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
 * Segmentation Worker Protocol
 *
 * Wire-level types for request / response / progress messages exchanged between
 * the main thread (`seg-client.ts`) and the segmentation worker
 * (`segmentation.worker.ts`).
 *
 * SAM 2.1 two-stage architecture:
 *   - 'download': Download model ONNX files to Cache Storage
 *   - 'encode': Run Image Encoder on a full image → cache embedding in Worker memory
 *   - 'decode': Run Mask Decoder with prompts → return polygon rings
 *   - 'segment-all': Auto mode — grid prompts + NMS → return all detected objects
 *
 * Design patterns (consistent with BgRemover Worker):
 *   - Mode B persistent singleton: Worker holds encoder/decoder sessions across calls
 *   - Multi-message: request → N progress → 1 result/error
 *   - reqId correlation for stale-response defense
 *   - Transferable ArrayBuffer for imageData (zero-copy)
 */

// ─── Prompt Types ────────────────────────────────────────────────────────────

export type SegPrompt =
  | { type: 'point'; x: number; y: number; label: 0 | 1 }  // 0=background, 1=foreground
  | { type: 'box'; x1: number; y1: number; x2: number; y2: number };

// ─── Main → Worker ───────────────────────────────────────────────────────────

export interface SegRequest {
  /** Correlation id (echoed in all responses). */
  reqId: number;

  /**
   * Action type:
   *   - 'download': Only download model to cache (no inference)
   *   - 'encode': Run Image Encoder → cache embedding
   *   - 'decode': Run Mask Decoder with prompts → polygon results
   *   - 'segment-all': Auto mode (grid prompts + NMS)
   */
  action: 'download' | 'encode' | 'decode' | 'segment-all';

  /** HuggingFace model ID or custom model identifier */
  modelId: string;

  /**
   * Image pixels for 'encode' action.
   * RGBA8 buffer, detached on postMessage (zero-copy).
   */
  imageData?: {
    data: ArrayBuffer;
    width: number;
    height: number;
  };

  /** Prompts for 'decode' action. */
  prompts?: SegPrompt[];

  /** Context for result validation (frame/layer/asset still exist). */
  context?: {
    frameId: string;
    layerId: string;
    assetId: string;
  };
}

// ─── Worker → Main: Progress ─────────────────────────────────────────────────

export interface SegProgress {
  type: 'progress';
  reqId: number;
  stage: 'detecting-device' | 'downloading' | 'encoding' | 'decoding' | 'post-processing';
  /** Device detected (set after detection). */
  device?: 'webgpu' | 'wasm';
  /** Download progress fields (only during 'downloading'). */
  file?: string;
  loaded?: number;
  total?: number;
  /** General 0-1 progress (encoding/decoding). */
  progress?: number;
}

// ─── Worker → Main: Result ───────────────────────────────────────────────────

export interface SegResult {
  type: 'result';
  reqId: number;
  action: 'download' | 'encode' | 'decode' | 'segment-all';

  /** 'encode' success flag. */
  embeddingReady?: boolean;

  /**
   * 'decode' result: up to 3 candidate masks (sorted by score desc).
   * Each mask contains polygon rings in image-local coordinates.
   */
  masks?: Array<{
    rings: { x: number; y: number }[][];
    score: number;
  }>;

  /**
   * 'segment-all' result: all detected objects.
   */
  segments?: Array<{
    id: number;
    rings: { x: number; y: number }[][];
    score: number;
    bounds: { x: number; y: number; w: number; h: number };
  }>;

  /** Context echoed back for validation. */
  context?: {
    frameId: string;
    layerId: string;
    assetId: string;
  } | null;

  /** Performance stats. */
  debug?: {
    deviceUsed: 'webgpu' | 'wasm';
    encodeMs?: number;
    decodeMs?: number;
    postProcessMs?: number;
    totalMs: number;
  };
}

// ─── Worker → Main: Error ────────────────────────────────────────────────────

export interface SegError {
  type: 'error';
  reqId: number;
  error: string;
}

// ─── Union ───────────────────────────────────────────────────────────────────

export type SegResponse = SegProgress | SegResult | SegError;
