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
 * Magic-Wand Worker
 *
 * Pipeline (per phase1_irregular_clip_spec §6.3):
 *   Phase 1  Color-tolerance flood fill → binary mask                (BFS, 4-neighborhood)
 *   Phase 2  Marching Squares contour tracing → raw integer rings    (boundary edges, then chained)
 *   Phase 3  Douglas–Peucker simplification → final layer-local rings
 *
 * The worker is intentionally dependency-free (no editor types, no React, no
 * geometry service): it speaks only `WandRequest` / `WandResponse` defined in
 * `./protocol.ts`. This keeps the bundled worker chunk small and lets the
 * algorithm be unit-tested in isolation if needed.
 */

import type { WandRequest, WandResponse } from './protocol';

// ───────────────────────────── Phase 1: BFS flood fill ─────────────────────────

/**
 * Allocate-once integer queue for BFS. Avoids `Array.shift()` (O(n)) and the
 * GC churn that would come from `push/shift` on a 4 K image (~8M pixels).
 */
class IndexQueue {
  private buf: Int32Array;
  private head = 0;
  private tail = 0;
  constructor(capacity: number) {
    this.buf = new Int32Array(capacity);
  }
  push(i: number) {
    // Grow on demand (defensive — initial capacity is width*height which is
    // already an upper bound, but a malicious request could pass smaller).
    if (this.tail >= this.buf.length) {
      const grown = new Int32Array(this.buf.length * 2);
      grown.set(this.buf);
      this.buf = grown;
    }
    this.buf[this.tail++] = i;
  }
  shift(): number {
    return this.buf[this.head++];
  }
  get size(): number {
    return this.tail - this.head;
  }
}

/**
 * Run a 4-neighborhood BFS flood from `seed`, admitting any pixel whose RGB
 * L1 distance to the seed colour is ≤ tolerance × 3 (and whose alpha > 0).
 *
 * @returns mask  Uint8Array length width*height; 1 = inside selection, 0 = outside.
 *                Returns `null` if the seed itself is transparent (alpha ≤ 0).
 *                Caller treats the all-zero / all-one cases as "no actionable
 *                selection" and returns empty rings.
 */
function floodFill(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  seed: { x: number; y: number },
  tolerance: number,
  contiguous: boolean,
): { mask: Uint8Array; floodPixels: number } | null {
  const total = width * height;
  const mask = new Uint8Array(total);

  const sIdx = (seed.y * width + seed.x) * 4;
  const sR = pixels[sIdx];
  const sG = pixels[sIdx + 1];
  const sB = pixels[sIdx + 2];
  const sA = pixels[sIdx + 3];
  if (sA <= 0) return null;

  // Manhattan tolerance over RGB. Multiply once.
  const tol3 = tolerance * 3;

  const colorMatches = (i4: number): boolean => {
    if (pixels[i4 + 3] <= 0) return false;
    const dR = Math.abs(pixels[i4] - sR);
    const dG = Math.abs(pixels[i4 + 1] - sG);
    const dB = Math.abs(pixels[i4 + 2] - sB);
    return dR + dG + dB <= tol3;
  };

  let floodPixels = 0;

  if (!contiguous) {
    // Whole-image scan; no BFS needed.
    for (let p = 0; p < total; p++) {
      if (colorMatches(p * 4)) {
        mask[p] = 1;
        floodPixels++;
      }
    }
    return { mask, floodPixels };
  }

  // BFS from seed.
  const seedP = seed.y * width + seed.x;
  if (!colorMatches(seedP * 4)) {
    return { mask, floodPixels: 0 }; // empty mask
  }

  const q = new IndexQueue(total);
  q.push(seedP);
  mask[seedP] = 1;
  floodPixels = 1;

  while (q.size > 0) {
    const p = q.shift();
    const x = p % width;
    const y = (p - x) / width;

    // 4-neighbors
    if (x > 0) {
      const np = p - 1;
      if (!mask[np] && colorMatches(np * 4)) {
        mask[np] = 1;
        floodPixels++;
        q.push(np);
      }
    }
    if (x < width - 1) {
      const np = p + 1;
      if (!mask[np] && colorMatches(np * 4)) {
        mask[np] = 1;
        floodPixels++;
        q.push(np);
      }
    }
    if (y > 0) {
      const np = p - width;
      if (!mask[np] && colorMatches(np * 4)) {
        mask[np] = 1;
        floodPixels++;
        q.push(np);
      }
    }
    if (y < height - 1) {
      const np = p + width;
      if (!mask[np] && colorMatches(np * 4)) {
        mask[np] = 1;
        floodPixels++;
        q.push(np);
      }
    }
  }

  return { mask, floodPixels };
}

// ─────────────────────── Phase 2: Boundary tracing ─────────────────────────────

