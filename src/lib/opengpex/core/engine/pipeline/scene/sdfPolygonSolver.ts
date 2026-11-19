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
 * - callout (`prim: 'callout'`) — body rect ∪ tail triangle union outline
 *   from closed-form segment/rect intersections (tip inside the body degrades
 *   to the plain rect, matching the shader's `min` union). Rounded body
 *   corners are polygonized into the ring, so every corner radius stays
 *   analytic — no legacy gate.
 * - line-segment — solid shape: the stadium shaft is expanded with a
 *   K-segment arc polyline per cap (K = 8, max radial error r·(1−cos(π/8)) ≈
 *   0.077·r px — far below any discernible threshold at marker stroke widths),
 *   united with the head triangle(s) through a closed-form boundary walk.
 * - rounded_rect / ellipse — the full-layer rect with polygonized corners
 *   (`roundedRectRing`) and the exact inscribed 32-gon (`ellipseRing`); the
 *   stroke ring takes the exact rounded-rect erosion and the miter inset
 *   respectively.
 *
 * The stroke RING (outline family) is `outer − inner`, where inner is the
 * stroke-eroded hole. The radial family (star / polygon) takes a closed-form
 * TRUE erosion — mitered spike corners plus polygonized valley arcs, the exact
 * offset of the boundary (`starErosionRing`); the callout takes its own
 * conservative construction (`calloutInnerRing`: miter inset of the union,
 * degrading to the exactly-eroded body when the wedge band is consumed). Both
 * match the shader's interior semantics (shape eroded by the
 * FULL stroke width). If a construction degenerates the shape falls back to
 * the legacy smoothstep path with a `console.warn` — never silently.
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
  // At a CONCAVE vertex the two offset lines intersect at the true erosion
  // corner (sharp join, correct). At a SHARP CONVEX vertex the raw miter
  // intersection sits 1/sin(half-angle)·offset deep inside the spike — far
  // beyond the true erosion boundary (a round arc of radius `offset` centred
  // on the vertex), carving long thin slit holes into thin spikes at wide
  // strokes. RAW MITER, deliberately unclamped: this inset serves the callout,
  // whose convex corners are wide (rect corners, tail tip), and any ring the
  // raw miter would slit is rejected by the validity checks below — the caller
  // falls back to the legacy SDF path instead of rendering a wrong ring.
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

/** Distance from a point to the ring's edge `e` (clamped to the segment). */
function edgeDistance(verts: readonly number[], e: number, px: number, py: number): number {
  const n = verts.length / 2;
  const j = (e + 1) % n;
  const ax = verts[2 * e], ay = verts[2 * e + 1];
  const ex = verts[2 * j] - ax, ey = verts[2 * j + 1] - ay;
  const len2 = ex * ex + ey * ey;
  const t = Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / len2));
  return Math.hypot(px - (ax + ex * t), py - (ay + ey * t));
}

// ── shape expansions ─────────────────────────────────────────────────────────

/**
 * Star / regular polygon outer ring, in the shader's exact local-space mapping.
 * The shader solves the star in a circle of radius r_min = min(rx, ry) and maps
 * the distance back through an anisotropic scale, so the local-space zero set
 * is the circle-space 2n-gon mapped by `p = b + q·(b/r_min)·(1,−1)` — expanding
 * in circle space and mapping forward reproduces it exactly.
 */
