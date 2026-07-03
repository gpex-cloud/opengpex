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
 * alpha.worker.ts — Standalone Web Worker for "Select from Alpha".
 *
 * Pipeline:
 *   Phase 1: Alpha thresholding → binary mask
 *   Phase 2: Boundary tracing (marching-squares edge extraction → closed rings)
 *   Phase 2.5: Small ring filtering
 *   Phase 3: Chaikin smoothing + Douglas-Peucker simplification
 *
 * This is a dedicated worker (independent of wand.worker.ts) that handles
 * AlphaRequest messages. It intentionally has no editor/React dependencies.
 */

import type { AlphaRequest, AlphaResponse } from './protocol';

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

// ──────────────────────────── Pipeline Entry Point ──────────────────────────────

const MIN_RING_AREA = 8;

function handleAlpha(req: AlphaRequest): AlphaResponse {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

  const { width, height } = req.imageData;
  const pixels = new Uint8ClampedArray(req.imageData.data);
  const total = width * height;

  const { mask, opaquePixels } = alphaThreshold(pixels, width, height, req.threshold);

  if (opaquePixels === 0) {
    return { reqId: req.reqId, rings: null, debug: { opaquePixels, totalPixels: total, ms: 0 } };
  }

  if (opaquePixels === total) {
    const rings = [[{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }]];
    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    return { reqId: req.reqId, rings, debug: { opaquePixels, totalPixels: total, ms: Math.round(t1 - t0) } };
  }

  const traced = traceBoundary(mask, width, height);
  if (!traced.rings.length) {
    return { reqId: req.reqId, rings: null, debug: { opaquePixels, totalPixels: total, ms: 0 } };
  }

  const significantRings = traced.rings.filter(r => ringArea(r) >= MIN_RING_AREA);
  if (!significantRings.length) {
    return { reqId: req.reqId, rings: null, debug: { opaquePixels, totalPixels: total, ms: 0 } };
  }

  const simplified = significantRings
    .map(r => chaikinSmooth(r))
    .map(r => simplifyRing(r, req.simplifyEpsilon))
    .filter(r => r.length >= 3);

  const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

  return {
    reqId: req.reqId,
    rings: simplified.length > 0 ? simplified : null,
    debug: { opaquePixels, totalPixels: total, ms: Math.round(t1 - t0) },
  };
}

// ──────────────────────────── Worker Boilerplate ────────────────────────────────

declare const WorkerGlobalScope: unknown;
if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined') {
  (self as unknown as { onmessage: (ev: MessageEvent<AlphaRequest>) => void }).onmessage = (ev) => {
    try {
      const resp = handleAlpha(ev.data);
      (self as unknown as { postMessage: (m: AlphaResponse) => void }).postMessage(resp);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      (self as unknown as { postMessage: (m: AlphaResponse) => void }).postMessage({
        reqId: ev.data?.reqId ?? -1,
        rings: null,
        error: errMsg,
      });
    }
  };
}
