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
 * bezier.ts — L0 cubic bézier operator family.
 *
 * Pure, DOM-free math for pen-path curve data: evaluation (de Casteljau),
 * tangents, arc-length tabulation, midpoint splitting, adaptive flattening
 * (the single exit form that feeds mask baking / selections / stroke
 * rendering), nearest-point queries for interaction, Schneider-style
 * least-squares fitting of polylines back into draggable anchor chains, and
 * SVG path `d` serialization/parsing.
 *
 * Data-model discipline: curve payloads persist as `PenPathData` (anchors +
 * relative handles); everything downstream of the pen tool consumes the
 * flattened `Point2D[]` polylines. This mirrors the existing Shape vs Polygon
 * split and MUST NOT be merged into a single representation — flattening is
 * lossy by design (bounded by the tolerance argument), fitting is lossy by
 * design (bounded the same way in the opposite direction).
 *
 * All coordinates are layer-local document pixels unless noted otherwise.
 * Screen-pixel thresholds (hit radius, handle size) are converted by the
 * caller in the plugin layer before reaching these functions.
 */

import { Point2D, CubicSegment, PenAnchor, PenSubPath, PenPathData } from '@opengpex/editor/core/types';

/** A turn angle above this many degrees (exterior) marks a sharp corner. */
const CORNER_TURN_DEG_DEFAULT = 60;
/** Hard recursion caps so pathological data cannot hang the flatten/fit loops. */
const MAX_FLATTEN_DEPTH = 24;
const MAX_FIT_DEPTH = 24;
/** Subdivision flatness margin: the true curve-to-chord distance of a cubic
 *  is at most 3/4 of the largest middle-control-point offset from the chord,
 *  so subdividing while that offset exceeds tolerance/2 bounds the real
 *  deviation well under the caller's tolerance. */
const FLATTEN_SAFETY = 0.5;

type Vec2 = Point2D;

const vec = (x: number, y: number): Vec2 => ({ x, y });
const sub = (a: Vec2, b: Vec2): Vec2 => vec(a.x - b.x, a.y - b.y);
const add = (a: Vec2, b: Vec2): Vec2 => vec(a.x + b.x, a.y + b.y);
const mul = (a: Vec2, s: number): Vec2 => vec(a.x * s, a.y * s);
const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
const len = (a: Vec2): number => Math.hypot(a.x, a.y);
const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

function normalize(v: Vec2): Vec2 {
  const l = len(v);
  return l < 1e-12 ? vec(0, 0) : vec(v.x / l, v.y / l);
}

/** Perpendicular distance from point to the infinite line through a→b.
 *  Falls back to the point distance when the line degenerates. */
function perpDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const l = len(ab);
  if (l < 1e-12) return dist(p, a);
  return Math.abs((p.x - a.x) * ab.y - (p.y - a.y) * ab.x) / l;
}

// ─────────────────────────── Evaluation & splitting ───────────────────────────

/**
 * Evaluates the cubic bézier B(t) through de Casteljau repeated linear
 * interpolation — numerically the most stable evaluation form and the same
 * lattice `splitCubic` reuses for its control-point bookkeeping.
 */
export function evaluateCubic(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Point2D {
  const u = 1 - t;
  const ax = u * p0.x + t * p1.x, ay = u * p0.y + t * p1.y;
  const bx = u * p1.x + t * p2.x, by = u * p1.y + t * p2.y;
  const cx = u * p2.x + t * p3.x, cy = u * p2.y + t * p3.y;
  const dx = u * ax + t * bx, dy = u * ay + t * by;
  const ex = u * bx + t * cx, ey = u * by + t * cy;
  return vec(u * dx + t * ex, u * dy + t * ey);
}

/** First derivative (tangent vector, NOT normalized) of the cubic at t. */
export function tangentAt(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Point2D {
  const u = 1 - t;
  return vec(
    3 * u * u * (p1.x - p0.x) + 6 * u * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x),
    3 * u * u * (p1.y - p0.y) + 6 * u * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y),
  );
}

/**
 * Splits the cubic at parameter t into left and right sub-segments via the
 * de Casteljau lattice: each level of lerped points supplies the control
 * points of one half. The halves join exactly: left(1) === right(0) === B(t).
 */
export function splitCubic(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): [CubicSegment, CubicSegment] {
  const u = 1 - t;
  const lerp = (a: Vec2, b: Vec2) => vec(u * a.x + t * b.x, u * a.y + t * b.y);
  const a01 = lerp(p0, p1), a12 = lerp(p1, p2), a23 = lerp(p2, p3);
  const b012 = lerp(a01, a12), b123 = lerp(a12, a23);
  const c = lerp(b012, b123);
  return [
    { p0, p1: a01, p2: b012, p3: c },
    { p0: c, p1: b123, p2: a23, p3 },
  ];
}

// ─────────────────────────── Arc length ───────────────────────────