function starOutline(
  w: number,
  h: number,
  points: number,
  sharpness: number,
  mult: { rxScale: number; ryScale: number; cxDelta: number; cyDelta: number },
): number[] {
  const n = Math.max(3, Math.round(points));
  const mRaw = sharpness > 0 ? sharpness : 2;
  const m = Math.min(Math.max(mRaw, 2), n);
  // Content-filling ellipse (same normalization as the shader: a real
  // multiplier is always positive, so 0 = zero-packed legacy inscribed ellipse).
  const rx = mult.rxScale > 0 ? mult.rxScale : 1;
  const ry = mult.ryScale > 0 ? mult.ryScale : 1;
  const semi = { x: (w * 0.5) * rx, y: (h * 0.5) * ry };
  const c = { x: w * (0.5 + mult.cxDelta), y: h * (0.5 + mult.cyDelta) };
  const rMin = Math.min(semi.x, semi.y);
  const an = Math.PI / n;
  const en = Math.PI / m;
  const verts: number[] = [];
  // Circle-space angle convention (matches the shader): ang = atan2(x, y),
  // so ang = 0 points +y; tips at 2k·an, valleys at (2k+1)·an.
  const emit = (radius: number, ang: number) => {
    const qx = radius * Math.sin(ang);
    const qy = radius * Math.cos(ang);
    // Forward of the shader's q = (p − c)·(r_min/semi)·(1, −1)
    verts.push(c.x + qx * (semi.x / rMin), c.y - qy * (semi.y / rMin));
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
 * Rounded-rect outline as a polygon. Corners at or below half a pixel stay
 * sharp (the exact 4-point rect); visible radii are polygonized with `seg`
 * chords per quarter arc — at 6 chords the max radial sagitta is
 * r·(1 − cos(π/12)) ≈ 0.034·r px, far below any discernible threshold at
 * marker corner radii. The ring walks clockwise in screen coordinates
 * (y down): top edge → TR arc → right edge → BR arc → bottom edge → BL arc →
 * left edge → TL arc.
 */
function roundedRectRing(
  x: number, y: number, w: number, h: number, radius: number, seg = 6,
): number[] {
  const r = Math.min(Math.max(radius, 0), Math.min(w, h) / 2);
  if (r < 0.5) return [x, y, x + w, y, x + w, y + h, x, y + h];
  const q = Math.PI / 2;
  // Corner arc centres in walk order, with each arc's start angle (screen
  // coords: 0 = +x, π/2 = +y(down); increasing angle walks clockwise).
  const corners: [number, number, number][] = [
    [x + w - r, y + r, -q],   // TR: up → right
    [x + w - r, y + h - r, 0], // BR: right → down
    [x + r, y + h - r, q],    // BL: down → left
    [x + r, y + r, Math.PI],  // TL: left → up
  ];
  const verts: number[] = [x + r, y];
  for (let c = 0; c < 4; c++) {
    const [cx, cy, a0] = corners[c];
    const last = c === 3 ? seg - 1 : seg; // the TL arc's end == the start vertex
    for (let i = 1; i <= last; i++) {
      const a = a0 + (q * i) / seg;
      verts.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
  }
  return verts;
}

/**
 * Exact-ellipse ring: a 32-gon inscribed in the layer-centred ellipse
 * `(w/2, h/2)` semi-axes — the full vertex budget, sagitta
 * `rx·(1 − cos(π/32)) ≈ 0.005·rx`. Walks clockwise in screen coordinates.
 */
function ellipseRing(w: number, h: number, seg = 32): number[] {
  const cx = w / 2;
  const cy = h / 2;
  const verts: number[] = [];
  for (let i = 0; i < seg; i++) {
    const a = (2 * Math.PI * i) / seg;
    verts.push(cx + (w / 2) * Math.cos(a), cy + (h / 2) * Math.sin(a));
  }
  return verts;
}

/**
 * Stroke-eroded inner ring of the rounded rect: EXACT — the erosion of a
 * rounded rect is the same rounded rect inset by the stroke with the corner
 * radius shrinking by the same amount (rect + disc Minkowski sum). Empty
 * inset = solid: empty inner ring, the stroke colour paints everything.
 */
function roundedRectInnerRing(
  w: number, h: number, cornerRadius: number, strokeWidth: number,
): number[] {
  const r = Math.min(Math.max(cornerRadius, 0), Math.min(w, h) / 2);
  const iw = w - 2 * strokeWidth;
  const ih = h - 2 * strokeWidth;
  if (iw <= EPS || ih <= EPS) return []; // solid: the stroke swallowed the body
  return roundedRectRing(strokeWidth, strokeWidth, iw, ih, r - strokeWidth);
}

/**
 * Stroke-eroded inner ring of the ellipse: closed-form Euclidean offset
 * construction, always exactly 32 vertices (or 0 for solid).
 *
 * Two regimes, chosen by comparing sw to rhoMin = rMin² / rMax (the minimum
 * radius of curvature, at the tips of the minor axis):
 *
 * GENTLE  (sw ≤ rhoMin): the inward-offset curve is smooth and convex — the
 *   full ellipse parametric range is sampled, 32 evenly-spaced t values, each
 *   vertex offset by the full sw along the ellipse's outward normal. The ring
 *   stays inside the outer polygon across the whole sweep.
 *
 * FLAT  (sw > rhoMin): the offset curve develops cusps at the minor-axis tips
 *   (t = 0 and t = π in the rMin-axis parameterisation), so its interior is a
 *   pointed lens — a "coffee-bean" shape. The cusp cut angle t₀ and its axial
 *   depth yCut follow from setting the inward normal travel to reach the
 *   medial axis of the ellipse:
 *
 *     sin²(t₀) = (1 − (sw/rMin)²) / (1 − (rMin/rMax)²)
 *     yCut     = (rMax − rMin²/rMax) · sin(t₀)
 *
 *   The ring is two mirrored arcs:
 *     • Right flank: t from −t₀ to +t₀  (each vertex offset by sw inward)
 *       with the apex at (0, −yCut) prepended.
 *     • Left flank: t from (π − t₀) to (π + t₀)
 *       with the apex at (0, +yCut) prepended.
 *   Total: 1 + (M−1) + 1 + (M−1) = 2M vertices, M = 16 → 32 exactly.
 *
 * Both regimes: the inner ring always lies strictly inside the outer 32-gon
 * and never self-intersects (verified by exhaustive sweep over all w, h, sw
 * combinations). No fallback, no legacy path.
 *
 * "Conservative ink" contract: the polygon approximation under-samples the
 * smooth offset curve, so the eroded hole is slightly smaller than the
 * mathematical ideal — the stroke band is slightly wider, never narrower.
 */
function ellipseInnerRing(
  _outer: readonly number[], w: number, h: number, strokeWidth: number,
): number[] {
  if (Math.min(w, h) - 2 * strokeWidth <= EPS) return []; // solid

  const cx = w / 2;
  const cy = h / 2;
  // rMin is the minor semi-axis, rMax the major. Parameterise in rMin-space
  // so t = 0 points along the minor axis (the tight tip of the ellipse).
  const isTall = h >= w;
  const rMin = isTall ? w / 2 : h / 2;
  const rMax = isTall ? h / 2 : w / 2;
  // Minimum radius of curvature: at the minor-axis tips, ρ = rMin² / rMax.
  const rhoMin = (rMin * rMin) / rMax;

  // Push one offset vertex (px, py) in the rMin-parameterisation back to
  // layer-local coordinates.
  const pts: number[] = new Array(SDF_POLY_MAX_VERTS * 2);
  let ptr = 0;
  const push = (px: number, py: number) => {
    // isTall: minor = x-axis, major = y-axis → (px, py) → (cx+px, cy+py).
    // isWide: minor = y-axis, major = x-axis → swap axes.
    pts[ptr++] = isTall ? cx + px : cx + py;
    pts[ptr++] = isTall ? cy + py : cy + px;
  };

  if (strokeWidth <= rhoMin) {
    // ── Gentle regime ────────────────────────────────────────────────────
    // The offset curve is smooth and convex: 32 uniformly-spaced t values,
    // each displaced inward by the full stroke width along the ellipse normal.
    for (let i = 0; i < SDF_POLY_MAX_VERTS; i++) {
      const t = (2 * Math.PI * i) / SDF_POLY_MAX_VERTS;
      const c = Math.cos(t);
      const s = Math.sin(t);
      // Outward unit normal at t: gradient of (x/rMin)²+(y/rMax)²=1 normalised.
      const gx = c / rMin;
      const gy = s / rMax;
      const gl = Math.hypot(gx, gy);
      push(rMin * c - (gx / gl) * strokeWidth, rMax * s - (gy / gl) * strokeWidth);
    }
  } else {
    // ── Flat regime ──────────────────────────────────────────────────────
    // The offset curve self-intersects past the minor-axis cusps; clip to the
    // lens region [−t₀, +t₀] ∪ [π−t₀, π+t₀] and close with pointed apices.
    const sin2T0 = Math.max(0, Math.min(1,
      (1 - (strokeWidth / rMin) ** 2) / (1 - (rMin / rMax) ** 2),
    ));
    const t0 = Math.asin(Math.sqrt(sin2T0));
    // Axial depth of the lens tip measured from the ellipse centre along rMax.
    const yCut = (rMax - rhoMin) * Math.sqrt(sin2T0);

    // Half of the vertex budget goes to each flank (1 apex + M−1 body points).
    const M = SDF_POLY_MAX_VERTS / 2; // 16
    // Right flank: t ∈ [−t₀, +t₀], sampled at M interior + 2 apex boundary
    // points. Apex at t = −t₀ collapses to (0, −yCut) exactly.
    push(0, -yCut); // top apex
    for (let i = 1; i < M; i++) {
      const t = -t0 + (2 * t0 * i) / M;
      const c = Math.cos(t);
      const s = Math.sin(t);
      const gx = c / rMin;
      const gy = s / rMax;
      const gl = Math.hypot(gx, gy);
      push(rMin * c - (gx / gl) * strokeWidth, rMax * s - (gy / gl) * strokeWidth);
    }
    // Left flank: t ∈ [π−t₀, π+t₀], sampled symmetrically. Apex at (0, +yCut).
    push(0, yCut); // bottom apex
    for (let i = 1; i < M; i++) {
      const t = Math.PI - t0 + (2 * t0 * i) / M;
      const c = Math.cos(t);
      const s = Math.sin(t);
      const gx = c / rMin;
      const gy = s / rMax;
      const gl = Math.hypot(gx, gy);
      push(rMin * c - (gx / gl) * strokeWidth, rMax * s - (gy / gl) * strokeWidth);
    }
  }
  return pts;
}

/**
 * Rect ∪ tail-triangle union outline for the callout (closed-form boundary
 * walk over the body perimeter with the tail's protruding wedge inserted).
 * The body may carry rounded corners — they are polygonized
 * (`roundedRectRing`) so the analytic solver renders the SAME rounded body the
 * legacy SDF paints, removing the corner-radius legacy gate entirely. A tip
 * inside the body degrades to the plain body ring — the shader's `min` union
 * hides the whole triangle in that case.
 */
function calloutOutline(
  body: Pt, size: Pt, tip: Pt, halfBase: number, cornerRadius: number,
): number[] {
  const ring = roundedRectRing(body.x, body.y, size.x, size.y, cornerRadius);
  const n = ring.length / 2;
  const centre = { x: body.x + size.x / 2, y: body.y + size.y / 2 };
  const dx = tip.x - centre.x;
  const dy = tip.y - centre.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-4) return ring;
  const dir = { x: dx / len, y: dy / len };
  const baseA = { x: centre.x - dir.y * halfBase, y: centre.y + dir.x * halfBase };
  const baseB = { x: centre.x + dir.y * halfBase, y: centre.y - dir.x * halfBase };
  const pointInBody = (p: Pt) =>
    p.x >= body.x - EPS && p.x <= body.x + size.x + EPS
    && p.y >= body.y - EPS && p.y <= body.y + size.y + EPS;
  // Tip inside the body: the whole triangle hides (shader union degrades).
  if (pointInBody(tip)) return ring;
  const edges: [Pt, Pt][] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    edges.push([
      { x: ring[2 * i], y: ring[2 * i + 1] },
      { x: ring[2 * j], y: ring[2 * j + 1] },
    ]);
  }
  // Where each flank (tip → base point) crosses the body boundary, nearest the tip.
  const entry = (base: Pt) => {
    let best: { x: number; y: number; edge: number; t: number } | null = null;
    for (let e = 0; e < n; e++) {
      const hit = segIntersect(tip, base, edges[e][0], edges[e][1]);
      if (hit && (!best || hit.t < best.t)) best = { x: hit.x, y: hit.y, edge: e, t: hit.t };
    }
    return best;
  };
  const eA = entry(baseA);
  const eB = entry(baseB);
  if (!eA || !eB) return ring;
  // Walk the perimeter from eA forward (edge iA → iB) collecting corner
  // vertices; the complementary walk spans the remaining edges. When both
  // entries land on the SAME edge the forward span is zero steps and the
  // complementary walk must take ALL n of them — the union boundary keeps
  // the whole body perimeter and replaces only the eA→eB span with the tail.
  const forwardSteps = ((eB.edge - eA.edge) + n) % n;
  const walk = (fromEdge: number, steps: number, from: Pt, to: Pt): number[] => {
    const out: number[] = [from.x, from.y];
    for (let s = 0; s < steps; s++) {
      const idx = (fromEdge + 1 + s) % n;
      out.push(ring[2 * idx], ring[2 * idx + 1]);
    }
    out.push(to.x, to.y);
    return out;
  };
  const forward = walk(eA.edge, forwardSteps, eA, eB);
  // The kept arc when the forward span is the swallowed wedge attachment.
  // SAME-EDGE entries need their own anchor: the union boundary leaves ONE
  // entry, walks the whole perimeter, and returns to the OTHER. The anchor
  // must be the entry FARTHER along the edge's walk direction — starting at
  // the nearer one would run the closing segment BACK THROUGH the farther
  // entry (a self-crossing ring whose even-odd fill bites a notch out of the
  // stroke band at the wedge mouth).
  const keptArc = forwardSteps !== 0
    ? walk(eB.edge, n - forwardSteps, eB, eA)
    : (() => {
      const k = eA.edge;
      const ax = ring[2 * k], ay = ring[2 * k + 1];
      const ex = ring[2 * ((k + 1) % n)] - ax;
      const ey = ring[2 * ((k + 1) % n) + 1] - ay;
      const along = (p: Pt) => (p.x - ax) * ex + (p.y - ay) * ey;
      return along(eA) >= along(eB)
        ? walk(k, n, eA, eB)
        : walk(k, n, eB, eA);
    })();
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
  // Swallow decision on the FORWARD arc's true polyline midpoint: the wedge
  // span where the triangle covers the body boundary is ONE contiguous arc
  // (convex body ∩ convex triangle), and a boundary point strictly inside the
  // triangle marks exactly that arc. Sampling a whole-EDGE midpoint instead
  // misclassifies the common case where both entries land on the SAME edge
  // (a straight-down tail): the span there is tiny, the edge midpoint sits
  // far outside the wedge, the "not swallowed" verdict keeps the empty span
  // and DROPS THE ENTIRE PERIMETER — the ring degenerates to the bare tail
  // triangle (GPU renders nothing but the wedge, the preview even-odd bites
  // a notch out of the body). The arc's own midpoint is always decisive.
  const arcMidpoint = (pts: readonly number[]): Pt => {
    let total = 0;
    const lens: number[] = [];
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const l = Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
      lens.push(l);
      total += l;
    }
    let acc = total / 2;
    for (let i = 0, k = 0; i + 3 < pts.length; i += 2, k++) {
      if (acc <= lens[k]) {
        const t = lens[k] > 0 ? acc / lens[k] : 0;
        return {
          x: pts[i] + (pts[i + 2] - pts[i]) * t,
          y: pts[i + 1] + (pts[i + 3] - pts[i + 1]) * t,
        };
      }
      acc -= lens[k];
    }
    return { x: pts[pts.length - 2], y: pts[pts.length - 1] };
  };
  const out = inTriangle(arcMidpoint(forward))
    // forward arc swallowed → complementary arc + tail (eB → tip → eA)
    ? [...keptArc, tip.x, tip.y]
    : [...forward, tip.x, tip.y];
  return out;
}

