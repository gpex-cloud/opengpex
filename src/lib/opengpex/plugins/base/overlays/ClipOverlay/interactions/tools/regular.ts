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
import { InteractionMath } from '@opengpex/editor/stage/interaction/Math';
import { createTransformHandler } from '@opengpex/editor/stage/interaction/handlers/TransformHandler';
import { makeClipToolGuard } from '../guard';

/**
 * ClipBoxHandler: Core interaction handler for clip tool.
 * Handles crop box: Resize and Create.
 *
 * Move and Peel are handled by the unified `createSelectionMoveHandler` which
 * operates on any selection type (rect/ellipse/polygon). This handler only
 * retains resize handles and new-selection creation.
 */
export const createClipBoxHandler = (): InteractionHandler => {
  return createTransformHandler({
    id: 'clip-box',
    priority: 100,

    test: (e) => {
      // Strategy-driven guard: only fires when the active tool declares
      // `handlerKind: 'clipbox'` (rect / ellipse rows).
      if (!makeClipToolGuard('clipbox')(e)) return null;

      const target = e.nativeEvent.target as HTMLElement;

      const handleElement = target.closest('[data-handle]') as HTMLElement;
      if (handleElement) {
        const handle = handleElement.dataset.handle || 'move';
        // Move and peel for clip selections are handled by createSelectionMoveHandler.
        // Exception: Re-Canvas move stays here since it's a purely rectangular,
        // no-peel operation with different constraints (no clamp, aspect ratio).
        if (handle === 'move') {
          const isReCanvas = !!e.state.getStateSignal(ClipOptionsAPI.signals.reCanvas);
          if (!isReCanvas) return null;
          return 'move';
        }
        return handle;
      }

      if (target.closest('button, a, [data-role="ui"]')) return null;

      // Accept clicks both inside AND outside canvas for creating selections.
      // Outside-canvas clicks allow the user to start a selection from the
      // canvas edge (Photoshop Marquee behavior). The TransformHandler will
      // clamp the starting anchor to the nearest canvas edge.
      return 'potential_create';
    },

    getInitialState: (e) => {
      const isReCanvas = e.state.getStateSignal(ClipOptionsAPI.signals.reCanvas) || false;
      const currentShape = isReCanvas ? e.activeFrame.canvasCropBox : getRegularClipShape(e.activeFrame);
      return currentShape?.rect || asLocalRect({ x: 0, y: 0, w: 0, h: 0 });
    },

    getConstraints: (e) => {
      const isReCanvas = e.state.getStateSignal(ClipOptionsAPI.signals.reCanvas) || false;
      return {
        aspect: isReCanvas ? e.activeFrame.canvasAspect : e.activeFrame.imageAspect,
        clamp: !isReCanvas,
        alignToLayerId: isReCanvas ? undefined : e.activeFrame.activeLayerId || undefined
      };
    },

    onUpdate: (e, newRect, tx, { dx: _dx, dy: _dy, type: _type }) => {
      const frame = e.activeFrame;
      const isReCanvas = e.state.getStateSignal(ClipOptionsAPI.signals.reCanvas) || false;
      const currentShape = isReCanvas ? frame.canvasCropBox : getRegularClipShape(frame);

      if (isReCanvas) {
        tx.update({ canvasCropBox: { ...currentShape, rect: newRect } }, 'frame');
      } else {
        // Determine the active tool slot from the per-frame field, NOT from
        // the existing shape's type.
        const latestTool = (frame.latestClipTool as ClipTool) || 'rect';
        const activeTool = latestTool === 'ellipse' ? 'ellipse' : 'rect';
        // P7: write a proper LocalPolygon (with rings) so downstream consumers
        // (polygonToShape, localToWorldPolygon, etc.) never see rings=undefined.
        const antiAliased = currentShape?.antiAliased ?? true;
        const newPoly = e.geometry.point2d.regularShapeToLocalPolygon(latestTool === 'ellipse' ? 'ellipse' : 'rect', newRect, antiAliased);
        tx.update({ clipBoxes: { ...frame.clipBoxes, [activeTool]: newPoly } }, 'frame');
      }

      // Sync exchange layer if needed
      if (!isReCanvas && frame.activeLayerId) {
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

    onEnd: (e, tx, startCanvas) => {
      // ── Gesture dispatch (extensible) ──
      // Priority order: more specific gestures checked first.

      // Double-click = select entire canvas (Photoshop "Ctrl+A" equivalent).
      // Sets the clip box to exactly match the canvas dimensions.
      if (InteractionMath.isDoubleClick(e, startCanvas)) {
        const frame = e.activeFrame;
        const isReCanvas = e.state.getStateSignal(ClipOptionsAPI.signals.reCanvas) || false;
        const fullCanvasRect = asLocalRect({ x: 0, y: 0, w: frame.canvas.w, h: frame.canvas.h });

        if (isReCanvas) {
          const currentShape = frame.canvasCropBox;
          tx.update({ canvasCropBox: { ...currentShape, rect: fullCanvasRect } }, 'frame');
        } else {
          const latestTool = (frame.latestClipTool as ClipTool) || 'rect';
          const activeTool = latestTool === 'ellipse' ? 'ellipse' : 'rect';
          const currentShape = getRegularClipShape(frame);
          const antiAliased = currentShape?.antiAliased ?? true;
          const newPoly = e.geometry.point2d.regularShapeToLocalPolygon(latestTool === 'ellipse' ? 'ellipse' : 'rect', fullCanvasRect, antiAliased);
          tx.update({ clipBoxes: { ...frame.clipBoxes, [activeTool]: newPoly } }, 'frame');
        }

        tx.commit();
        return;
      }

      // Single static click (no drag) = clear selection (Photoshop Marquee behavior).
      // Works identically inside and outside canvas.
      if (InteractionMath.isStaticClick(e, startCanvas)) {
        e.actions.executeCommand(ClipOptionsAPI.commands.resetBox.uid);
      }

      tx.commit();
    }
  });
};