/**
 * Extract the boundary rings of a binary mask using a simple horizontal-edge
 * tracer. Output rings are at integer pixel coordinates and start at the upper-
 * left corner of each contour, traversed clockwise (we don't currently
 * distinguish outer / inner winding — Phase 1 spec §3.3.2 renders with
 * `evenodd`, which works regardless of CW/CCW per ring).
 *
 * Algorithm:
 *   1. For each pixel `(x, y)`, examine the four edges between this pixel and
 *      its neighbors. An edge is on the contour iff one side is "in" (mask=1)
 *      and the other "out".
 *   2. Build an undirected edge list, then chain edges into closed rings via
 *      a vertex → edges adjacency map.
 *
 * Output coordinates are the corner-points of the pixel grid (integer 0..w/h),
 * NOT pixel centers. This means a single-pixel selection produces a 1×1 ring
 * with vertices (x,y) (x+1,y) (x+1,y+1) (x,y+1).
 */
interface Edge {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

function traceBoundary(
  mask: Uint8Array,
  width: number,
  height: number,
): { rings: { x: number; y: number }[][]; rawCount: number } {
  // Collect edges. There are up to (w+1)*h horizontal cell edges and w*(h+1)
  // vertical, but we only emit those on the contour.
  const edges: Edge[] = [];

  const get = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= width || y >= height) return 0;
    return mask[y * width + x];
  };

  // Horizontal edges: between (x, y-1) above and (x, y) below, for y in [0..h]
  // Edge spans from (x, y) to (x+1, y).
  for (let y = 0; y <= height; y++) {
    for (let x = 0; x < width; x++) {
      const above = get(x, y - 1);
      const below = get(x, y);
      if (above !== below) {
        edges.push({ ax: x, ay: y, bx: x + 1, by: y });
      }
    }
  }

  // Vertical edges: between (x-1, y) left and (x, y) right, for x in [0..w]
  // Edge spans from (x, y) to (x, y+1).
  for (let x = 0; x <= width; x++) {
    for (let y = 0; y < height; y++) {
      const left = get(x - 1, y);
      const right = get(x, y);
      if (left !== right) {
        edges.push({ ax: x, ay: y, bx: x, by: y + 1 });
      }
    }
  }

  if (!edges.length) {
    return { rings: [], rawCount: 0 };
  }

  // Chain edges into closed rings via a vertex → edge index multimap.
  // Vertex key: y * (width + 1) + x   (compact integer keying).
  const vkey = (x: number, y: number) => y * (width + 1) + x;
  const adjacency = new Map<number, number[]>();
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const ka = vkey(e.ax, e.ay);
    const kb = vkey(e.bx, e.by);
    let la = adjacency.get(ka);
    if (!la) { la = []; adjacency.set(ka, la); }
    la.push(i);
    let lb = adjacency.get(kb);
    if (!lb) { lb = []; adjacency.set(kb, lb); }
    lb.push(i);
  }

  const used = new Uint8Array(edges.length);
  const rings: { x: number; y: number }[][] = [];
  let rawCount = 0;

  for (let start = 0; start < edges.length; start++) {
    if (used[start]) continue;
    const ring: { x: number; y: number }[] = [];
    let curEdge = start;
    let curVx = edges[start].ax;
    let curVy = edges[start].ay;
    ring.push({ x: curVx, y: curVy });

    // Walk until we return to the starting vertex.
    while (true) {
      used[curEdge] = 1;
      const e = edges[curEdge];
      // Move to the OTHER endpoint of curEdge.
      const nextX = e.ax === curVx && e.ay === curVy ? e.bx : e.ax;
      const nextY = e.ax === curVx && e.ay === curVy ? e.by : e.ay;
      ring.push({ x: nextX, y: nextY });
      curVx = nextX;
      curVy = nextY;

      if (curVx === edges[start].ax && curVy === edges[start].ay) {
        break;
      }

      // Find the next unused edge incident to this vertex.
      const adj = adjacency.get(vkey(curVx, curVy));
      if (!adj) break;
      let nextEdge = -1;
      for (const ei of adj) {
        if (!used[ei]) { nextEdge = ei; break; }
      }
      if (nextEdge < 0) break;
      curEdge = nextEdge;
    }

    rawCount += ring.length;
    if (ring.length >= 4) {
      // Drop the duplicated final vertex (same as first) before returning.
      ring.pop();
      rings.push(ring);
    }
  }

  return { rings, rawCount };
}

// ───────────────────────── Phase 3: RDP simplification ────────────────────────

/**
 * Iterative Douglas–Peucker. Returns a simplified copy of `points` keeping
 * only vertices whose perpendicular distance to the active sub-segment is
 * greater than `epsilon`.
 *
 * `points` is treated as an OPEN polyline: the returned array contains the
 * first and last point of the input. For closed rings the caller should first
 * duplicate the start vertex at the end (we do not — see `simplifyRing`).
 */
