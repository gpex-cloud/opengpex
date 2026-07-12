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
  LocalShape,
  asLocalRect,
} from '@opengpex/editor/core/types';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';
import { InteractionMath } from '@opengpex/editor/stage/interaction/Math';
import { createTransformHandler } from '@opengpex/editor/stage/interaction/handlers/TransformHandler';
import {
  ClipOptionsAPI,
  ClipTool,
} from '../../../options/ClipOptions/protocols';

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
  let isRegular = false;
  let activeTool: ClipTool = 'rect';
  let startPolygon: LocalPolygon | null = null;
  let initialRect: LocalRect = asLocalRect({ x: 0, y: 0, w: 0, h: 0 });
  let hasPeeled = false;

  return createTransformHandler({
    id: 'clip-selection-move',
    priority: 130,

    test: (e: InteractionEvent) => {
      // ─── Mode admission ───────────────────────────────────────────────
      const inClip = e.state.interaction.interactionMode === 'clip';
      const inReCanvas = !!e.state.getStateSignal(ClipOptionsAPI.signals.reCanvas);
      // Re-Canvas has its own move logic in clipbox handler (always rect).
      if (!inClip || inReCanvas) return null;

      // ─── Existing selection check ─────────────────────────────────────
      const box = getClipBox(e.activeFrame);
      if (!box) return null;

      const me = e.nativeEvent as MouseEvent;
      if (me.button === 2) return null;

      // Skip UI elements
      const target = me.target as HTMLElement;
      if (target.closest('button, a, input, [data-role="ui"], [contenteditable]')) return null;

      // ─── Hit-test: is click inside the existing selection? ─────────────
      if (box.regular) {
        const handleElement = target.closest('[data-handle]') as HTMLElement;
        if (!handleElement) return null;
        const handle = handleElement.dataset.handle || '';
        if (handle !== 'move') return null;
      } else {
        const poly = box.spatial as LocalPolygon;
        const inside = e.geometry.polygon.isPointInPolygon(e.point.canvas, poly.rings);
        if (!inside) return null;
      }

      // ─── Determine operation type ────────────────────────────────────
      const activeLayer = e.activeFrame.activeLayerId
        ? e.activeFrame.layers.byId[e.activeFrame.activeLayerId]
        : undefined;
      const isExchangeActive = activeLayer?.role === 'exchange';

      if (me.metaKey) {
        if (isExchangeActive) {
          return me.altKey ? 'peel' : 'move';
        } else {
          return 'peel';
        }
      }
      return 'move';
    },

    getInitialState: (e: InteractionEvent) => {
      const box = getClipBox(e.activeFrame);
      hasPeeled = false;
      activeTool = (e.activeFrame.latestClipTool as ClipTool) || 'rect';

      if (!box) {
        isRegular = true;
        startPolygon = null;
        initialRect = asLocalRect({ x: 0, y: 0, w: 0, h: 0 });
        return initialRect;
      }

      isRegular = box.regular;

      if (box.regular) {
        startPolygon = null;
        initialRect = { ...box.spatial.rect };
      } else {
        startPolygon = box.spatial as LocalPolygon;
        initialRect = { ...startPolygon.rect };
      }

      // Store drag start position for the move-delta label
      e.actions.fast.setTransient('clipMoveStart', { x: initialRect.x, y: initialRect.y });

      return initialRect;
    },

    getConstraints: () => ({
      clamp: true,  // Strict canvas bounds clamping for all selection moves
    }),

    onUpdate: (e: InteractionEvent, newRect: LocalRect, tx, { dx, dy, type }) => {
      const frame = e.activeFrame;

      // ─── Peel mode: trigger peel on threshold ─────────────────────────
      if (type === 'peel' && (e.nativeEvent as MouseEvent).metaKey) {
        if (!hasPeeled) {
          if (Math.sqrt(dx * dx + dy * dy) > 5) {
            hasPeeled = true;
            setTimeout(() => e.actions.adv.layer.peel.peelToExchange.execute({
              isCopy: (e.nativeEvent as MouseEvent).altKey
            }), 0);
          }
          return; // Don't move until peel is triggered
        }
      }

      // ─── Move: update selection position ──────────────────────────────
      // `newRect` is already snapped + clamped by TransformHandler's internal
      // call to InteractionMath.snapAndSync(). Smart guides are written to
      // transient automatically.

      if (isRegular) {
        const currentShape = frame.clipBoxes[activeTool] as LocalShape;
        tx.update({
          clipBoxes: {
            ...frame.clipBoxes,
            [activeTool]: { ...currentShape, rect: newRect }
          }
        }, 'frame');
      } else if (startPolygon) {
        // Polygon: compute position delta from initial bounding rect
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

    onEnd: (e: InteractionEvent, tx, startCanvas) => {
      // Static click (no drag) = clear selection (Photoshop behavior)
      if (InteractionMath.isStaticClick(e, startCanvas)) {
        // Don't clear on Meta-click (that's an aborted peel attempt)
        const me = e.nativeEvent as MouseEvent;
        if (!me.metaKey) {
          e.actions.executeCommand(ClipOptionsAPI.commands.resetBox.uid);
        }
      }

      // Clear move-delta transient (hides the delta label)
      e.actions.fast.setTransient('clipMoveStart', null);

      tx.commit();
      hasPeeled = false;
    }
  });
};
