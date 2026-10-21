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

import { EditorCommand, EditorContextValue, Layer } from '@opengpex/editor/core/types';
import type { MarkerData } from './marker/types';
import { LayerFactory } from '@opengpex/editor/core/layer';
import * as P from './protocols';

// ─── Commands ──────────────────────────────────────────────────────────────────

/**
 * cmd.place: Places a newly drawn marker as a `type:'vector'` layer directly
 * above the active layer, as a plain top-level layer (no auto-grouping).
 *
 * undoable: true → the placement is a single undo step.
 */
const placeCommand: EditorCommand<{ frameId: string; layer: Layer }, void> = {
  id: P.CMD_PLACE,
  name: 'Place Marker Layer',
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
