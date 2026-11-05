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
import { readPeelSession } from '../../peel/session';
import { InteractionTransaction } from '@opengpex/editor/stage/interaction/Transaction';
import { ROTATE_CURSOR } from '@opengpex/editor/icons';
import { ClipOptionsAPI } from '../../../../options/ClipOptions/protocols';

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
  // Rotated-box dims at gesture start — denominators for the scale factors.
  let startW = 0;
  let startH = 0;
  // ─── Local-frame scale state (rotated selections) ────────────────────────
  // The selection's orientation at gesture start (radians) and its rotated
  // content-box centre. All scale math runs in this LOCAL frame: the box's
  // own axes, so a rotated rectangle stays a rectangle under non-uniform
  // scale (world-axis factors would shear it into a parallelogram). For an
  // upright selection the local frame IS the world frame and every value
  // below degenerates to the historical axis-aligned math, bitwise.
  let startThetaRad = 0;
  let startBoxCx = 0;
  let startBoxCy = 0;
  // Pointer angle at gesture start (rotate mode).
  let startAngleRad = 0;
  // The selection's absolute orientation at gesture start (rotate mode),
  // The selection's orientation record at gesture start (degrees): the
  // anchor the Shift snap grid accumulates onto. No vertex probing — the
  // record lives on the polygon (orientationDeg) and rotatePolygon
  // accumulates it.
  let startOrientationDeg = 0;
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

      // Session yield (finding 13): while a peel session is undecided, ALL
      // selection-gizmo transforms belong to the session drive (priority 125
      // above this handler); a plain selection edit must never race it.
      if (readPeelSession(e.activeFrame)?.status === 'peeled') return false;

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

      if (mode === 'rotate') {
        const rect = box.rect;
        anchorX = rect.x + rect.w / 2;
        anchorY = rect.y + rect.h / 2;
        startAngleRad = Math.atan2(e.point.canvas.y - anchorY, e.point.canvas.x - anchorX);
        startOrientationDeg = box.orientationDeg ?? 0;
        // Finding 14: the selection displays its own accumulated rotation
        // (the chip reads the live orientationDeg record; see the HUD delta chip).
        tx.declareFeedback({ kind: 'rotate', target: 'frame', origin: { x: anchorX, y: anchorY } });
        e.actions.fast.cursor.notifyDragging(ROTATE_CURSOR);
        return;
      }

      // Scale gesture: measure the content box along the selection's OWN
      // orientation through THE shared gizmo basis (plain + session solve
      // the same way). For an upright selection this degenerates to the
      // axis-aligned rect.
      startThetaRad = ((box.orientationDeg ?? 0) * Math.PI) / 180;
      const basis = e.geometry.polygon.measureGizmoResizeAnchor(box, startThetaRad, mode);
      startBoxCx = basis.cx;
      startBoxCy = basis.cy;
      startW = Math.max(basis.w, MIN_DIMENSION_PX);
      startH = Math.max(basis.h, MIN_DIMENSION_PX);
      anchorX = basis.anchorX;
      anchorY = basis.anchorY;
    },

    onMove: (e) => {
      if (!startPoly || !tx || !mode) return;
      const p = e.point.canvas;

      let newPoly: LocalPolygon;
      if (mode === 'rotate') {
        const angle = Math.atan2(p.y - anchorY, p.x - anchorX) - startAngleRad;
        let deltaRad = angle;
        if ((e.nativeEvent as MouseEvent).shiftKey) {
          // Shift snaps the ACCUMULATED orientation to 15° steps (PS
          // Transform Selection): the grid anchors on the record from
          // gesture start, so a rotated selection can always be brought
          // back to upright (or any 15° multiple) exactly.
          deltaRad = e.geometry.transform.snapRotationRad(angle, (startOrientationDeg * Math.PI) / 180);
        }
        newPoly = e.geometry.polygon.rotatePolygon(startPoly, { x: anchorX, y: anchorY }, deltaRad);
      } else {
        // Corner drag: both axes scale, anchor = opposite corner of the
        // ROTATED box. Edge drag: single axis scales, anchor = the opposite
        // edge LINE (fixed line) so only the grabbed side moves. Factors
        // come from THE shared local-frame solve (the selection-driven peel
        // session consumes the same one — the two gestures can never
        // disagree); at θ=0 the local frame coincides with the world frame
        // and the math reduces to the historical axis-aligned behavior
        // bitwise. Shift = proportional scale (PS Transform Selection).
        const cos = Math.cos(startThetaRad);
        const sin = Math.sin(startThetaRad);
        const pdx = p.x - startBoxCx;
        const pdy = p.y - startBoxCy;
        const { sx, sy } = e.geometry.polygon.solveGizmoResizeScale(
          mode,
          pdx * cos + pdy * sin,
          -pdx * sin + pdy * cos,
          startW,
          startH,
          { uniform: (e.nativeEvent as MouseEvent).shiftKey, minW: MIN_DIMENSION_PX, minH: MIN_DIMENSION_PX },
        );
        // Apply the factors in the local frame through the pure geometry
        // primitive: the composite is anchor + R(θ)·S·R(-θ)·(p − anchor) —
        // a rotated rectangle stays a rectangle. The two rotations cancel
        // in orientationDeg, so the record is unchanged.
        newPoly = e.geometry.polygon.scalePolygon(
          startPoly,
          { x: anchorX, y: anchorY },
          sx,
          sy,
          startThetaRad,
        );
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
