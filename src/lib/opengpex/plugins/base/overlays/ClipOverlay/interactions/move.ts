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
  InteractionEvent,
  LocalRect,
  LocalPolygon,
  asLocalRect,
} from '@opengpex/editor/core/types';
import { getClipBox, getRegularClipShape } from '@opengpex/editor/core/helpers/selection';
import { createTransformHandler, TransformIntent } from '@opengpex/editor/stage/interaction/handlers/TransformHandler';
import {
  ClipOptionsAPI,
  ClipTool,
} from '../../../options/ClipOptions/protocols';

/** Edge hit threshold — must match the value in regular.ts */
const EDGE_HIT_THRESHOLD_PX = 6;

/**
 * createSelectionMoveHandler — Unified selection move + peel handler.
 *
 * This handler is tool-agnostic: it operates on ANY already-established selection
 * (LocalShape from rect/ellipse, or LocalPolygon from lasso/wand), providing:
 *
 *   - **Move**: drag inside existing selection → translate selection by (dx, dy)
 *   - **Peel (剥离)**: Meta+drag inside selection → fragment the image layer and
 *     move the fragment (delegating to `peelToExchange`)
 *
 * Architecture: wraps `createTransformHandler` to inherit its built-in capabilities:
 *   - `InteractionMath.snapAndSync()` → smart guide alignment
 *   - Canvas clamp
 *   - Physical pixel alignment
 *   - Proper transaction lifecycle
 *
 * For polygon selections, the TransformHandler operates on the polygon's bounding
 * rect. The actual polygon vertices are translated by the rect's position delta
 * in `onUpdate`.
 *
 * Priority: 130 (higher than clipbox=100, lasso/wand=110) so that clicking inside
 * an existing selection is intercepted here BEFORE the creation handlers can fire.
 * Clicks OUTSIDE the selection fall through to the tool's creation handler.
 */
