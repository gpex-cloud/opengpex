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
 * marker/squareize.ts — one-shot "regularize the marker's bounding box"
 * geometry for the quick-reset affordances (double-click a corner handle,
 * panel Regular button). Pure math only — no React, no store access; the
 * callers (interaction handler / panel command) own the transaction and the
 * world-space centre write-back.
 *
 * REGULARIZE semantics, not "square": the target box ratio is the shape's
 * canonical regular-form aspect (per `naturalRatio` below). For box-derived
 * shapes that ratio is 1:1 (square rect, circle, square segment/callout box),
 * which is exactly the old square behaviour; for radial shapes (polygon /
 * star) it is the regular n-gon's natural silhouette aspect — squaring the
 * box would squash a triangle AWAY from equilateral, not towards it.
 *
 * The fit is a TIGHTENING gesture: the uniform scale s = min(w/rw, h/rh)
 * keeps the target box fully inside the old one — it never grows the marker
 * over its neighbours. Layer-local geometry that is not implied by the
 * bounding (segment endpoints, callout body + tip) rescales with the box
 * exactly like the resize gesture does, and the segment family then runs the
 * same ink-growth containment pass so fixed-size heads and round caps can
 * never poke outside the new (smaller) box.
 */

import type { MarkerData } from './types';
import {
  isSegmentData,
  segmentLayoutOf,
  segmentContainment,
  shiftSegmentEndpoints,
} from './shapes/line-segment/geometry';
import { radialNaturalRatio } from './shapes/polygon-family/geometry';
import { rescaleLocalGeometry } from './shapes/shared';

/** Minimum bounding side — the marker must never collapse below the resize floor. */
export const SQUAREIZE_MIN_SIDE_PX = 8;

/** Which corner handle was double-clicked (the OPPOSITE corner becomes the anchor). */
export type CornerHandle = 'nw' | 'ne' | 'sw' | 'se';

export type SquareizeAnchor =
  | { kind: 'center' }
  | { kind: 'corner'; handle: CornerHandle };

export interface SquareizeResult {
  /** Rescaled marker payload (endpoints / body / tip track the box). */
  markerData: MarkerData;
  /**
   * New bounding-centre offset from the OLD centre, in LAYER-LOCAL axes.
   * Callers rotate this through the gesture-start world matrix's rotation
   * columns to get the world centre delta (zero for the centre anchor and
   * for unrotated marker boxes when the containment pass is a no-op).
   */
  centerDelta: { x: number; y: number };
  /**
   * Final bounding after the segment containment pass (equals the target box
   * for every family except the segments, where fixed-size ink may force a
   * minimal expansion — same contract as the resize gesture).
   */
  bounding: { w: number; h: number };
}

/**
 * The canonical regular-form bounding ratio for a marker datum.
 *
 * Radial shapes (polygon / star): the regular n-gon's natural silhouette
 * aspect, from the same unit-circle vertex angular set the renderer maps —
 * one closed form covers both fill regimes and odd/even side counts alike.
 * Every other kind: 1:1 (square rect, circle; segments and callout carry no
 * "regular" notion beyond the square box, matching the previous behaviour).
 */
function naturalRatio(data: MarkerData): { w: number; h: number } {
  if (data.kind === 'polygon') return radialNaturalRatio(data.sides);
  if (data.kind === 'star') return radialNaturalRatio(data.points);
  return { w: 1, h: 1 };
}

/**
 * Compute the regularized marker geometry.
 *
 * Local-axes model (same as the orientation-aware resize): the bounding rect
 * is (0,0,w,h) in layer-local axes. The target box (natural ratio at scale s)
 * keeps the requested anchor fixed — the centre for the panel entry, or the
 * corner OPPOSITE the double-clicked handle for the handle entry — under the
 * tightening fit s = min(w/rw, h/rh) (floor: the longer target side never
 * drops below the resize floor).
 *
 * Returns null when the bounding is degenerate (nothing to regularize).
 */
export function squareizeMarker(
  data: MarkerData,
  bounding: { w: number; h: number },
  anchor: SquareizeAnchor,
): SquareizeResult | null {
  if (!(bounding.w > 0 && bounding.h > 0)) return null;

  const ratio = naturalRatio(data);
  if (!(ratio.w > 0 && ratio.h > 0)) return null;

  let s = Math.min(bounding.w / ratio.w, bounding.h / ratio.h);
  s = Math.max(s, SQUAREIZE_MIN_SIDE_PX / Math.max(ratio.w, ratio.h));
  const newW = ratio.w * s;
  const newH = ratio.h * s;
  const sx = newW / bounding.w;
  const sy = newH / bounding.h;

  // Anchor-aligned placement of the target box inside the old local rect.
  // Centre anchor: the box is centred in the old rect, so its centre (the
  // layer's cx/cy anchor) stays put. Corner anchor: keep the OPPOSITE corner's
  // edges fixed and grow the box back towards the dragged side.
  let x = 0;
  let y = 0;
  if (anchor.kind === 'center') {
    x = (bounding.w - newW) / 2;
    y = (bounding.h - newH) / 2;
  } else {
    if (anchor.handle.includes('w')) x = bounding.w - newW; // anchor on the right edge
    if (anchor.handle.includes('n')) y = bounding.h - newH; // anchor on the bottom edge
  }
  const centerDelta = {
    x: x + newW / 2 - bounding.w / 2,
    y: y + newH / 2 - bounding.h / 2,
  };

  let nextData = rescaleLocalGeometry(data, sx, sy);
  let finalW = newW;
  let finalH = newH;

  // Segment family containment: heads and round caps paint at FIXED pixel
  // sizes, so a shrunken box can leave ink outside the bounding. Expand the
  // committed box minimally to contain the paint (identical to the resize
  // gesture's containment tail); the centre follows the containment delta.
  if (isSegmentData(nextData)) {
    const seg = segmentLayoutOf(nextData);
    if (seg) {
      const sw = Math.max(0, nextData.stroke.width);
      const layout = segmentContainment(
        seg.a, seg.b,
        sw / 2, seg.headLen, seg.headA, seg.headB,
        finalW, finalH,
      );
      nextData = shiftSegmentEndpoints(nextData, layout.shiftX, layout.shiftY);
      finalW = layout.bounding.w;
      finalH = layout.bounding.h;
      centerDelta.x += layout.centerDeltaX;
      centerDelta.y += layout.centerDeltaY;
    }
  }

  return { markerData: nextData, centerDelta, bounding: { w: finalW, h: finalH } };
}
