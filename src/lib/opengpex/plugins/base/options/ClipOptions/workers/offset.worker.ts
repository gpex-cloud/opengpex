/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * offset.worker.ts — Web Worker for polygon ring offset operations.
 *
 * Two algorithms:
 *   - vertex-normal: Fast, for regular selections (rect/ellipse). Shifts each
 *     vertex along its averaged-normal by `distance` pixels.
 *   - morphological: Photoshop-style EDT-based offset for irregular selections
 *     (lasso/wand). No spikes, no self-intersections, handles topology changes.
 *
 * Convention: negative distance = expand, positive = contract
 * (matches the CW-wound ring inward-normal convention of the editor).
 */

import type { OffsetRequest, OffsetResponse } from './protocol';

type Point2D = { x: number; y: number };

// ═══════════════════════════════════════════════════════════════════════════════
// Vertex-Normal Offset (for regular selections)
// ═══════════════════════════════════════════════════════════════════════════════

function offsetRings(rings: Point2D[][], distance: number, canvasW: number, canvasH: number): Point2D[][] | null {
  if (distance === 0 || rings.length === 0) return rings;
  const result: Point2D[][] = [];

  for (const ring of rings) {
    if (ring.length < 3) continue;
    const offsetRing = offsetSingleRing(ring, distance);
    if (!offsetRing || offsetRing.length < 3) continue;
    const clamped = clampRingToBounds(offsetRing, canvasW, canvasH);
    if (clamped.length >= 3 && computeRingArea(clamped) > 1) {
      result.push(clamped);
    }
  }

  return result.length > 0 ? result : null;
}

function offsetSingleRing(ring: Point2D[], distance: number): Point2D[] | null {
  const n = ring.length;
  const result: Point2D[] = [];

  for (let i = 0; i < n; i++) {
    const prev = ring[(i - 1 + n) % n];
    const curr = ring[i];
    const next = ring[(i + 1) % n];

    const e1x = curr.x - prev.x, e1y = curr.y - prev.y;
    const e2x = next.x - curr.x, e2y = next.y - curr.y;

    const len1 = Math.sqrt(e1x * e1x + e1y * e1y) || 1;
    const len2 = Math.sqrt(e2x * e2x + e2y * e2y) || 1;

    const n1x = -e1y / len1, n1y = e1x / len1;
    const n2x = -e2y / len2, n2y = e2x / len2;

    let nx = n1x + n2x, ny = n1y + n2y;
    const nLen = Math.sqrt(nx * nx + ny * ny);

    if (nLen < 1e-6) {
      nx = n1x; ny = n1y;
    } else {
      nx /= nLen; ny /= nLen;
      const dot = n1x * nx + n1y * ny;
      const scale = dot > 0.1 ? 1 / dot : 1;
      const clampedScale = Math.min(scale, 4);
      nx *= clampedScale; ny *= clampedScale;
    }

    result.push({
      x: Math.round((curr.x + nx * distance) * 100) / 100,
      y: Math.round((curr.y + ny * distance) * 100) / 100,
    });
  }

  return result;
}

function clampRingToBounds(ring: Point2D[], canvasW: number, canvasH: number): Point2D[] {
  return ring.map(p => ({
    x: Math.max(0, Math.min(canvasW, p.x)),
    y: Math.max(0, Math.min(canvasH, p.y)),
  }));
}

function computeRingArea(ring: Point2D[]): number {
  let area = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += ring[i].x * ring[j].y;
    area -= ring[j].x * ring[i].y;
  }
  return Math.abs(area) / 2;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Morphological (Distance-Field) Offset (for irregular selections)
// ═══════════════════════════════════════════════════════════════════════════════

