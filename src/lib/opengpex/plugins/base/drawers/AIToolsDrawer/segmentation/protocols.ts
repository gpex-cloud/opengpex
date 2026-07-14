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
 * Segmentation Feature Protocols
 *
 * Domain-level types, constants and configuration for the SAM segmentation
 * feature. These are consumed by the panel, commands, hooks, settings UI,
 * and external consumers (e.g. ClipOverlay/sam.ts).
 *
 * Worker wire-level types live in `./worker.types.ts`.
 */

// ─── Command IDs ─────────────────────────────────────────────────────────────

/** Segmentation encode command — encodes a layer image into SAM embedding */
export const CMD_SEG_ENCODE = 'cmd.seg_encode';
/** Segmentation decode command — decodes prompts against cached embedding */
export const CMD_SEG_DECODE = 'cmd.seg_decode';
/** Segment All Objects — auto grid prompts + NMS → all objects in image */
export const CMD_SEG_ALL = 'cmd.seg_all';

// ─── Signal IDs ──────────────────────────────────────────────────────────────

export const SIGNAL_SEG_STATUS = 'signal.seg_status';
/** Active tab within the AITools drawer ('bg-removal' | 'segmentation') */
export const SIGNAL_ACTIVE_TAB = 'signal.active_tab';

// ─── Status Types ────────────────────────────────────────────────────────────

export type SegStage =
  | 'idle'
  | 'downloading'
  | 'encoding'
  | 'decoding'
  | 'ready'       // Embedding cached, awaiting prompts
  | 'error';

export interface SegStatus {
  [key: string]: unknown;
  stage: SegStage;
  device: 'webgpu' | 'wasm' | null;
  downloadProgress: number;
  downloadedBytes: number;
  totalBytes: number;
  speedBps: number;
  etaSeconds: number;
  downloadFile: string | null;
  encodeProgress: number;
  errorMessage: string | null;
  embeddingReady: boolean;
  /** Asset ID of the layer with a warm embedding */
  embeddingAssetId: string | null;
  /** Last decode results (up to 3 candidates) */
  candidates: Array<{
    rings: { x: number; y: number }[][];
    score: number;
  }>;
  /** Index of the currently active candidate in clipBoxes */
  activeCandidateIdx: number;
  /** Performance stats from last decode */
  lastDecodeMs: number;
  /** Total elapsed ms */
  elapsedMs: number;
}

export const INITIAL_SEG_STATUS: SegStatus = {
  stage: 'idle',
  device: null,
  downloadProgress: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  speedBps: 0,
  etaSeconds: 0,
  downloadFile: null,
  encodeProgress: 0,
  errorMessage: null,
  embeddingReady: false,
  embeddingAssetId: null,
  candidates: [],
  activeCandidateIdx: 0,
  lastDecodeMs: 0,
  elapsedMs: 0,
};

// ─── Model Management ────────────────────────────────────────────────────────

export interface SegModelEntry {
  id: string;
  name: string;
  modelId: string;
  size: string;
  description: string;
  builtin: boolean;
  default?: boolean;
  type: 'interactive' | 'auto';
  /**
   * Encoder filename (ORT-optimized format for onnxruntime-web).
   * Defaults to "encoder.with_runtime_opt.ort".
   * Some repos may use "encoder_fp16.ort" or similar variants.
   */
  encoderFile?: string;
  /**
   * Decoder filename. Defaults to "decoder.onnx".
   * Some repos may use "decoder_fp16.onnx" or similar variants.
   */
  decoderFile?: string;
  /**
   * Expected total download size in bytes (approximate).
   * Used for download progress estimation.
   */
  expectedBytes?: number;
}

export const DEFAULT_SEG_ENCODER_FILE = 'encoder.with_runtime_opt.ort';
export const DEFAULT_SEG_DECODER_FILE = 'decoder.onnx';

export const BUILTIN_SEG_MODELS: SegModelEntry[] = [
  {
    id: 'SharpAI/sam2-hiera-tiny-onnx',
    name: 'SAM 2.1 Tiny',
    modelId: 'SharpAI/sam2-hiera-tiny-onnx',
    size: '~155 MB',
    description: 'Recommended — fast interactive segmentation',
    builtin: true,
    default: true,
    type: 'interactive',
    encoderFile: 'encoder.with_runtime_opt.ort',
    decoderFile: 'decoder.onnx',
    expectedBytes: 42_000_000, // ~40 MB total
  },
];

