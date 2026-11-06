/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more
 * details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * alpha.ts — trace the opaque-alpha contour of an RGBA raster into
 * closed rings. Pure math over a pixel buffer: no DOM, no worker, no editor
 * types. Two consumers share this exact implementation:
 *
 *   - "Select from Alpha" (ClipOptions alpha.worker.ts) — writes the rings as
 *     a wand selection;
 *   - the bake family (baking.ts) — rebuilds a physical fragment's outline
 *     path after a composite so Refocus and future outline tools see the
 *     fragment's true contour instead of its bounding box.
 *
 * Pipeline: alpha thresholding → marching-squares boundary tracing → small
 * ring filtering → Chaikin smoothing + Douglas-Peucker simplification →
 * boundary clamping.
 */

// ──────────────────────────── Phase 1: Alpha Thresholding ──────────────────────

function alphaThreshold(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  threshold: number,
): { mask: Uint8Array; opaquePixels: number } {
  const total = width * height;
  const mask = new Uint8Array(total);
  let opaquePixels = 0;

  for (let p = 0; p < total; p++) {
    if (pixels[p * 4 + 3] > threshold) {
      mask[p] = 1;
      opaquePixels++;
    }
  }

  return { mask, opaquePixels };
}

// ──────────────────────────── Phase 2: Boundary Tracing ────────────────────────

interface Edge {
  ax: number; ay: number;
  bx: number; by: number;
}

function traceBoundary(
  mask: Uint8Array,
  width: number,
  height: number,
): { rings: { x: number; y: number }[][]; rawCount: number } {
  const edges: Edge[] = [];

  const get = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= width || y >= height) return 0;
    return mask[y * width + x];
  };

  for (let y = 0; y <= height; y++) {
    for (let x = 0; x < width; x++) {
      if (get(x, y - 1) !== get(x, y)) {
        edges.push({ ax: x, ay: y, bx: x + 1, by: y });
      }
    }
  }

  for (let x = 0; x <= width; x++) {
    for (let y = 0; y < height; y++) {
      if (get(x - 1, y) !== get(x, y)) {
        edges.push({ ax: x, ay: y, bx: x, by: y + 1 });
      }
    }
  }

  if (!edges.length) return { rings: [], rawCount: 0 };

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

    while (true) {
      used[curEdge] = 1;
      const e = edges[curEdge];
      const nextX = e.ax === curVx && e.ay === curVy ? e.bx : e.ax;
      const nextY = e.ax === curVx && e.ay === curVy ? e.by : e.ay;
      ring.push({ x: nextX, y: nextY });
      curVx = nextX;
      curVy = nextY;

      if (curVx === edges[start].ax && curVy === edges[start].ay) break;

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
      ring.pop();
      rings.push(ring);
    }
  }

  return { rings, rawCount };
}

// ──────────────────────────── Phase 2.5: Small Ring Filtering ───────────────────

function ringArea(ring: { x: number; y: number }[]): number {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y);
  }
  return Math.abs(area) / 2;
}

// ──────────────────────────── Phase 3: Smoothing + Simplification ──────────────

function chaikinSmooth(ring: { x: number; y: number }[]): { x: number; y: number }[] {
  if (ring.length < 3) return ring;
  const out: { x: number; y: number }[] = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const curr = ring[i];
    const next = ring[(i + 1) % n];
    out.push({ x: 0.75 * curr.x + 0.25 * next.x, y: 0.75 * curr.y + 0.25 * next.y });
    out.push({ x: 0.25 * curr.x + 0.75 * next.x, y: 0.25 * curr.y + 0.75 * next.y });
  }
  return out;
}

function simplifyOpen(points: { x: number; y: number }[], epsilon: number): { x: number; y: number }[] {
  const n = points.length;
  if (n < 3 || epsilon <= 0) return points.slice();

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

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

// ──────────────────────────── Phase 4: Boundary Clamping ───────────────────────

/**
 * Clamp ring vertices to image bounds.
 *
 * After Chaikin smoothing + Douglas-Peucker simplification, vertices near the
 * image boundary (within ~1.5px) may have been pulled inward due to corner
 * rounding and segment collapsing. This snaps them back to the image edge,
 * matching the wand.worker.ts approach of handling boundary pixels by treating
 * out-of-bounds as 0.
 *
 * Snap threshold: 1.5px — covers the maximum inward shift from Chaikin (0.25×segment)
 * on 1px marching-squares segments plus DP epsilon.
 */
const BOUNDARY_SNAP_THRESHOLD = 1.5;

function clampToBounds(
  ring: { x: number; y: number }[],
  width: number,
  height: number,
): { x: number; y: number }[] {
  return ring.map(p => ({
    x: p.x < BOUNDARY_SNAP_THRESHOLD ? 0 : p.x > width - BOUNDARY_SNAP_THRESHOLD ? width : p.x,
    y: p.y < BOUNDARY_SNAP_THRESHOLD ? 0 : p.y > height - BOUNDARY_SNAP_THRESHOLD ? height : p.y,
  }));
}

// ──────────────────────────── Pipeline Entry Point ──────────────────────────────

const MIN_RING_AREA = 8;

/**
 * traceAlphaRings: trace the alpha > `threshold` region of an RGBA buffer into
 * closed, smoothed, simplified rings in raster coordinates (0-based pixels,
 * origin top-left). Returns null when nothing significant is opaque; an
 * fully-opaque buffer short-circuits to the full-image rectangle ring.
 */
export function traceAlphaRings(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  threshold: number,
  simplifyEpsilon: number,
): { x: number; y: number }[][] | null {
  const total = width * height;

  const { mask, opaquePixels } = alphaThreshold(pixels, width, height, threshold);

  if (opaquePixels === 0) return null;

  if (opaquePixels === total) {
    return [[{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }]];
  }

  const traced = traceBoundary(mask, width, height);
  if (!traced.rings.length) return null;

  const significantRings = traced.rings.filter(r => ringArea(r) >= MIN_RING_AREA);
  if (!significantRings.length) return null;

  const simplified = significantRings
    .map(r => chaikinSmooth(r))
    .map(r => simplifyRing(r, simplifyEpsilon))
    .filter(r => r.length >= 3)
    .map(r => clampToBounds(r, width, height));

  return simplified.length > 0 ? simplified : null;
}
