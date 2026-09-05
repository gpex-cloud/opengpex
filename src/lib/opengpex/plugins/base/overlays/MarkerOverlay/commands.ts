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

/**
 * resolveTopHostLayer: the topmost host layer in z-order (ignores exchange/frag
 * sub-layers, which carry a `hostId`). This is the "previous layer" a freshly
 * drawn marker sits on top of.
 */
function resolveTopHostLayer(frame: Frame): Layer | null {
  const order = frame.layers.order;
  for (let i = order.length - 1; i >= 0; i--) {
    const l = frame.layers.byId[order[i]];
    if (l && !l.hostId) return l;
  }
  return null;
}

/** A marker layer is a `type:'vector'` layer produced by the Marker Tool. */
function isMarkerLayer(l: Layer | undefined | null): boolean {
  return !!l && l.type === 'vector' && !!l.markerData;
}

/** A group auto-created by the Marker Tool to hold consecutive markers. */
function isVectorGroup(l: Layer | undefined | null): boolean {
  return !!l && l.type === 'group' && l.metadata?.isVectorGroup === true;
}

/**
 * Auto-grouping decision for a newly drawn marker, based on the current
 * top-of-stack layer (see spec discussion):
 *   - 'append': add the marker into an existing vector group `groupId`.
 *   - 'create': the top layer is a bare marker `seedLayerId` — create a new
 *               vector group and move both it and the new marker into it.
 *   - 'none':   place the marker as a plain top layer (no grouping). Applies
 *               when the stack top is not a marker, or is a marker already
 *               inside a user-created (non-vector) group.
 *
 * Resolving off both the group header AND a marker's `groupId` keeps this correct
 * regardless of whether the group header sits above or below its children in the
 * flat order (the two layouts produced by createGroup vs. panel reorder).
 */
function resolveGrouping(
  frame: Frame,
): { mode: 'none' } | { mode: 'append'; groupId: string } | { mode: 'create'; seedLayerId: string } {
  const top = resolveTopHostLayer(frame);
  if (!top) return { mode: 'none' };

  // Stack top is a vector group header → append into it.
  if (isVectorGroup(top)) return { mode: 'append', groupId: top.id };

  // Stack top is a marker.
  if (isMarkerLayer(top)) {
    if (top.groupId) {
      const g = frame.layers.byId[top.groupId];
      // Already inside a vector group → append; inside a manual group → leave it.
      return isVectorGroup(g) ? { mode: 'append', groupId: g.id } : { mode: 'none' };
    }
    // Bare marker → seed a new vector group holding both markers.
    return { mode: 'create', seedLayerId: top.id };
  }

  return { mode: 'none' };
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

    const decision = resolveGrouping(frame);

    if (decision.mode === 'append') {
      const layer = { ...payload.layer, groupId: decision.groupId };
      const insertAt = LayerFactory.getInsertIndexAbove(frame, decision.groupId);
      ctx.layers.addLayer(payload.frameId, layer, insertAt);
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

      // Move the existing bare marker (the seed) into the group. It stays where
      // it is in z-order — only its groupId changes.
      ctx.actions.updateLayer(payload.frameId, seedId, { groupId: group.id });

      // Group header goes to the BOTTOM of the member block (spec §2.2). The seed
      // is the current top-of-stack HOST layer (hostId is empty), so the slot the
      // seed's block starts at is exactly `indexOf(seedId)` — inserting there
      // pushes the seed block up and leaves the header just beneath it.
      const seedBlockStart = frame.layers.order.indexOf(seedId);
      ctx.layers.addLayer(payload.frameId, group, seedBlockStart);

      // The new marker is the newest → top of the group. Since the seed was the
      // top-of-stack host layer, "top" is simply the end of the order (default
      // append, same as mode 'none'). No hand-computed index needed.
      const layer = { ...payload.layer, groupId: group.id };
      ctx.layers.addLayer(payload.frameId, layer);
      ctx.layers.activate(payload.frameId, layer.id);
      return;
    }

    // mode 'none': plain top layer (original behavior).
    ctx.layers.addLayer(payload.frameId, payload.layer);
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