function morphOffsetRings(
  rings: Point2D[][],
  distance: number,
  canvasW: number,
  canvasH: number,
  simplifyEpsilon: number
): Point2D[][] | null {
  if (distance === 0 || rings.length === 0) return rings;
  if (canvasW <= 0 || canvasH <= 0) return null;

  const mask = rasterizeRings(rings, canvasW, canvasH);
  const absDist = Math.abs(distance);
  // Convention: distance < 0 → expand, distance > 0 → contract
  const expanding = distance < 0;

  const distField = expanding
    ? computeEDT(mask, canvasW, canvasH, false)
    : computeEDT(mask, canvasW, canvasH, true);

  const newMask = new Uint8Array(canvasW * canvasH);
  for (let i = 0; i < newMask.length; i++) {
    if (expanding) {
      newMask[i] = (mask[i] === 1 || distField[i] <= absDist) ? 1 : 0;
    } else {
      newMask[i] = (mask[i] === 1 && distField[i] > absDist) ? 1 : 0;
    }
  }

  const rawRings = morphTraceBoundary(newMask, canvasW, canvasH);
  if (rawRings.length === 0) return null;

  const result: Point2D[][] = [];
  for (const ring of rawRings) {
    const simplified = morphSimplifyRing(ring, simplifyEpsilon);
    if (simplified.length >= 3) result.push(simplified);
  }

  return result.length > 0 ? result : null;
}

// ─── Rasterization ────────────────────────────────────────────────────────────

function rasterizeRings(rings: Point2D[][], w: number, h: number): Uint8Array {
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const intersections: number[] = [];
    const scanY = y + 0.5;
    for (const ring of rings) {
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const a = ring[i], b = ring[(i + 1) % n];
        if ((a.y <= scanY && b.y > scanY) || (b.y <= scanY && a.y > scanY)) {
          const t = (scanY - a.y) / (b.y - a.y);
          intersections.push(a.x + t * (b.x - a.x));
        }
      }
    }
    intersections.sort((a, b) => a - b);
    for (let i = 0; i < intersections.length - 1; i += 2) {
      const xStart = Math.max(0, Math.ceil(intersections[i]));
      const xEnd = Math.min(w - 1, Math.floor(intersections[i + 1]));
      for (let x = xStart; x <= xEnd; x++) mask[y * w + x] = 1;
    }
  }
  return mask;
}

// ─── EDT (Felzenszwalb) ───────────────────────────────────────────────────────

function computeEDT(mask: Uint8Array, w: number, h: number, inside: boolean): Float32Array {
  const INF = 1e20;
  const size = w * h;
  const d = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    d[i] = inside ? (mask[i] === 1 ? INF : 0) : (mask[i] === 0 ? INF : 0);
  }

  const maxDim = Math.max(w, h);
  const f = new Float32Array(maxDim);
  const z = new Float32Array(maxDim + 1);
  const v = new Int32Array(maxDim);

  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = d[y * w + x];
    edt1d(f, h, v, z);
    for (let y = 0; y < h; y++) d[y * w + x] = f[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = d[y * w + x];
    edt1d(f, w, v, z);
    for (let x = 0; x < w; x++) d[y * w + x] = f[x];
  }

  for (let i = 0; i < size; i++) d[i] = Math.sqrt(d[i]);
  return d;
}

function edt1d(f: Float32Array, n: number, v: Int32Array, z: Float32Array): void {
  v[0] = 0; z[0] = -1e20; z[1] = 1e20;
  let k = 0;
  for (let q = 1; q < n; q++) {
    while (true) {
      const vk = v[k];
      const s = ((f[q] + q * q) - (f[vk] + vk * vk)) / (2 * q - 2 * vk);
      if (s > z[k]) { k++; v[k] = q; z[k] = s; z[k + 1] = 1e20; break; }
      k--;
    }
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const vk = v[k];
    f[q] = (q - vk) * (q - vk) + f[vk];
  }
}

// ─── Boundary Tracing ─────────────────────────────────────────────────────────