export const createSelectionMoveHandler = (): InteractionHandler => {
  // ─── Closure state ─────────────────────────────────────────────────────────
  let activeTool: ClipTool = 'rect';
  let startPolygon: LocalPolygon | null = null;
  let initialRect: LocalRect = asLocalRect({ x: 0, y: 0, w: 0, h: 0 });
  let hasPeeled = false;
  let labelActivated = false; // UI-only: tracks whether clipMoveStart transient has been set

  return createTransformHandler({
    id: 'clip-selection-move',
    priority: 130,

    test: (e: InteractionEvent): TransformIntent | null => {
      // ─── Mode admission ───────────────────────────────────────────────
      const inClip = e.state.interaction.interactionMode === 'clip';
      const inReCanvas = !!e.state.getStateSignal(ClipOptionsAPI.signals.reCanvas);
      // Re-Canvas has its own move logic in clipbox handler (always rect).
      if (!inClip || inReCanvas) return null;

      // ─── Existing selection check ─────────────────────────────────────
      const box = getClipBox(e.activeFrame);
      if (!box) return null;

      const me = e.nativeEvent as MouseEvent;

      // Skip UI elements
      const target = me.target as HTMLElement;
      if (target.closest('button, a, input, [data-role="ui"], [contenteditable]')) return null;

      // ─── Hit-test: is click inside the existing selection? ─────────────
      const boxShape = e.geometry.polygon.polygonToShape(box);
      if (boxShape.type !== 'path') {
        // Regular (rect/ellipse): require clicking the move handle
        const handleElement = target.closest('[data-handle]') as HTMLElement;
        if (!handleElement) return null;
        const handle = handleElement.dataset.handle || '';
        if (handle !== 'move') return null;

        // ─── Edge exclusion: if pointer is near a selection edge, yield to
        // the clip-box handler's edge resize detection (priority 100).
        const clipShape = getRegularClipShape(e.activeFrame);
        const rect = clipShape?.rect;
        if (rect && rect.w > 0 && rect.h > 0) {
          const k = e.activeFrame.camera.k;
          const T = EDGE_HIT_THRESHOLD_PX / k;
          const px = e.point.canvas.x;
          const py = e.point.canvas.y;

          const latestTool = (e.activeFrame.latestClipTool as ClipTool) || 'rect';
          const isEllipse = latestTool === 'ellipse' || latestTool === 'pathellipse';

          if (isEllipse) {
            const cx = rect.x + rect.w / 2;
            const cy = rect.y + rect.h / 2;
            const rx = rect.w / 2;
            const ry = rect.h / 2;
            const nx = (px - cx) / rx;
            const ny = (py - cy) / ry;
            const r = Math.sqrt(nx * nx + ny * ny);
            const avgRadius = (rx + ry) / 2;
            if (Math.abs(r - 1) * avgRadius <= T) return null;
          } else {
            const dTop = Math.abs(py - rect.y);
            const dBottom = Math.abs(py - (rect.y + rect.h));
            const dLeft = Math.abs(px - rect.x);
            const dRight = Math.abs(px - (rect.x + rect.w));
            const inHRange = px >= rect.x - T && px <= rect.x + rect.w + T;
            const inVRange = py >= rect.y - T && py <= rect.y + rect.h + T;
            if ((dTop <= T && inHRange) || (dBottom <= T && inHRange) ||
                (dLeft <= T && inVRange) || (dRight <= T && inVRange)) return null;
          }
        }
      } else {
        // Irregular polygon: hit-test against polygon rings
        const inside = e.geometry.polygon.isPointInPolygon(e.point.canvas, box.rings);
        if (!inside) return null;
      }

      // ─── Determine operation type ────────────────────────────────────
      const activeLayer = e.activeFrame.activeLayerId
        ? e.activeFrame.layers.byId[e.activeFrame.activeLayerId]
        : undefined;
      const isExchangeActive = activeLayer?.role === 'exchange';

      if (me.metaKey || me.ctrlKey) {
        if (isExchangeActive) {
          return me.altKey ? { category: 'custom', sub: 'peel' } : { category: 'move' };
        } else {
          return { category: 'custom', sub: 'peel' };
        }
      }
      return { category: 'move' };
    },

    getInitialState: (e: InteractionEvent) => {
      const box = getClipBox(e.activeFrame);
      hasPeeled = false;
      labelActivated = false;
      activeTool = (e.activeFrame.latestClipTool as ClipTool) || 'rect';

      if (!box) {
        startPolygon = null;
        initialRect = asLocalRect({ x: 0, y: 0, w: 0, h: 0 });
        return initialRect;
      }

      // Always capture startPolygon for both regular and irregular selections.
      startPolygon = box;
      initialRect = { ...box.rect };

      // NOTE: clipMoveStart is deferred to onUpdate (≥1px threshold) to avoid
      // flashing the delta label on micro-movements / static clicks.

      return initialRect;
    },

    getConstraints: () => ({
      clamp: true,  // Strict canvas bounds clamping for all selection moves
    }),

    onUpdate: (e: InteractionEvent, newRect: LocalRect, tx, context) => {
      const frame = e.activeFrame;

      // ─── Delta label: show only after ≥1px real displacement ──────────
      if (!labelActivated) {
        const dx = Math.abs(newRect.x - initialRect.x);
        const dy = Math.abs(newRect.y - initialRect.y);
        if (dx >= 1 || dy >= 1) {
          labelActivated = true;
          e.actions.fast.setTransient('clipMoveStart', { x: initialRect.x, y: initialRect.y });
        }
      }

      // ─── Peel mode: trigger peel on threshold ─────────────────────────
      if (context.intent.sub === 'peel' && ((e.nativeEvent as MouseEvent).metaKey || (e.nativeEvent as MouseEvent).ctrlKey)) {
        if (!hasPeeled) {
          if (Math.sqrt(context.dx * context.dx + context.dy * context.dy) >= 1) {
            hasPeeled = true;
            setTimeout(() => e.actions.adv.layer.peel.peelToExchange.execute({
              isCopy: (e.nativeEvent as MouseEvent).altKey
            }), 0);
          }
          return; // Don't move until peel is triggered
        }
      }

      // ─── Move: update selection position ──────────────────────────────
      if (startPolygon) {
        const polyDx = newRect.x - initialRect.x;
        const polyDy = newRect.y - initialRect.y;
        const newPoly = e.geometry.polygon.translatePolygon(startPolygon, polyDx, polyDy);
        tx.update({
          clipBoxes: {
            ...frame.clipBoxes,
            [activeTool]: newPoly
          }
        }, 'frame');
      }

      // ─── Sync exchange layer position ─────────────────────────────────
      if (frame.activeLayerId) {
        const activeLayer = frame.layers.byId[frame.activeLayerId];
        const exchangeLayer = (activeLayer?.role === 'exchange')
          ? activeLayer
          : frame.layers.order
              .map(id => frame.layers.byId[id])
              .find(l => l.role === 'exchange' && l.hostId === frame.activeLayerId);

        if (exchangeLayer) {
          const worldCenter = e.geometry.space.localToWorld(
            newRect.x + newRect.w / 2,
            newRect.y + newRect.h / 2,
            frame
          );
          const vr = exchangeLayer.visibleShape?.rect;
          const vox = vr?.x ?? 0;
          const voy = vr?.y ?? 0;
          const pose = e.geometry.transform.computeFragmentCenter(
            worldCenter,
            { x: vox, y: voy },
            exchangeLayer.rotation,
            exchangeLayer.flip
          );
          tx.update({ cx: pose.x, cy: pose.y }, 'layer', exchangeLayer.id);
        }
      }
    },

    // ── Gesture rules (pre-end interceptors) ──
    gestures: [{
      name: 'static-click-clear',
      match: (ctx) => !ctx.hasMoved
                   && ctx.intent.category === 'move'
                   && !ctx.endModifiers.meta
                   && !ctx.endModifiers.ctrl,
      action: (e) => {
        // Static click inside selection → clear selection (Photoshop behavior)
        e.actions.executeCommand(ClipOptionsAPI.commands.resetBox.uid);
      },
    }],

    // onEnd ALWAYS executes (framework guarantee). Used for resource cleanup only.
    onEnd: (e) => {
      e.actions.fast.setTransient('clipMoveStart', null);
      hasPeeled = false;
    },
  });
};
