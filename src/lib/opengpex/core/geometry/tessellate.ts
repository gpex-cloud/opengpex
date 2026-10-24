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

import { isPointInRing } from './operators/polygon';

/**
 * tessellate.ts — CPU triangulation of simple polygon sets for GPU area fill.
 *
 * Input contract: SIMPLE polygons only — each outer ring does not
 * self-intersect, every hole lies fully inside its outer ring, rings do not
 * cross each other. Callers normalize messy input (self-intersections,
 * even-odd tangles) BEFORE calling this module — in the engine's face-render
 * pipeline that normalization is `poly-clip.ts`'s `unionRingsMulti`
 * (Martinez-Rueda-Feito via polygon-clipping). Keeping this module
 * normalization-free is the whole point of the "poly-clip first, clean-input
 * tessellation second" split (spec §12.2 decision B).
 *
 * Algorithm:
 *  1. Orient every outer ring CCW and every hole CW (canonical winding).
 *  2. Bridge each hole into its outer ring at a mutually-visible vertex pair
 *     (zero-area bridge: the hole chain is spliced into the outer ring with
 *     both bridge endpoints duplicated), producing one simple polygon per
 *     input polygon. Rightmost-hole-vertex ray casting finds the candidate
 *     bridge; a brute-force mutual-visibility sweep is the fallback when the
 *     fast candidate is blocked (deeply nested / touching configurations).
 *  3. Ear-clip each merged polygon into a CCW triangle list. Collinear
 *     vertices are dropped (degenerate ears emit nothing) so the loop always
 *     terminates; vertex counts here are tens-to-hundreds (flattened pen
 *     paths), so the O(n²) worst case is milliseconds.
 *
 * Pure module: no DOM, no engine, no GPU — trivially golden-testable
 * (area conservation, index validity, winding).
 */

export type Pt = { x: number; y: number };

/** One normalized polygon: outer boundary + fully-contained holes. */
export interface SimplePolygon {
  outer: readonly Pt[];
  holes: Pt[][];
}

/**
 * Standard shoelace signed area. Sign convention throughout THIS module:
 * POSITIVE = the "screen-forward" winding in y-down document coordinates
 * (right → down → left → up), which is what every producer of flattened pen
 * rings emits naturally; `cross3` shares this convention (positive = convex
 * ear). All three (signedRingArea, cross3, ear test) agree by construction.
 */
export function signedRingArea(ring: readonly Pt[]): number {
  let a = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += ring[i].x * ring[j].y - ring[j].x * ring[i].y;
  }
  return a / 2;
}

const EPSILON = 1e-9;