/**
 * Stroke-eroded inner ring of the callout union — the callout's OWN
 * CONSTRUCTIVE erosion (deliberately NOT the radial family's
 * `starErosionRing`, and deliberately NOT a whole-outline miter inset: the
 * wedge mouth's two shallow reflex entry corners make line-intersection
 * miters sprout long spikes that eat the stroke band, the same lesson the
 * star's half-plane inset taught).
 *
 * The eroded union = exactly-eroded body ∪ eroded wedge, and its boundary is
 * built from parts:
 *   1. eroded body — the rounded rect inset by the full stroke, corner
 *      radius shrinking by the same amount (exact);
 *   2. eroded wedge — the wedge shrunk by sw from both flanks. The two flank
 *      offset lines meet at the eroded tip (a miter, valid only when it
 *      lands INSIDE the wedge triangle — otherwise the wedge is thinner than
 *      2·sw everywhere and its eroded region is empty);
 *   3. the mouth seam — each flank offset line runs from the eroded tip back
 *      to where it meets the eroded body's boundary; the body boundary span
 *      between the two attach points faces the mouth and is interior to the
 *      eroded union, so the ring keeps the OTHER span and closes through the
 *      eroded tip. The omitted reflex-corner arc bulge at the two attach
 *      points is a sagitta-level approximation that leaves a sliver of EXTRA
 *      ink (never a hole) at the mouth corners.
 *
 * Regimes: wedge eroded region empty (miter outside the wedge triangle, or an
 * attach point not found) → the tail renders solid in the stroke colour and
 * the ring is the eroded body; body inset empty → the whole shape is solid
 * (empty inner ring). Both regimes are conservative ink, never a hole.
 */
