/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

'use client';

import { EditorContextValue, EditorCommand, Layer, asLocalShape } from '@opengpex/editor/core/types';
import { LayerFactory } from '@opengpex/editor/core/layer';
import type { TextLayerData } from '@opengpex/editor/core/types/models';
import { normalizeBoxMode } from '@opengpex/editor/core/types/models';
import { TEXT_LAYER_PADDING } from '@opengpex/editor/core/helpers/config';
import { computeTextLayout } from '@opengpex/editor/core/engine/text/textLayout';
import { compensateCenterX, compensateCenterY } from './geometry';
import * as P from './protocols';

// ─── Commands ──────────────────────────────────────────────────────────────────

/**
 * cmd.place: Places a new text layer and enters editing state
 *
 * undoable: true → Automatically establish SIGNAL_COMMIT undo baseline before execution.
 * Undo will remove the newly created layer completely in one step.
 */
const placeCommand: EditorCommand<{ frameId: string; layer: Layer }, void> = {
  id: P.CMD_PLACE,
  name: 'Place Text Layer',
  undoable: true,
  execute: (ctx: EditorContextValue, payload: { frameId: string; layer: Layer }) => {
    const frame = ctx.state.frames.byId[payload.frameId];
    if (!frame) return;

    // Plain layer, inserted directly above the active layer
    // (getInsertIndexAbove handles group / hostId targets). Falls back to
    // append-on-top (undefined index → reducer push) when there is no active layer.
    const below = LayerFactory.resolveActiveHostLayer(frame);
    const insertAt = LayerFactory.getInsertIndexAbove(frame, below?.id);
    ctx.layers.addLayer(payload.frameId, payload.layer, insertAt);
    finishPlace(ctx, payload.frameId, payload.layer.id);
  },
};

/**
 * finishPlace: shared tail of cmd.place — activate the new text layer and enter
 * the inline create-editing session.
 */
function finishPlace(ctx: EditorContextValue, frameId: string, layerId: string): void {
  ctx.layers.activate(frameId, layerId);
  ctx.scoped!.setSignal(P.SIGNAL_EDITING_TEXT_LAYER_ID, layerId);
  ctx.scoped!.setSignal(P.SIGNAL_SESSION_TYPE, 'create');
}

/**
 * cmd.edit_start: Activates an existing text layer and enters editing state
 *
 * undoable: false → No automatic checkpoint. The editing session (ModifySession)
 * manages its own snapshot and creates a checkpoint only at commit time when
 * actual changes are detected. Cancel restores from snapshot with zero undo impact.
 */
const editStartCommand: EditorCommand<{ frameId: string; layerId: string }, void> = {
  id: P.CMD_EDIT_START,
  name: 'Start Text Editing',
  undoable: false,
  execute: (ctx: EditorContextValue, payload: { frameId: string; layerId: string }) => {
    ctx.actions.setActiveLayer(payload.frameId, payload.layerId);
    ctx.scoped!.setSignal(P.SIGNAL_EDITING_TEXT_LAYER_ID, payload.layerId);
    ctx.scoped!.setSignal(P.SIGNAL_SESSION_TYPE, 'modify');
  },
};

/**
 * cmd.update_properties: Updates text layer style attributes
 *
 * undoable: true → Automatically establish SIGNAL_COMMIT undo baseline before execution.
 * Only used for attribute modifications in non-editing state (editing state modifications should go directly to updateLayer to avoid fragmented snapshots).
 *
 * Text layers render on the GPU from `textData` (vector spine), so a style
 * patch only needs the model update — no baked asset to refresh. Auto-mode
 * boxes are re-measured here, mirroring the editing commit's DOM measurement
 * (line-box model + padding, top-left anchored), so a larger font is never
 * clipped by the old bounding.
 */
