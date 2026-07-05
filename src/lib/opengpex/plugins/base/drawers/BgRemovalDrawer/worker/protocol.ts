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
 * BgRemoval Worker Protocol
 *
 * Wire-level types for the request / response / progress messages exchanged
 * between the main thread (`client.ts`) and the bg-removal worker
 * (`bg-removal.worker.ts`).
 *
 * Design notes (per 202606026_ai_bg_removal_spec §2.4 & §2.5):
 *   - Mode B (persistent singleton): Worker holds the loaded pipeline across
 *     multiple invocations; model load (~70MB) only happens once.
 *   - Multi-message model: request → N progress messages → 1 final response.
 *   - `reqId` correlation for stale-response defense.
 *   - ImageData buffer transferred as Transferable (zero-copy).
 *   - Dynamic model selection: `modelId` specifies which HuggingFace model to load.
 */

/** Main thread → Worker */
export interface BgRemovalRequest {
  /** Correlation id (echoed back in all responses/progress). */
  reqId: number;

  /**
   * Action type:
   *   - 'remove' (default): Run complete background removal (download/load + inference)
   *   - 'download': Only download/load the model to cache, do not run inference
   */
  action?: 'remove' | 'download';

  /**
   * HuggingFace model repository ID to use for inference.
   * e.g. "briaai/RMBG-1.4", "schirrmacher/birefnet-general"
   */
  modelId: string;

  /**
   * Layer raster pixels (RGBA8). Buffer is detached on postMessage
   * — caller MUST NOT touch it after sending.
   */
  imageData?: {
    data: ArrayBuffer;
    width: number;
    height: number;
  };

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
export interface BgRemovalProgress {
  type: 'progress';
  reqId: number;
  stage: 'detecting-device' | 'loading' | 'downloading' | 'processing';
  /** Device detected (only set after device detection) */
  device?: 'webgpu' | 'wasm';
  /** Download progress fields (only during 'downloading') */
  file?: string;
  loaded?: number;
  total?: number;
  /** Processing progress 0-1 (only during 'processing') */
  progress?: number;
}

/** Worker → Main thread: Final result */
export interface BgRemovalResult {
  type: 'result';
  reqId: number;
  /** Action type echoed back */
  action?: 'remove' | 'download';
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
export interface BgRemovalError {
  type: 'error';
  reqId: number;
  error: string;
}

/** Union of all Worker → Main thread messages */
export type BgRemovalResponse = BgRemovalProgress | BgRemovalResult | BgRemovalError;