/**
 * Adaptive arc-length tabulation: recursively subdivides the curve until each
 * leaf's control-polygon length matches its chord length to within 1e-4 doc px
 * (flat leaves are indistinguishable from straight lines at that scale), then
 * accumulates chord lengths. Returns the CUMULATIVE length at each
 * subdivision node, starting at 0 — the last entry is the total arc length.
 * Monotone non-decreasing, suitable for binary search of t by arclength.
 */
export function arcLengths(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2): number[] {
  const acc: number[] = [0];
  const walk = (a: Vec2, b: Vec2, c: Vec2, d: Vec2, depth: number): void => {
    const poly = dist(a, b) + dist(b, c) + dist(c, d);
    const chord = dist(a, d);
    if (poly - chord <= 1e-5 || depth >= MAX_FLATTEN_DEPTH) {
      acc.push(acc[acc.length - 1] + chord);
      return;
    }
    const [l, r] = splitCubic(a, b, c, d, 0.5);
    walk(l.p0, l.p1, l.p2, l.p3, depth + 1);
    walk(r.p0, r.p1, r.p2, r.p3, depth + 1);
  };
  walk(p0, p1, p2, p3, 0);
  return acc;
}

// ─────────────────────────── Flattening ───────────────────────────

/**
 * Flattens a chain of cubic segments into a polyline. The chain is treated as
 * continuous: each segment's start point must equal the previous segment's
 * end point (a duplicated point is emitted only once).
 *
 * Adaptive subdivision: curved regions split densely, flat regions collapse
 * to single chords. `toleranceDocPx` bounds the true curve-to-polyline
 * deviation in document pixels — independent of zoom, so the same data
 * flattens identically at any zoom level or export size.
 */
export function flattenCubicChain(segments: readonly CubicSegment[], toleranceDocPx: number): Point2D[] {
  const out: Point2D[] = [];
  const threshold = Math.max(toleranceDocPx * FLATTEN_SAFETY, 1e-6);
  const push = (p: Point2D) => {
    const last = out[out.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) out.push(vec(p.x, p.y));
  };
  for (const seg of segments) {
    push(seg.p0);
    flattenOne(seg, threshold, 0, push);
  }
  return out;
}

function flattenOne(seg: CubicSegment, threshold: number, depth: number, push: (p: Point2D) => void): void {
  const d1 = perpDistance(seg.p1, seg.p0, seg.p3);
  const d2 = perpDistance(seg.p2, seg.p0, seg.p3);
  if (Math.max(d1, d2) <= threshold || depth >= MAX_FLATTEN_DEPTH) {
    push(seg.p3);
    return;
  }
  const [l, r] = splitCubic(seg.p0, seg.p1, seg.p2, seg.p3, 0.5);
  flattenOne(l, threshold, depth + 1, push);
  flattenOne(r, threshold, depth + 1, push);
}

// ─────────────────────────── Nearest point (interaction) ───────────────────────────

export interface NearestPointResult {
  /** Parameter within the winning segment, 0..1. */
  t: number;
  /** Euclidean distance from the query point to the curve. */
  dist: number;
  /** Index into the segment chain of the winning segment. */
  segmentIndex: number;
}

/**
 * Closest point on a cubic segment chain to `pt`, or null when the best
 * candidate is farther than `tolerance`. Coarse uniform sampling locates the
 * promising bracket per segment, then golden-section refinement converges the
 * parameter — accurate enough for screen-space hit testing where the caller
 * compares against a handle-radius threshold anyway.
 */
export function nearestPointOnPath(path: readonly CubicSegment[], pt: Vec2, tolerance: number): NearestPointResult | null {
  let bestIndex = -1;
  let bestT = 0;
  let bestDist = Infinity;
  const K = 16;
  for (let si = 0; si < path.length; si++) {
    const seg = path[si];
    let bi = 0;
    let bd = Infinity;
    for (let k = 0; k <= K; k++) {
      const t = k / K;
      const p = evaluateCubic(seg.p0, seg.p1, seg.p2, seg.p3, t);
      const d = dist(p, pt);
      if (d < bd) { bd = d; bi = k; }
    }
    const lo = Math.max(0, (bi - 1) / K);
    const hi = Math.min(1, (bi + 1) / K);
    // Golden-section search on the squared distance (unimodal within the bracket).
    const gr = (Math.sqrt(5) - 1) / 2;
    let a = lo, b = hi;
    let c = b - gr * (b - a), d2 = a + gr * (b - a);
    const sq = (t: number) => {
      const p = evaluateCubic(seg.p0, seg.p1, seg.p2, seg.p3, t);
      const dx = p.x - pt.x, dy = p.y - pt.y;
      return dx * dx + dy * dy;
    };
    let fc = sq(c), fd = sq(d2);
    for (let it = 0; it < 40 && b - a > 1e-7; it++) {
      if (fc < fd) {
        b = d2; d2 = c; fd = fc; c = b - gr * (b - a); fc = sq(c);
      } else {
        a = c; c = d2; fc = fd; d2 = a + gr * (b - a); fd = sq(d2);
      }
    }
    const tStar = (a + b) / 2;
    const dStar = Math.sqrt(sq(tStar));
    if (dStar < bestDist) {
      bestIndex = si; bestT = tStar; bestDist = dStar;
    }
  }
  if (bestIndex < 0 || bestDist > tolerance) return null;
  return { t: bestT, dist: bestDist, segmentIndex: bestIndex };
}

