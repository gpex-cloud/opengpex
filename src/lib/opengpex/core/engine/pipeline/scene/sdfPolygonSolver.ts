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
 * sdfPolygonSolver.ts — screen-front polygon expansion for the SDF L2 analytic
 * coverage solver (see `shaders/sdf.ts`).
 *
 * The L1 rect solver showed that replacing the `smoothstep` + `fwidth` coverage
 * approximation with an exact "outline ∩ texel cell" area integral removes the
 * knife-edge stray pixels that appear when a straight shape edge lands on the
 * pixel grid. L2 extends that to the remaining SDF primitives whose rendered
 * shape is (or expands to) a polygon:
 *
 * - star / polygon (`prim: 'star'`) — the shader's star zero set is exactly the
 *   2n-gon with tips at radius r and valleys at
 *   `r * (cos(π/n) − sin(π/n)/tan(π/m))` in circle space, mapped to local space
 *   by the same anisotropic transform the shader applies (verified to ~1e-14
 *   against the distance formula). `sharpness === 2` is the regular n-gon.
 * - callout (`prim: 'callout'`, cornerRadius < 0.5) — body rect ∪ tail triangle
 *   union outline from closed-form segment/rect intersections (tip inside the
 *   body degrades to the plain rect, matching the shader's `min` union).
 * - arrow / line / darrow — solid shapes: the stadium shaft is expanded with a
 *   K-segment arc polyline per cap (K = 8, max radial error r·(1−cos(π/8)) ≈
 *   0.077·r px — far below any discernible threshold at marker stroke widths),
 *   united with the head triangle(s) through a closed-form boundary walk.
 *
 * The stroke RING (outline family) is `outer − inner`, where inner is the
 * polygon inset by the stroke width using straight miter joins — the same
 * sharp-inner-corner convention the L1 rect solver established (the legacy
 * smoothstep path rounds inner corners at radius = stroke width; L1 already
 * shipped the sharp rendering). If the inset self-intersects (stroke wider
 * than a spike or neck) the shape falls back to the legacy smoothstep path
 * with a `console.warn` — never silently.
 *
 * Everything here is pure geometry in LAYER-LOCAL logical pixels (the same
 * space the fragment shader solves in), so coverage stays an exact area
 * integral at every render density. Contract: a `null` return means "no
 * solver outline; use the legacy smoothstep path".
 *
 * @module core/engine/pipeline/scene/sdfPolygonSolver
 */

import type { SdfPrimitive } from './Scene';

/**
 * Vertex budget per ring. Matches the WGSL uniform's vertex slots exactly
 * (`SDF_POLY_UNIFORM_VERTS` in `shaders/sdf.ts`).
 */
export const SDF_POLY_MAX_VERTS = 32;

/** Arc segments per stadium cap. 8 segments → max radial error ≈ 0.077·r px. */
const CAP_SEGMENTS = 8;

/** Degeneracy tolerance (a fraction of a thousandth of a pixel). */
const EPS = 1e-3;

/**
 * A solver outline: flat [x0, y0, x1, y1, ...] vertex rings in layer-local
 * LOGICAL pixels. `inner` is the stroke-inset ring (empty for solid shapes —
 * the whole outer region paints in the stroke colour).
 */
export interface SdfSolverOutline {
  readonly outer: readonly number[];
  readonly inner: readonly number[];
}

type Pt = { x: number; y: number };

function signedArea(verts: readonly number[]): number {
  let s = 0;
  const n = verts.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    s += verts[2 * i] * verts[2 * j + 1] - verts[2 * j] * verts[2 * i + 1];
  }
  return s / 2;
}

function segIntersect(
  a1: Pt, a2: Pt, b1: Pt, b2: Pt,
): { x: number; y: number; t: number } | null {
  const d1x = a2.x - a1.x;
  const d1y = a2.y - a1.y;
  const d2x = b2.x - b1.x;
  const d2y = b2.y - b1.y;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((b1.x - a1.x) * d2y - (b1.y - a1.y) * d2x) / den;
  const u = ((b1.x - a1.x) * d1y - (b1.y - a1.y) * d1x) / den;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return { x: a1.x + d1x * t, y: a1.y + d1y * t, t };
}

// ── miter inset (stroke ring inner ring) ────────────────────────────────────

/**
 * Straight miter inset of a simple polygon by `offset` px (the ring's inner
 * boundary). Returns null when the inset degenerates: collapsed area,
 * self-intersection, or any vertex escaping the source polygon — the caller
 * falls back to the legacy smoothstep path in that case.
 */
