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
import { isSegmentData, segmentLayoutOf, segmentContainment, shiftSegmentEndpoints } from './marker/shapes/line-segment/geometry';
import { squareizeMarker } from './marker/squareize';
import { resolveAutoGroupPlacement } from '../../drawers/CraftDrawer/protocols';
import * as P from './protocols';

// ─── Commands ──────────────────────────────────────────────────────────────────

/**
 * cmd.place: Places a newly drawn marker as a `type:'vector'` layer directly
 * above the active layer, folding into the craft auto group when the active
 * layer is a session member (see `resolveAutoGroupPlacement`).
 *
 * undoable: true → the placement (including any auto group formed alongside
 * it) is a single undo step.
 */
const placeCommand: EditorCommand<{ frameId: string; layer: Layer }, void> = {
  id: P.CMD_PLACE,
  name: 'Place Marker Layer',
  undoable: true,
  execute: (ctx: EditorContextValue, payload: { frameId: string; layer: Layer }) => {
    const frame = ctx.state.frames.byId[payload.frameId];
    if (!frame) return;

    // Craft auto grouping (may also create the group container for a second
    // consecutive member). All indices come precomputed from the same frame
    // snapshot — do NOT recompute against the frame after the first addLayer.
    const placement = resolveAutoGroupPlacement(frame);
    if (placement.group) {
      ctx.layers.factory.addLayer(payload.frameId, placement.group.layer, placement.group.insertAt);
    }
    if (placement.hostPatch) {
      ctx.actions.updateLayer(payload.frameId, placement.hostPatch.layerId, { groupId: placement.hostPatch.groupId });
    }
    if (placement.groupId) payload.layer.groupId = placement.groupId;
    ctx.layers.factory.addLayer(payload.frameId, payload.layer, placement.insertAt);
    ctx.layers.factory.activate(payload.frameId, payload.layer.id);
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
  execute: (ctx: EditorContextValue, payload: { frameId: string; layerId: string; patch: Partial<MarkerData> },) => {
    const frame = ctx.state.frames.byId[payload.frameId];
    const layer = frame?.layers.byId[payload.layerId];
    if (!frame || !layer || !layer.markerData) return;

    const merged = { ...layer.markerData, ...payload.patch } as MarkerData;

    // Segment family containment: these shapes paint OUTWARD from their
    // endpoints, so growing the stroke width or head scale grows the ink
    // beyond a bounding frozen at creation — it would clip at the transient
    // texture edge. Re-derive the containment layout (minimally expanded box,
    // re-anchored endpoints, centre delta converted through the world matrix's
    // rotation/flip columns) and commit geometry + style as ONE undoable
    // write. The outline family grows inward and never needs this.
    let markerData: MarkerData = merged;
    let cx = layer.cx;
    let cy = layer.cy;
    let w = layer.bounding.w;
    let h = layer.bounding.h;
    const widthChanged = payload.patch.stroke?.width !== undefined
      && payload.patch.stroke.width !== layer.markerData.stroke.width;
    const headChanged = isSegmentData(merged) && merged.kind !== 'line'
      && 'headScale' in payload.patch
      && payload.patch.headScale !== undefined
      && payload.patch.headScale !== (layer.markerData as { headScale?: number }).headScale;
    if (isSegmentData(merged) && (widthChanged || headChanged)) {
      const seg = segmentLayoutOf(merged);
      if (seg) {
        const sw = Math.max(0, merged.stroke.width);
        const layout = segmentContainment(
          seg.a, seg.b,
          sw / 2, seg.headLen, seg.headA, seg.headB,
          layer.bounding.w, layer.bounding.h,
        );
        markerData = shiftSegmentEndpoints(merged, layout.shiftX, layout.shiftY);
        w = layout.bounding.w;
        h = layout.bounding.h;
        const M = ctx.geometry.transform.getLayerWorldMatrix(layer);
        cx += M.a * layout.centerDeltaX + M.c * layout.centerDeltaY;
        cy += M.b * layout.centerDeltaX + M.d * layout.centerDeltaY;
      }
    }

    ctx.actions.updateLayer(payload.frameId, payload.layerId, {
      markerData,
      ...(w !== layer.bounding.w || h !== layer.bounding.h
        ? ctx.layers.factory.rebaseToBounds({ x: cx - w / 2, y: cy - h / 2, w, h })
        : {}),
    } as Partial<Layer>);
  },
};

// ─── Export ────────────────────────────────────────────────────────────────────

/**
 * cmd.squareize_marker: Snaps the selected marker's bounding box to a square
 * to its natural proportions (NOT a literal square: a rect squares, a polygon
 * or star returns to its regular n-gon silhouette), centre-anchored — the
 * panel's "Regular" button.
 *
 * undoable: true → the reset is a single undo step. All geometry (endpoint /
 * body / tip rescale, segment containment) comes from the shared pure helper,
 * so this command and the double-click-handle gesture produce identical
 * results modulo the anchor choice.
 */
const squareizeMarkerCommand: EditorCommand<{ frameId: string; layerId: string }, void> = {
  id: P.CMD_SQUAREIZE_MARKER,
  name: 'Regularize Marker Bounding',
  undoable: true,
  execute: (ctx: EditorContextValue, payload: { frameId: string; layerId: string }) => {
    const frame = ctx.state.frames.byId[payload.frameId];
    const layer = frame?.layers.byId[payload.layerId];
    if (!frame || !layer || !layer.markerData) return;

    const result = squareizeMarker(layer.markerData, layer.bounding, { kind: 'center' });
    if (!result) return;

    const M = ctx.geometry.transform.getLayerWorldMatrix(layer);
    const cx = layer.cx + M.a * result.centerDelta.x + M.c * result.centerDelta.y;
    const cy = layer.cy + M.b * result.centerDelta.x + M.d * result.centerDelta.y;

    ctx.actions.updateLayer(payload.frameId, payload.layerId, {
      // Pose-preserving rebaser: the {cx, cy, bounding, visibleShape} quartet
      // stays consistent by construction — visibleShape MUST ride along or
      // the LayerOverlay outline keeps the old box while the marker shrinks.
      ...ctx.layers.factory.rebaseToBounds({
        x: cx - result.bounding.w / 2,
        y: cy - result.bounding.h / 2,
        w: result.bounding.w,
        h: result.bounding.h,
      }),
      markerData: result.markerData,
    } as Partial<Layer>);
  },
};

export const MARKER_OVERLAY_COMMANDS = [
  placeCommand,
  updateMarkerCommand,
  squareizeMarkerCommand,
];
