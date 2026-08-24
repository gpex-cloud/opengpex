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

import {
  InteractionHandler,
  asLocalRect,
} from '@opengpex/editor/core/types';
import { getRegularClipShape } from '@opengpex/editor/core/helpers/selection';
import {
  ClipOptionsAPI,
  ClipTool,
} from '../../../../options/ClipOptions/protocols';
import { createTransformHandler, TransformIntent, ResizeHandle } from '@opengpex/editor/stage/interaction/handlers/TransformHandler';
import { makeClipToolGuard } from '../guard';

/**
 * Edge hit detection threshold in screen pixels.
 * When the pointer is within this distance from a selection edge (in screen space),
 * the click is interpreted as an edge resize instead of creating a new selection.
 */
const EDGE_HIT_THRESHOLD_PX = 6;

/**
 * ClipBoxHandler: Core interaction handler for clip tool.
 * Handles clip box: Resize and Create.
 *
 * Move and Peel are handled by the unified `createSelectionMoveHandler` which
 * operates on any selection type (rect/ellipse/polygon). This handler only
 * retains resize handles and new-selection creation.
 *
 * Re-Canvas interactions are handled by the dedicated `createReCanvasHandler`
 * (in re-canvas.ts) which has priority 115 and intercepts first when Re-Canvas
 * is active. This handler explicitly skips Re-Canvas for safety.
 */
