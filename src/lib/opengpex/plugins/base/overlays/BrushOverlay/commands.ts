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

import { EditorContextValue, EditorCommand, Layer, Frame } from '@opengpex/editor/core/types';
import { LayerFactory } from '@opengpex/editor/core/layer';
import * as P from './protocols';

// ─── Commands ──────────────────────────────────────────────────────────────────

/** A stroke layer is a `type:'vector'` layer produced by the Brush Tool. */
function isStrokeLayer(l: Layer | undefined | null): boolean {
  return !!l && l.type === 'vector' && !!l.strokeData;
}

/** A group auto-created by the Brush Tool to hold consecutive strokes. */
function isStrokeGroup(l: Layer | undefined | null): boolean {
  return !!l && l.type === 'group' && l.metadata?.isStrokeGroup === true;
}

/**
 * Auto-grouping decision for a newly drawn stroke, delegating the generic
 * "nearest same-kind neighbour" mechanism to LayerFactory and injecting only the
 * brush-specific predicates. See LayerFactory.resolveNeighborGroupTarget for the
 * below-first / create / append / none semantics.
 */
function resolveGrouping(
  frame: Frame,
  below: Layer | null,
  above: Layer | null,
): { mode: 'none' } | { mode: 'append'; groupId: string } | { mode: 'create'; seedLayerId: string } {
  return LayerFactory.resolveNeighborGroupTarget(frame, below, above, {
    isMember: isStrokeLayer,
    isGroupHeader: isStrokeGroup,
  });
}

/**
 * cmd.place: Places a freshly started logic-brush stroke as a `type:'vector'`
 * layer, with automatic grouping of consecutively drawn strokes — aligned with
 * MarkerOverlay's place command.
 *
 * ONE STROKE = ONE LAYER. Grouping rules (see resolveGrouping):
 *   - First stroke on empty space / on a non-stroke → plain top layer.
 *   - Drawn on top of a bare stroke → both are moved into a new auto
 *     "Strokes" group (metadata.isStrokeGroup).
 *   - Drawn on top of an existing auto stroke group (or its member) → appended.
 *   - On top of a stroke that lives in a user-created group → left ungrouped.
 * Distinct `isStrokeGroup` metadata keeps brush auto-groups isolated from the
 * Marker (`isVectorGroup`) and Text (`isTextGroup`) ones.
 *
 * undoable: true → this is the ONLY undo checkpoint of a stroke gesture. The
 * whole in-progress trajectory afterwards rides the volatile fast track
 * (`InteractionTransaction.begin(silent)`, which does not signal a checkpoint),
 * and the pointerup commit writes it through `fast.commit`, which does not
 * either. Group creation + seed re-parent + new layer collapse into that same
 * single undo step, reverting to before the pen touched down.
 */
const placeCommand: EditorCommand<{ frameId: string; layer: Layer }, void> = {
  id: P.CMD_PLACE,
  name: 'Place Stroke Layer',
  undoable: true,
  execute: (ctx: EditorContextValue, payload: { frameId: string; layer: Layer }) => {
    const frame = ctx.state.frames.byId[payload.frameId];
    if (!frame) return;

    // The new stroke always lands directly above the active layer. `insertAt` is
    // the single source of truth for its slot; grouping only decides `groupId` and
    // whether/where a group header is inserted — never the new layer's slot.
    const below = LayerFactory.resolveActiveHostLayer(frame);
    const insertAt = LayerFactory.getInsertIndexAbove(frame, below?.id);
    const above = LayerFactory.resolveHostAbove(frame, insertAt);
    const decision = resolveGrouping(frame, below, above);

    // 'append': join the group and land at the TOP of its member block via
    // getInsertIndexAbove(groupId). This is the group-contiguity guarantee — a
    // plain `insertAt` could wedge the new layer BELOW the group header when the
    // group was matched via the above neighbour.
    if (decision.mode === 'append') {
      const layer = { ...payload.layer, groupId: decision.groupId };
      const groupInsertAt = LayerFactory.getInsertIndexAbove(frame, decision.groupId);
      ctx.layers.addLayer(payload.frameId, layer, groupInsertAt);
      ctx.layers.activate(payload.frameId, layer.id);
      return;
    }

    if (decision.mode === 'create') {
      const seedId = decision.seedLayerId;

      // Name the group after the existing host layers (e.g. "Group Strokes",
      // "Group Strokes 2").
      const hostLayers = LayerFactory.getHostLayers(
        frame.layers.order.map(id => frame.layers.byId[id]),
      );
      const groupName = LayerFactory.getNewLayerName(hostLayers, 'Group Strokes');
      const group = LayerFactory.getNewGroup({
        name: groupName,
        metadata: { isStrokeGroup: true },
      });

      // Move the existing bare stroke (the seed) into the group — only its groupId
      // changes; its z-order slot is untouched.
      ctx.actions.updateLayer(payload.frameId, seedId, { groupId: group.id });

      // Header goes to the BOTTOM of the combined {seed, new-stroke} member block.
      // The block's lowest slot is min(seedIdx, insertAt):
      //   • seed BELOW the slot (active is the seed) → seedIdx < insertAt → seedIdx
      //   • seed ABOVE the slot (grouped via the above neighbour) → seedIdx === insertAt
      const seedIdx = frame.layers.order.indexOf(seedId);
      const headerIndex = Math.min(seedIdx, insertAt as number);
      ctx.layers.addLayer(payload.frameId, group, headerIndex);

      // Inserting the header at headerIndex (≤ insertAt) shifted the new-stroke slot
      // up by exactly one, so it lands at insertAt + 1 — directly above the seed
      // when the seed is below, or directly below the seed when the seed is above.
      const layer = { ...payload.layer, groupId: group.id };
      ctx.layers.addLayer(payload.frameId, layer, (insertAt as number) + 1);
      ctx.layers.activate(payload.frameId, layer.id);
      return;
    }

    // mode 'none': plain layer, inserted directly above the active layer
    // (getInsertIndexAbove handles group / hostId targets). Falls back to
    // append-on-top (undefined index → reducer push) when there is no active layer.
    ctx.layers.addLayer(payload.frameId, payload.layer, insertAt);
    ctx.layers.activate(payload.frameId, payload.layer.id);
  },
};

// ─── Export ────────────────────────────────────────────────────────────────────

export const BRUSH_OVERLAY_COMMANDS = [placeCommand];
