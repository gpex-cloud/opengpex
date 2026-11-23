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
 * Denoise Worker Message Protocol
 *
 * Wire-level types for the request / response / progress messages exchanged
 * between the main thread (`client.ts`) and the denoise worker (`worker.ts`).
 *
 * Design notes:
 *   - Extends shared WorkerRequest/WorkerProgress/WorkerError base types
 *   - All model/backend resolution is done on the main thread (full transparency)
 *   - Denoising is resolution-preserving: output dims == input dims
 */

import type { WorkerRequest, WorkerProgress, WorkerError } from '../_shared/inference/types';

// ─── Main → Worker ───────────────────────────────────────────────────────────

export interface DenoiseRequest extends WorkerRequest {
  /** Tile size in pixels (default 256). */
  tileSize?: number;
  /**
   * 16-bit precision path: interleaved RGBA float32 [0, 1] pixels replacing
   * the 8-bit `imageData`. When present, inference runs through the session's
   * f32 entry (`runImageF32`) — no ÷255/×255 quantization at either pipeline
   * end; the caller has already decoded the 16-bit naked truth to f32 [0, 1].
   * `imageData` should be omitted alongside this (the worker errors if both
   * are set, to catch accidental double-feed).
   */
  f32ImageData?: { data: ArrayBuffer; width: number; height: number };
}

// ─── Worker → Main ───────────────────────────────────────────────────────────

export interface DenoiseProgress extends WorkerProgress {
  /** Current tile being processed (1-based). */
  currentTile?: number;
  /** Total number of tiles. */
  totalTiles?: number;
}

export interface DenoiseResult {
  type: 'result';
  reqId: number;
  /** Output RGBA buffer (same size as input) — Transferable. */
  imageData?: { data: ArrayBuffer; width: number; height: number };
  /**
   * f32 precision path output: interleaved RGBA float32 [0, 1], same dims as
   * the input raster (denoising is resolution-preserving). Present only when
   * the request carried `f32ImageData`; `imageData` then carries the 8-bit
   * quantized display proxy of the same pixels.
   */
  f32ImageData?: { data: ArrayBuffer; width: number; height: number };
  debug?: {
    deviceUsed: 'webgpu' | 'wasm';
    totalMs: number;
    tilesProcessed: number;
  };
}

/** Worker → Main thread: Error */
export type DenoiseError = WorkerError;

export type DenoiseResponse = DenoiseProgress | DenoiseResult | DenoiseError;
