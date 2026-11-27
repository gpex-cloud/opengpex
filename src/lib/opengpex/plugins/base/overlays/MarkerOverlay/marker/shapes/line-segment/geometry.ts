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
 * line-segment/geometry.ts — the straight-line marker family's (arrow / line /
 * darrow) ENTIRE render-side geometry: the single-source head triangles, the
 * tight painted bounding, the ink-growth containment, the SVG drag preview and
 * the engine SDF translation. This module is what makes the three kinds ONE
 * shape with different head flags — nothing segment-specific may live in the
 * cross-family `shapes/shared.ts`. Pure — no React (checked by
 * render-purity.test.ts).
 */

import type { MarkerData, SegmentMarkerData, SdfGeometry } from '../../types';

/** 2D point (canvas-local or layer-local px, used interchangeably by value). */
interface Pt {
  x: number;
  y: number;
}

/**
 * AA headroom added on EVERY side of the segment family's tight bounding. The
 * fragment shader's `fwidth` coverage needs half a pixel of headroom at the
 * ink boundary, plus a quantization safety margin — the mirror image of the
 * outline family (rect / ellipse) needing NO padding because its stroke grows
 * INWARD. Without it the tight box would clip the AA fringe at the transient
 * texture edge.
 */
export const SEGMENT_AA_MARGIN_PX = 1;

/** 45° angle snap step (radians) applied when Shift is held. */
const SNAP_STEP = Math.PI / 4;

/** Snap the end point's direction (from start) to the nearest 45°, preserving length. */
export function snapDirection45(startX: number, startY: number, endX: number, endY: number): { x: number; y: number } {
  const dx = endX - startX;
  const dy = endY - startY;
  const len = Math.hypot(dx, dy);
  const snapped = Math.round(Math.atan2(dy, dx) / SNAP_STEP) * SNAP_STEP;
  return { x: startX + Math.cos(snapped) * len, y: startY + Math.sin(snapped) * len };
}

// ─── Segment family: SINGLE-SOURCE head geometry ──────────────────────────────

/** The three vertices of a segment head triangle (layer-local px). */
interface SegmentHeadVertices {
  /** Apex — sits exactly ON the endpoint (the shader's head lands there). */
  tip: Pt;
  /** Base corners, `headLen` back along the shaft, ± max(headLen/2, halfW) across it. */
  cornerM: Pt;
  cornerP: Pt;
}

/**
 * Head triangle at endpoint `b` pointing away from `a`. THE geometry source for
 * the whole plugin: painted bounds (below), the SVG drag preview and any future
 * outline expansion must all take their vertices from here, so the bounding can
 * never drift from the ink.
 *
 * The base half-width is floored at the shaft radius `halfW`: the shader cuts
 * the shaft FLUSH at each headed base plane and floors the triangle base by
 * the same formula, so a head shorter than the stroke width renders as a squat
 * triangle that still wraps the shaft's flat base end (a narrower base would
 * leave the flat end poking past the base corners). The polygon solver's
 * outline walk re-derives the same floor.
 */
export function segmentHeadAtB(a: Pt, b: Pt, headLen: number, halfW: number): SegmentHeadVertices {
  const len = Math.max(Math.hypot(b.x - a.x, b.y - a.y), 1e-4);
  const dirX = (b.x - a.x) / len;
  const dirY = (b.y - a.y) / len;
  const half = Math.max(headLen * 0.5, halfW);
  const baseX = b.x - dirX * headLen;
  const baseY = b.y - dirY * headLen;
  const perpX = -dirY * half;
  const perpY = dirX * half;
  return { tip: { x: b.x, y: b.y }, cornerM: { x: baseX - perpX, y: baseY - perpY }, cornerP: { x: baseX + perpX, y: baseY + perpY } };
}

/** Head triangle at endpoint `a` pointing away from `b` (darrow's back head). */
export function segmentHeadAtA(a: Pt, b: Pt, headLen: number, halfW: number): SegmentHeadVertices {
  // Mirrored head: swap the roles of the endpoints.
  const m = segmentHeadAtB(b, a, headLen, halfW);
  return { tip: m.tip, cornerM: m.cornerM, cornerP: m.cornerP };
}

// ─── Segment family: tight painted bounding + containment ─────────────────────