export function insetPolygon(verts: readonly number[], offset: number): number[] | null {
  const n = verts.length / 2;
  if (n < 3 || offset <= EPS) return null;
  const area = signedArea(verts);
  if (Math.abs(area) < EPS) return null;
  // Inward normal for edge (v_i → v_{i+1}): perpendicular flipped by the ring
  // orientation so it points INTO the polygon.
  const side = area > 0 ? -1 : 1;
  const nx = new Float64Array(n);
  const ny = new Float64Array(n);
  const c = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = verts[2 * j] - verts[2 * i];
    const ey = verts[2 * j + 1] - verts[2 * i + 1];
    const len = Math.hypot(ex, ey);
    if (len < EPS) return null;
    nx[i] = (side * ey) / len;
    ny[i] = (-side * ex) / len;
    c[i] = nx[i] * verts[2 * i] + ny[i] * verts[2 * i + 1] + offset;
  }
  // Inner vertex i = intersection of the offset lines of edges (i−1, i).
  const inner: number[] = new Array(n * 2);
  for (let i = 0; i < n; i++) {
    const p = i === 0 ? n - 1 : i - 1;
    const den = nx[p] * ny[i] - ny[p] * nx[i];
    if (Math.abs(den) < 1e-9) return null; // parallel offset edges — spike collapsed
    const x = (c[p] * ny[i] - c[i] * ny[p]) / den;
    const y = (nx[p] * c[i] - nx[i] * c[p]) / den;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    inner[2 * i] = x;
    inner[2 * i + 1] = y;
  }
  // Validity: same orientation, non-collapsed area, no self-intersection, and
  // every inner vertex strictly inside the source polygon.
  const innerArea = signedArea(inner);
  if (innerArea * area <= 0 || Math.abs(innerArea) < EPS) return null;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    for (let k = i + 2; k < n; k++) {
      if (i === 0 && k === n - 1) continue; // adjacent through the wraparound
      const l = (k + 1) % n;
      if (segIntersect(
        { x: inner[2 * i], y: inner[2 * i + 1] },
        { x: inner[2 * j], y: inner[2 * j + 1] },
        { x: inner[2 * k], y: inner[2 * k + 1] },
        { x: inner[2 * l], y: inner[2 * l + 1] },
      )) return null;
    }
  }
  // Every inner vertex must sit strictly inside the source ring. The miter
  // intersection can legitimately lie beyond a NON-adjacent edge's infinite
  // line (sharp spike tips) while still being inside the polygon — containment
  // is a polygon test (crossing number, concave-safe), not a distance test.
  for (let v = 0; v < n; v++) {
    if (!pointInRing(verts, { x: inner[2 * v], y: inner[2 * v + 1] })) return null;
  }
  // Over-inset guard: the source may be too thin for the offset even when the
  // miter algebra still yields a well-formed ring (an 8×8 square inset by 5
  // produces an inverted 2×2 square). The eroded set is non-empty only if some
  // region sits ≥ offset from the boundary — require the inner ring's centroid
  // to be that deep from every edge SEGMENT.
  let cx = 0;
  let cy = 0;
  for (let v = 0; v < n; v++) {
    cx += inner[2 * v];
    cy += inner[2 * v + 1];
  }
  cx /= n;
  cy /= n;
  for (let e = 0; e < n; e++) {
    const j = (e + 1) % n;
    const ex = verts[2 * j] - verts[2 * e];
    const ey = verts[2 * j + 1] - verts[2 * e + 1];
    const len2 = ex * ex + ey * ey;
    const t = Math.max(0, Math.min(1, ((cx - verts[2 * e]) * ex + (cy - verts[2 * e + 1]) * ey) / len2));
    const px = verts[2 * e] + ex * t;
    const py = verts[2 * e + 1] + ey * t;
    if (Math.hypot(cx - px, cy - py) < offset) return null;
  }
  return inner;
}

/** Crossing-number point-in-ring (works for concave simple rings). */
function pointInRing(verts: readonly number[], p: Pt): boolean {
  let inside = false;
  const n = verts.length / 2;
  let j = n - 1;
  for (let i = 0; i < n; i++) {
    const yi = verts[2 * i + 1];
    const yj = verts[2 * j + 1];
    if ((yi > p.y) !== (yj > p.y)) {
      const cross = (verts[2 * j] - verts[2 * i]) * (p.y - yi) / (yj - yi) + verts[2 * i];
      if (p.x < cross) inside = !inside;
    }
    j = i;
  }
  return inside;
}

