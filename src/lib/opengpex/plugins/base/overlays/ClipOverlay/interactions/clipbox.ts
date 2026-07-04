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
  CropTool,
} from '../../../options/ClipOptions/protocols';
import { InteractionMath } from '@opengpex/editor/stage/interaction/Math';
import { createTransformHandler } from '@opengpex/editor/stage/interaction/handlers/TransformHandler';
import { makeCropToolGuard } from './guard';

/**
 * ClipBoxHandler: Core interaction handler for clip tool.
 * Handles crop box: Resize, Move, Create, and Peel.
 */
export const createClipBoxHandler = (): InteractionHandler => {
  let hasPeeled = false;

  return createTransformHandler({
    id: 'clip-box',
    priority: 100,

    test: (e) => {
      // Strategy-driven guard: only fires when the active tool declares
      // `handlerKind: 'clipbox'` (rect / ellipse rows).
      if (!makeCropToolGuard('clipbox')(e)) return null;

      const target = e.nativeEvent.target as HTMLElement;

      const handleElement = target.closest('[data-handle]') as HTMLElement;
      if (handleElement) {
        const handle = handleElement.dataset.handle || 'move';
        // Meta+drag crop box -> enter peel mode (peel fragments)
        if (handle === 'move' && (e.nativeEvent as MouseEvent).metaKey) {
          return 'peel';
        }
        return handle;
      }

      if (target.closest('button, a, [data-role="ui"]')) return null;

      const frame = e.activeFrame;
      const isInsideCanvas = e.geometry.space.isPointInRect(e.point.canvas, {
        x: 0, y: 0, w: frame.canvas.w, h: frame.canvas.h
      });

      if (isInsideCanvas) return 'potential_create';

      return null;
    },

    getInitialState: (e) => {
      const isReCanvas = e.state.getStateSignal(ClipOptionsAPI.signals.reCanvas) || false;
      const currentShape = isReCanvas ? e.activeFrame.canvasCropBox : getRegularClipShape(e.activeFrame);
      hasPeeled = false;
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

    onUpdate: (e, newRect, tx, { dx, dy, type }) => {
      const frame = e.activeFrame;
      const isReCanvas = e.state.getStateSignal(ClipOptionsAPI.signals.reCanvas) || false;
      const currentShape = isReCanvas ? frame.canvasCropBox : getRegularClipShape(frame);

      if (type === 'peel' && (e.nativeEvent as MouseEvent).metaKey) {
        if (!hasPeeled) {
          if (Math.sqrt(dx * dx + dy * dy) > 5) {
            hasPeeled = true;
            setTimeout(() => e.actions.adv.layer.peel.peelToExchange.execute({ isCopy: (e.nativeEvent as MouseEvent).altKey }), 0);
          }
          return;
        }
      }

      if (isReCanvas) {
        tx.update({ canvasCropBox: { ...currentShape, rect: newRect } }, 'frame');
      } else {
        // Determine the active tool slot from the per-frame field, NOT from
        // the existing shape's type.
        const latestTool = (frame.latestClipTool as CropTool) || 'rect';
        const activeTool = latestTool === 'ellipse' ? 'ellipse' : 'rect';
        const shapeType = latestTool === 'ellipse' ? 'circle' : 'rect';
        tx.update({ clipBoxes: { ...frame.clipBoxes, [activeTool]: { ...currentShape, type: shapeType, rect: newRect } } }, 'frame');
      }

      // Sync exchange layer if needed
      if (!isReCanvas && frame.activeLayerId) {
        const activeLayer = frame.activeLayerId ? frame.layers.byId[frame.activeLayerId] : undefined;
        const exchangeLayer = (activeLayer?.role === 'exchange')
          ? activeLayer
          : frame.layers.order.map(id => frame.layers.byId[id]).find(l => l.role === 'exchange' && l.parentId === frame.activeLayerId);

        if (exchangeLayer) {
          // Bounding-centered matrix: content center in world = (cx + v.x, cy + v.y),
          // so to place the fragment's visual center at the clip box center we subtract
          // the visibleShape offset from the desired world position.
          const vr = exchangeLayer.visibleShape?.rect;
          const vox = vr?.x ?? 0;
          const voy = vr?.y ?? 0;
          tx.update({
            cx: newRect.x + newRect.w / 2 - frame.canvas.w / 2 - vox,
            cy: newRect.y + newRect.h / 2 - frame.canvas.h / 2 - voy
          }, 'layer', exchangeLayer.id);
        }
      }
    },

    onEnd: (e, tx, startCanvas) => {
      // Handle Double Click to clear selection (Photoshop-style).
      if (InteractionMath.isDoubleClick(e, startCanvas)) {
        e.actions.executeCommand(ClipOptionsAPI.commands.resetBox.uid);
      }

      tx.commit();
      hasPeeled = false;
    }
  });
};