/**
 * TIGHT painted AABB of a segment: each unheaded end contributes its round
 * cap (a circle of radius `halfW` → its ±halfW box), each headed end
 * contributes the THREE head vertices from the single-source helpers above.
 * The shaft and its caps lie between these extremes. Plus `margin` px of AA
 * headroom per side. A uniform head-length pad on every side (the legacy
 * scheme) leaves huge empty bands around any arrow: the tip protrudes nothing
 * along its own axis and the barbs only reach headLen/2 sideways.
 *
 * The headed-end vertices are EXACT for the shipped ink: the shader cuts the
 * shaft flush at each head's base plane, so the shaft contributes nothing past
 * the base line and never wider than the floored base corners.
 */
export function segmentPaintedBounds(
  a: Pt,
  b: Pt,
  halfW: number,
  headLen: number,
  headA: boolean,
  headB: boolean,
  margin: number,
): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const eat = (p: Pt) => {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  };
  const eatCap = (p: Pt) => {
    eat({ x: p.x - halfW, y: p.y - halfW });
    eat({ x: p.x + halfW, y: p.y + halfW });
  };
  if (headA) {
    const h = segmentHeadAtA(a, b, headLen, halfW);
    eat(h.tip);
    eat(h.cornerM);
    eat(h.cornerP);
  } else {
    eatCap(a);
  }
  if (headB) {
    const h = segmentHeadAtB(a, b, headLen, halfW);
    eat(h.tip);
    eat(h.cornerM);
    eat(h.cornerP);
  } else {
    eatCap(b);
  }
  return { minX: minX - margin, minY: minY - margin, maxX: maxX + margin, maxY: maxY + margin };
}

/** Turn a raw painted extent into the tight bounding + endpoints in layer-local space. */
function paintedToLayout(
  painted: { minX: number; minY: number; maxX: number; maxY: number },
  a: Pt,
  b: Pt,
): { bounding: { w: number; h: number }; centerLocal: Pt; a: Pt; b: Pt } {
  const w = painted.maxX - painted.minX;
  const h = painted.maxY - painted.minY;
  return {
    bounding: { w, h },
    centerLocal: { x: painted.minX + w / 2, y: painted.minY + h / 2 },
    a: { x: a.x - painted.minX, y: a.y - painted.minY },
    b: { x: b.x - painted.minX, y: b.y - painted.minY },
  };
}

/**
 * `computeFromDrag`'s layout step: tight bounding of the painted segment and
 * the two endpoints re-expressed relative to the box's top-left (layer-local).
 */
export function segmentTightBounding(
  start: Pt,
  end: Pt,
  halfW: number,
  headLen: number,
  headA: boolean,
  headB: boolean,
  margin: number = SEGMENT_AA_MARGIN_PX,
): { bounding: { w: number; h: number }; centerLocal: Pt; a: Pt; b: Pt } {
  return paintedToLayout(segmentPaintedBounds(start, end, halfW, headLen, headA, headB, margin), start, end);
}

/**
 * Containment layout for an EXISTING segment whose box is frozen but whose ink
 * has grown (stroke-width / head-scale change, or a shrink resize that does not
 * scale the stroke). Unlike the outline family, the segment family paints
 * OUTWARD from its endpoints, so the paint can exceed the box and get clipped
 * at the transient texture edge. Given the current box (layer-local origin) and
 * the current endpoints, returns the minimally expanded box (only the sides the
 * paint spills past grow), the shift to apply to the layer-local endpoints (so
 * they keep their position relative to the box top-left), and the box-centre
 * delta in LOCAL coordinates — convert that delta through the layer world
 * matrix's rotation/flip columns (`M.a·dx + M.c·dy`) to move cx/cy
 * pose-preservingly, then commit the whole thing through
 * `LayerFactory.rebaseToBounds`.
 *
 * ESCALATION NOTE: this containment is currently segment-family-only because
 * it is the only family whose ink grows OUTWARD from a frozen bounding (the
 * outline family's stroke grows inward and can never spill; callout's tip is
 * frozen inside its box). The two call sites (resize in interactions.ts,
 * style-change in commands.ts) are deliberately NOT generalized behind a
 * plugin-wide `inkGrowsOf(data): ContainmentPlanner | null` seam — with a
 * single implementation that abstraction is idle indirection. IF a future
 * shape paints outside its frozen box again, promote this into that seam
 * instead of adding a third per-kind branch at the call sites.
 */