function simplifyOpen(points: { x: number; y: number }[], epsilon: number): { x: number; y: number }[] {
  const n = points.length;
  if (n < 3 || epsilon <= 0) return points.slice();

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  // Stack of [start, end] index pairs.
  const stack: number[] = [0, n - 1];
  while (stack.length > 0) {
    const e = stack.pop() as number;
    const s = stack.pop() as number;
    if (e <= s + 1) continue;

    const ax = points[s].x, ay = points[s].y;
    const bx = points[e].x, by = points[e].y;
    const dx = bx - ax, dy = by - ay;
    const segLen2 = dx * dx + dy * dy;

    let maxD2 = -1;
    let maxIdx = -1;
    for (let i = s + 1; i < e; i++) {
      const px = points[i].x, py = points[i].y;
      let d2: number;
      if (segLen2 === 0) {
        const ex = px - ax, ey = py - ay;
        d2 = ex * ex + ey * ey;
      } else {
        // Perpendicular distance squared from p to line (a,b).
        const cross = (dx * (ay - py) - (ax - px) * dy);
        d2 = (cross * cross) / segLen2;
      }
      if (d2 > maxD2) { maxD2 = d2; maxIdx = i; }
    }

    if (maxIdx >= 0 && maxD2 > epsilon * epsilon) {
      keep[maxIdx] = 1;
      stack.push(s, maxIdx, maxIdx, e);
    }
  }

  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push(points[i]);
  }
  return out;
}

/**
 * Simplify a CLOSED ring. We append a copy of the first vertex, run RDP, then
 * drop the final duplicate before returning.
 */
function simplifyRing(ring: { x: number; y: number }[], epsilon: number): { x: number; y: number }[] {
  if (ring.length < 4 || epsilon <= 0) return ring.slice();
  const closed = ring.slice();
  closed.push(ring[0]);
  const simplified = simplifyOpen(closed, epsilon);
  if (simplified.length > 1 &&
      simplified[0].x === simplified[simplified.length - 1].x &&
      simplified[0].y === simplified[simplified.length - 1].y) {
    simplified.pop();
  }
  return simplified;
}

// ────────────────────────── Pipeline glue / main entry ─────────────────────────

function runWand(req: WandRequest): WandResponse {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

  const { width, height } = req.imageData;
  const pixels = new Uint8ClampedArray(req.imageData.data);

  // Bounds-check seed.
  if (
    req.seed.x < 0 || req.seed.y < 0 ||
    req.seed.x >= width || req.seed.y >= height
  ) {
    return { reqId: req.reqId, rings: [] };
  }

  // Phase 1
  const flood = floodFill(pixels, width, height, req.seed, req.tolerance, req.contiguous);
  if (!flood) {
    // Seed on transparent → no selection.
    return { reqId: req.reqId, rings: [] };
  }
  if (flood.floodPixels === 0 || flood.floodPixels === width * height) {
    // All-out or all-in — nothing actionable.
    return { reqId: req.reqId, rings: [] };
  }

  // Phase 2
  const traced = traceBoundary(flood.mask, width, height);
  if (!traced.rings.length) {
    return { reqId: req.reqId, rings: [] };
  }

  // Phase 3
  const simplified = traced.rings
    .map(r => simplifyRing(r, req.simplifyEpsilon))
    .filter(r => r.length >= 3);

  const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

  let simplifiedCount = 0;
  for (const r of simplified) simplifiedCount += r.length;

  return {
    reqId: req.reqId,
    rings: simplified,
    debug: {
      floodPixels: flood.floodPixels,
      rawContourPoints: traced.rawCount,
      simplifiedPoints: simplifiedCount,
      ms: Math.round(t1 - t0),
    },
  };
}

// Worker boilerplate — only register when running in a Worker context.
// (`self` is also defined on the main thread, so we additionally test
// `WorkerGlobalScope` which is unique to dedicated workers.)
declare const WorkerGlobalScope: unknown;
if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined') {
  (self as unknown as { onmessage: (ev: MessageEvent<WandRequest>) => void }).onmessage = (ev) => {
    try {
      const resp = runWand(ev.data);
      (self as unknown as { postMessage: (m: WandResponse) => void }).postMessage(resp);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      (self as unknown as { postMessage: (m: WandResponse) => void }).postMessage({
        reqId: ev.data?.reqId ?? -1,
        rings: [],
        error: errMsg,
      });
    }
  };
}

// Exposed only for unit testing the algorithm without spinning up a real Worker.
export const __test__ = { floodFill, traceBoundary, simplifyOpen, simplifyRing, runWand };
