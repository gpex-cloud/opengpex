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
 * Thin shell: the tracing pipeline (alpha thresholding → marching-squares
 * boundary tracing → small ring filtering → Chaikin smoothing + Douglas-
 * Peucker simplification → boundary clamping) lives in
 * core/geometry/operators/alpha.ts, shared verbatim with the bake
 * family's outline rebuild. This file only adapts the worker protocol.
 */

/**
 * The tracing math lives in geometry/operators/alpha.ts — shared
 * verbatim with the bake family's outline rebuild (services/baking.ts), so
 * "Select from Alpha" and bake outlines trace with the SAME algorithm.
 * Imported via the geometry public whitelist: a worker has no
 * GeometryService instance to receive.
 */
import { traceAlphaRings } from '@opengpex/editor/core/geometry/public';
import type { AlphaRequest, AlphaResponse } from './protocol';

function handleAlpha(req: AlphaRequest): AlphaResponse {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

  const rings = traceAlphaRings(
    new Uint8ClampedArray(req.imageData.data),
    req.imageData.width,
    req.imageData.height,
    req.threshold,
    req.simplifyEpsilon,
  );

  const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const totalPixels = req.imageData.width * req.imageData.height;

  return {
    reqId: req.reqId,
    rings,
    debug: { opaquePixels: 0, totalPixels, ms: Math.round(t1 - t0) },
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