function cross3(o: Pt, a: Pt, b: Pt): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** True when segments p1→p2 and p3→p4 properly intersect (no shared endpoints). */
function segmentsProperlyIntersect(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d1 = cross3(p3, p4, p1);
  const d2 = cross3(p3, p4, p2);
  const d3 = cross3(p1, p2, p3);
  const d4 = cross3(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Point-in-ring by ray casting — the shared L0 primitive (boundary behaviour unspecified; callers keep bridges off boundaries). */
const pointInRing = isPointInRing;

/**
 * True when the open segment a→b stays inside-or-on the CCW ring: it must not
 * properly cross any ring edge, and its midpoint must be inside the ring.
 */
function segmentInsideRing(a: Pt, b: Pt, ring: readonly Pt[]): boolean {
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if (segmentsProperlyIntersect(a, b, ring[j], ring[i])) return false;
  }
  return pointInRing({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, ring);
}

/** Canonical winding: outer CCW, holes CW (both flips in place on a copy). */
function orientedCopy(ring: readonly Pt[], ccw: boolean): Pt[] {
  const pts = ring.slice();
  // Drop a duplicated closing point if the producer appended one.
  if (pts.length > 1) {
    const first = pts[0], last = pts[pts.length - 1];
    if (Math.abs(first.x - last.x) < EPSILON && Math.abs(first.y - last.y) < EPSILON) pts.pop();
  }
  if (pts.length < 3) return pts;
  const isCCW = signedRingArea(pts) > 0;
  if (isCCW !== ccw) pts.reverse();
  return pts;
}

/**
 * Splice one hole (CW) into the outer ring (CCW) at a mutually-visible
 * vertex pair, returning the merged simple polygon. Zero-area bridge: the
 * bridge endpoints appear twice, so the merged ring's signed area equals
 * outer minus hole exactly — the invariant the area-conservation test pins.
 */
function bridgeHole(outer: Pt[], hole: readonly Pt[]): Pt[] {
  if (hole.length < 3) return outer;

  // Fast candidate (Eberly-style): the hole's rightmost vertex, ray-cast +x
  // into the outer ring; the nearest intersecting edge offers up to three
  // bridge targets (the hit point if it is a vertex, else the edge's two
  // endpoints — take the one with the largest x, then verify visibility).
  let maxIdx = 0;
  for (let i = 1; i < hole.length; i++) {
    if (hole[i].x > hole[maxIdx].x) maxIdx = i;
  }
  const p = hole[maxIdx];

  const candidates: Pt[] = [];
  let bestT = Infinity;
  let bestEdge: [Pt, Pt] | null = null;
  for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
    const a = outer[j], b = outer[i];
    if ((a.y > p.y) === (b.y > p.y)) continue;
    const t = (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x;
    if (t >= p.x && t < bestT) {
      bestT = t;
      bestEdge = [a, b];
    }
  }
  if (bestEdge) {
    const [a, b] = bestEdge;
    // Prefer the edge endpoint with the larger x (standard refinement); the
    // raw intersection point qualifies only when it coincides with a vertex.
    candidates.push(a.x >= b.x ? a : b);
    candidates.push(a.x >= b.x ? b : a);
  }

  const tryBridge = (q: Pt): Pt[] | null => {
    if (!segmentInsideRing(p, q, outer)) return null;
    // The bridge travels the SOLID region: it must not enter the hole's
    // interior (sharing the hole-vertex endpoint p is fine).
    if (pointInRing({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, hole)) return null;
    for (let k = 0, j = hole.length - 1; k < hole.length; j = k++) {
      if (segmentsProperlyIntersect(p, q, hole[j], hole[k])) return null;
    }
    // Splice: outer[0..i], p, hole[j..], hole[j], outer[i..] — both bridge
    // endpoints duplicated so the merged polygon visits the hole entirely.
    const oi = outer.findIndex((v) => v === q);
    const merged: Pt[] = [];
    for (let k = 0; k <= oi; k++) merged.push(outer[k]);
    merged.push(p);
    for (let k = 0; k < hole.length; k++) merged.push(hole[(maxIdx + k) % hole.length]);
    merged.push(hole[maxIdx]);
    merged.push(q);
    for (let k = oi + 1; k < outer.length; k++) merged.push(outer[k]);
    // The merged ring must remain simple & CCW with the expected area; any
    // numerical surprise rejects the candidate.
    if (signedRingArea(merged) <= 0) return null;
    return merged;
  };

  for (const q of candidates) {
    const merged = tryBridge(q);
    if (merged) return merged;
  }

  // Fallback: brute-force mutual-visibility sweep over all vertex pairs.
  let best: { merged: Pt[]; area: number } | null = null;
  for (let oi = 0; oi < outer.length; oi++) {
    for (let hj = 0; hj < hole.length; hj++) {
      const p2 = hole[hj], q2 = outer[oi];
      if (!segmentInsideRing(p2, q2, outer)) continue;
      if (pointInRing({ x: (p2.x + q2.x) / 2, y: (p2.y + q2.y) / 2 }, hole)) continue;
      let crossesHole = false;
      for (let k = 0, j = hole.length - 1; k < hole.length; j = k++) {
        if (segmentsProperlyIntersect(p2, q2, hole[j], hole[k])) { crossesHole = true; break; }
      }
      if (crossesHole) continue;
      const merged: Pt[] = [];
      for (let k = 0; k <= oi; k++) merged.push(outer[k]);
      merged.push(p2);
      for (let k = 0; k < hole.length; k++) merged.push(hole[(hj + k) % hole.length]);
      merged.push(hole[hj]);
      merged.push(q2);
      for (let k = oi + 1; k < outer.length; k++) merged.push(outer[k]);
      const area = signedRingArea(merged);
      if (area > EPSILON && (!best || area > best.area)) best = { merged, area };
    }
  }
  if (best) return best.merged;

  // Geometrically unreachable for a normalized simple polygon set; drop the
  // hole rather than emit corrupted geometry (documented degradation).
  return outer;
}

/** Ear-clip one simple CCW polygon into a flat CCW triangle list. */
function earClip(ring: readonly Pt[]): number[] {
  const indices: number[] = [];
  const n = ring.length;
  if (n < 3) return indices;

  const remaining: number[] = Array.from({ length: n }, (_, i) => i);
  // Collinear vertices are clipped away up front: they emit no triangle and
  // guarantee the main loop always finds progress.
  let guard = 0;
  while (remaining.length > 3 && guard < n * n) {
    guard++;
    let clipped = false;
    for (let i = 0; i < remaining.length; i++) {
      const ip = remaining[(i + remaining.length - 1) % remaining.length];
      const ic = remaining[i];
      const inx = remaining[(i + 1) % remaining.length];
      const cross = cross3(ring[ip], ring[ic], ring[inx]);
      if (Math.abs(cross) < EPSILON) {
        remaining.splice(i, 1);
        clipped = true;
        break;
      }
    }
    if (!clipped) break;
  }

  guard = 0;
  const maxGuard = remaining.length * remaining.length * 2;
  while (remaining.length > 3 && guard < maxGuard) {
    guard++;
    let earFound = false;
    for (let i = 0; i < remaining.length; i++) {
      const ip = remaining[(i + remaining.length - 1) % remaining.length];
      const ic = remaining[i];
      const inx = remaining[(i + 1) % remaining.length];
      const a = ring[ip], b = ring[ic], c = ring[inx];
      if (cross3(a, b, c) <= EPSILON) continue; // reflex or collinear
      let contains = false;
      for (const vi of remaining) {
        if (vi === ip || vi === ic || vi === inx) continue;
        const pv = ring[vi];
        // Bridge-seam duplicates: the same COORDINATE can appear twice in the
        // merged ring. A copy sitting exactly on an ear corner must not block
        // the ear — skip by coordinate coincidence, not just by index.
        if ((Math.abs(pv.x - a.x) < EPSILON && Math.abs(pv.y - a.y) < EPSILON) ||
            (Math.abs(pv.x - b.x) < EPSILON && Math.abs(pv.y - b.y) < EPSILON) ||
            (Math.abs(pv.x - c.x) < EPSILON && Math.abs(pv.y - c.y) < EPSILON)) continue;
        // Strict interior test with a small tolerance so vertices ON an ear
        // edge (bridge duplicates) don't permanently block a valid ear.
        const d1 = cross3(a, b, pv);
        const d2 = cross3(b, c, pv);
        const d3 = cross3(c, a, pv);
        const tol = -EPSILON;
        if (d1 >= tol && d2 >= tol && d3 >= tol) {
          contains = true;
          break;
        }
      }
      if (contains) continue;
      indices.push(ip, ic, inx);
      remaining.splice(i, 1);
      earFound = true;
      break;
    }
    if (!earFound) break; // Numerically stuck — emit what we have (documented degradation).
  }
  if (remaining.length === 3) {
    indices.push(remaining[0], remaining[1], remaining[2]);
  }
  return indices;
}

export interface FaceTriangulation {
  /** Flat positions: [x, y] per vertex, 3 vertices per triangle, CCW winding. */
  positions: Float32Array;
  /** Number of triangles (positions.length === triangleCount × 9). */
  triangleCount: number;
}

/**
 * Triangulates a normalized simple-polygon set into GPU-ready positions.
 * Polygons whose outer ring carries no area (<3 effective vertices) are
 * skipped. Holes are bridged into their outer ring first, so the output is
 * plain triangle soup with no per-polygon bookkeeping downstream.
 */
export function triangulateFaces(polygons: readonly SimplePolygon[]): FaceTriangulation {
  const positions: number[] = [];
  let triangleCount = 0;

  for (const poly of polygons) {
    const outer = orientedCopy(poly.outer, true);
    if (outer.length < 3) continue;

    // Bridge holes largest-first (area order keeps degenerate bridges rarer
    // for nested-hole configurations and is the common heuristic ordering).
    const holes = poly.holes
      .map((h) => orientedCopy(h, false))
      .filter((h) => h.length >= 3)
      .sort((a, b) => Math.abs(signedRingArea(b)) - Math.abs(signedRingArea(a)));
    let merged = outer;
    for (const hole of holes) {
      merged = bridgeHole(merged, hole);
    }
    if (merged.length < 3) continue;

    const idx = earClip(merged);
    for (const i of idx) {
      positions.push(merged[i].x, merged[i].y);
    }
    triangleCount += idx.length / 3;
  }

  return { positions: new Float32Array(positions), triangleCount };
}
