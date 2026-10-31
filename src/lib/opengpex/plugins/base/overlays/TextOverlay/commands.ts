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

import { EditorContextValue, EditorCommand, Layer, asLocalShape, VolatileState } from '@opengpex/editor/core/types';
import { LayerFactory } from '@opengpex/editor/core/layer';
import { LayerUtils } from '@opengpex/editor/core/layer/utils';
import type { TextLayerData } from '@opengpex/editor/core/types/models';
import { normalizeBoxMode } from '@opengpex/editor/core/types/models';
import { measureTextBounding, measuredBoxesDiffer } from './hooks/measuring';
import { affectsTextStyleLayout, type TextStyleField } from './hooks/styling';
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
    // Establish the history checkpoint at the PLACED state, recording the
    // creation as its own undo step. Everything the session does on top of it
    // (typing, panel styling) then baselines against a valid checkpoint — the
    // session's ledgered writes stay per-op granular, and undoing the creation
    // step removes the layer in one move.
    ctx.actions.history.commitCheckpoint(payload.frameId);
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
    // Establish the history checkpoint at the session-start state: every
    // ledgered write inside the session (panel style commands) baselines
    // against it and stays its own undo step, and session cancel restores
    // exactly this state. Without the rebase, the checkpoint would still sit
    // wherever the last outside op left it, and the session's first ledgered
    // write would swallow the raw interim edits above it.
    ctx.actions.history.commitCheckpoint(payload.frameId);
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
 * (line-box model, top-left anchored), so a larger font is never
 * clipped by the old bounding.
 */
/**
 * Shared implementation of the style-patch commands: merges the patch into the
 * layer's textData, then re-measures content-hugging boxes so a style change
 * never clips the glyphs. Both the undoable and the live variant run THIS body
 * — the re-measure policy is not optional per caller.
 *
 * Re-measuring happens ONLY when the patch touches a layout-affecting field
 * (styling.ts's catalog): a colour or alignment patch cannot change metrics,
 * and measuring anyway makes the canvas engine fight the DOM engine's values
 * (the editing session measures from the live contenteditable) — the two
 * engines disagree by a pixel and ping-pong bounding corrections into history
 * as phantom no-op undo steps.
 */
function executeStylePatch(ctx: EditorContextValue, payload: { frameId: string; layerId: string; patch: Partial<TextLayerData> }): void {
  const frame = ctx.state.frames.byId[payload.frameId];
  const layer = frame?.layers.byId[payload.layerId];
  if (!frame || !layer || !layer.textData) return;

  // Measurement baseline during a live editing session: the slow track is
  // frozen while the session runs, so the typed content the box must measure
  // against lives in the fast-track draft. The merged latest layer is
  // slow ⊕ draft; stacking this patch last gives slow floor ⊕ draft content ⊕
  // patch — an in-session style change therefore re-measures the text the
  // user is actually looking at instead of the stale (create session: empty)
  // slow-track content. Outside a session latestLayer IS the slow layer and
  // the expression degenerates to the old baseline.
  const liveLayer = ctx.actions.fast.latestLayer(payload.frameId, payload.layerId) ?? layer;
  const measureBase: TextLayerData = { ...liveLayer.textData!, ...payload.patch };

  // The LEDGERED landing stays slow-track based: only the style fields and
  // the geometry they imply belong in this command's undo step. The draft's
  // typed content is deliberately NOT folded in — content lands to the slow
  // track exclusively at the session's commit exit, and baking it in here
  // would break the commit's dirty baseline.
  const textData: TextLayerData = { ...layer.textData, ...payload.patch };

  // The live box (draft geometry) is the comparison baseline: the slow-track
  // geometry is frozen during a session, so comparing against it would turn
  // every in-session style patch into a phantom geometry write.
  const liveBounding = liveLayer.bounding;

  let bounding = layer.bounding;
  let cx = layer.cx;
  let cy = layer.cy;
  const mode = normalizeBoxMode(measureBase.boxMode);
  const layoutAffecting = Object.keys(payload.patch).some(
    (key) => affectsTextStyleLayout(key as TextStyleField),
  );
  if (layoutAffecting && mode === 'auto_width') {
    const measured = measureTextBounding(measureBase);
    // Equality runs through the one-pixel tolerance: a canvas-engine answer
    // within 1px of the DOM engine's is engine noise, not a layout change —
    // writing it back would create a phantom undo step and invite the next
    // commit to write the old value right back.
    if (measuredBoxesDiffer(measured, liveBounding)) {
      cx = compensateCenterX(layer.cx, bounding.w, measured.w, measureBase.align);
      cy = compensateCenterY(layer.cy, bounding.h, measured.h);
      bounding = measured;
    }
  } else if (layoutAffecting && mode === 'auto_height') {
    // Width is locked (boxWidth); re-measure only the wrapped height so a
    // style change never clips the paragraph.
    const measured = measureTextBounding(measureBase, measureBase.boxWidth || liveBounding.w);
    if (measuredBoxesDiffer({ w: liveBounding.w, h: measured.h }, liveBounding)) {
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

  // Draft refresh: when the layer sits in a live editing session, the fast
  // track carries a whole-object textData draft whose only live key is the
  // typed content. Without this refresh the merged frame would keep serving
  // the pre-patch style to the GPU renderer until the next keystroke restacks
  // the draft. The refresh applies the landed (slow-track) style over the
  // draft while preserving the draft's content — content never lands to the
  // slow track from this command.
  if (ctx.state.interaction.signals[P.TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID] === payload.layerId) {
    const compositeKey = LayerUtils.getCompositeKey(payload.frameId, payload.layerId);
    ctx.actions.mutateVolatile((v: VolatileState) => {
      const entry = v.buffered.layers[compositeKey];
      const draftTextData = entry?.patch?.textData;
      if (!draftTextData) return;
      v.buffered.layers[compositeKey] = {
        ...entry,
        patch: { ...entry.patch, textData: { ...textData, content: draftTextData.content } },
      };
    });
  }
}

const updatePropertiesCommand: EditorCommand<{ frameId: string; layerId: string; patch: Partial<TextLayerData> }, void> = {
  id: P.CMD_UPDATE_PROPERTIES,
  name: 'Update Text Properties',
  undoable: true,
  execute: executeStylePatch,
};

/**
 * cmd.update_properties_live: the non-undoable twin of cmd.update_properties.
 *
 * Serves continuous slider dragging on a selected (pre-edit) text layer: the
 * panel writes each pointermove step through this command so the box follows
 * the style in real time, while the release event goes through the undoable
 * cmd.update_properties for the single history checkpoint. Running the same
 * body as the undoable variant is the point — before this existed the live
 * path wrote textData directly and skipped the re-measure entirely, so the
 * box only converged when the slider was released.
 */
const updatePropertiesLiveCommand: EditorCommand<{ frameId: string; layerId: string; patch: Partial<TextLayerData> }, void> = {
  id: P.CMD_UPDATE_PROPERTIES_LIVE,
  name: 'Update Text Properties (Live)',
  undoable: false,
  execute: executeStylePatch,
};

// ─── Export ────────────────────────────────────────────────────────────────────

export const TEXT_OVERLAY_COMMANDS = [
  placeCommand,
  editStartCommand,
  updatePropertiesCommand,
  updatePropertiesLiveCommand,
];