// ── shape expansions ─────────────────────────────────────────────────────────

/**
 * Star / regular polygon outer ring, in the shader's exact local-space mapping.
 * The shader solves the star in a circle of radius r_min = min(w,h)/2 and maps
 * the distance back through an anisotropic scale, so the local-space zero set
 * is the circle-space 2n-gon mapped by `p = b + q·(b/r_min)·(1,−1)` — expanding
 * in circle space and mapping forward reproduces it exactly.
 */
function starOutline(w: number, h: number, points: number, sharpness: number): number[] {
  const n = Math.max(3, Math.round(points));
  const mRaw = sharpness > 0 ? sharpness : 2;
  const m = Math.min(Math.max(mRaw, 2), n);
  const bx = w / 2;
  const by = h / 2;
  const rMin = Math.min(bx, by);
  const an = Math.PI / n;
  const en = Math.PI / m;
  const verts: number[] = [];
  // Circle-space angle convention (matches the shader): ang = atan2(x, y),
  // so ang = 0 points +y; tips at 2k·an, valleys at (2k+1)·an.
  const emit = (radius: number, ang: number) => {
    const qx = radius * Math.sin(ang);
    const qy = radius * Math.cos(ang);
    // Forward of the shader's q = (p − b)·(r_min/b)·(1, −1)
    verts.push(bx + qx * (bx / rMin), by - qy * (by / rMin));
  };
  if (m <= 2 + EPS) {
    // sharpness 2 = the regular n-gon (valleys sit exactly on the tips' chord)
    for (let k = 0; k < n; k++) emit(rMin, 2 * k * an);
  } else {
    const rIn = rMin * (Math.cos(an) - Math.sin(an) / Math.tan(en));
    if (rIn <= EPS) return []; // spikes thinning to the centre: degenerate ring
    for (let k = 0; k < n; k++) {
      emit(rMin, 2 * k * an);
      emit(rIn, (2 * k + 1) * an);
    }
  }
  return verts;
}

/**
 * Rect ∪ tail-triangle union outline for the callout (closed-form boundary
 * walk over the rect perimeter with the tail's protruding wedge inserted).
 * A tip inside the body degrades to the plain rect — the shader's `min` union
 * hides the whole triangle in that case.
 */
function calloutOutline(body: Pt, size: Pt, tip: Pt, halfBase: number): number[] {
  const rect = [
    body.x, body.y,
    body.x + size.x, body.y,
    body.x + size.x, body.y + size.y,
    body.x, body.y + size.y,
  ];
  const centre = { x: body.x + size.x / 2, y: body.y + size.y / 2 };
  const dx = tip.x - centre.x;
  const dy = tip.y - centre.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-4) return rect;
  const dir = { x: dx / len, y: dy / len };
  const baseA = { x: centre.x - dir.y * halfBase, y: centre.y + dir.x * halfBase };
  const baseB = { x: centre.x + dir.y * halfBase, y: centre.y - dir.x * halfBase };
  const pointInRect = (p: Pt) =>
    p.x >= body.x - EPS && p.x <= body.x + size.x + EPS
    && p.y >= body.y - EPS && p.y <= body.y + size.y + EPS;
  // Tip inside the body: the whole triangle hides (shader union degrades).
  if (pointInRect(tip)) return rect;
  const edges: [Pt, Pt][] = [];
  for (let i = 0; i < 4; i++) {
    edges.push([
      { x: rect[2 * i], y: rect[2 * i + 1] },
      { x: rect[2 * ((i + 1) % 4)], y: rect[2 * ((i + 1) % 4) + 1] },
    ]);
  }
  // Where each flank (tip → base point) crosses the rect boundary, nearest the tip.
  const entry = (base: Pt) => {
    let best: { x: number; y: number; edge: number; t: number } | null = null;
    for (let e = 0; e < 4; e++) {
      const hit = segIntersect(tip, base, edges[e][0], edges[e][1]);
      if (hit && (!best || hit.t < best.t)) best = { x: hit.x, y: hit.y, edge: e, t: hit.t };
    }
    return best;
  };
  const eA = entry(baseA);
  const eB = entry(baseB);
  if (!eA || !eB) return rect;
  // Walk the perimeter from eA forward (edge iA → iB) collecting corner
  // vertices; if that arc's midpoint hides inside the triangle it is the
  // swallowed side — walk the complementary arc instead.
  const walk = (fromEdge: number, toEdge: number, from: Pt, to: Pt): number[] => {
    const steps = ((toEdge - fromEdge) + 4) % 4;
    const ring: number[] = [from.x, from.y];
    let idx = fromEdge;
    for (let s = 0; s < steps; s++) {
      idx = (idx + 1) % 4;
      ring.push(rect[2 * idx], rect[2 * idx + 1]);
    }
    ring.push(to.x, to.y);
    return ring;
  };
  const forward = walk(eA.edge, eB.edge, eA, eB);
  // Midpoint sample of the forward arc (mid-edge + mid-vertex is enough: any
  // boundary point strictly between the entries decides which arc is swallowed).
  const stepsF = ((eB.edge - eA.edge) + 4) % 4;
  const sampleEdge = (eA.edge + Math.max(0, stepsF - 1)) % 4;
  const midArc = {
    x: (edges[sampleEdge][0].x + edges[sampleEdge][1].x) / 2,
    y: (edges[sampleEdge][0].y + edges[sampleEdge][1].y) / 2,
  };
  const inTriangle = (p: Pt) => {
    const cross = (o: Pt, a: Pt, b: Pt) =>
      (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const d1 = cross(tip, baseA, p);
    const d2 = cross(baseA, baseB, p);
    const d3 = cross(baseB, tip, p);
    const neg = d1 < -EPS || d2 < -EPS || d3 < -EPS;
    const pos = d1 > EPS || d2 > EPS || d3 > EPS;
    return !(neg && pos);
  };
  const ring = inTriangle(midArc)
    // forward arc swallowed → complementary arc + tail (eB → tip → eA)
    ? [...walk(eB.edge, eA.edge, eB, eA), tip.x, tip.y]
    : [...forward, tip.x, tip.y];
  return ring;
}

