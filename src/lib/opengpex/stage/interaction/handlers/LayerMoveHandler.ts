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

import { InteractionHandler, Layer, asWorldRect } from '@opengpex/editor/core/types';
import { InteractionMath } from '../Math';
import { InteractionTransaction } from '../Transaction';

/**
 * LayerMoveHandler: Handles layer movement
 */
export const createLayerMoveHandler = (): InteractionHandler => {
  let startCanvasPoint = { x: 0, y: 0 };
  let startLayerPos = { x: 0, y: 0 };
  let targetLayer: Layer | null = null;
  let tx: InteractionTransaction | null = null;

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
      startLayerPos = { x: targetLayer.cx, y: targetLayer.cy };
    },
    onMove: (e) => {
      if (!targetLayer || !tx) return;

      const deltaX = e.point.canvas.x - startCanvasPoint.x;
      const deltaY = e.point.canvas.y - startCanvasPoint.y;

      // 💡 1. Extract logical bounding box size of the current visible fragment
      const rect = targetLayer.visibleShape?.rect || {
        x: 0,
        y: 0,
        w: targetLayer.bounding.w,
        h: targetLayer.bounding.h
      };
      const frame = e.activeFrame;

      // 💡 2. cx/cy is in world coordinates -> convert to canvas-local top-left coordinates for snapAndSync
      const newWorldCx = startLayerPos.x + deltaX;
      const newWorldCy = startLayerPos.y + deltaY;
      const localCenter = e.geometry.space.worldToLocal(newWorldCx, newWorldCy, frame);
      const fragmentRect = {
        x: localCenter.x - rect.w / 2,
        y: localCenter.y - rect.h / 2,
        w: rect.w,
        h: rect.h
      };

      const opState = { lastThrottleTime: 0 };
      const snapped = InteractionMath.snapAndSync(e, fragmentRect, opState, {
        excludeLayerId: targetLayer.id
      });

      // 💡 3. Aligned fragment center from canvas-local -> reverse transform back to world (cx, cy)
      const snappedCenterLocal = {
        x: snapped.x + fragmentRect.w / 2,
        y: snapped.y + fragmentRect.h / 2
      };
      const finalWorld = e.geometry.space.localToWorld(snappedCenterLocal.x, snappedCenterLocal.y, frame);

      tx.update({ cx: finalWorld.x, cy: finalWorld.y }, 'layer', targetLayer.id);
    },
    onEnd: (e) => {
      if (tx) {
        // 💡 Pixel alignment on release: ensure layer is 100% aligned with canvas physical integer pixel grid on physical boundaries (left/top bounds).
        // Calls unified geometric alignment service alignCenterToCanvasGrid, auto-handling 0.5px spatial offset due to odd/even canvas width and height.
        if (targetLayer) {
          const latest = e.actions.fast.latestLayer(e.activeFrame.id, targetLayer.id);
          if (latest) {
            const rect = latest.visibleShape?.rect || latest.bounding;

            const alignedRect = e.geometry.snapping.snapRectToPixel(
              asWorldRect({
                x: latest.cx - rect.w / 2,
                y: latest.cy - rect.h / 2,
                w: rect.w,
                h: rect.h
              }),
              e.activeFrame.canvas
            );

            const center = e.geometry.space.getRectCenter(alignedRect);

            tx.update({
              cx: center.x,
              cy: center.y
            }, 'layer', targetLayer.id);
          }
        }
        tx.commit();
        tx = null;
      }
      targetLayer = null;
    }
  };
};