// ─────────────────────────── Anchor ↔ segment conversion ───────────────────────────

/** Resolves a relative handle slot to an absolute control point (null → anchor itself). */
function handleToAbs(anchor: PenAnchor, h: { x: number; y: number } | null | undefined): Point2D {
  return h ? vec(anchor.x + h.x, anchor.y + h.y) : vec(anchor.x, anchor.y);
}

/**
 * Converts an anchor-based pen path into the flat cubic segment chain the L0
 * math operates on. Open subpaths produce n-1 segments, closed subpaths
 * produce n (the closing segment reuses the first anchor's handles).
 */
export function penPathToCubicSegments(path: PenPathData): CubicSegment[] {
  const segs: CubicSegment[] = [];
  for (const sub of path.paths) {
    const a = sub.anchors;
    if (a.length < 2) continue;
    const count = sub.closed ? a.length : a.length - 1;
    for (let i = 0; i < count; i++) {
      const from = a[i];
      const to = a[(i + 1) % a.length];
      segs.push({
        p0: vec(from.x, from.y),
        p1: handleToAbs(from, from.handleOut),
        p2: handleToAbs(to, to.handleIn),
        p3: vec(to.x, to.y),
      });
    }
  }
  return segs;
}

// ─────────────────────────── Polyline → cubic fitting ───────────────────────────

/** Exterior turn angle at vertex cur, in degrees (0 = straight, 180 = reversal). */
function turnAngleDeg(prev: Vec2, cur: Vec2, next: Vec2): number {
  const v1 = sub(cur, prev), v2 = sub(next, cur);
  const n1 = len(v1), n2 = len(v2);
  if (n1 < 1e-12 || n2 < 1e-12) return 0;
  const c = Math.min(1, Math.max(-1, dot(v1, v2) / (n1 * n2)));
  return (Math.acos(c) * 180) / Math.PI;
}

/**
 * Fits an anchor chain to a dense polyline (Schneider-style least squares
 * with max-error splitting). Corners — vertices whose exterior turn angle
 * exceeds `cornerTurnDeg` — become sharp anchors with `handleIn`/`handleOut`
 * = null; the runs between corners are fitted independently, with the
 * corner-adjacent segment ends solved under the zero-handle constraint so the
 * reconstructed curve is exactly what was error-checked. All other anchors
 * get collinear (symmetric) handles. Round-trip error against the input
 * polyline is bounded by `toleranceDocPx`.
 */
export function fitCubicsToPolyline(
  ring: readonly Point2D[],
  toleranceDocPx: number,
  closed: boolean,
  cornerTurnDeg: number = CORNER_TURN_DEG_DEFAULT,
): PenAnchor[] {
  const pts = dedupeRing(ring, closed);
  const n = pts.length;
  if (n === 0) return [];
  if (n === 1) return [{ x: pts[0].x, y: pts[0].y }];
  const isClosed = closed && n >= 3;

  // Corner detection.
  const corner = new Array<boolean>(n).fill(false);
  if (isClosed) {
    for (let i = 0; i < n; i++) {
      if (turnAngleDeg(pts[(i - 1 + n) % n], pts[i], pts[(i + 1) % n]) > cornerTurnDeg) corner[i] = true;
    }
  } else {
    for (let i = 1; i < n - 1; i++) {
      if (turnAngleDeg(pts[i - 1], pts[i], pts[i + 1]) > cornerTurnDeg) corner[i] = true;
    }
  }

  // The fitter's error is measured at chord-length parameter nodes, which is
  // a proxy for the true polyline deviation. Verify the reconstructed curve
  // against the input and tighten the internal tolerance until the delivered
  // round-trip error honours the caller's bound.
  const target = Math.max(toleranceDocPx, 1e-6);
  let internalTol = target;
  let anchors: PenAnchor[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    anchors = buildAnchors(pts, corner, isClosed, internalTol);
    if (roundTripError(pts, anchors, isClosed, target) <= target) break;
    internalTol *= 0.5;
  }
  return anchors;
}

