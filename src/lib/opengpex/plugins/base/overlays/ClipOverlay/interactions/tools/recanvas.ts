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
import {
  ClipOptionsAPI,
} from '../../../../options/ClipOptions/protocols';
import { createTransformHandler, TransformIntent, ResizeHandle } from '@opengpex/editor/stage/interaction/handlers/TransformHandler';

/**
 * Edge hit detection threshold in screen pixels.
 * When the pointer is within this distance from a selection edge (in screen space),
 * the click is interpreted as an edge resize instead of creating a new selection.
 */
const EDGE_HIT_THRESHOLD_PX = 6;

/**
 * ReCanvasHandler: Dedicated interaction handler for Re-Canvas mode.
 *
 * Re-Canvas is a cross-cutting modal state that allows the user to resize the
 * physical canvas bounds. It is always rectangular, has no clamp (can extend
 * beyond current canvas), and does not sync to exchange layers.
 *
 * Priority 115: Higher than `regular.ts` (100) so it intercepts when Re-Canvas
 * is active. Lower than `move.ts` (130) — though move.ts already skips
 * Re-Canvas, so no conflict.
 */
export const createReCanvasHandler = (): InteractionHandler => {
  return createTransformHandler({
    id: 'clip-recanvas',
    priority: 115,
    clampAnchor: false, // Re-Canvas must NOT clamp anchor to canvas bounds

    test: (e): TransformIntent | null => {
      // Guard: only fires when Re-Canvas signal is active
      const inReCanvas = !!e.state.getStateSignal(ClipOptionsAPI.signals.reCanvas);
      if (!inReCanvas) return null;

      const target = e.nativeEvent.target as HTMLElement;
      if (target.closest('button, a, [data-role="ui"]')) return null;

      const rect = e.activeFrame.canvasClipBox?.rect;
      if (!rect || rect.w <= 0 || rect.h <= 0) return null;

      // ─── Corner handles (from DOM data-handle) ────────────────────────
      const handleElement = target.closest('[data-handle]') as HTMLElement;
      if (handleElement) {
        const handle = handleElement.dataset.handle || 'move';
        if (handle !== 'move') {
          return { category: 'resize', handle: handle as ResizeHandle };
        }
        // handle === 'move': fall through to edge detection
      }

      // ─── Edge hit detection (same algorithm as cursor hook) ────────────
      const k = e.activeFrame.camera.k;
      const T = EDGE_HIT_THRESHOLD_PX / k;
      const px = e.point.canvas.x;
      const py = e.point.canvas.y;

      const dTop = Math.abs(py - rect.y);
      const dBottom = Math.abs(py - (rect.y + rect.h));
      const dLeft = Math.abs(px - rect.x);
      const dRight = Math.abs(px - (rect.x + rect.w));
      const inHRange = px >= rect.x - T && px <= rect.x + rect.w + T;
      const inVRange = py >= rect.y - T && py <= rect.y + rect.h + T;

      if (dTop <= T && inHRange) return { category: 'resize', handle: 'n' };
      if (dBottom <= T && inHRange) return { category: 'resize', handle: 's' };
      if (dLeft <= T && inVRange) return { category: 'resize', handle: 'w' };
      if (dRight <= T && inVRange) return { category: 'resize', handle: 'e' };

      // ─── Inside box → move ─────────────────────────────────────────────
      if (handleElement && handleElement.dataset.handle === 'move') {
        return { category: 'move' };
      }

      // ─── Outside box → create (resize from edge) ──────────────────────
      // Re-Canvas "create" means user wants to redraw the canvas region.
      // Unlike crop, anchor should NOT be clamped to canvas (see clampAnchor: false).
      return { category: 'create' };
    },

    getInitialState: (e) => {
      return e.activeFrame.canvasClipBox?.rect || asLocalRect({ x: 0, y: 0, w: 0, h: 0 });
    },

    getConstraints: (e) => ({
      aspect: e.activeFrame.canvasAspect,
      clamp: false, // Re-Canvas MUST allow exceeding canvas bounds
    }),

    onUpdate: (e, newRect, tx) => {
      const frame = e.activeFrame;
      const currentShape = frame.canvasClipBox;
      tx.update({ canvasClipBox: { ...currentShape, rect: newRect } }, 'frame');
      // No exchange layer sync needed for Re-Canvas
    },

    // ── Declarative Gesture Rules ──
    gestures: [
      {
        name: 'double-click-select-all',
        match: (ctx) => ctx.isDoubleClick && ctx.intent.category === 'create',
        action: (e, tx) => {
          const frame = e.activeFrame;
          const fullCanvasRect = asLocalRect({ x: 0, y: 0, w: frame.canvas.w, h: frame.canvas.h });
          tx.update({ canvasClipBox: { ...frame.canvasClipBox, rect: fullCanvasRect } }, 'frame');
        }
      },
      // NOTE: No 'static-click-clear' for Re-Canvas — static click inside is a no-op.
      // Re-Canvas always has a canvasClipBox (it represents the physical canvas bounds).
    ],
  });
};
