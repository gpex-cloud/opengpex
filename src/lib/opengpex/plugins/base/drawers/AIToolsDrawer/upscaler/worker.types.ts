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
 * Upscale Worker Message Protocol
 *
 * Wire-level types for the request / response / progress messages exchanged
 * between the main thread (`client.ts`) and the upscale worker (`worker.ts`).
 *
 * Design notes:
 *   - Extends shared WorkerRequest/WorkerProgress/WorkerError base types
 *   - All model/backend resolution is done on the main thread (full transparency)
 *   - Worker only receives fully resolved parameters and executes
 */

import type { WorkerRequest, WorkerProgress, WorkerError } from '../_shared/inference/types';

// ─── Main → Worker ───────────────────────────────────────────────────────────

export interface UpscaleRequest extends WorkerRequest {
  /**
   * Native output scale of the model (2 or 4).
   * 2x models output [1,3,H*2,W*2], 4x models output [1,3,H*4,W*4].
   * @default 4
   */
  modelScale?: 2 | 4;
  /** Target scale factor (may differ from modelScale — triggers post-processing). */
  scale?: 2 | 4;
  /** Tile size in pixels (default 128). */
  tileSize?: number;
  /**
   * f32 precision input (16-bit source): interleaved RGBA f32 [0, 1] decoded
   * from the `dec:` truth. When present, inference runs through the session's
   * f32 entry and the base `imageData` should be omitted alongside this.
   */
  f32ImageData?: { data: ArrayBuffer; width: number; height: number };
}

// ─── Worker → Main ───────────────────────────────────────────────────────────

export interface UpscaleProgress extends WorkerProgress {
  /** Current tile being processed (1-based). */
  currentTile?: number;
  /** Total number of tiles. */
  totalTiles?: number;
}

export interface UpscaleResult {
  type: 'result';
  reqId: number;
  /** Output RGBA buffer (scaled size) — Transferable. */
  imageData?: { data: ArrayBuffer; width: number; height: number };
  /**
   * f32 precision truth of the upscaled output (present iff the request
   * carried `f32ImageData`); `imageData` then carries the 8-bit display proxy.
   */
  f32ImageData?: { data: ArrayBuffer; width: number; height: number };
  debug?: {
    deviceUsed: 'webgpu' | 'wasm';
    totalMs: number;
    tilesProcessed: number;
  };
}

/** Worker → Main thread: Error */
export type UpscaleError = WorkerError;

export type UpscaleResponse = UpscaleProgress | UpscaleResult | UpscaleError;