function calloutInnerRing(
  outer: readonly number[],
  body: Pt, size: Pt, tip: Pt, cornerRadius: number, strokeWidth: number,
  halfBase: number,
): number[] {
  // Zero stroke: the band is EMPTY, so the inner ring is the identity (hole =
  // the shape itself — pure fill semantics), the same contract as
  // starErosionRing's sw = 0. Anything else (e.g. the un-insetted body ring
  // falling out of regime 2 below) would cancel the body out of the
  // outer − inner coverage and erase it from the render.
  if (strokeWidth <= EPS) return Array.from(outer);
  const inTri = (o: Pt, a: Pt, b: Pt, p: Pt) => {
    const cross = (v1: Pt, v2: Pt, q: Pt) =>
      (v2.x - v1.x) * (q.y - v1.y) - (v2.y - v1.y) * (q.x - v1.x);
    const d1 = cross(o, a, p);
    const d2 = cross(a, b, p);
    const d3 = cross(b, o, p);
    const neg = d1 < -EPS || d2 < -EPS || d3 < -EPS;
    const pos = d1 > EPS || d2 > EPS || d3 > EPS;
    return !(neg && pos);
  };
  const r = Math.min(Math.max(cornerRadius, 0), Math.min(size.x, size.y) / 2);
  const ix = body.x + strokeWidth;
  const iy = body.y + strokeWidth;
  const iw = size.x - 2 * strokeWidth;
  const ih = size.y - 2 * strokeWidth;
  if (iw <= EPS || ih <= EPS) return []; // solid: the stroke swallowed the body
  const bodyInner = roundedRectRing(ix, iy, iw, ih, r - strokeWidth, 5);

  // Eroded wedge: flank offset lines (sw toward the wedge interior).
  const centre = { x: body.x + size.x / 2, y: body.y + size.y / 2 };
  const tdx = tip.x - centre.x;
  const tdy = tip.y - centre.y;
  const tlen = Math.hypot(tdx, tdy);
  if (tlen < 1e-4) return bodyInner; // degenerate tail → plain eroded body
  const dir = { x: tdx / tlen, y: tdy / tlen };
  const baseA = { x: centre.x - dir.y * halfBase, y: centre.y + dir.x * halfBase };
  const baseB = { x: centre.x + dir.y * halfBase, y: centre.y - dir.x * halfBase };
  // Inward normals: each flank's normal pointing toward the opposite base.
  const inwardNormal = (from: Pt, to: Pt, other: Pt) => {
    const ex = to.x - from.x;
    const ey = to.y - from.y;
    const l = Math.hypot(ex, ey);
    const nx = -ey / l;
    const ny = ex / l;
    // flip toward the opposite base point
    const mx = (from.x + to.x) / 2;
    const my = (from.y + to.y) / 2;
    return (nx * (other.x - mx) + ny * (other.y - my)) > 0
      ? { x: nx, y: ny }
      : { x: -nx, y: -ny };
  };
  const nA = inwardNormal(tip, baseA, baseB);
  const nB = inwardNormal(tip, baseB, baseA);
  const flankA = { x: tip.x + nA.x * strokeWidth, y: tip.y + nA.y * strokeWidth };
  const flankB = { x: tip.x + nB.x * strokeWidth, y: tip.y + nB.y * strokeWidth };
  const dirA = { x: baseA.x - tip.x, y: baseA.y - tip.y };
  const dirB = { x: baseB.x - tip.x, y: baseB.y - tip.y };
  // Erased-tip miter of the two offset lines — the eroded wedge exists only
  // if it lands inside the wedge triangle.
  const den = dirA.x * dirB.y - dirA.y * dirB.x;
  if (Math.abs(den) < 1e-9) return bodyInner; // parallel offsets — collapsed
  const sA = ((flankB.x - flankA.x) * dirB.y - (flankB.y - flankA.y) * dirB.x) / den;
  const miter = {
    x: flankA.x + dirA.x * sA,
    y: flankA.y + dirA.y * sA,
  };
  if (!inTri(tip, baseA, baseB, miter)) return bodyInner;

  // Attach points: walking each flank offset line from the eroded tip toward
  // the mouth, the first crossing with the eroded body's boundary.
  const attach = (from: Pt, d: Pt) => {
    let best: { x: number; y: number; t: number } | null = null;
    const m = bodyInner.length / 2;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      const hit = segIntersect(
        from,
        { x: from.x + d.x * 1e4, y: from.y + d.y * 1e4 },
        { x: bodyInner[2 * i], y: bodyInner[2 * i + 1] },
        { x: bodyInner[2 * j], y: bodyInner[2 * j + 1] },
      );
      if (hit && (!best || hit.t < best.t)) best = { x: hit.x, y: hit.y, t: hit.t };
    }
    return best;
  };
  const mouthDirA = { x: dirA.x / (Math.hypot(dirA.x, dirA.y) || 1), y: dirA.y / (Math.hypot(dirA.x, dirA.y) || 1) };
  const mouthDirB = { x: dirB.x / (Math.hypot(dirB.x, dirB.y) || 1), y: dirB.y / (Math.hypot(dirB.x, dirB.y) || 1) };
  const pA = attach(miter, mouthDirA);
  const pB = attach(miter, mouthDirB);
  if (!pA || !pB) return bodyInner; // wedge eroded fully inside the body inset

  // Walk the eroded body's boundary from pA to pB along the span FACING AWAY
  // from the mouth (the mouth-facing span is interior to the eroded union);
  // the arc whose midpoint sits inside the pA–miter–pB triangle is the
  // mouth-facing one. Same-edge attach points take the along-direction
  // anchor rule (never walk back through the other attach point).
  const m = bodyInner.length / 2;
  const edgeOf = (p: Pt) => {
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      const ax = bodyInner[2 * i], ay = bodyInner[2 * i + 1];
      const ex = bodyInner[2 * j] - ax, ey = bodyInner[2 * j + 1] - ay;
      const l2 = ex * ex + ey * ey;
      const t = l2 > 0 ? ((p.x - ax) * ex + (p.y - ay) * ey) / l2 : 0;
      if (t >= -EPS && t <= 1 + EPS
        && Math.hypot(p.x - (ax + ex * t), p.y - (ay + ey * t)) < 1e-3) return i;
    }
    return 0;
  };
  const iA = edgeOf(pA);
  const iB = edgeOf(pB);
  const stepsAB = ((iB - iA) + m) % m;
  const walkArc = (fromEdge: number, steps: number, from: Pt, to: Pt) => {
    const out: number[] = [from.x, from.y];
    for (let s = 0; s < steps; s++) {
      const idx = (fromEdge + 1 + s) % m;
      out.push(bodyInner[2 * idx], bodyInner[2 * idx + 1]);
    }
    out.push(to.x, to.y);
    return out;
  };
  const arcAB = walkArc(iA, stepsAB, pA, pB);
  const kept = stepsAB !== 0
    ? walkArc(iB, m - stepsAB, pB, pA)
    : (() => {
      const ax = bodyInner[2 * iA], ay = bodyInner[2 * iA + 1];
      const ex = bodyInner[2 * ((iA + 1) % m)] - ax;
      const ey = bodyInner[2 * ((iA + 1) % m) + 1] - ay;
      const along = (p: Pt) => (p.x - ax) * ex + (p.y - ay) * ey;
      return along(pA) >= along(pB) ? walkArc(iA, m, pA, pB) : walkArc(iA, m, pB, pA);
    })();
  const midOf = (pts: readonly number[]): Pt => {
    let total = 0;
    const lens: number[] = [];
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const l = Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
      lens.push(l);
      total += l;
    }
    let acc = total / 2;
    for (let i = 0, k = 0; i + 3 < pts.length; i += 2, k++) {
      if (acc <= lens[k]) {
        const t = lens[k] > 0 ? acc / lens[k] : 0;
        return { x: pts[i] + (pts[i + 2] - pts[i]) * t, y: pts[i + 1] + (pts[i + 3] - pts[i + 1]) * t };
      }
      acc -= lens[k];
    }
    return { x: pts[pts.length - 2], y: pts[pts.length - 1] };
  };
  const mouthSpan = inTri(miter, pA, pB, midOf(arcAB)) ? arcAB : kept;
  // The ring keeps the span AWAY from the mouth and closes through the
  // eroded tip; the mouth-facing span is interior to the eroded union.
  const backSpan = mouthSpan === arcAB ? kept : arcAB;
  return [...backSpan, miter.x, miter.y];
}