/**
 * Capsule ∪ head triangle(s) union outline (arrow / darrow / line), closed-form
 * boundary walk: back end (cap arc or head walk) → −normal side → front end
 * (cap arc or head walk) → +normal side. The shaft is clipped back by headLen
 * at each end that carries a head; that end's cap semicircle hides inside the
 * head triangle, and the boundary goes base point → base corner → tip.
 */
function capsuleHeadsOutline(
  a: Pt, b: Pt, halfW: number, headLen: number, headA: boolean, headB: boolean,
): number[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-4) return [];
  const dir = { x: dx / len, y: dy / len };
  const nrm = { x: -dir.y, y: dir.x };
  const headHalf = headLen * 0.5;
  const shaftA = headA ? { x: a.x + dir.x * headLen, y: a.y + dir.y * headLen } : a;
  const shaftB = headB ? { x: b.x - dir.x * headLen, y: b.y - dir.y * headLen } : b;
  if (Math.hypot(shaftB.x - shaftA.x, shaftB.y - shaftA.y) < 1e-4) return [];
  const at = (c: Pt, s: number, w: number) => ({ x: c.x + nrm.x * w * s, y: c.y + nrm.y * w * s });
  const verts: number[] = [];
  // 1. Back end (A). Head: tip → corner(−) → base point(−). Cap: arc from
  //    +n·halfW through −dir around to −n·halfW.
  if (headA) {
    const cornerM = at(shaftA, -1, headHalf);
    const baseM = at(shaftA, -1, halfW);
    verts.push(a.x, a.y, cornerM.x, cornerM.y, baseM.x, baseM.y);
  } else {
    // Arc around A from +normal through −dir to −normal: θ = π/2 … 3π/2
    for (let i = 0; i <= CAP_SEGMENTS; i++) {
      const th = Math.PI / 2 + (Math.PI * i) / CAP_SEGMENTS;
      verts.push(
        shaftA.x + dir.x * halfW * Math.cos(th) + nrm.x * halfW * Math.sin(th),
        shaftA.y + dir.y * halfW * Math.cos(th) + nrm.y * halfW * Math.sin(th),
      );
    }
  }
  // 2. −normal side to B.
  const bBaseM = at(shaftB, -1, halfW);
  verts.push(bBaseM.x, bBaseM.y);
  // 3. Front end (B). Head: corner(−) → tip → corner(+) → base point(+).
  //    Cap: arc from −normal through +dir to +normal: θ = −π/2 … +π/2.
  if (headB) {
    const cornerM = at(shaftB, -1, headHalf);
    const cornerP = at(shaftB, 1, headHalf);
    const baseP = at(shaftB, 1, halfW);
    verts.push(cornerM.x, cornerM.y, b.x, b.y, cornerP.x, cornerP.y, baseP.x, baseP.y);
  } else {
    for (let i = 0; i <= CAP_SEGMENTS; i++) {
      const th = -Math.PI / 2 + (Math.PI * i) / CAP_SEGMENTS;
      verts.push(
        shaftB.x + dir.x * halfW * Math.cos(th) + nrm.x * halfW * Math.sin(th),
        shaftB.y + dir.y * halfW * Math.cos(th) + nrm.y * halfW * Math.sin(th),
      );
    }
  }
  // 4. +normal side back toward A. Head: base point(+) → corner(+) (the ring
  //    wraps to the tip). Cap: nothing — the arc already ended at +n·halfW.
  if (headA) {
    const baseP = at(shaftA, 1, halfW);
    const cornerP = at(shaftA, 1, headHalf);
    verts.push(baseP.x, baseP.y, cornerP.x, cornerP.y);
  }
  return verts;
}

