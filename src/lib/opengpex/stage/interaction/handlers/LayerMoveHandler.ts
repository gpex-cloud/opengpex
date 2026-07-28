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

import { InteractionHandler, Layer, LayerMovePose } from '@opengpex/editor/core/types';
import { InteractionMath } from '../Math';
import { InteractionTransaction } from '../Transaction';

/**
 * LayerMoveHandler: Handles layer movement (rotation-aware refactored version).
 *
 * Key design:
 *   - `computeLayerMovePose` is called once in onStart to pre-compute rotation-dependent
 *     AABB size and center offset, eliminating per-frame matrix recalculation.
 *   - onMove uses pose.aabbSize for correct snapping rect construction and
 *     pose.centerOffset for trivial reverse (no computeFragmentCenter needed).
 *   - onEnd uses worldToLocal + snapToPixel + localToWorld for pixel alignment.
 */
export const createLayerMoveHandler = (): InteractionHandler => {
  let startCanvasPoint = { x: 0, y: 0 };
  let startLayerCx = 0;
  let startLayerCy = 0;
  let targetLayer: Layer | null = null;
  let tx: InteractionTransaction | null = null;
  let pose: LayerMovePose | null = null;
  const opState = { lastThrottleTime: 0 };

  return {
    id: 'layer-move',
    priority: 10,
    test: (e) => {
      const isRightClick = (e.nativeEvent as MouseEvent).button === 2;
      if (isRightClick) return false;

      // Only pan mode allows layer movement (clip -> operates crop box, craft -> tool interactions)
      if (e.state.interaction.interactionMode !== 'pan') return false;

      // In any mode, mouse outside canvas does not trigger layer movement (delegated to ViewportPanHandler)
      const frame = e.activeFrame;
      const isOutsideCanvas = !e.geometry.space.isPointInRect(e.point.canvas, {
        x: 0, y: 0, w: frame.canvas.w, h: frame.canvas.h
      });
      if (isOutsideCanvas) return false;

      const isPanMode = e.state.interaction.interactionMode === 'pan';

      const topLayer = e.geometry.space.pickTopLayer(e.point.world, e.activeFrame.layers);

      // If there is a clicked layer, and that layer can be moved
      if (topLayer && !topLayer.locked && topLayer.visible) {
        targetLayer = topLayer;
        return true;
      }

      // If no layer is clicked, but not in pan mode, and there is a selected active layer
      if (!isPanMode) {
        const activeLayer = e.activeFrame.activeLayerId ? e.activeFrame.layers.byId[e.activeFrame.activeLayerId] : undefined;
        if (activeLayer && !activeLayer.locked && activeLayer.visible) {
          targetLayer = activeLayer;
          return true;
        }
      }

      return false;
    },
    onStart: (e) => {
      if (!targetLayer) return;

      // Select layer
      if (targetLayer.id !== e.activeFrame.activeLayerId) {
        e.actions.setActiveLayer(e.activeFrame.id, targetLayer.id);
      }

      tx = new InteractionTransaction(e);
      tx.begin();

      startCanvasPoint = { x: e.point.canvas.x, y: e.point.canvas.y };
      startLayerCx = targetLayer.cx;
      startLayerCy = targetLayer.cy;

      // ★ Core change: compute rotation-aware pose once at drag start
      pose = e.geometry.transform.computeLayerMovePose(targetLayer);

      opState.lastThrottleTime = 0;
    },
    onMove: (e) => {
      if (!targetLayer || !tx || !pose) return;

      const deltaX = e.point.canvas.x - startCanvasPoint.x;
      const deltaY = e.point.canvas.y - startCanvasPoint.y;

      // Candidate new cx/cy
      const candidateCx = startLayerCx + deltaX;
      const candidateCy = startLayerCy + deltaY;

      // Visible content center = (cx, cy) + centerOffset (world space)
      const visibleCenterWorld = {
        x: candidateCx + pose.centerOffset.x,
        y: candidateCy + pose.centerOffset.y
      };

      // Convert to canvas local coordinates, build correct AABB rect
      const frame = e.activeFrame;
      const localCenter = e.geometry.space.worldToLocal(
        visibleCenterWorld.x, visibleCenterWorld.y, frame
      );
      const fragmentRect = {
        x: localCenter.x - pose.aabbSize.w / 2,  // ★ Use rotated AABB size
        y: localCenter.y - pose.aabbSize.h / 2,
        w: pose.aabbSize.w,
        h: pose.aabbSize.h
      };

      // Snap
      const snapped = InteractionMath.snapAndSync(e, fragmentRect, opState, {
        excludeLayerId: targetLayer.id
      });

      // ★ Simplified reverse: snapped center = snapped visible center (local)
      const snappedCenterLocal = {
        x: snapped.x + pose.aabbSize.w / 2,
        y: snapped.y + pose.aabbSize.h / 2
      };
      const snappedCenterWorld = e.geometry.space.localToWorld(
        snappedCenterLocal.x, snappedCenterLocal.y, frame
      );

      // cx = visible center - centerOffset (subtract constant offset, no matrix inversion needed)
      const finalCx = snappedCenterWorld.x - pose.centerOffset.x;
      const finalCy = snappedCenterWorld.y - pose.centerOffset.y;

      tx.update({ cx: finalCx, cy: finalCy }, 'layer', targetLayer.id);
    },
    onEnd: (e) => {
      if (tx) {
        if (targetLayer && pose) {
          const latest = e.actions.fast.latestLayer(e.activeFrame.id, targetLayer.id);
          if (latest) {
            // ★ Pixel alignment: align visible AABB top-left edge to canvas pixel grid.
            // We round the TOP-LEFT corner (not center) to preserve correct positioning
            // for odd-dimension layers whose center is naturally at .5 (half-pixel).
            // This matches the pre-refactoring snapRectToPixel approach that naturally
            // handled odd/even canvas and layer dimensions.
            const frame = e.activeFrame;
            const currentVisibleCenter = {
              x: latest.cx + pose.centerOffset.x,
              y: latest.cy + pose.centerOffset.y
            };
            // World → Local (get center in canvas-local coords)
            const local = e.geometry.space.worldToLocal(
              currentVisibleCenter.x, currentVisibleCenter.y, frame
            );
            // Snap AABB top-left to pixel grid, then derive center
            const halfW = pose.aabbSize.w / 2;
            const halfH = pose.aabbSize.h / 2;
            const topLeft = { x: local.x - halfW, y: local.y - halfH };
            const alignedTopLeft = e.geometry.snapping.snapToPixel(topLeft);
            const aligned = { x: alignedTopLeft.x + halfW, y: alignedTopLeft.y + halfH };
            const alignedWorld = e.geometry.space.localToWorld(
              aligned.x, aligned.y, frame
            );

            // cx = aligned visible center - fixed offset
            tx.update({
              cx: alignedWorld.x - pose.centerOffset.x,
              cy: alignedWorld.y - pose.centerOffset.y
            }, 'layer', targetLayer.id);
          }
        }
        tx.commit();
        tx = null;
      }
      targetLayer = null;
      pose = null;
    }
  };
};