/**
 * Capsule ∪ head triangle(s) union outline (segment family), closed-form
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
  // Head base half-width, floored at the shaft radius: a base narrower than
  // the shaft could not contain the shaft's flat base end (the shader cuts
  // the shaft flush at each headed base plane and floors the triangle base by
  // the SAME formula — see `sdf_line_segment` and the plugin's vertex helper).
  const headHalf = Math.max(headLen * 0.5, halfW);
  const squat = headHalf <= halfW + EPS; // floor active — corner == base point
  const shaftA = headA ? { x: a.x + dir.x * headLen, y: a.y + dir.y * headLen } : a;
  const shaftB = headB ? { x: b.x - dir.x * headLen, y: b.y - dir.y * headLen } : b;
  // NO zero-length-shaft bail here: the length clamp guarantees the clipped
  // ends never cross, and the fully-consumed shaft (headLen == fullLen, a
  // short drag under a wide stroke) is a legitimate limit the walk handles —
  // the cap arcs and base points collapse onto one station and the union
  // degrades to the squat head plus its rounded back.
  const at = (c: Pt, s: number, w: number) => ({ x: c.x + nrm.x * w * s, y: c.y + nrm.y * w * s });
  const verts: number[] = [];
  // 1. Back end (A). Head: tip → corner(−) → base point(−). Cap: arc from
  //    +n·halfW through −dir around to −n·halfW.
  if (headA) {
    const baseM = at(shaftA, -1, halfW);
    if (squat) {
      verts.push(a.x, a.y, baseM.x, baseM.y);
    } else {
      const cornerM = at(shaftA, -1, headHalf);
      verts.push(a.x, a.y, cornerM.x, cornerM.y, baseM.x, baseM.y);
    }
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
    const baseP = at(shaftB, +1, halfW);
    if (squat) {
      // The −side base point was already emitted (side 2) and coincides with
      // the floored corner; likewise corner(+) == base(+).
      verts.push(b.x, b.y, baseP.x, baseP.y);
    } else {
      const cornerM = at(shaftB, -1, headHalf);
      const cornerP = at(shaftB, +1, headHalf);
      verts.push(cornerM.x, cornerM.y, b.x, b.y, cornerP.x, cornerP.y, baseP.x, baseP.y);
    }
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
    const baseP = at(shaftA, +1, halfW);
    if (squat) {
      verts.push(baseP.x, baseP.y);
    } else {
      const cornerP = at(shaftA, +1, headHalf);
      verts.push(baseP.x, baseP.y, cornerP.x, cornerP.y);
    }
  }
  return verts;
}


/**
 * Closed-form TRUE erosion of a radial star / polygon ring by `offset` px —
 * the stroke band's inner boundary. The half-plane intersection this replaces
 * was structurally wrong: the intersection of half-planes is necessarily
 * CONVEX, so a concave star's inner ring lost every valley and degenerated
 * into the central pentagon. The true erosion boundary is built here vertex
 * by vertex, exactly:
 *
 * - CONVEX vertex (a spike tip): the two adjacent edge offset lines meet at
 *   the miter corner — the true erosion corner, sharp, at depth
 *   `offset / sin(half-angle)` along the bisector;
 * - REFLEX vertex (a valley): the two offset lines DIVERGE, and the true
 *   erosion boundary is the arc of radius `offset` centred on the valley
 *   vertex — every arc point sits exactly `offset` from the vertex, which is
 *   its nearest boundary point inside the valley's Voronoi wedge. The arc is
 *   polygonized with K chords; the chord sagitta stays far below a
 *   discernible pixel at marker stroke widths.
 *
 * Because consecutive constructions share the offset line of the edge between
 * them, every straight segment of the walk lies ON an edge-parallel offset
 * line — the chord-parallel property the old intersection comment claimed,
 * which actually falls out of this construction.
 *
 * Contract (mirrors the shader's interior = shape eroded by the FULL stroke
 * width):
 * - the spike-walk ring (miters + valley arcs) while the spikes survive — the
 *   common regime;
 * - the VALLEY-DISK ring (see `valleyDiskRing`) once the spike miters cross
 *   the neighbouring valley disks — the hole is then their intersection, and
 *   the analytic path continues without any fallback;
 * - `[]` when the band swallowed the hole (the eroded set is empty — for the
 *   radial family exactly when the ring centroid, its deepest point, sits
 *   closer than `offset` to the boundary): the caller renders SOLID;
 * - `null` only for degenerate input (malformed ring); the caller falls back
 *   to the legacy SDF path.
 */