// ── dispatcher ───────────────────────────────────────────────────────────────

/**
 * Build the L2 analytic solver outline for an SDF primitive, or null when the
 * primitive has no exact polygon form (ellipse, rounded corners), the expansion
 * exceeds the vertex budget, or the geometry degenerates. A `console.warn`
 * always accompanies a budget/degeneracy fallback so analytic exactness never
 * silently degrades.
 */
export function sdfSolverOutline(
  prim: SdfPrimitive,
  size: readonly [number, number],
  strokeWidth: number,
  shapeParams: readonly number[],
  headScale: number,
): SdfSolverOutline | null {
  const [w, h] = size;
  let outer: number[] = [];
  let needsInner = false;
  if (prim === 'star') {
    outer = starOutline(w, h, shapeParams[0] ?? 5, shapeParams[1] ?? 3.2);
    needsInner = true;
  } else if (prim === 'callout') {
    const cornerRadius = shapeParams[6] ?? 0;
    if (cornerRadius >= 0.5) return null; // rounded corners → L3 pending, legacy path
    const body = { x: shapeParams[0] ?? 0, y: shapeParams[1] ?? 0 };
    const bodySize = { x: shapeParams[2] ?? w, y: shapeParams[3] ?? h };
    const tip = { x: shapeParams[4] ?? 0, y: shapeParams[5] ?? 0 };
    const halfBase = shapeParams[7] ?? 0;
    outer = calloutOutline(body, bodySize, tip, halfBase);
    needsInner = true;
  } else if (prim === 'arrow' || prim === 'darrow' || prim === 'line') {
    const halfW = strokeWidth / 2;
    const a = { x: shapeParams[0] ?? 0, y: shapeParams[1] ?? 0 };
    const b = { x: shapeParams[2] ?? 0, y: shapeParams[3] ?? 0 };
    if (prim === 'line') {
      outer = capsuleHeadsOutline(a, b, halfW, 0, false, false);
    } else {
      const headLen = Math.max(0, strokeWidth * headScale);
      if (headLen * 0.5 <= halfW + EPS) {
        // Head no wider than the shaft: only acceptable when it protrudes
        // nothing; otherwise the thin-spike union needs the legacy path.
        if (headLen <= EPS) outer = capsuleHeadsOutline(a, b, halfW, 0, false, false);
        else return fallback(prim, 'thin head');
      } else if (prim === 'arrow') {
        outer = capsuleHeadsOutline(a, b, halfW, headLen, false, true);
      } else {
        outer = capsuleHeadsOutline(a, b, halfW, headLen, true, true);
      }
    }
  } else {
    // rounded_rect (L1 owns the sharp case in-shader) / ellipse (L4): legacy.
    return null;
  }
  if (outer.length < 6 || outer.length / 2 > SDF_POLY_MAX_VERTS) {
    return fallback(prim, `outline has ${outer.length / 2} vertices`);
  }
  if (!Number.isFinite(signedArea(outer)) || Math.abs(signedArea(outer)) < EPS) {
    return fallback(prim, 'degenerate outline');
  }
  let inner: number[] = [];
  if (needsInner) {
    const inset = insetPolygon(outer, strokeWidth);
    if (!inset) return fallback(prim, 'stroke inset degenerate');
    if (inset.length / 2 > SDF_POLY_MAX_VERTS) return fallback(prim, 'inner ring budget');
    inner = inset;
  }
  return { outer, inner };
}

function fallback(prim: SdfPrimitive, reason: string): null {
  console.warn(`[sdf-polygon-solver] ${prim}: smoothstep fallback (${reason})`);
  return null;
}
