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
 * invert.worker.ts — Standalone Web Worker for "Invert Selection" and the
 * selection boolean combine (P5: Shift = union / Alt = difference).
 *
 * Uses polygon-clipping (loaded via importScripts) to compute:
 *   invert:  result = canvasRect \ selectionPolygon  (boolean difference)
 *   boolean: result = base <op> incoming             (union/intersection/diff)
 *
 * This produces clean geometry that SVG ant-line rendering can stroke
 * without spurious double-box / figure-8 artifacts. The pure math lives in
 * poly-bool.ts (lib injected), so tests can drive the npm build of the
 * same library.
 */

import type { BooleanRequest, BooleanResponse, InvertRequest, InvertResponse } from './protocol';
import {
  computeBooleanRings,
  computeInvertRings,
  type PolygonClippingLib,
} from '@opengpex/editor/core/geometry/poly-bool';

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

// ──────────────────────────── Handlers ──────────────────────────────────────────

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function handleInvert(req: InvertRequest): InvertResponse {
  const t0 = now();
  try {
    const rings = computeInvertRings(polygonClipping, req.rings, req.canvasW, req.canvasH);
    return { reqId: req.reqId, rings, debug: { ms: Math.round(now() - t0) } };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[invert.worker] ERROR:', errMsg, err);
    return { reqId: req.reqId, rings: null, error: errMsg };
  }
}

function handleBoolean(req: BooleanRequest): BooleanResponse {
  const t0 = now();
  try {
    const rings = computeBooleanRings(polygonClipping, req.op, req.base, req.incoming);
    return { reqId: req.reqId, rings, debug: { ms: Math.round(now() - t0) } };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[invert.worker] boolean ERROR:', errMsg, err);
    return { reqId: req.reqId, rings: null, error: errMsg };
  }
}

// ──────────────────────────── Worker Boilerplate ────────────────────────────────

declare const WorkerGlobalScope: unknown;
if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined') {
  (self as unknown as { onmessage: (ev: MessageEvent<InvertRequest | BooleanRequest>) => void }).onmessage = (ev) => {
    const req = ev.data;
    try {
      if (req.type === 'boolean') {
        (self as unknown as { postMessage: (m: BooleanResponse) => void }).postMessage(handleBoolean(req));
      } else {
        (self as unknown as { postMessage: (m: InvertResponse) => void }).postMessage(handleInvert(req));
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      (self as unknown as { postMessage: (m: InvertResponse | BooleanResponse) => void }).postMessage({
        reqId: req?.reqId ?? -1,
        rings: null,
        error: errMsg,
      });
    }
  };
}
