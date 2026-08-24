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
import { getClipBox } from '@opengpex/editor/core/helpers/selection';
import { ClipOptionsAPI } from '../../../../options/ClipOptions/protocols';
import { createTransformHandler, TransformIntent, ResizeHandle } from '@opengpex/editor/stage/interaction/handlers/TransformHandler';
import { makeClipToolGuard } from '../guard';

/**
 * PathEllipseHandler: Path-based ellipse selection interaction handler.
 *
 * Reuses the same drag-to-define-rect interaction as the regular clipbox handler
 * (rect/ellipse tools), but on each update stores a high-density adaptive polygon
 * via `ellipseToPolygon` instead of the fixed 64-point polygon. This ensures
 * the selection stays on the `type:'path'` pipeline (not recognized as circle),
 * providing pixel-perfect fragment/hole complementarity even when the selection
 * extends beyond layer boundaries.
 *
 * Stored in `frame.clipBoxes['pathellipse']` as a LocalPolygon.
 */
export const createPathEllipseHandler = (): InteractionHandler => {
  return createTransformHandler({
    id: 'clip-pathellipse',
    priority: 100,

    test: (e): TransformIntent | null => {
      // Strategy-driven guard: only fires when `handlerKind: 'pathellipse'`
      if (!makeClipToolGuard('pathellipse')(e)) return null;

      const target = e.nativeEvent.target as HTMLElement;

      const handleElement = target.closest('[data-handle]') as HTMLElement;
      if (handleElement) {
        const handle = handleElement.dataset.handle || 'move';
        if (handle === 'move') {
          // Fall through to edge detection / create
        } else {
          return { category: 'resize', handle: handle as ResizeHandle };
        }
      }

      if (target.closest('button, a, [data-role="ui"]')) return null;

      // ─── Edge hit detection (ellipse arc) ──────────────────────────────
      const EDGE_HIT_THRESHOLD_PX = 6;
      const currentBox = getClipBox(e.activeFrame);
      const rect = currentBox?.rect;

      if (rect && rect.w > 0 && rect.h > 0 && e.activeFrame.latestClipTool === 'pathellipse') {
        const k = e.activeFrame.camera.k;
        const T = EDGE_HIT_THRESHOLD_PX / k;

        const px = e.point.canvas.x;
        const py = e.point.canvas.y;
        const cx = rect.x + rect.w / 2;
        const cy = rect.y + rect.h / 2;
        const rx = rect.w / 2;
        const ry = rect.h / 2;

        // Normalized distance to ellipse
        const nx = (px - cx) / rx;
        const ny = (py - cy) / ry;
        const r = Math.sqrt(nx * nx + ny * ny);
        const avgRadius = (rx + ry) / 2;
        const distToEllipse = Math.abs(r - 1) * avgRadius;

        if (distToEllipse <= T) {
          const cosA = (px - cx) / (Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy)) || 1);
          const sinA = (py - cy) / (Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy)) || 1);

          if (Math.abs(cosA) > Math.abs(sinA)) {
            return { category: 'resize', handle: px < cx ? 'w' : 'e' };
          } else {
            return { category: 'resize', handle: py < cy ? 'n' : 's' };
          }
        }
      }

      return { category: 'create' };
    },

    getInitialState: (e) => {
      const currentBox = getClipBox(e.activeFrame);
      return currentBox?.rect || asLocalRect({ x: 0, y: 0, w: 0, h: 0 });
    },

    getConstraints: (e) => {
      return {
        aspect: e.activeFrame.imageAspect,
        clamp: true,
        alignToLayerId: e.activeFrame.activeLayerId || undefined
      };
    },

    onUpdate: (e, newRect, tx) => {
      const frame = e.activeFrame;
      const currentBox = getClipBox(frame);
      const antiAliased = currentBox?.antiAliased ?? true;

      // Use 360-point ellipsePathToLocalPolygon to stay on type:'path' pipeline.
      // The 64-point regularShapeToLocalPolygon('ellipse') is recognized as type:'circle'
      // by point2dToLocalShape, which breaks path ∩ path intersection in nested cuts.
      const newPoly = e.geometry.polygon.ellipsePathToLocalPolygon(newRect, antiAliased);
      tx.update({ clipBoxes: { ...frame.clipBoxes, ['pathellipse']: newPoly } }, 'frame');
    },

    gestures: [
      {
        name: 'double-click-select-all',
        match: (ctx) => ctx.isDoubleClick && ctx.intent.category === 'create',
        action: (e, tx) => {
          const frame = e.activeFrame;
          const fullCanvasRect = asLocalRect({ x: 0, y: 0, w: frame.canvas.w, h: frame.canvas.h });
          const currentBox = getClipBox(frame);
          const antiAliased = currentBox?.antiAliased ?? true;
          const newPoly = e.geometry.polygon.ellipsePathToLocalPolygon(fullCanvasRect, antiAliased);
          tx.update({ clipBoxes: { ...frame.clipBoxes, ['pathellipse']: newPoly } }, 'frame');
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
  });
};
