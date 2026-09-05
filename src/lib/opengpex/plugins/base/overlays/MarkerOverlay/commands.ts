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

import { EditorContextValue, EditorCommand, Layer, Frame, MarkerData } from '@opengpex/editor/core/types';
import { LayerFactory } from '@opengpex/editor/core/layer';
import * as P from './protocols';

// ─── Commands ──────────────────────────────────────────────────────────────────

/** A marker layer is a `type:'vector'` layer produced by the Marker Tool. */
function isMarkerLayer(l: Layer | undefined | null): boolean {
  return !!l && l.type === 'vector' && !!l.markerData;
}

/** A group auto-created by the Marker Tool to hold consecutive markers. */
function isVectorGroup(l: Layer | undefined | null): boolean {
  return !!l && l.type === 'group' && l.metadata?.isVectorGroup === true;
}

/**
 * Auto-grouping decision for a newly drawn marker, delegating the generic
 * "nearest same-kind neighbour" mechanism to LayerFactory and injecting only the
 * marker-specific predicates. See LayerFactory.resolveNeighborGroupTarget for the
 * below-first / create / append / none semantics.
 */
function resolveGrouping(
  frame: Frame,
  below: Layer | null,
  above: Layer | null,
): { mode: 'none' } | { mode: 'append'; groupId: string } | { mode: 'create'; seedLayerId: string } {
  return LayerFactory.resolveNeighborGroupTarget(frame, below, above, {
    isMember: isMarkerLayer,
    isGroupHeader: isVectorGroup,
  });
}

/**
 * cmd.place: Places a newly drawn marker as a `type:'vector'` layer, with
 * automatic grouping of consecutively drawn markers.
 *
 * Grouping rules (see resolveGrouping):
 *   - First marker on empty space / on a non-marker → plain top layer.
 *   - Drawn on top of a bare marker → both are moved into a new auto "Markers"
 *     group (metadata.isVectorGroup).
 *   - Drawn on top of an existing auto vector group (or its member) → appended.
 *   - On top of a marker that lives in a user-created group → left ungrouped.
 *
 * undoable: true → the whole operation (group creation + seed re-parent + new
 * layer) collapses into a single undo step, so one undo cleanly reverts it.
 */
const placeCommand: EditorCommand<{ frameId: string; layer: Layer }, void> = {
  id: P.CMD_PLACE,
  name: 'Place Marker Layer',
  undoable: true,
  execute: (ctx: EditorContextValue, payload: { frameId: string; layer: Layer }) => {
    const frame = ctx.state.frames.byId[payload.frameId];
    if (!frame) return;

    // The new marker always lands directly above the active layer. `insertAt` is
    // the single source of truth for its slot; grouping only decides `groupId` and
    // whether/where a group header is inserted — never the new layer's slot.
    const below = LayerFactory.resolveActiveHostLayer(frame);
    const insertAt = LayerFactory.getInsertIndexAbove(frame, below?.id);
    const above = LayerFactory.resolveHostAbove(frame, insertAt);
    const decision = resolveGrouping(frame, below, above);

    // 'append': join the group and land at the TOP of its member block via
    // getInsertIndexAbove(groupId). This is the group-contiguity guarantee — a
    // plain `insertAt` could wedge the new layer BELOW the group header when the
    // group was matched via the above neighbour, violating spec §2.2 (header at
    // the bottom of the member block).
    if (decision.mode === 'append') {
      const layer = { ...payload.layer, groupId: decision.groupId };
      const groupInsertAt = LayerFactory.getInsertIndexAbove(frame, decision.groupId);
      ctx.layers.addLayer(payload.frameId, layer, groupInsertAt);
      ctx.layers.activate(payload.frameId, layer.id);
      return;
    }

    if (decision.mode === 'create') {
      const seedId = decision.seedLayerId;

      // Name the group after the existing host layers (e.g. "Markers", "Markers 2").
      const hostLayers = LayerFactory.getHostLayers(
        frame.layers.order.map(id => frame.layers.byId[id]),
      );
      const groupName = LayerFactory.getNewLayerName(hostLayers, 'Group Markers');
      const group = LayerFactory.getNewGroup({
        name: groupName,
        metadata: { isVectorGroup: true },
      });

      // Move the existing bare marker (the seed) into the group — only its groupId
      // changes; its z-order slot is untouched.
      ctx.actions.updateLayer(payload.frameId, seedId, { groupId: group.id });

      // Header goes to the BOTTOM of the combined {seed, new-marker} member block
      // (spec §2.2). The block's lowest slot is min(seedIdx, insertAt):
      //   • seed BELOW the slot (active is the seed) → seedIdx < insertAt → seedIdx
      //   • seed ABOVE the slot (grouped via the above neighbour) → seedIdx === insertAt
      // In create mode `insertAt` is always defined (either neighbour that seeded
      // the group implies a defined slot).
      const seedIdx = frame.layers.order.indexOf(seedId);
      const headerIndex = Math.min(seedIdx, insertAt as number);
      ctx.layers.addLayer(payload.frameId, group, headerIndex);

      // Inserting the header at headerIndex (≤ insertAt) shifted the new-marker slot
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

/**
 * cmd.update_marker: Updates markerData of an existing marker layer.
 *
 * undoable: true → each committed property change is an independent undo step.
 * Used by MarkerPanel for non-live (discrete) edits. Continuous edits (slider
 * dragging) should call `actions.updateLayer` directly to avoid fragmented
 * undo checkpoints, then commit once on release.
 */
const updateMarkerCommand: EditorCommand<{ frameId: string; layerId: string; patch: Partial<MarkerData> }, void> = {
  id: P.CMD_UPDATE_MARKER,
  name: 'Update Marker Properties',
  undoable: true,
  execute: (ctx: EditorContextValue, payload: { frameId: string; layerId: string; patch: Partial<MarkerData> }) => {
    const frame = ctx.state.frames.byId[payload.frameId];
    const layer = frame?.layers.byId[payload.layerId];
    if (!frame || !layer || !layer.markerData) return;

    ctx.actions.updateLayer(payload.frameId, payload.layerId, {
      markerData: {
        ...layer.markerData,
        ...payload.patch,
      } as MarkerData,
    });
  },
};

// ─── Export ────────────────────────────────────────────────────────────────────

export const MARKER_OVERLAY_COMMANDS = [
  placeCommand,
  updateMarkerCommand,
];
