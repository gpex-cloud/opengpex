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

// ─── Tool Identity ───────────────────────────────────────────────────────────

/** Config sub-key used for persisted plugin config (e.g. `config.seg`). */
export const MODEL_TYPE_KEY = 'seg' as const;
/** Human-readable display name for this tool category. */
export const MODEL_TYPE_NAME = 'Segmentation';

// ─── Command IDs ─────────────────────────────────────────────────────────────

/** Segmentation encode command — encodes a layer image into SAM embedding */
export const CMD_SEG_ENCODE = 'cmd.seg_encode';
/** Segmentation decode command — decodes prompts against cached embedding */
export const CMD_SEG_DECODE = 'cmd.seg_decode';
/** Segment All Objects — auto grid prompts + NMS → all objects in image */
export const CMD_SEG_ALL = 'cmd.seg_all';

// ─── Signal IDs (legacy — kept for cross-plugin reference) ───────────────────

/** Active tab within the AITools drawer ('bg-removal' | 'segmentation') */
export const SIGNAL_ACTIVE_TAB = 'signal.active_tab';

import type { ModelEntry, ModelCatalog } from '../_shared/types';

// ─── Model Management ────────────────────────────────────────────────────────

/**
 * SegModelEntry — extends ModelEntry with SAM-specific fields.
 *
 * With the transformers.js migration, the model uses AutoModel + AutoProcessor
 * from a single HuggingFace repo (config.json + ONNX weights managed internally
 * by transformers.js). The `encoderFile`/`decoderFile` fields are kept for
 * backwards-compatibility with custom models but are not used by built-in models.
 */
export interface SegModelEntry extends ModelEntry {
  type: 'interactive' | 'auto';
  /**
   * @deprecated Legacy field for raw ORT mode.
   * Encoder filename (ORT-optimized format for onnxruntime-web).
   */
  encoderFile?: string;
  /**
   * @deprecated Legacy field for raw ORT mode.
   * Decoder filename.
   */
  decoderFile?: string;
}

/** @deprecated Legacy constant — transformers.js manages model files internally. */
export const DEFAULT_SEG_ENCODER_FILE = 'onnx/vision_encoder.onnx';
/** @deprecated Legacy constant — transformers.js manages model files internally. */
export const DEFAULT_SEG_DECODER_FILE = 'onnx/prompt_encoder_mask_decoder.onnx';

export const BUILTIN_SEG_MODELS: SegModelEntry[] = [
  {
    id: 'onnx-community/sam2.1-hiera-tiny-ONNX',
    name: 'SAM 2.1 Tiny',
    modelId: 'onnx-community/sam2.1-hiera-tiny-ONNX',
    size: '~300 MB',
    description: 'Recommended — fast interactive segmentation (transformers.js)',
    builtin: true,
    default: true,
    type: 'interactive',
    encoderFile: 'onnx/vision_encoder.onnx',
    decoderFile: 'onnx/prompt_encoder_mask_decoder.onnx',
    expectedBytes: 155_000_000,
  },
];

export interface SegConfig extends ModelCatalog {
  models: SegModelEntry[];
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
 * For transformers.js models (onnx-community/sam2.1-*), returns:
 *   - config.json + preprocessor_config.json (needed by AutoModel/AutoProcessor)
 *   - vision_encoder ONNX + data (image encoder weights)
 *   - prompt_encoder_mask_decoder ONNX + data (decoder weights)
 *
 * Files are listed in the order transformers.js will request them.
 */
export function getSegModelFiles(model: SegModelEntry): { filename: string; expectedBytes?: number }[] {
  const encoderFile = model.encoderFile ?? DEFAULT_SEG_ENCODER_FILE;
  const decoderFile = model.decoderFile ?? DEFAULT_SEG_DECODER_FILE;
  const totalBytes = model.expectedBytes;
  // For transformers.js compatible models, include config + ONNX + data files
  const encoderBytes = totalBytes ? Math.round(totalBytes * 0.87) : undefined; // ~134 MB
  const decoderBytes = totalBytes ? Math.round(totalBytes * 0.13) : undefined; // ~21 MB
  return [
    { filename: 'config.json' },
    { filename: 'preprocessor_config.json' },
    { filename: encoderFile, expectedBytes: encoderBytes },
    { filename: `${encoderFile}_data`, expectedBytes: encoderBytes },
    { filename: decoderFile, expectedBytes: decoderBytes },
    { filename: `${decoderFile}_data`, expectedBytes: decoderBytes },
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