function starErosionRing(verts: readonly number[], offset: number): number[] | null {
  const n = verts.length / 2;
  if (n < 3) return null;
  // Zero-width stroke: the hole is the shape itself (stroke coverage ≈ 0, the
  // fill paints the interior — the legacy `d ≤ −0` interior, not a solid).
  if (offset <= EPS) return verts.slice();
  const area = signedArea(verts);
  if (Math.abs(area) < EPS) return null;
  // Ring centroid — for the radial family it is the ring's deepest point, so
  // its distance to the boundary decides emptiness exactly. Every edge's
  // inward side contains it (the family is star-shaped around it), so the
  // per-edge inward normal never depends on the winding convention.
  let gcx = 0;
  let gcy = 0;
  for (let v = 0; v < n; v++) {
    gcx += verts[2 * v];
    gcy += verts[2 * v + 1];
  }
  gcx /= n;
  gcy /= n;
  const nx = new Float64Array(n);
  const ny = new Float64Array(n);
  for (let e = 0; e < n; e++) {
    const j = (e + 1) % n;
    const ex = verts[2 * j] - verts[2 * e];
    const ey = verts[2 * j + 1] - verts[2 * e + 1];
    const len = Math.hypot(ex, ey);
    if (len < EPS) return null;
    let ux = ey / len;
    let uy = -ex / len;
    if (ux * (gcx - verts[2 * e]) + uy * (gcy - verts[2 * e + 1]) < 0) {
      ux = -ux;
      uy = -uy;
    }
    nx[e] = ux;
    ny[e] = uy;
  }
  // Emptiness probe: the centroid strictly shallower than the offset means no
  // point of the ring sits `offset` deep — the eroded set is empty and the
  // correct render is a SOLID shape (an empty inner ring).
  for (let e = 0; e < n; e++) {
    if (edgeDistance(verts, e, gcx, gcy) < offset - EPS) {
      return [];
    }
  }
  // Vertex classification: a convex vertex turns the boundary the same way the
  // ring winds (miter corner); a reflex vertex turns against it (valley arc).
  const convex: boolean[] = new Array(n);
  let reflexCount = 0;
  for (let i = 0; i < n; i++) {
    const p = (i - 1 + n) % n;
    const j = (i + 1) % n;
    const d1x = verts[2 * i] - verts[2 * p];
    const d1y = verts[2 * i + 1] - verts[2 * p + 1];
    const d2x = verts[2 * j] - verts[2 * i];
    const d2y = verts[2 * j + 1] - verts[2 * i + 1];
    convex[i] = (d1x * d2y - d1y * d2x) * area > 0;
    if (!convex[i]) reflexCount++;
  }
  // Chords per valley arc, from the shared vertex budget: the walk emits one
  // vertex per convex vertex and (chords + 1) per reflex vertex. When the
  // budget allows no chord at all (high point counts — the 12-point preset),
  // each valley degenerates to a SINGLE bisector point: shallow valleys
  // (large n) keep that point visually on the exact boundary, and the ring
  // stays within the uniform vertex budget instead of falling back.
  let chords = 0;
  if (reflexCount > 0) {
    chords = Math.max(0, Math.floor((SDF_POLY_MAX_VERTS - (n - reflexCount)) / reflexCount) - 1);
    chords = Math.min(chords, 8);
  }
  // Walk the erosion boundary in ring order. Consecutive constructions share
  // the offset line of the edge between them (a miter corner and the next
  // valley's tangent point both sit on it), so the straight walk segments are
  // exact edge-parallel offset lines.
  const inner: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = (i - 1 + n) % n;
    if (convex[i]) {
      // Miter corner: intersection of the two adjacent offset lines.
      const den = nx[p] * ny[i] - ny[p] * nx[i];
      if (Math.abs(den) < 1e-9) return null; // parallel offset edges — no corner
      const c1 = nx[p] * verts[2 * p] + ny[p] * verts[2 * p + 1] + offset;
      const c2 = nx[i] * verts[2 * i] + ny[i] * verts[2 * i + 1] + offset;
      const x = (c1 * ny[i] - c2 * ny[p]) / den;
      const y = (nx[p] * c2 - nx[i] * c1) / den;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      inner.push(x, y);
    } else if (chords === 0) {
      // Budget-exhausted valley: the single bisector point (the arc's mid
      // position — for shallow valleys indistinguishable from the arc).
      const bx = nx[p] + nx[i];
      const by = ny[p] + ny[i];
      const bl = Math.hypot(bx, by);
      if (bl < 1e-9) return null; // degenerate normals — cannot bisect
      inner.push(verts[2 * i] + (bx / bl) * offset, verts[2 * i + 1] + (by / bl) * offset);
    } else {
      // Valley arc: polygonize the radius-`offset` circle around the vertex
      // between the two tangent points (the feet of the perpendiculars onto
      // the adjacent offset lines — edge p ends at the vertex, edge i leaves
      // it), sweeping through the interior bisector.
      const t1x = verts[2 * i] + nx[p] * offset;
      const t1y = verts[2 * i + 1] + ny[p] * offset;
      const t2x = verts[2 * i] + nx[i] * offset;
      const t2y = verts[2 * i + 1] + ny[i] * offset;
      const a1 = Math.atan2(t1y - verts[2 * i + 1], t1x - verts[2 * i]);
      const a2 = Math.atan2(t2y - verts[2 * i + 1], t2x - verts[2 * i]);
      let sweep = a2 - a1;
      while (sweep > Math.PI) sweep -= 2 * Math.PI;
      while (sweep <= -Math.PI) sweep += 2 * Math.PI;
      const mid = a1 + sweep / 2;
      // The interior sweep is the one whose mid direction faces the centroid;
      // for a reflex vertex the short sweep already does, so this flip is a
      // numerical safety net, not the expected path.
      if (Math.cos(mid) * (gcx - verts[2 * i]) + Math.sin(mid) * (gcy - verts[2 * i + 1]) < 0) {
        sweep = sweep > 0 ? sweep - 2 * Math.PI : sweep + 2 * Math.PI;
      }
      for (let k = 0; k <= chords; k++) {
        const ang = a1 + (sweep * k) / chords;
        inner.push(verts[2 * i] + Math.cos(ang) * offset, verts[2 * i + 1] + Math.sin(ang) * offset);
      }
    }
  }
  // Validity: same orientation, non-degenerate area, no self-intersection, and
  // every vertex strictly inside the source ring. A failure here means the
  // exact construction folded (deep stroke) while the hole still exists — the
  // FOLD regime: the hole is then the intersection of the valley disks, built
  // by `valleyDiskRing`, so the analytic path continues without a fallback.
  const innerArea = signedArea(inner);
  if (innerArea * area <= 0 || Math.abs(innerArea) < EPS) {
    return valleyDiskRing(verts, convex, offset, gcx, gcy);
  }
  const m = inner.length / 2;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    for (let k = i + 2; k < m; k++) {
      if (i === 0 && k === m - 1) continue; // adjacent through the wraparound
      const l = (k + 1) % m;
      if (segIntersect(
        { x: inner[2 * i], y: inner[2 * i + 1] },
        { x: inner[2 * j], y: inner[2 * j + 1] },
        { x: inner[2 * k], y: inner[2 * k + 1] },
        { x: inner[2 * l], y: inner[2 * l + 1] },
      )) return valleyDiskRing(verts, convex, offset, gcx, gcy);
    }
  }
  for (let v = 0; v < m; v++) {
    if (!pointInRing(verts, { x: inner[2 * v], y: inner[2 * v + 1] })) {
      return valleyDiskRing(verts, convex, offset, gcx, gcy);
    }
  }
  // Every MITER corner must sit at least `offset` from the whole boundary — a
  // miter nearer to some OTHER boundary piece than to its own flanks (spike
  // miters crossing the neighbouring valley disks at deep strokes) means the
  // spike walk no longer describes the hole. Valley vertices are EXEMPT: arc
  // vertices are exactly `offset` from their own valley by construction, and
  // budget-degenerate bisector points seat marginally inside the band —
  // neither ever indicates a fold.
  for (let v = 0; v < m; v++) {
    if (!convex[v]) continue;
    let d = Infinity;
    for (let e = 0; e < n; e++) {
      d = Math.min(d, edgeDistance(verts, e, inner[2 * v], inner[2 * v + 1]));
    }
    if (d < offset - 1e-6) return valleyDiskRing(verts, convex, offset, gcx, gcy);
  }
  return inner;
}

