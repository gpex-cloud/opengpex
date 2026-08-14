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
 * invert.worker.ts — Standalone Web Worker for "Invert Selection".
 *
 * Uses polygon-clipping library (loaded via importScripts) to compute:
 *   result = canvasRect \ selectionPolygon  (boolean difference)
 *
 * This produces clean geometry that SVG ant-line rendering can stroke
 * without spurious "日"-shaped artifacts.
 */

import type { InvertRequest, InvertResponse } from './protocol';

// ──────────────────────────── Type definitions for polygon-clipping ─────────────

/** polygon-clipping API surface (subset used here) */
interface PolygonClippingLib {
  difference(
    subject: [number, number][][][],
    ...clips: [number, number][][][][]
  ): [number, number][][][];
}

/** Worker global scope augmented after importScripts loads polygon-clipping */
interface PolygonClippingGlobal {
  polygonClipping: PolygonClippingLib | { default: PolygonClippingLib };
}

// ──────────────────────────── Load polygon-clipping via importScripts ───────────

declare function importScripts(...urls: string[]): void;
importScripts('/ext/js/polygon-clipping.js');

// esbuild IIFE with --global-name wraps ESM default export → access via .default
const _pc = (self as unknown as PolygonClippingGlobal).polygonClipping;
const polygonClipping: PolygonClippingLib =
  'default' in _pc ? (_pc as { default: PolygonClippingLib }).default : _pc;

// ──────────────────────────── Core Logic ────────────────────────────────────────

function handleInvert(req: InvertRequest): InvertResponse {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();

  const { rings, canvasW, canvasH } = req;

  if (!rings || rings.length === 0) {
    // No selection → invert = select all (canvas rect)
    const fullRect = [{ x: 0, y: 0 }, { x: canvasW, y: 0 }, { x: canvasW, y: canvasH }, { x: 0, y: canvasH }];
    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return { reqId: req.reqId, rings: [fullRect], debug: { ms: Math.round(t1 - t0) } };
  }

  try {
    // Convert Point2D rings to polygon-clipping format: number[][][]
    // polygon-clipping uses [x, y] coordinate pairs
    // Subject: canvas bounding rectangle
    const subject: [number, number][][] = [
      [[0, 0], [canvasW, 0], [canvasW, canvasH], [0, canvasH], [0, 0]],
    ];

    // Clip: selection polygon (may have multiple rings)
    // Each ring must be closed (first point == last point) for polygon-clipping
    const clip: [number, number][][] = rings.map(ring => {
      const coords: [number, number][] = ring.map(p => [p.x, p.y]);
      // Close the ring if not already closed
      if (coords.length > 0) {
        const first = coords[0];
        const last = coords[coords.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) {
          coords.push([first[0], first[1]]);
        }
      }
      return coords;
    });

    // polygon-clipping.difference expects: difference(subject, ...clips)
    // where subject and each clip are MultiPolygon: number[][][][]
    // subject = [polygon] where polygon = [ring] = [[x,y], ...]
    // clip = [polygon] where polygon = [outerRing, ...holes]
    const result = polygonClipping.difference([subject], [clip]);

    if (!result || result.length === 0) {
      const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
      return { reqId: req.reqId, rings: null, debug: { ms: Math.round(t1 - t0) } };
    }

    // Flatten multi-polygon result into Point2D[][] rings
    const outputRings: { x: number; y: number }[][] = [];
    for (const polygon of result) {
      for (const ring of polygon) {
        // Remove closing duplicate point (polygon-clipping outputs closed rings)
        const pts = ring.map(([x, y]: [number, number]) => ({ x, y }));
        if (pts.length > 1) {
          const first = pts[0];
          const last = pts[pts.length - 1];
          if (first.x === last.x && first.y === last.y) {
            pts.pop();
          }
        }
        if (pts.length >= 3) {
          outputRings.push(pts);
        }
      }
    }

    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return {
      reqId: req.reqId,
      rings: outputRings.length > 0 ? outputRings : null,
      debug: { ms: Math.round(t1 - t0) },
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[invert.worker] ERROR:', errMsg, err);
    return { reqId: req.reqId, rings: null, error: errMsg };
  }
}

// ──────────────────────────── Worker Boilerplate ────────────────────────────────

declare const WorkerGlobalScope: unknown;
if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined') {
  (self as unknown as { onmessage: (ev: MessageEvent<InvertRequest>) => void }).onmessage = (ev) => {
    try {
      const resp = handleInvert(ev.data);
      (self as unknown as { postMessage: (m: InvertResponse) => void }).postMessage(resp);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      (self as unknown as { postMessage: (m: InvertResponse) => void }).postMessage({
        reqId: ev.data?.reqId ?? -1,
        rings: null,
        error: errMsg,
      });
    }
  };
}