export function segmentContainment(
  a: Pt,
  b: Pt,
  halfW: number,
  headLen: number,
  headA: boolean,
  headB: boolean,
  boxW: number,
  boxH: number,
  margin: number = SEGMENT_AA_MARGIN_PX,
): {
  bounding: { w: number; h: number };
  shiftX: number;
  shiftY: number;
  centerDeltaX: number;
  centerDeltaY: number;
} {
  const painted = segmentPaintedBounds(a, b, halfW, headLen, headA, headB, margin);
  const minX = Math.min(0, painted.minX);
  const minY = Math.min(0, painted.minY);
  const maxX = Math.max(boxW, painted.maxX);
  const maxY = Math.max(boxH, painted.maxY);
  return {
    bounding: { w: maxX - minX, h: maxY - minY },
    // `|| 0` normalizes the negated zero: Math.min(0, positive) yields +0 and
    // -0 leaks into consumers that compare with Object.is.
    shiftX: -minX || 0,
    shiftY: -minY || 0,
    centerDeltaX: (minX + maxX) / 2 - boxW / 2,
    centerDeltaY: (minY + maxY) / 2 - boxH / 2,
  };
}

// ─── Segment family: business-data façade ─────────────────────────────────────

/**
 * Effective head length for a segment of `fullLen`: the style's preferred
 * length (strokeWidth × headScale) clamped so the shaft — clipped back by
 * headLen at EACH headed end — never inverts. Without the clamp a short drag
 * (just past the 8px minimum) makes headLen exceed the shaft: the clipped
 * endpoints cross, and the capsule SDF resolves the reversed segment into a
 * fat bowtie blob. `nHeads` heads share the length budget, so each gets at
 * most fullLen / nHeads (heads meet at the midpoint in the degenerate limit).
 * THE single clamp — definition drag layout, layout façade, engine shader and
 * polygon solver must all derive their head length through it (shader and
 * solver re-derive it from the same formula, see their comments).
 */
export function effectiveHeadLen(fullLen: number, sw: number, headScale: number, headA: boolean, headB: boolean): number {
  if (!headA && !headB) return 0;
  const preferred = Math.max(0, sw) * headScale;
  const nHeads = (headA ? 1 : 0) + (headB ? 1 : 0);
  return Math.min(preferred, Math.max(fullLen, 1e-4) / nHeads);
}

/** Head configuration + endpoints of a segment marker; null for every other kind. */
interface SegmentLayout {
  a: Pt;
  b: Pt;
  headLen: number;
  headA: boolean;
  headB: boolean;
}

/** Endpoints and head configuration of a segment marker; null for every other kind. */
export function segmentLayoutOf(data: MarkerData): SegmentLayout | null {
  switch (data.kind) {
    case 'arrow':
      return {
        a: data.a, b: data.b,
        headLen: effectiveHeadLen(Math.hypot(data.b.x - data.a.x, data.b.y - data.a.y), data.stroke.width, data.headScale || 3, false, true),
        headA: false, headB: true,
      };
    case 'darrow':
      return {
        a: data.a, b: data.b,
        headLen: effectiveHeadLen(Math.hypot(data.b.x - data.a.x, data.b.y - data.a.y), data.stroke.width, data.headScale || 3, true, true),
        headA: true, headB: true,
      };
    case 'line':
      return { a: data.a, b: data.b, headLen: 0, headA: false, headB: false };
    default:
      return null;
  }
}

/** Narrow a marker-data union to the segment family. */
export function isSegmentData(data: MarkerData): data is SegmentMarkerData {
  return data.kind === 'arrow' || data.kind === 'line' || data.kind === 'darrow';
}

/** Shift the endpoints of a segment marker's layer-local data (containment step). */
export function shiftSegmentEndpoints(data: SegmentMarkerData, shiftX: number, shiftY: number): SegmentMarkerData {
  const moved = (p: Pt) => ({ x: p.x + shiftX, y: p.y + shiftY });
  return { ...data, a: moved(data.a), b: moved(data.b) };
}

/** Engine SDF translation for a segment marker: one primitive, head flags in params. */
export function segmentToSdf(data: SegmentMarkerData): SdfGeometry {
  const layout = segmentLayoutOf(data);
  if (!layout) return { prim: 'line-segment', shapeParams: [0, 0, 0, 0, 0, 0], headScale: 0 };
  return {
    prim: 'line-segment',
    shapeParams: [
      layout.a.x, layout.a.y, layout.b.x, layout.b.y,
      layout.headA ? 1 : 0, layout.headB ? 1 : 0,
    ],
    headScale: data.kind === 'line' ? 0 : (data.headScale || 3),
  };
}