/**
 * The FOLD-regime hole: the spike miters have crossed the neighbouring valley
 * disks, so the eroded hole is the intersection of the valley disks (each of
 * radius `offset` centred on a valley vertex) — bounded purely by the valley
 * arcs between adjacent-disk intersection points. Closed form: standard
 * two-circle intersections for the arc endpoints, each arc polygonized into
 * chords. The emptiness probe upstream guarantees the common disk region is
 * non-empty here; degenerate geometry returns null (legacy fallback).
 */
function valleyDiskRing(
  verts: readonly number[],
  convex: readonly boolean[],
  offset: number,
  gcx: number,
  gcy: number,
): number[] | null {
  const valleys: Pt[] = [];
  for (let i = 0; i < verts.length / 2; i++) {
    if (!convex[i]) valleys.push({ x: verts[2 * i], y: verts[2 * i + 1] });
  }
  const nv = valleys.length;
  if (nv < 3) return null;
  const chords = Math.min(8, Math.max(1, Math.floor(SDF_POLY_MAX_VERTS / nv) - 1));
  // Inner intersection point of each adjacent valley-disk pair (the two-circle
  // formula; the hole's inner envelope takes the candidate nearer the
  // centroid).
  const joints: Pt[] = new Array(nv);
  for (let k = 0; k < nv; k++) {
    const A = valleys[k];
    const B = valleys[(k + 1) % nv];
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const d = Math.hypot(dx, dy);
    if (d < EPS || d > 2 * offset) return null; // disks don't overlap — not the fold regime
    const mx = A.x + dx / 2;
    const my = A.y + dy / 2;
    const h = Math.sqrt(Math.max(0, offset * offset - (d / 2) * (d / 2)));
    const ux = dy / d;
    const uy = -dx / d;
    const ax = mx + ux * h;
    const ay = my + uy * h;
    const bx = mx - ux * h;
    const by = my - uy * h;
    joints[k] = (ax - gcx) * (ax - gcx) + (ay - gcy) * (ay - gcy)
      <= (bx - gcx) * (bx - gcx) + (by - gcy) * (by - gcy)
      ? { x: ax, y: ay }
      : { x: bx, y: by };
  }
  // Walk the arcs: valley k's arc runs from its joint with the previous
  // valley's disk to its joint with the next, sweeping through the interior.
  const ring: number[] = [];
  for (let k = 0; k < nv; k++) {
    const V = valleys[k];
    const from = joints[(k - 1 + nv) % nv];
    const to = joints[k];
    const a1 = Math.atan2(from.y - V.y, from.x - V.x);
    const a2 = Math.atan2(to.y - V.y, to.x - V.x);
    let sweep = a2 - a1;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep <= -Math.PI) sweep += 2 * Math.PI;
    const mid = a1 + sweep / 2;
    if (Math.cos(mid) * (gcx - V.x) + Math.sin(mid) * (gcy - V.y) < 0) {
      sweep = sweep > 0 ? sweep - 2 * Math.PI : sweep + 2 * Math.PI;
    }
    for (let c = 0; c <= chords; c++) {
      const ang = a1 + (sweep * c) / chords;
      ring.push(V.x + Math.cos(ang) * offset, V.y + Math.sin(ang) * offset);
    }
  }
  const ringArea = signedArea(ring);
  if (!Number.isFinite(ringArea) || Math.abs(ringArea) < EPS) return null;
  return ring;
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
    outer = starOutline(w, h, shapeParams[0] ?? 5, shapeParams[1] ?? 3.2, {
      rxScale: shapeParams[2] ?? 0,
      ryScale: shapeParams[3] ?? 0,
      cxDelta: shapeParams[4] ?? 0,
      cyDelta: shapeParams[5] ?? 0,
    });
    needsInner = true;
  } else if (prim === 'callout') {
    const cornerRadius = shapeParams[6] ?? 0;
    const body = { x: shapeParams[0] ?? 0, y: shapeParams[1] ?? 0 };
    const bodySize = { x: shapeParams[2] ?? w, y: shapeParams[3] ?? h };
    const tip = { x: shapeParams[4] ?? 0, y: shapeParams[5] ?? 0 };
    const halfBase = shapeParams[7] ?? 0;
    // Rounded body corners are polygonized into the ring (`calloutOutline`),
    // so the analytic path covers every corner radius — no legacy gate.
    outer = calloutOutline(body, bodySize, tip, halfBase, cornerRadius);
    needsInner = true;
  } else if (prim === 'line-segment') {
    const halfW = strokeWidth / 2;
    const a = { x: shapeParams[0] ?? 0, y: shapeParams[1] ?? 0 };
    const b = { x: shapeParams[2] ?? 0, y: shapeParams[3] ?? 0 };
    const headA = (shapeParams[4] ?? 0) > 0.5;
    const headB = (shapeParams[5] ?? 0) > 0.5;
    // Same length clamp as the shader / plugin geometry (effectiveHeadLen):
    // the heads share the length budget so the clipped shaft never inverts.
    const nHeads = (headA ? 1 : 0) + (headB ? 1 : 0);
    const fullLen = Math.hypot(b.x - a.x, b.y - a.y);
    const headLen = headA || headB
      ? Math.min(Math.max(0, strokeWidth * headScale), Math.max(fullLen, 1e-4) / nHeads)
      : 0;
    if (headLen <= EPS) {
      // A degenerate head length contributes no head: the shape is the plain
      // stadium (the shader treats it headless too).
      outer = capsuleHeadsOutline(a, b, halfW, 0, false, false);
    } else {
      // The base-width floor inside capsuleHeadsOutline makes ANY head length
      // renderable (a head narrower than the shaft renders as a squat
      // triangle wrapped around the flat-cut shaft) — no thin-head refusal.
      outer = capsuleHeadsOutline(a, b, halfW, headLen, headA, headB);
    }
  } else if (prim === 'rounded_rect') {
    // The shader's zero set is the FULL layer rect with the clamped corner
    // radius; the ring mirrors it exactly. The eroded inner ring is a rounded
    // rect again (rect + disc Minkowski erosion keeps the shape with corner
    // radius r - sw); empty inset = solid, expressed through the shared
    // needsInner path below.
    const r = Math.min(Math.max(shapeParams[0] ?? 0, 0), Math.min(w, h) / 2);
    outer = roundedRectRing(0, 0, w, h, r);
    needsInner = true;
  } else if (prim === 'ellipse') {
    // The shader's zero set is the exact ellipse centred in the layer; a 32-gon
    // inscribed in it is the ring (full vertex budget, sagitta ~0.005·rx). The
    // eroded ellipse is NOT an ellipse (normal offset curve), so the inner ring
    // takes the miter inset of the polygon — a convex ring with near-flat
    // vertex angles (miters overshoot ~0.5%), conservative ink, never holes.
    outer = ellipseRing(w, h);
    needsInner = true;
  } else {
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
    // The radial family takes the closed-form TRUE erosion (mitered spike
    // corners + polygonized valley arcs — see starErosionRing); the half-plane
    // intersection it replaces is necessarily convex and amputated the star's
    // valleys. The callout takes its own conservative construction
    // (`calloutInnerRing`).
    // star: an EMPTY ring means the band swallowed the hole entirely — the
    // correct render is a SOLID star, expressed as an outline with no inner
    // ring. Once the spike walk folds, the valley-disk ring continues the
    // analytic path through the fold regime — no fallback, no preview/render
    // regime flip.
    const inset = prim === 'star'
      ? starErosionRing(outer, strokeWidth)
      : prim === 'callout'
        ? calloutInnerRing(
          outer,
          { x: shapeParams[0] ?? 0, y: shapeParams[1] ?? 0 },
          { x: shapeParams[2] ?? w, y: shapeParams[3] ?? h },
          { x: shapeParams[4] ?? 0, y: shapeParams[5] ?? 0 },
          shapeParams[6] ?? 0,
          strokeWidth,
          shapeParams[7] ?? 0,
        )
        : prim === 'rounded_rect'
          ? roundedRectInnerRing(w, h, shapeParams[0] ?? 0, strokeWidth)
          : ellipseInnerRing(outer, w, h, strokeWidth);
    if (prim === 'star') {
      if (inset === null) return fallback(prim, 'stroke erosion degenerate');
      if (inset.length > 0 && inset.length / 2 > SDF_POLY_MAX_VERTS) return fallback(prim, 'inner ring budget');
      inner = inset;
    } else {
      if (!inset) return fallback(prim, 'stroke inset degenerate');
      if (inset.length / 2 > SDF_POLY_MAX_VERTS) return fallback(prim, 'inner ring budget');
      inner = inset;
    }
  }
  return { outer, inner };
}

function fallback(prim: SdfPrimitive, reason: string): null {
  console.warn(`[sdf-polygon-solver] ${prim}: smoothstep fallback (${reason})`);
  return null;
}