/** One fitting pass over corner-delimited runs at a given internal tolerance. */
function buildAnchors(pts: Point2D[], corner: boolean[], isClosed: boolean, tol: number): PenAnchor[] {
  const n = pts.length;
  const anchors: PenAnchor[] = [];
  const zero: FitEnd = { type: 'zero' };

  if (!isClosed) {
    const bounds = [0];
    for (let i = 1; i < n - 1; i++) if (corner[i]) bounds.push(i);
    bounds.push(n - 1);
    const free: FitEnd = { type: 'free' };
    for (let k = 0; k + 1 < bounds.length; k++) {
      const run = pts.slice(bounds[k], bounds[k + 1] + 1);
      // Corners are sharp (zero handle); the open path's own endpoints keep a
      // fitted inward handle — their outward side has no segment anyway.
      const startC = bounds[k] === 0 ? free : zero;
      const endC = bounds[k + 1] === n - 1 ? free : zero;
      appendRunAnchors(anchors, fitRun(run, tol, startC, endC), k > 0);
    }
    return anchors;
  }

  const corners: number[] = [];
  for (let i = 0; i < n; i++) if (corner[i]) corners.push(i);
  if (corners.length === 0) {
    // Fully smooth closed loop: one run wrapping back to its start anchor. The
    // wrap seam shares a central-difference tangent so it is G1 like any other.
    const d0 = normalize(sub(pts[1], pts[n - 1]));
    const segs = fitRun([...pts, pts[0]], tol, { type: 'fixed', d: d0 }, { type: 'fixed', d: mul(d0, -1) });
    appendRunAnchors(anchors, segs, false, true);
    return anchors;
  }
  for (let k = 0; k < corners.length; k++) {
    const start = corners[k];
    const end = corners[(k + 1) % corners.length];
    const run: Point2D[] = [];
    let i = start;
    for (;;) {
      run.push(pts[i]);
      if (i === end && run.length > 1) break;
      i = (i + 1) % n;
    }
    // The final run closes back onto the start anchor: drop its duplicate end.
    appendRunAnchors(anchors, fitRun(run, tol, zero, zero), k > 0, k === corners.length - 1);
  }
  return anchors;
}

