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
 * ClipOptions Worker Protocol
 *
 * Wire-level types for the request/response exchanged between the main
 * thread (client.ts) and the ClipOptions compute workers:
 *   - alpha.worker.ts  (Select from Alpha)
 *   - offset.worker.ts (Morphological/vertex-normal ring offset)
 */

// ─────────────────────────── Alpha Worker Protocol ──────────────────────────────

/** Main thread → alpha.worker */
export interface AlphaRequest {
  reqId: number;
  type: 'alpha';
  imageData: {
    data: ArrayBuffer;
    width: number;
    height: number;
  };
  /** Alpha threshold (0–255). Pixels with alpha > threshold are selected. */
  threshold: number;
  /** Douglas–Peucker simplification epsilon. */
  simplifyEpsilon: number;
}

/** alpha.worker → Main thread */
export interface AlphaResponse {
  reqId: number;
  rings: { x: number; y: number }[][] | null;
  debug?: { opaquePixels: number; totalPixels: number; ms: number };
  error?: string;
}

// ─────────────────────────── Offset Worker Protocol ─────────────────────────────

/** Main thread → offset.worker */
export interface OffsetRequest {
  reqId: number;
  type: 'offset';
  /** Input polygon rings (Point2D[][]) */
  rings: { x: number; y: number }[][];
  /** Offset distance in pixels (negative = expand, positive = contract — matches offsetRings convention) */
  distance: number;
  /** Canvas width (rasterization bounds for morphological offset) */
  canvasW: number;
  /** Canvas height */
  canvasH: number;
  /** Whether to use vertex-normal (regular) or morphological (irregular) algorithm */
  algorithm: 'vertex-normal' | 'morphological';
  /** Douglas–Peucker simplification epsilon (only for morphological, default 1.0) */
  simplifyEpsilon?: number;
}

/** offset.worker → Main thread */
export interface OffsetResponse {
  reqId: number;
  /** Offset rings, or null if selection collapses */
  rings: { x: number; y: number }[][] | null;
  debug?: { ms: number };
  error?: string;
}