export interface SegConfig {
  [key: string]: unknown;
  models: SegModelEntry[];
  activeModelId: string;
}

export const DEFAULT_SEG_CONFIG: SegConfig = {
  models: [...BUILTIN_SEG_MODELS],
  activeModelId: BUILTIN_SEG_MODELS[0].id,
};

// ─── Model Files (download manifest) ─────────────────────────────────────────

/**
 * Legacy constant — kept for backwards compatibility.
 * @deprecated Use `getSegModelFiles(model)` instead.
 */
export const SEG_MODEL_FILES = [
  { filename: 'encoder.with_runtime_opt.ort' },
  { filename: 'decoder.onnx' },
] as const;

/**
 * Get the download manifest for a segmentation model.
 *
 * Only downloads files actually used at inference:
 *   - encoder (ORT-optimized, e.g. "encoder.with_runtime_opt.ort")
 *   - decoder (e.g. "decoder.onnx")
 *
 * NOTE: `encoder.onnx` (raw ONNX) is NOT downloaded — it's for Python/desktop
 * only and may contain ops unsupported by onnxruntime-web.
 */
export function getSegModelFiles(model: SegModelEntry): { filename: string; expectedBytes?: number }[] {
  const encoderFile = model.encoderFile ?? DEFAULT_SEG_ENCODER_FILE;
  const decoderFile = model.decoderFile ?? DEFAULT_SEG_DECODER_FILE;
  // Split expected bytes roughly: encoder is ~80% of total, decoder ~20%
  const totalBytes = model.expectedBytes;
  const encoderBytes = totalBytes ? Math.round(totalBytes * 0.8) : undefined;
  const decoderBytes = totalBytes ? Math.round(totalBytes * 0.2) : undefined;
  return [
    { filename: encoderFile, expectedBytes: encoderBytes },
    { filename: decoderFile, expectedBytes: decoderBytes },
  ];
}

// ─── Cross-Plugin Public Types ───────────────────────────────────────────────
//
// These types form the PUBLIC CONTRACT for external consumers (e.g. ClipOverlay).
// Internal implementation details (Worker messages, ONNX sessions) stay in
// `./worker.types.ts` and are NOT exported here.

/**
 * SegPrompt — User interaction prompt for SAM decoding.
 *
 * Coordinates are in **image-local** space (pixels relative to the layer's
 * intrinsic width × height). The caller (e.g. SAM interaction handler) is
 * responsible for projecting world/canvas coords → layer-local before
 * submitting.
 */
export type SegPrompt =
  | { type: 'point'; x: number; y: number; label: 0 | 1 }  // 0=background, 1=foreground
  | { type: 'box'; x1: number; y1: number; x2: number; y2: number };

/** Payload for `CMD_SEG_ENCODE` — encode a layer image into SAM embedding. */
export interface SegEncodePayload {
  /** RGBA pixel buffer (Transferable — zero-copy to Worker). */
  imageData: {
    data: ArrayBuffer;
    width: number;
    height: number;
  };
  /** Context for stale-response validation. */
  context: {
    frameId: string;
    layerId: string;
    assetId: string;
  };
}

/** Result of `CMD_SEG_ENCODE`. */
export interface SegEncodeResult {
  success: boolean;
  error?: string;
}

/** Payload for `CMD_SEG_DECODE` — decode prompts against a cached embedding. */
export interface SegDecodePayload {
  prompts: SegPrompt[];
  /** Context — must match the most recent encode's context. */
  context: {
    frameId: string;
    layerId: string;
    assetId: string;
  };
}

/** Result of `CMD_SEG_DECODE`. */
export interface SegDecodeResult {
  success: boolean;
  /** Up to 3 candidate masks sorted by score descending. */
  masks?: Array<{
    rings: { x: number; y: number }[][];
    score: number;
  }>;
  /** Performance stats. */
  debug?: {
    deviceUsed: 'webgpu' | 'wasm';
    encodeMs?: number;
    decodeMs?: number;
    postProcessMs?: number;
    totalMs: number;
  };
  error?: string;
}
