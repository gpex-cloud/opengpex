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

/**
 * SelectionTransformHandler (priority 120) — scale and rotate an IRREGULAR
 * selection (lasso / wand / boolean-result polygon) through the shared
 * TransformGizmo handles (the same knobs marker/text overlays use):
 *
 *   - Corner drags (nw/ne/sw/se): the dragged bbox corner follows the
 *     pointer, the opposite corner is the fixed anchor; every ring vertex
 *     scales relative to that anchor. Crossing the anchor mirrors the
 *     geometry; dimensions are clamped to ≥1px so the polygon never collapses.
 *   - Edge drags (n/s/e/w): single-axis scale, the other axis keeps s=1
 *     (anchor = the opposite edge midpoint).
 *   - Rotation handle (data-gizmo-rotate): spins the vertex set around the
 *     bbox center by the pointer angle delta. Shift snaps to 15°
 *     (pen-rotate precedent).
 *
 * Regular selections keep their own resize path (the rect handler's
 * TransformHandler resize, which regenerates the polygon from the rect).
 *
 * Frame-rate discipline: wand selections can carry thousands of ring points,
 * and every store write re-derives the marching-ants path from them. The
 * transform therefore coalesces pointermove updates into one store write per
 * animation frame (rAF), flushing any pending write synchronously before the
 * transaction commits so the final frame is never lost.
 *
 * The transform rides the frame channel only (tx.update confinement) — same
 * transactional, single-undo-step lifecycle as the move handler. Frozen
 * stroke snapshots are intentionally untouched: editing a selection never
 * rewrites constraints already committed to layer pixels.
 */

import type { InteractionHandler, LocalPolygon } from '@opengpex/editor/core/types';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';
import { InteractionTransaction } from '@opengpex/editor/stage/interaction/Transaction';
import { ROTATE_CURSOR } from '@opengpex/editor/icons';
import { ClipOptionsAPI } from '../../../options/ClipOptions/protocols';

type ScaleMode = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w';
type TransformMode = ScaleMode | 'rotate';

/** Minimum bbox dimension in canvas px after scaling (prevents collapse). */
const MIN_DIMENSION_PX = 1;

