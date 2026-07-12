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
import { InteractionTransaction } from '@opengpex/editor/stage/interaction/Transaction';
import {
  ClipOptionsAPI,
  CropTool,
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
 * Architecture benefit: move/peel logic is written ONCE. New tool types only need
 * a creation handler; move and peel are automatically inherited.
 *
 * Priority: 130 (higher than clipbox=100, lasso/wand=110) so that clicking inside
 * an existing selection is intercepted here BEFORE the creation handlers can fire.
 * Clicks OUTSIDE the selection fall through to the tool's creation handler.
 */
export const createSelectionMoveHandler = (): InteractionHandler => {
  let type = '';
  let startCanvas = { x: 0, y: 0 };
  let startRect: LocalRect | null = null;
  let startPolygon: LocalPolygon | null = null;
  let isRegular = false;
  let activeTool: CropTool = 'rect';
  let tx: InteractionTransaction | null = null;
  let hasPeeled = false;

  return {
    id: 'clip-selection-move',
    priority: 130,

    test: (e: InteractionEvent) => {
      // ─── Mode admission ───────────────────────────────────────────────
      const inClip = e.state.interaction.interactionMode === 'clip';
      const inReCanvas = !!e.state.getStateSignal(ClipOptionsAPI.signals.reCanvas);
      // Re-Canvas has its own move logic in clipbox handler (always rect).
      // This unified handler only serves clip-mode selections.
      if (!inClip || inReCanvas) return false;

      // ─── Existing selection check ─────────────────────────────────────
      const box = getClipBox(e.activeFrame);
      if (!box) return false;

      const me = e.nativeEvent as MouseEvent;
      if (me.button === 2) return false;

      // Skip UI elements
      const target = me.target as HTMLElement;
      if (target.closest('button, a, input, [data-role="ui"], [contenteditable]')) return false;

      // ─── Hit-test: is click inside the existing selection? ─────────────
      if (box.regular) {
        // For regular shapes: accept clicks on the [data-handle="move"] element
        // (the CSS crop-box div). This maintains backward compatibility with the
        // existing DOM-based hit area.
        const handleElement = target.closest('[data-handle]') as HTMLElement;
        if (!handleElement) return false;
        const handle = handleElement.dataset.handle || '';
        if (handle !== 'move') return false;
      } else {
        // For polygons: use geometric point-in-polygon test (no DOM element exists)
        const poly = box.spatial as LocalPolygon;
        const inside = e.geometry.polygon.isPointInPolygon(e.point.canvas, poly.rings);
        if (!inside) return false;
      }

      // ─── Determine operation type ────────────────────────────────────
      if (me.metaKey) {
        type = 'peel';
      } else {
        type = 'move';
      }
      return true;
    },

    onStart: (e: InteractionEvent) => {
      startCanvas = { x: e.point.canvas.x, y: e.point.canvas.y };
      hasPeeled = false;

      const box = getClipBox(e.activeFrame);
      if (!box) return;

      isRegular = box.regular;
      activeTool = (e.activeFrame.latestClipTool as CropTool) || 'rect';

      if (box.regular) {
        startRect = { ...box.spatial.rect };
        startPolygon = null;
      } else {
        startPolygon = box.spatial as LocalPolygon;
        startRect = { ...startPolygon.rect };
      }

      tx = new InteractionTransaction(e);
      tx.begin();
    },

    onMove: (e: InteractionEvent) => {
      if (!tx) return;
      const { dx, dy } = InteractionMath.getCanvasDelta(e, startCanvas);
      const frame = e.activeFrame;

      // ─── Peel mode: trigger peel on threshold, then translate exchange ─
      if (type === 'peel' && (e.nativeEvent as MouseEvent).metaKey) {
        if (!hasPeeled) {
          if (Math.sqrt(dx * dx + dy * dy) > 5) {
            hasPeeled = true;
            setTimeout(() => e.actions.adv.layer.peel.peelToExchange.execute({
              isCopy: (e.nativeEvent as MouseEvent).altKey
            }), 0);
          }
          return;
        }
      }

      // ─── Move: translate selection ────────────────────────────────────
      if (isRegular && startRect) {
        // Translate the rect
        const newRect = asLocalRect({
          x: Math.round(startRect.x + dx),
          y: Math.round(startRect.y + dy),
          w: startRect.w,
          h: startRect.h,
        });

        // Get the current shape to preserve type/antiAliased
        const currentShape = frame.clipBoxes[activeTool] as LocalShape;
        tx.update({
          clipBoxes: {
            ...frame.clipBoxes,
            [activeTool]: { ...currentShape, rect: newRect }
          }
        }, 'frame');
      } else if (!isRegular && startPolygon) {
        // Translate the polygon
        const newPoly = e.geometry.polygon.translatePolygon(startPolygon, dx, dy);
        tx.update({
          clipBoxes: {
            ...frame.clipBoxes,
            [activeTool]: newPoly
          }
        }, 'frame');
      }

      // ─── Sync exchange layer position (shared logic) ──────────────────
      if (frame.activeLayerId) {
        const activeLayer = frame.layers.byId[frame.activeLayerId];
        const exchangeLayer = (activeLayer?.role === 'exchange')
          ? activeLayer
          : frame.layers.order
              .map(id => frame.layers.byId[id])
              .find(l => l.role === 'exchange' && l.hostId === frame.activeLayerId);

        if (exchangeLayer) {
          // Compute new selection center in world coordinates
          const rect = isRegular && startRect
            ? asLocalRect({ x: Math.round(startRect.x + dx), y: Math.round(startRect.y + dy), w: startRect.w, h: startRect.h })
            : (startPolygon ? asLocalRect({ x: startPolygon.rect.x + dx, y: startPolygon.rect.y + dy, w: startPolygon.rect.w, h: startPolygon.rect.h }) : null);

          if (rect) {
            const worldCenter = e.geometry.space.localToWorld(
              rect.x + rect.w / 2,
              rect.y + rect.h / 2,
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
      }
    },

    onEnd: (e: InteractionEvent) => {
      if (!tx) return;

      // Static click (no drag) = clear selection (Photoshop behavior)
      if (InteractionMath.isStaticClick(e, startCanvas)) {
        // Don't clear on Meta-click (that's an aborted peel attempt)
        if (type !== 'peel') {
          e.actions.executeCommand(ClipOptionsAPI.commands.resetBox.uid);
        }
      }

      tx.commit();
      tx = null;
      type = '';
      startRect = null;
      startPolygon = null;
      hasPeeled = false;
    },
  };
};
