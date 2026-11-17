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

import { InteractionHandler, Layer, LayerMovePose, asLocalRect } from '@opengpex/editor/core/types';
import { InteractionMath, type SnapOpState } from '../Math';
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
 *
 * [Architecture Note] This handler is a SYSTEM-LEVEL component and stays in stage.
 * The evidence: its test() is tool-agnostic (pan-mode bare drag or Cmd spring key,
 * top layer under the pointer — it knows no tool); the Dispatcher hard-codes it as
 * the spring-key global fallback ('layer-move', the framework guarantee "Cmd+drag
 * moves the object under the pointer in any tool, without per-tool cooperation");
 * tool-owned move handlers (marker/text/…) coordinate around it by outranking its
 * priority 10. A framework guarantee cannot rest on an optional plugin, so the
 * earlier idea of migrating it into LayerOverlay was inverted: the overlay owns the
 * VISUALIZATION (outline + delta label) and reads state; it does not need to own
 * the gesture. Layer-service access flows through the InteractionEvent injection
 * (e.layers), so no plugin residency is required here either.
 */
export const createLayerMoveHandler = (): InteractionHandler => {
  let startCanvasPoint = { x: 0, y: 0 };
  let startLayerCx = 0;
  let startLayerCy = 0;
  let targetLayer: Layer | null = null;
  let tx: InteractionTransaction | null = null;
  let pose: LayerMovePose | null = null;
  const opState: SnapOpState = { lastThrottleTime: 0 };

  return {
    id: 'layer-move',
    priority: 10,
    test: (e) => {

      // Pan mode allows layer movement with a bare drag; any other mode
      // requires the Cmd spring key (temporarily moving the object under the
      // pointer). Clip -> crop-box operations, craft -> tool interactions.
      const isPanMode = e.state.interaction.interactionMode === 'pan';
      const springMeta = e.spring.meta;
      if (!isPanMode && !springMeta) return false;

      // In any mode, mouse outside canvas does not trigger layer movement (delegated to ViewportPanHandler)
      const frame = e.activeFrame;
      const isOutsideCanvas = !e.geometry.space.isPointInRect(e.point.canvas, {
        x: 0, y: 0, w: frame.canvas.w, h: frame.canvas.h
      });
      if (isOutsideCanvas) return false;

      const topLayer = e.geometry.space.pickTopLayer(e.point.world, e.activeFrame.layers);

      // If there is a clicked layer, and that layer can be moved
      if (topLayer && !topLayer.locked && topLayer.visible) {
        targetLayer = topLayer;
        return true;
      }

      // Active-layer fallback: bare drag in pan mode over empty canvas falls
      // through to viewport-pan, so this only fires in tool modes. Under the
      // Cmd spring key it must NOT fire — "Cmd+drag on empty canvas is a
      // no-op", moving the (unrelated) active layer would be surprising.
      if (!isPanMode && !springMeta) {
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

      // Declare the gesture feedback for the moved layer's delta chip (a
      // marker layer's always-on chip HUD renders it; plain layers carry no
      // chip HUD yet). Cleared by the transaction's commit/abort.
      tx.declareFeedback({
        kind: 'translate',
        target: 'layer',
        targetId: targetLayer.id,
        origin: { x: startLayerCx, y: startLayerCy },
      });

      opState.lastThrottleTime = 0;
      delete opState.lastPointerPos;
      delete opState.lastGuideX;
      delete opState.lastGuideY;
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
      const localCenter = e.geometry.space.worldToLocal(visibleCenterWorld.x, visibleCenterWorld.y, frame.canvas);
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
      const snappedCenterWorld = e.geometry.space.localToWorld(snappedCenterLocal.x, snappedCenterLocal.y, frame.canvas);

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
            // ★ Pixel alignment: align visible AABB top-left edge to canvas pixel grid,
            // through the layer service's placement posture (round top-left, size
            // preserved — an odd-sized layer keeps its natural half-integer center).
            // SYSTEM COMPONENT: this handler stays in stage by design (tool-agnostic
            // spring-key global fallback, dispatcher-guaranteed); the layer service
            // reaches it through the InteractionEvent injection, no plugin residency
            // required.
            const frame = e.activeFrame;
            // World → Local (visible center in canvas-local coords), then the
            // same marker-style posture: center-derived top-left rect in,
            // aligned world anchor out — no manual half-extent reconstruction.
            const localCenter = e.geometry.space.worldToLocal(latest.cx + pose.centerOffset.x, latest.cy + pose.centerOffset.y, frame.canvas);
            const { worldCenter } = e.layers.snap.snapLayerPlacement(
              asLocalRect({
                x: localCenter.x - pose.aabbSize.w / 2,
                y: localCenter.y - pose.aabbSize.h / 2,
                w: pose.aabbSize.w,
                h: pose.aabbSize.h,
              }),
              frame.canvas,
            );

            // cx = aligned visible center - fixed offset
            tx.update({
              cx: worldCenter.x - pose.centerOffset.x,
              cy: worldCenter.y - pose.centerOffset.y
            }, 'layer', targetLayer.id);
          }
        }
        tx.commit();
        tx = null;
      }
      targetLayer = null;
      pose = null;
      delete opState.lastPointerPos;
      delete opState.lastGuideX;
      delete opState.lastGuideY;
    }
  };
};