export const createSelectionTransformHandler = (): InteractionHandler => {
  let mode: TransformMode | null = null;
  let startPoly: LocalPolygon | null = null;
  let tx: InteractionTransaction | null = null;
  // Anchor (scale) / center (rotate) in canvas-local coordinates.
  let anchorX = 0;
  let anchorY = 0;
  // Bbox dims at gesture start — denominators for the scale factors.
  let startW = 0;
  let startH = 0;
  // Pointer angle at gesture start (rotate mode).
  let startAngleRad = 0;
  // The selection's absolute orientation at gesture start (rotate mode),
  // derived from the first edge of the outer ring. Shift snapping works on
  // the ABSOLUTE angle (base + delta) so 0° — the un-rotated pose — always
  // sits on the 15° grid and any rotated selection can be brought back
  // upright. rotatePolygon preserves vertex order, so the first edge is a
  // stable orientation probe for tool-drawn polygons.
  let baseOrientationRad = 0;
  // rAF coalescing: the latest transformed polygon waits here while a frame
  // is already scheduled; at most one store write per display frame.
  let pendingPoly: LocalPolygon | null = null;
  let rafId: number | null = null;

  const flushPending = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (pendingPoly && tx?.isActive) {
      tx.update({ confinement: pendingPoly }, 'frame');
    }
    pendingPoly = null;
  };

  const scheduleWrite = (poly: LocalPolygon) => {
    pendingPoly = poly;
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      flushPending();
    });
  };

  return {
    id: 'clip-selection-transform',
    priority: 120,
    // The handles are specific DOM targets — claiming Shift/Alt here only
    // means "transform handles keep working while a modifier is held"
    // (Shift rotate-snap reads the key mid-gesture; the press-time channel
    // would otherwise filter this handler out entirely).
    springOverride: ['shift', 'alt'],

    test: (e) => {
      // Selection editing mode only (same admission as the move handler).
      const inClip = e.state.interaction.interactionMode === 'clip';
      const inReCanvas = !!e.state.getStateSignal(ClipOptionsAPI.signals.reCanvas);
      if (!inClip || inReCanvas) return false;

      const box = getClipBox(e.activeFrame);
      if (!box) return false;

      // ONE transform logic for EVERY selection shape: scale handles and the
      // rotation dot claim rect-shaped selections too (a 4-point ring scales
      // identically through the ring-affine math; after a rotation it simply
      // becomes a path polygon). The old regenerate-from-rect resize path in
      // the rect handler is retired.
      const target = e.nativeEvent.target as HTMLElement;
      const gizmoEl = target.closest('[data-gizmo-handle], [data-gizmo-rotate]') as HTMLElement | null;
      if (!gizmoEl) return false;

      if (gizmoEl.dataset.gizmoRotate) {
        mode = 'rotate';
      } else {
        const handle = gizmoEl.dataset.gizmoHandle || '';
        if (!['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'].includes(handle)) return false;
        mode = handle as ScaleMode;
      }
      return true;
    },

    onStart: (e) => {
      const box = getClipBox(e.activeFrame);
      if (!box || !mode) return;
      startPoly = box;
      tx = new InteractionTransaction(e);
      tx.begin(false);

      const rect = box.rect;
      startW = Math.max(rect.w, MIN_DIMENSION_PX);
      startH = Math.max(rect.h, MIN_DIMENSION_PX);

      if (mode === 'rotate') {
        anchorX = rect.x + rect.w / 2;
        anchorY = rect.y + rect.h / 2;
        startAngleRad = Math.atan2(e.point.canvas.y - anchorY, e.point.canvas.x - anchorX);
        const ring = box.rings[0];
        if (ring && ring.length >= 2) {
          baseOrientationRad = Math.atan2(ring[1].y - ring[0].y, ring[1].x - ring[0].x);
        } else {
          baseOrientationRad = 0;
        }
        e.actions.fast.cursor.notifyDragging(ROTATE_CURSOR);
      }
    },

    onMove: (e) => {
      if (!startPoly || !tx || !mode) return;
      const p = e.point.canvas;
      const rect = startPoly.rect;

      let newPoly: LocalPolygon;
      if (mode === 'rotate') {
        const angle = Math.atan2(p.y - anchorY, p.x - anchorX) - startAngleRad;
        let deltaRad = angle;
        if ((e.nativeEvent as MouseEvent).shiftKey) {
          // Shift snaps the ABSOLUTE orientation (base + delta) to 15° steps
          // (PS Transform Selection): the un-rotated pose stays on the grid,
          // so a rotated selection can always be brought back to it. Snapping
          // the raw gesture delta instead would strand off-grid accumulated
          // angles (e.g. 17° could never return to 0°).
          const step = (15 * Math.PI) / 180;
          const absolute = baseOrientationRad + angle;
          deltaRad = Math.round(absolute / step) * step - baseOrientationRad;
        }
        newPoly = e.geometry.polygon.rotatePolygon(startPoly, { x: anchorX, y: anchorY }, deltaRad);
      } else {
        // Corner drag: both axes scale, anchor = opposite corner.
        // Edge drag: single axis scales, anchor = the OPPOSITE EDGE itself
        // (fixed line) so only the grabbed side moves; the cross axis keeps
        // s=1 so its anchor coordinate is irrelevant.
        const isCorner = mode.length === 2;
        const anchorRight = mode.includes('w');
        const anchorBottom = mode.includes('n');
        const ax = isCorner
          ? (anchorRight ? rect.x + rect.w : rect.x)
          : (mode === 'e' ? rect.x : mode === 'w' ? rect.x + rect.w : rect.x + rect.w / 2);
        const ay = isCorner
          ? (anchorBottom ? rect.y + rect.h : rect.y)
          : (mode === 'n' ? rect.y + rect.h : mode === 's' ? rect.y : rect.y + rect.h / 2);
        const cornerX = anchorRight ? rect.x : rect.x + rect.w;
        const cornerY = anchorBottom ? rect.y : rect.y + rect.h;
        const addressesX = isCorner || mode === 'e' || mode === 'w';
        const addressesY = isCorner || mode === 'n' || mode === 's';

        const minSx = MIN_DIMENSION_PX / startW;
        const minSy = MIN_DIMENSION_PX / startH;
        let sx = addressesX ? (p.x - ax) / (cornerX - ax || 1) : 1;
        let sy = addressesY ? (p.y - ay) / (cornerY - ay || 1) : 1;
        if (addressesX && Math.abs(sx) < minSx) sx = Math.sign(sx) * minSx;
        if (addressesY && Math.abs(sy) < minSy) sy = Math.sign(sy) * minSy;
        // Shift = proportional scale (PS Transform Selection): one uniform
        // factor from the mean of both axes, per-axis sign preserved so a
        // mirrored drag stays mirrored. No conflict with Shift's boolean
        // meaning — that lives on the CREATE gesture, this on gizmo handles.
        if (isCorner && (e.nativeEvent as MouseEvent).shiftKey) {
          const uniform = (Math.abs(sx) + Math.abs(sy)) / 2;
          sx = Math.sign(sx) * uniform;
          sy = Math.sign(sy) * uniform;
        }
        newPoly = e.geometry.polygon.scalePolygon(startPoly, { x: ax, y: ay }, sx, sy);
      }

      scheduleWrite(newPoly);
    },

    onEnd: (e) => {
      // Flush any rAF-coalesced write before committing so the committed
      // state includes the final pointer position.
      flushPending();
      if (tx) {
        tx.commit();
        tx = null;
      }
      mode = null;
      startPoly = null;
      e.actions.fast.cursor.notifyDragging(null);
      e.actions.fast.cursor.notifyHover(null);
    },

    onCancel: (e) => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      pendingPoly = null;
      if (tx) {
        tx.abort();
        tx = null;
      }
      mode = null;
      startPoly = null;
      e.actions.fast.cursor.notifyDragging(null);
    },
  };
};