/** Max distance from any input vertex to the curve reconstructed from the anchors. */
function roundTripError(pts: Point2D[], anchors: PenAnchor[], closed: boolean, tol: number): number {
  const segs = penPathToCubicSegments({ paths: [{ anchors, closed }] });
  if (segs.length === 0) return Infinity;
  const flat = flattenCubicChain(segs, tol / 8);
  let worst = 0;
  for (const pt of pts) {
    let best = Infinity;
    for (let i = 0; i + 1 < flat.length; i++) {
      const a = flat[i], b = flat[i + 1];
      const abx = b.x - a.x, aby = b.y - a.y;
      const l2 = abx * abx + aby * aby;
      let t = l2 > 0 ? ((pt.x - a.x) * abx + (pt.y - a.y) * aby) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(pt.x - (a.x + t * abx), pt.y - (a.y + t * aby)));
      if (best === 0) break;
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

/** Drops consecutive duplicates (and, for closed rings, a duplicated last point). */
function dedupeRing(ring: readonly Point2D[], closed: boolean): Point2D[] {
  let pts = ring.map(p => vec(p.x, p.y));
  if (closed && pts.length > 1 && dist(pts[0], pts[pts.length - 1]) < 1e-9) pts = pts.slice(0, -1);
  const out: Point2D[] = [];
  for (const p of pts) {
    if (out.length === 0 || dist(out[out.length - 1], p) > 1e-9) out.push(p);
  }
  return out;
}

/**
 * Handle constraint at a run boundary of the fitter.
 * - `zero`: the handle collapses onto the anchor (corner / path end).
 * - `free`: direction from the local polyline segments, magnitude solved.
 * - `fixed`: direction given (shared split tangent), magnitude solved.
 * Directions always point from the boundary INTO the run.
 */
type FitEnd =
  | { type: 'zero' }
  | { type: 'free' }
  | { type: 'fixed'; d: Vec2 };

/**
 * Core Schneider fit of one polyline run, with G1 continuity BY CONSTRUCTION:
 * every split reuses one central-difference tangent for both halves, so the
 * segments joined at an interior anchor always carry collinear handles and no
 * post-hoc symmetrization (which would perturb the error-checked geometry) is
 * ever needed. Boundary ends use a zero-handle constraint where the caller
 * found a corner, so the anchor-reconstructed curve equals the fitted curve
 * exactly and the measured error is the delivered error.
 *
 * Chord-length parameterization + least-squares handle magnitudes + recursive
 * split at the max-error vertex until the deviation drops under `tol`.
 */
function fitRun(pts: Point2D[], tol: number, startC: FitEnd, endC: FitEnd, depth = 0): CubicSegment[] {
  const n = pts.length;
  const p0 = pts[0], p3 = pts[n - 1];
  const chord = dist(p0, p3);
  if (n === 2) {
    const d1 = startC.type === 'zero' ? null : startC.type === 'free' ? normalize(sub(pts[1], pts[0])) : startC.d;
    const d2 = endC.type === 'zero' ? null : endC.type === 'free' ? normalize(sub(pts[n - 2], pts[n - 1])) : endC.d;
    return [{
      p0: vec(p0.x, p0.y),
      p1: d1 ? add(p0, mul(d1, chord / 3)) : vec(p0.x, p0.y),
      p2: d2 ? add(p3, mul(d2, chord / 3)) : vec(p3.x, p3.y),
      p3: vec(p3.x, p3.y),
    }];
  }

  // Chord-length parameterization.
  const u = new Array<number>(n);
  u[0] = 0;
  for (let i = 1; i < n; i++) u[i] = u[i - 1] + dist(pts[i - 1], pts[i]);
  const total = u[n - 1];
  if (total < 1e-12) return [{ p0: vec(p0.x, p0.y), p1: vec(p0.x, p0.y), p2: vec(p3.x, p3.y), p3: vec(p3.x, p3.y) }];
  for (let i = 0; i < n; i++) u[i] /= total;

  const t1 = startC.type === 'free' ? normalize(sub(pts[1], pts[0]))
    : startC.type === 'fixed' ? startC.d : null;
  const t2 = endC.type === 'free' ? normalize(sub(pts[n - 2], pts[n - 1]))
    : endC.type === 'fixed' ? endC.d : null;

  // Bernstein bases for the interior control points at parameter u.
  const b1 = (t: number) => 3 * t * (1 - t) * (1 - t);
  const b2 = (t: number) => 3 * t * t * (1 - t);
  // Everything in B(u) that does not depend on the unknown handle magnitudes:
  // with c1 = p0 + a1*d1 and c2 = p3 + a2*d2 the fixed part is
  // (b0 + b1)*p0 + (b2 + b3)*p3.
  const base = (t: number) => {
    const s = 1 - t;
    const w0 = s * s * s + 3 * s * s * t;
    const w3 = 3 * s * t * t + t * t * t;
    return vec(w0 * p0.x + w3 * p3.x, w0 * p0.y + w3 * p3.y);
  };

  // Least squares for the handle magnitudes along the (fixed or derived) directions.
  let alpha1 = 0, alpha2 = 0;
  const solve2 = (d1: Vec2, d2: Vec2): void => {
    let C11 = 0, C12 = 0, C22 = 0, X1 = 0, X2 = 0;
    for (let i = 1; i < n - 1; i++) {
      const r = sub(pts[i], base(u[i]));
      const w1 = b1(u[i]), w2 = b2(u[i]);
      C11 += w1 * w1;
      C12 += w1 * w2 * dot(d1, d2);
      C22 += w2 * w2;
      X1 += w1 * dot(d1, r);
      X2 += w2 * dot(d2, r);
    }
    const det = C11 * C22 - C12 * C12;
    if (det > 1e-12) {
      alpha1 = (X1 * C22 - X2 * C12) / det;
      alpha2 = (C11 * X2 - C12 * X1) / det;
    } else {
      alpha1 = chord / 3; alpha2 = chord / 3;
    }
  };
  const solve1 = (d: Vec2, which: 1 | 2): void => {
    let C = 0, X = 0;
    for (let i = 1; i < n - 1; i++) {
      const r = sub(pts[i], base(u[i]));
      const w = which === 1 ? b1(u[i]) : b2(u[i]);
      C += w * w;
      X += w * dot(d, r);
    }
    const a = C > 1e-12 ? X / C : chord / 3;
    if (which === 1) alpha1 = a; else alpha2 = a;
  };
  if (t1 && t2) solve2(t1, t2);
  else if (t1) solve1(t1, 1);
  else if (t2) solve1(t2, 2);
  // Standard Schneider clamp: oversized handles are unstable and never help.
  alpha1 = Math.min(Math.max(alpha1, 0), Math.max(chord, 1e-9));
  alpha2 = Math.min(Math.max(alpha2, 0), Math.max(chord, 1e-9));
  if (!isFinite(alpha1) || !isFinite(alpha2)) { alpha1 = chord / 3; alpha2 = chord / 3; }
  if (startC.type === 'zero') alpha1 = 0;
  if (endC.type === 'zero') alpha2 = 0;

  const buildSeg = (): CubicSegment => ({
    p0: vec(p0.x, p0.y),
    p1: t1 ? add(p0, mul(t1, alpha1)) : vec(p0.x, p0.y),
    p2: t2 ? add(p3, mul(t2, alpha2)) : vec(p3.x, p3.y),
    p3: vec(p3.x, p3.y),
  });
  let seg = buildSeg();

  // Newton reparameterization (standard Schneider): chord-length parameters are
  // only a first guess; aligning them to the fitted curve before the error pass
  // avoids spurious max-error spikes that would fragment the fit.
  for (let iter = 0; iter < 3; iter++) {
    let moved = false;
    for (let i = 1; i < n - 1; i++) {
      const d = sub(evaluateCubic(seg.p0, seg.p1, seg.p2, seg.p3, u[i]), pts[i]);
      const dv = tangentAt(seg.p0, seg.p1, seg.p2, seg.p3, u[i]);
      const dd = dot(dv, dv);
      if (dd < 1e-12) continue;
      const step = dot(d, dv) / dd;
      const nu = u[i] - step;
      if (nu > 1e-4 && nu < 1 - 1e-4 && isFinite(nu)) {
        if (Math.abs(nu - u[i]) > 1e-6) moved = true;
        u[i] = nu;
      }
    }
    if (!moved) break;
    if (t1 && t2) solve2(t1, t2);
    else if (t1) solve1(t1, 1);
    else if (t2) solve1(t2, 2);
    alpha1 = Math.min(Math.max(alpha1, 0), Math.max(chord, 1e-9));
    alpha2 = Math.min(Math.max(alpha2, 0), Math.max(chord, 1e-9));
    if (startC.type === 'zero') alpha1 = 0;
    if (endC.type === 'zero') alpha2 = 0;
    seg = buildSeg();
  }

  // Max point-to-point error at the parameterization nodes.
  let maxE = -1, maxI = -1;
  for (let i = 1; i < n - 1; i++) {
    const b = evaluateCubic(seg.p0, seg.p1, seg.p2, seg.p3, u[i]);
    const e = dist(b, pts[i]);
    if (e > maxE) { maxE = e; maxI = i; }
  }
  if (maxE <= tol || depth >= MAX_FIT_DEPTH) return [seg];

  // Split at the worst vertex under ONE shared tangent (central difference):
  // both halves' facing ends are pinned to it, which is what makes the seam G1.
  const splitDir = normalize(sub(pts[maxI + 1], pts[maxI - 1]));
  const left = pts.slice(0, maxI + 1);
  const right = pts.slice(maxI);
  return [
    ...fitRun(left, tol, startC, { type: 'fixed', d: mul(splitDir, -1) }, depth + 1),
    ...fitRun(right, tol, { type: 'fixed', d: splitDir }, endC, depth + 1),
  ];
}

/**
 * Appends one fitted run to the anchor output. Every segment boundary becomes
 * an anchor: interior anchors are G1 by construction (collinear handles), and
 * run boundaries carry null handles on their guarded side(s) — a sharp corner.
 * `skipFirst` reuses the already-pushed shared corner anchor when continuing
 * after a previous run; `wrap` folds the closing anchor of a loop back onto
 * `anchors[0]` instead of pushing a duplicate.
 */
function appendRunAnchors(anchors: PenAnchor[], segs: CubicSegment[], skipFirst: boolean, wrap = false): void {
  for (let j = 0; j < segs.length; j++) {
    const seg = segs[j];
    const outH = relativeHandle(seg.p1, seg.p0);
    const inH = relativeHandle(seg.p2, seg.p3);
    if (j === 0) {
      if (!skipFirst) anchors.push({ x: seg.p0.x, y: seg.p0.y, handleIn: null, handleOut: outH });
    } else {
      // G1 seam: the shared anchor's handles are collinear by construction.
      const prev = anchors[anchors.length - 1];
      if (!prev.handleOut) prev.handleOut = outH;
    }
    const isLast = j === segs.length - 1;
    if (isLast && wrap) {
      // Fold the closing seam onto the start anchor. A corner start keeps its
      // sharp (null) side because the guarded fit produced no handle there.
      const a0 = anchors[0];
      if (inH && (a0.handleIn === null || a0.handleIn === undefined)) a0.handleIn = inH;
      return;
    }
    anchors.push({ x: seg.p3.x, y: seg.p3.y, handleIn: inH, handleOut: null });
  }
}

/** Relative handle from anchor a to absolute control point c (null when degenerate). */
function relativeHandle(c: Point2D, a: Point2D): { x: number; y: number } | null {
  const v = sub(c, a);
  return len(v) < 1e-9 ? null : { x: v.x, y: v.y };
}

// ─────────────────────────── SVG path `d` serialization ───────────────────────────

const fmtNum = (v: number): string => String(parseFloat(v.toFixed(3)));

/**
 * Serializes a pen path to an SVG path `d` string (absolute commands only:
 * M / L / C / Z). Null handles serialize as explicit C commands with the
 * control point on the anchor — geometry-preserving and parser-simple.
 */
export function penPathToSvgD(path: PenPathData): string {
  const parts: string[] = [];
  for (const sub of path.paths) {
    const a = sub.anchors;
    if (a.length === 0) continue;
    parts.push(`M ${fmtNum(a[0].x)} ${fmtNum(a[0].y)}`);
    const count = sub.closed ? a.length : a.length - 1;
    for (let i = 0; i < count; i++) {
      const from = a[i], to = a[(i + 1) % a.length];
      const c1 = handleToAbs(from, from.handleOut);
      const c2 = handleToAbs(to, to.handleIn);
      parts.push(`C ${fmtNum(c1.x)} ${fmtNum(c1.y)} ${fmtNum(c2.x)} ${fmtNum(c2.y)} ${fmtNum(to.x)} ${fmtNum(to.y)}`);
    }
    if (sub.closed) parts.push('Z');
  }
  return parts.join(' ');
}


const TOKEN_RE = /[MLHVCSQTAZmlhvcsqtaz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;

/**
 * Parses an SVG path `d` string into pen path data. Supports M/L/H/V/C/S/Q/T/Z
 * in both absolute and relative forms; every curved command normalizes to a
 * cubic (Q/T convert exactly, S/T resolve reflected controls), lines become
 * null-handle anchors. Arc (`A`) commands throw — arc-to-cubic conversion is
 * out of scope for the L0 family and callers should fail closed rather than
 * silently drop geometry.
 */
export function svgDToPenPath(d: string): PenPathData {
  const tokens = d.match(TOKEN_RE) ?? [];
  let i = 0;
  const nextNum = (): number => {
    const v = parseFloat(tokens[i++]);
    if (isNaN(v)) throw new Error(`svgDToPenPath: expected number at token ${i} in "${d}"`);
    return v;
  };
  const isNum = (s: string | undefined): boolean => s !== undefined && /^[-+.\d]/.test(s);

  let cx = 0, cy = 0;
  let subStart: Point2D = vec(0, 0);
  let prevC2: Point2D | null = null;
  let prevQ: Point2D | null = null;
  let cmd: string | null = null;
  let rel = false;
  const paths: PenSubPath[] = [];
  let cur: PenAnchor[] = [];
  let justClosed = false;

  const lastAnchor = (): PenAnchor | null => cur[cur.length - 1] ?? null;

  const openSubAt = (x: number, y: number) => {
    if (cur.length > 0) paths.push({ anchors: cur, closed: false });
    cur = [{ x, y }];
    cx = x; cy = y;
    subStart = vec(x, y);
    prevC2 = null; prevQ = null;
  };
  /** Ensures a current subpath exists (new subpath at the last M/Z position when needed). */
  const ensureOpen = () => {
    if (justClosed) { openSubAt(subStart.x, subStart.y); justClosed = false; return; }
    if (cur.length === 0) openSubAt(cx, cy);
  };
  const lineTo = (x: number, y: number) => {
    ensureOpen();
    cur.push({ x, y });
    cx = x; cy = y;
    prevC2 = null; prevQ = null;
  };
  const cubicTo = (c1: Point2D, c2: Point2D, p: Point2D) => {
    ensureOpen();
    const prev = lastAnchor()!;
    const outH = relativeHandle(c1, prev);
    if (outH) prev.handleOut = outH;
    const inH = relativeHandle(c2, p);
    cur.push({ x: p.x, y: p.y, handleIn: inH });
    cx = p.x; cy = p.y;
    prevC2 = c2; prevQ = null;
  };
  const quadToCubic = (q: Point2D, p: Point2D): { c1: Point2D; c2: Point2D } => ({
    c1: add(vec(cx, cy), mul(sub(q, vec(cx, cy)), 2 / 3)),
    c2: add(p, mul(sub(q, p), 2 / 3)),
  });
  const reflect = (pivot: Point2D, about: Point2D): Point2D => vec(2 * about.x - pivot.x, 2 * about.y - pivot.y);

  while (i < tokens.length) {
    const tok = tokens[i];
    if (/^[A-Za-z]$/.test(tok)) {
      i++;
      cmd = tok.toUpperCase();
      rel = tok !== cmd;
      if (cmd === 'A') throw new Error(`svgDToPenPath: arc (A) commands are not supported in "${d}"`);
      if (cmd === 'Z') {
        if (cur.length > 1) {
          if (dist(lastAnchor()!, subStart) < 1e-9) cur.pop();
          paths.push({ anchors: cur, closed: true });
        }
        cur = [];
        cx = subStart.x; cy = subStart.y;
        prevC2 = null; prevQ = null;
        justClosed = true;
      }
      continue;
    }
    if (cmd === null) throw new Error(`svgDToPenPath: coordinate data before any command in "${d}"`);
    if (cmd === 'Z') { i = tokens.length; break; }

    switch (cmd) {
      case 'M': {
        openSubAt(nextNum() + (rel ? cx : 0), nextNum() + (rel ? cy : 0));
        justClosed = false;
        cmd = 'L'; // subsequent coordinate pairs are implicit line-tos
        break;
      }
      case 'L': lineTo(nextNum() + (rel ? cx : 0), nextNum() + (rel ? cy : 0)); break;
      case 'H': lineTo(nextNum() + (rel ? cx : 0), cy); break;
      case 'V': lineTo(cx, nextNum() + (rel ? cy : 0)); break;
      case 'C': {
        const c1 = vec(nextNum() + (rel ? cx : 0), nextNum() + (rel ? cy : 0));
        const c2 = vec(nextNum() + (rel ? cx : 0), nextNum() + (rel ? cy : 0));
        cubicTo(c1, c2, vec(nextNum() + (rel ? cx : 0), nextNum() + (rel ? cy : 0)));
        break;
      }
      case 'S': {
        const c2 = vec(nextNum() + (rel ? cx : 0), nextNum() + (rel ? cy : 0));
        const p = vec(nextNum() + (rel ? cx : 0), nextNum() + (rel ? cy : 0));
        cubicTo(prevC2 ? reflect(prevC2, vec(cx, cy)) : vec(cx, cy), c2, p);
        break;
      }
      case 'Q': {
        const q = vec(nextNum() + (rel ? cx : 0), nextNum() + (rel ? cy : 0));
        const p = vec(nextNum() + (rel ? cx : 0), nextNum() + (rel ? cy : 0));
        const { c1, c2 } = quadToCubic(q, p);
        cubicTo(c1, c2, p);
        prevQ = q;
        break;
      }
      case 'T': {
        const p = vec(nextNum() + (rel ? cx : 0), nextNum() + (rel ? cy : 0));
        const q: Point2D = prevQ ? reflect(prevQ, vec(cx, cy)) : vec(cx, cy);
        const { c1, c2 } = quadToCubic(q, p);
        cubicTo(c1, c2, p);
        prevQ = q;
        break;
      }
      default: throw new Error('unreachable');
    }
    if (cmd !== 'M' && !isNum(tokens[i])) cmd = null; // command fully consumed
  }
  if (cur.length > 0) paths.push({ anchors: cur, closed: false });
  return { paths };
}

// ─── Anchor-payload operations ─────────────────────────────────────────────────
//
// The anchor currency (PenPathData: paths → subpaths → anchors with RELATIVE
// handles) sits one level above the segment currency above. Ops here are pure
// payload→payload math, named for the payload and the operation — never for a
// consuming tool or interaction.

/**
 * mapPathAnchors: Applies an arbitrary point map to every anchor position of
 * the payload. Handle offsets are stored RELATIVE to their anchors, so each
 * handle's absolute ENDPOINT is mapped through `map` and then re-based against
 * the mapped anchor — the generic primitive behind translating, scaling and
 * otherwise affinely (or non-affinely) transforming an anchor path while
 * keeping the curve shape tracking the map.
 *
 * Pure: the result shares nothing with the input (gesture snapshots and undo
 * steps rely on that).
 */
export function mapPathAnchors(path: PenPathData, map: (pt: Point2D) => Point2D): PenPathData {
  return {
    paths: path.paths.map((sub) => ({
      closed: sub.closed,
      anchors: sub.anchors.map((a) => {
        const p = map({ x: a.x, y: a.y });
        const rebase = (h: { x: number; y: number } | null | undefined) => {
          if (!h) return h;
          const end = map({ x: a.x + h.x, y: a.y + h.y });
          return { x: end.x - p.x, y: end.y - p.y };
        };
        return { x: p.x, y: p.y, handleIn: rebase(a.handleIn), handleOut: rebase(a.handleOut) };
      }),
    })),
  };
}

/**
 * nearestPathAnchor: Closest anchor ELEMENT within `tolerance` (same space as
 * the coordinates) — anchors and handle endpoints compete, and the smaller
 * handle targets win ties. Returns the payload indices plus which part of the
 * anchor was hit; null when nothing is within tolerance.
 */
export function nearestPathAnchor(
  path: PenPathData,
  pt: Point2D,
  tolerance: number,
): { pathIdx: number; anchorIdx: number; kind: 'anchor' | 'handleIn' | 'handleOut' } | null {
  let best: { pathIdx: number; anchorIdx: number; kind: 'anchor' | 'handleIn' | 'handleOut'; dist: number } | null = null;
  const consider = (pathIdx: number, anchorIdx: number, kind: 'anchor' | 'handleIn' | 'handleOut', d: number) => {
    if (d > tolerance) return;
    if (!best || d < best.dist) {
      best = { pathIdx, anchorIdx, kind, dist: d };
    }
  };
  path.paths.forEach((sub, pathIdx) => {
    sub.anchors.forEach((a, anchorIdx) => {
      consider(pathIdx, anchorIdx, 'anchor', Math.hypot(a.x - pt.x, a.y - pt.y));
      if (a.handleIn) {
        consider(pathIdx, anchorIdx, 'handleIn', Math.hypot(a.x + a.handleIn.x - pt.x, a.y + a.handleIn.y - pt.y));
      }
      if (a.handleOut) {
        consider(pathIdx, anchorIdx, 'handleOut', Math.hypot(a.x + a.handleOut.x - pt.x, a.y + a.handleOut.y - pt.y));
      }
    });
  });
  if (!best) return null;
  const hit = best as { pathIdx: number; anchorIdx: number; kind: 'anchor' | 'handleIn' | 'handleOut' };
  return { pathIdx: hit.pathIdx, anchorIdx: hit.anchorIdx, kind: hit.kind };
}