export const createClipBoxHandler = (): InteractionHandler => {
  return createTransformHandler({
    id: 'clip-box',
    priority: 100,

    test: (e): TransformIntent | null => {
      // Strategy-driven guard: only fires when the active tool declares
      // `handlerKind: 'clipbox'` (rect / ellipse rows).
      if (!makeClipToolGuard('clipbox')(e)) return null;

      // Explicitly skip Re-Canvas (handled by dedicated re-canvas handler)
      if (e.state.getStateSignal(ClipOptionsAPI.signals.reCanvas)) return null;

      const target = e.nativeEvent.target as HTMLElement;

      const handleElement = target.closest('[data-handle]') as HTMLElement;
      if (handleElement) {
        const handle = handleElement.dataset.handle || 'move';
        // Move and peel for clip selections are handled by createSelectionMoveHandler.
        if (handle === 'move') {
          // Fall through to edge detection below.
          // If the pointer is near a selection edge, handle it as resize.
          // If not: yield to the move handler (priority 130).
        } else {
          return { category: 'resize', handle: handle as ResizeHandle };
        }
      }

      if (target.closest('button, a, [data-role="ui"]')) return null;

      // ─── Edge hit detection ────────────────────────────────────────────
      // When pointer is within EDGE_HIT_THRESHOLD_PX (screen pixels) of a
      // selection edge, interpret as single-axis resize (n/s/e/w).
      // This allows resizing from ANY point along the marching ants line,
      // solving the "handles out of viewport after zoom" problem.
      const currentShape = getRegularClipShape(e.activeFrame);
      const rect = currentShape?.rect;

      if (rect && rect.w > 0 && rect.h > 0) {
        // Convert threshold from screen pixels to canvas-local pixels
        const k = e.activeFrame.camera.k;
        const T = EDGE_HIT_THRESHOLD_PX / k;

        const px = e.point.canvas.x;
        const py = e.point.canvas.y;

        const latestTool = (e.activeFrame.latestClipTool as ClipTool) || 'rect';
        const isEllipse = latestTool === 'ellipse';

        if (isEllipse) {
          // ─── Ellipse: distance to ellipse arc ─────────────────────────
          // Uses normalized coordinates to compute approximate distance from
          // the pointer to the ellipse boundary.
          const cx = rect.x + rect.w / 2;
          const cy = rect.y + rect.h / 2;
          const rx = rect.w / 2;
          const ry = rect.h / 2;

          // Normalize to unit circle space
          const nx = (px - cx) / rx;
          const ny = (py - cy) / ry;
          const r = Math.sqrt(nx * nx + ny * ny);

          // Approximate distance to ellipse in canvas-local pixels
          // Uses average radius for de-normalization (acceptable approximation
          // for hit detection — exact ellipse distance requires iterative solving)
          const avgRadius = (rx + ry) / 2;
          const distToEllipse = Math.abs(r - 1) * avgRadius;

          if (distToEllipse <= T) {
            // Determine resize direction by pointer angle relative to center.
            // Quadrant-based: |cos| > |sin| → horizontal (e/w), else vertical (n/s)
            const cosA = (px - cx) / (Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy)) || 1);
            const sinA = (py - cy) / (Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy)) || 1);

            if (Math.abs(cosA) > Math.abs(sinA)) {
              return { category: 'resize', handle: px < cx ? 'w' : 'e' };
            } else {
              return { category: 'resize', handle: py < cy ? 'n' : 's' };
            }
          }
        } else {
          // ─── Rectangle: distance to bounding rect edges ───────────────
          const dTop = Math.abs(py - rect.y);
          const dBottom = Math.abs(py - (rect.y + rect.h));
          const dLeft = Math.abs(px - rect.x);
          const dRight = Math.abs(px - (rect.x + rect.w));

          // Range checks: pointer must be within the edge's span (± tolerance)
          const inHRange = px >= rect.x - T && px <= rect.x + rect.w + T;
          const inVRange = py >= rect.y - T && py <= rect.y + rect.h + T;

          // Check edges (single-axis resize)
          if (dTop <= T && inHRange) return { category: 'resize', handle: 'n' };
          if (dBottom <= T && inHRange) return { category: 'resize', handle: 's' };
          if (dLeft <= T && inVRange) return { category: 'resize', handle: 'w' };
          if (dRight <= T && inVRange) return { category: 'resize', handle: 'e' };
        }
      }

      // Accept clicks both inside AND outside canvas for creating selections.
      // Outside-canvas clicks allow the user to start a selection from the
      // canvas edge (Photoshop Marquee behavior). The TransformHandler will
      // clamp the starting anchor to the nearest canvas edge.
      return { category: 'create' };
    },

    getInitialState: (e) => {
      const currentShape = getRegularClipShape(e.activeFrame);
      return currentShape?.rect || asLocalRect({ x: 0, y: 0, w: 0, h: 0 });
    },

    getConstraints: (e) => {
      return {
        aspect: e.activeFrame.imageAspect,
        clamp: true,
        alignToLayerId: e.activeFrame.activeLayerId || undefined
      };
    },

    onUpdate: (e, newRect, tx, _context) => {
      const frame = e.activeFrame;
      const currentShape = getRegularClipShape(frame);

      // Determine the active tool slot from the per-frame field, NOT from
      // the existing shape's type.
      const latestTool = (frame.latestClipTool as ClipTool) || 'rect';
      const activeTool = latestTool === 'ellipse' ? 'ellipse' : 'rect';
      // P7: write a proper LocalPolygon (with rings) so downstream consumers
      // (polygonToShape, localToWorldPolygon, etc.) never see rings=undefined.
      const antiAliased = currentShape?.antiAliased ?? true;
      const newPoly = e.geometry.polygon.regularShapeToLocalPolygon(latestTool === 'ellipse' ? 'ellipse' : 'rect', newRect, antiAliased);
      tx.update({ clipBoxes: { ...frame.clipBoxes, [activeTool]: newPoly } }, 'frame');

      // Sync exchange layer if needed
      if (frame.activeLayerId) {
        const activeLayer = frame.activeLayerId ? frame.layers.byId[frame.activeLayerId] : undefined;
        const exchangeLayer = (activeLayer?.role === 'exchange')
          ? activeLayer
          : frame.layers.order.map(id => frame.layers.byId[id]).find(l => l.role === 'exchange' && l.hostId === frame.activeLayerId);

        if (exchangeLayer) {
          // Convert clip box center from frame-local to world coordinates
          const worldCenter = e.geometry.space.localToWorld(newRect.x + newRect.w / 2, newRect.y + newRect.h / 2, frame);
          // Account for layer orientation (rotation/flip) when computing anchor.
          const vr = exchangeLayer.visibleShape?.rect;
          const vox = vr?.x ?? 0;
          const voy = vr?.y ?? 0;
          const pose = e.geometry.transform.computeFragmentCenter(worldCenter, { x: vox, y: voy }, exchangeLayer.rotation, exchangeLayer.flip);
          tx.update({ cx: pose.x, cy: pose.y }, 'layer', exchangeLayer.id);
        }
      }
    },

    // ── Declarative Gesture Rules ──
    // Only creation-type interactions support double-click (select all) and
    // static-click (clear selection). Resize handle interactions should NEVER
    // trigger these gestures — the intent.category check ensures this.
    gestures: [
      {
        name: 'double-click-select-all',
        match: (ctx) => ctx.isDoubleClick && ctx.intent.category === 'create',
        action: (e, tx) => {
          const frame = e.activeFrame;
          const fullCanvasRect = asLocalRect({ x: 0, y: 0, w: frame.canvas.w, h: frame.canvas.h });

          const latestTool = (frame.latestClipTool as ClipTool) || 'rect';
          const activeTool = latestTool === 'ellipse' ? 'ellipse' : 'rect';
          const currentShape = getRegularClipShape(frame);
          const antiAliased = currentShape?.antiAliased ?? true;
          const newPoly = e.geometry.polygon.regularShapeToLocalPolygon(latestTool === 'ellipse' ? 'ellipse' : 'rect', fullCanvasRect, antiAliased);
          tx.update({ clipBoxes: { ...frame.clipBoxes, [activeTool]: newPoly } }, 'frame');
        }
      },
      {
        name: 'static-click-clear',
        match: (ctx) => !ctx.hasMoved && ctx.intent.category === 'create',
        action: (e) => {
          e.actions.executeCommand(ClipOptionsAPI.commands.resetBox.uid);
        }
      }
    ],

    // No onEnd needed — autoCommit handles resize/move completion.
  });
};
