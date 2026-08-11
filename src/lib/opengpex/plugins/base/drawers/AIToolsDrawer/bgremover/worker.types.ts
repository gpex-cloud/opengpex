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
 * BgRemover Worker Protocol
 *
 * Wire-level types for the request / response / progress messages exchanged
 * between the main thread (`client.ts`) and the bg-removal worker (`worker.ts`).
 *
 * Design notes:
 *   - Mode B (persistent singleton): Worker holds the loaded pipeline across
 *     multiple invocations; model load (~70MB) only happens once.
 *   - Multi-message model: request → N progress messages → 1 final response.
 *   - `reqId` correlation for stale-response defense.
 *   - ImageData buffer transferred as Transferable (zero-copy).
 *   - All model/backend resolution is done on the main thread (full transparency).
 */

import type { WorkerRequest, WorkerProgress, WorkerError } from '../_shared/inference/types';

/** Main thread → Worker */
export interface BgRemoverRequest extends WorkerRequest {
  /**
   * Context snapshot for result validation — the main thread uses these
   * to verify the target Frame/Layer still exists when writing results.
   */
  context?: {
    frameId: string;
    layerId: string;
  };
}

/** Worker → Main thread: Progress update (sent multiple times) */
export type BgRemoverProgress = WorkerProgress;

/** Worker → Main thread: Final result */
export interface BgRemoverResult {
  type: 'result';
  reqId: number;
  /** Context echoed back for validation */
  context?: {
    frameId: string;
    layerId: string;
  } | null;
  /**
   * Contour rings in layer-local coordinates:
   *   rings[0]   — outer boundary (CW)
   *   rings[1+]  — internal holes (CCW)
   * EMPTY array means no useful selection was found.
   */
  rings: { x: number; y: number }[][];
  /** Performance stats */
  debug?: {
    deviceUsed: 'webgpu' | 'wasm';
    inferenceMs: number;
    postProcessMs: number;
    totalMs: number;
  };
}

/** Worker → Main thread: Error */
export type BgRemoverError = WorkerError;

/** Union of all Worker → Main thread messages */
export type BgRemoverResponse = BgRemoverProgress | BgRemoverResult | BgRemoverError;