const updatePropertiesCommand: EditorCommand<{ frameId: string; layerId: string; patch: Partial<TextLayerData> }, void> = {
  id: P.CMD_UPDATE_PROPERTIES,
  name: 'Update Text Properties',
  undoable: true,
  execute: (ctx: EditorContextValue, payload: { frameId: string; layerId: string; patch: Partial<TextLayerData> }): void => {
    const frame = ctx.state.frames.byId[payload.frameId];
    const layer = frame?.layers.byId[payload.layerId];
    if (!frame || !layer || !layer.textData) return;

    const textData: TextLayerData = { ...layer.textData, ...payload.patch };

    let bounding = layer.bounding;
    let cx = layer.cx;
    let cy = layer.cy;
    const mode = normalizeBoxMode(textData.boxMode);
    if (mode === 'auto_width') {
      const measured = measureTextBounding(textData);
      if (measured.w !== bounding.w || measured.h !== bounding.h) {
        // Align-aware anchor compensation — same formula the editing commit
        // path uses (left edge / centre / right edge per textAlign; the top
        // edge anchors vertical growth).
        cx = compensateCenterX(layer.cx, bounding.w, measured.w, textData.align);
        cy = compensateCenterY(layer.cy, bounding.h, measured.h);
        bounding = measured;
      }
    } else if (mode === 'auto_height') {
      // Width is locked (boxWidth); re-measure only the wrapped height so a
      // style change never clips the paragraph.
      const measured = measureTextBounding(textData, textData.boxWidth || bounding.w);
      if (measured.h !== bounding.h) {
        cy = compensateCenterY(layer.cy, bounding.h, measured.h);
        bounding = { w: bounding.w, h: measured.h };
      }
    }
    // 'fixed': the user owns the box — never re-measured here.
    const visibleShape = asLocalShape({ x: 0, y: 0, w: bounding.w, h: bounding.h });

    ctx.actions.updateLayer(payload.frameId, payload.layerId, {
      textData,
      bounding,
      visibleShape,
      cx,
      cy,
    });
  },
};

/**
 * Measure the content bounding of a text layer for the style-patch path
 * (cmd.update_properties), delegating wrapping and glyph measurement to the
 * shared `computeTextLayout` so this path can never drift from the layout the
 * GPU renderer and the DOM editor both consume. The height uses the same
 * line-box model as the DOM editor: one `fontSize × lineHeight` box per
 * content line, plus padding on both axes. With `wrapWidth` (auto_height
 * mode) lines wrap at the locked width first. Slightly generous is fine — it
 * only has to never clip the glyphs.
 */
function measureTextBounding(td: TextLayerData, wrapWidth?: number): { w: number; h: number } {
  const ctx = getMeasureCtx();
  const layout = computeTextLayout(
    ctx,
    { ...td, boxMode: wrapWidth !== undefined ? 'auto_height' : 'auto_width' },
    wrapWidth ?? 0,
    0,
  );
  let maxLineW = 0;
  for (const line of layout.lines) maxLineW = Math.max(maxLineW, line.width);
  const h = Math.max(Math.ceil(layout.lines.length * layout.lineHeight) + TEXT_LAYER_PADDING.y * 2, 20);
  if (wrapWidth !== undefined) {
    // auto_height: the width is locked; only the height follows the content.
    return { w: wrapWidth, h };
  }
  return {
    w: Math.max(Math.ceil(maxLineW) + TEXT_LAYER_PADDING.x * 2, 4),
    h,
  };
}

let measureCtx: CanvasRenderingContext2D | null = null;
function getMeasureCtx(): CanvasRenderingContext2D {
  if (!measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d')!;
  }
  return measureCtx;
}

/**
 * cmd.modify_commit: Commits a modify session with full layer patch
 *
 * undoable: true → Creates the undo baseline automatically (SIGNAL_COMMIT).
 * Called AFTER restoring the original snapshot so that undo reverts to pre-edit state.
 * The payload contains the full final layer state to apply.
 */
const modifyCommitCommand: EditorCommand<{ frameId: string; layerId: string; patch: Partial<Layer> }, void> = {
  id: P.CMD_MODIFY_COMMIT,
  name: 'Commit Text Modification',
  undoable: true,
  execute: (ctx: EditorContextValue, payload: { frameId: string; layerId: string; patch: Partial<Layer> }) => {
    ctx.actions.updateLayer(payload.frameId, payload.layerId, payload.patch);
  },
};

// ─── Export ────────────────────────────────────────────────────────────────────

export const TEXT_OVERLAY_COMMANDS = [
  placeCommand,
  editStartCommand,
  updatePropertiesCommand,
  modifyCommitCommand,
];