function morphTraceBoundary(mask: Uint8Array, width: number, height: number): Point2D[][] {
  interface MorphEdge { ax: number; ay: number; bx: number; by: number; }
  const edges: MorphEdge[] = [];
  const get = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= width || y >= height) return 0;
    return mask[y * width + x];
  };

  for (let y = 0; y <= height; y++)
    for (let x = 0; x < width; x++)
      if (get(x, y - 1) !== get(x, y))
        edges.push({ ax: x, ay: y, bx: x + 1, by: y });

  for (let x = 0; x <= width; x++)
    for (let y = 0; y < height; y++)
      if (get(x - 1, y) !== get(x, y))
        edges.push({ ax: x, ay: y, bx: x, by: y + 1 });

  if (!edges.length) return [];

  const vkey = (x: number, y: number) => y * (width + 1) + x;
  const adjacency = new Map<number, number[]>();
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const ka = vkey(e.ax, e.ay), kb = vkey(e.bx, e.by);
    let la = adjacency.get(ka); if (!la) { la = []; adjacency.set(ka, la); } la.push(i);
    let lb = adjacency.get(kb); if (!lb) { lb = []; adjacency.set(kb, lb); } lb.push(i);
  }

  const used = new Uint8Array(edges.length);
  const rings: Point2D[][] = [];

  for (let start = 0; start < edges.length; start++) {
    if (used[start]) continue;
    const ring: Point2D[] = [];
    let curEdge = start, curVx = edges[start].ax, curVy = edges[start].ay;
    ring.push({ x: curVx, y: curVy });

    while (true) {
      used[curEdge] = 1;
      const e = edges[curEdge];
      const nextVx = (e.ax === curVx && e.ay === curVy) ? e.bx : e.ax;
      const nextVy = (e.ax === curVx && e.ay === curVy) ? e.by : e.ay;
      const candidates = adjacency.get(vkey(nextVx, nextVy));
      let found = -1;
      if (candidates) for (const idx of candidates) { if (!used[idx]) { found = idx; break; } }
      if (found === -1) break;
      ring.push({ x: nextVx, y: nextVy });
      curVx = nextVx; curVy = nextVy; curEdge = found;
    }

    if (ring.length >= 4) rings.push(ring);
  }

  return rings;
}

// ─── Simplification ───────────────────────────────────────────────────────────

function morphSimplifyRing(ring: Point2D[], epsilon: number): Point2D[] {
  if (ring.length <= 4) return ring;
  const closed = [...ring, ring[0]];
  const simplified = morphSimplifyOpen(closed, epsilon);
  if (simplified.length > 1) {
    const first = simplified[0], last = simplified[simplified.length - 1];
    if (first.x === last.x && first.y === last.y) simplified.pop();
  }
  return simplified;
}

function morphSimplifyOpen(points: Point2D[], epsilon: number): Point2D[] {
  if (points.length <= 2) return [...points];
  let maxDist = 0, maxIdx = 0;
  const first = points[0], last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], first, last);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }
  if (maxDist > epsilon) {
    const left = morphSimplifyOpen(points.slice(0, maxIdx + 1), epsilon);
    const right = morphSimplifyOpen(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }
  return [first, last];
}

function perpDist(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.sqrt((p.x - a.x) ** 2 + (p.y - a.y) ** 2);
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / Math.sqrt(lenSq);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Worker Entry Point
// ═══════════════════════════════════════════════════════════════════════════════

function handleOffset(req: OffsetRequest): OffsetResponse {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

  try {
    let result: Point2D[][] | null;
    if (req.algorithm === 'vertex-normal') {
      result = offsetRings(req.rings, req.distance, req.canvasW, req.canvasH);
    } else {
      result = morphOffsetRings(req.rings, req.distance, req.canvasW, req.canvasH, req.simplifyEpsilon ?? 1.0);
    }

    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    return { reqId: req.reqId, rings: result, debug: { ms: Math.round(t1 - t0) } };
  } catch (err) {
    return { reqId: req.reqId, rings: null, error: err instanceof Error ? err.message : String(err) };
  }
}

declare const WorkerGlobalScope: unknown;
if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined') {
  (self as unknown as { onmessage: (ev: MessageEvent<OffsetRequest>) => void }).onmessage = (ev) => {
    const resp = handleOffset(ev.data);
    (self as unknown as { postMessage: (m: OffsetResponse) => void }).postMessage(resp);
  };
}
