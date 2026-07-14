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
 * BgRemover Feature Protocols
 *
 * Domain-level types, constants and configuration for the AI background removal
 * feature. These are consumed by the panel, commands, hooks, and settings UI.
 *
 * Worker wire-level types live in `./worker.types.ts`.
 */

// ─── Command IDs ─────────────────────────────────────────────────────────────

export const CMD_REMOVE_BG = 'cmd.remove_bg';
export const CMD_DOWNLOAD_MODEL = 'cmd.download_model';
export const CMD_ABORT = 'cmd.abort';
export const CMD_OPEN_SETTINGS = 'cmd.open_settings';

// ─── Signal IDs ──────────────────────────────────────────────────────────────

export const SIGNAL_STATUS = 'signal.status';

// ─── Status Types ────────────────────────────────────────────────────────────

export type BgRemoverStage =
  | 'idle'
  | 'loading'       // Model being loaded into memory (from cache or initial import)
  | 'downloading'   // Genuine network download in progress
  | 'processing'    // Inference running
  | 'done'
  | 'error';

/** Result info stored after a successful inference. */
export interface BgRemoverResultInfo {
  /** Device that ran the inference */
  deviceUsed: 'webgpu' | 'wasm';
  /** Inference time in ms */
  inferenceMs: number;
  /** Post-processing time in ms */
  postProcessMs: number;
  /** Total time in ms */
  totalMs: number;
  /** Number of vertices in the generated contour polygon */
  vertexCount: number;
}

export interface BgRemoverStatus {
  [key: string]: unknown;
  stage: BgRemoverStage;
  /** Device being used: 'webgpu' | 'wasm' | null (undetermined) */
  device: 'webgpu' | 'wasm' | null;
  /** Model download progress (0-1), only valid during 'downloading' stage */
  downloadProgress: number;
  /** Downloaded bytes */
  downloadedBytes: number;
  /** Total bytes to download */
  totalBytes: number;
  /** Download speed in bytes/second */
  speedBps: number;
  /** Estimated time remaining in seconds */
  etaSeconds: number;
  /** Processing progress (0-1), only valid during 'processing' stage */
  processingProgress: number;
  /** Error message (only valid during 'error' stage) */
  errorMessage: string | null;
  /** Whether model is cached (subsequent loads skip download) */
  modelCached: boolean;
  /** Context snapshot for result validation */
  context: { frameId: string; layerId: string } | null;
  /** Total elapsed time in ms for the last completed inference */
  elapsedMs: number;
  /** Result info from last successful inference (only valid during 'done' stage) */
  resultInfo: BgRemoverResultInfo | null;
  /** Stored polygon from last successful inference, for re-applying on click */
  resultPolygon: unknown | null;
  /** Frame ID the result polygon belongs to */
  resultFrameId: string | null;
}

export const INITIAL_STATUS: BgRemoverStatus = {
  stage: 'idle',
  device: null,
  downloadProgress: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  speedBps: 0,
  etaSeconds: 0,
  processingProgress: 0,
  errorMessage: null,
  modelCached: false,
  context: null,
  elapsedMs: 0,
  resultInfo: null,
  resultPolygon: null,
  resultFrameId: null,
};

// ─── Model Management ────────────────────────────────────────────────────────

/**
 * A single model entry in the model registry.
 * Built-in models cannot be edited or removed.
 */
export interface BgModelEntry {
  /** Unique identifier (usually same as modelId for built-ins) */
  id: string;
  /** Display name shown in the UI */
  name: string;
  /** HuggingFace model repository ID (e.g. "briaai/RMBG-1.4") */
  modelId: string;
  /**
   * ONNX model filename within the HuggingFace repo.
   * BG remover repos that follow the transformers.js convention use "onnx/model.onnx".
   * Some repos may use a different path. Falls back to "onnx/model.onnx" if not specified.
   */
  onnxFile?: string;
  /**
   * Expected ONNX file size in bytes (approximate).
   * Used for download progress estimation so the progress bar doesn't flash
   * 100% when tiny config files complete before the large ONNX starts.
   */
  expectedBytes?: number;
  /** Approximate download size description */
  size: string;
  /** Short description */
  description: string;
  /** Whether this is a built-in model (cannot be edited or deleted) */
  builtin: boolean;
}

/**
 * Plugin configuration (persisted via pluginConfig / localStorage).
 */
export interface BgRemoverConfig {
  [key: string]: unknown;
  /** All registered models (built-in + user-custom) */
  models: BgModelEntry[];
  /** ID of the currently selected/active model */
  activeModelId: string;
}

// ─── Built-in Models ─────────────────────────────────────────────────────────

export const BUILTIN_MODELS: BgModelEntry[] = [
  {
    id: 'OS-Software/InSPyReNet-SwinB-Plus-Ultra-ONNX',
    name: 'InSPyReNet Ultra',
    modelId: 'OS-Software/InSPyReNet-SwinB-Plus-Ultra-ONNX',
    onnxFile: 'onnx/model_fp16.onnx',
    expectedBytes: 210_000_000, // ~200 MB
    size: '~200 MB',
    description: 'Sharp edges, excellent for products & e-commerce',
    builtin: true,
  },
  {
    id: 'briaai/RMBG-1.4',
    name: 'RMBG 1.4',
    modelId: 'briaai/RMBG-1.4',
    onnxFile: 'onnx/model_fp16.onnx',
    expectedBytes: 95_000_000, // ~90 MB
    size: '~90 MB',
    description: 'Fast, general-purpose background removal',
    builtin: true,
  },
];

export const DEFAULT_BG_REMOVAL_CONFIG: BgRemoverConfig = {
  models: [...BUILTIN_MODELS],
  activeModelId: BUILTIN_MODELS[0].id,
};

// ─── Model Files (download manifest) ─────────────────────────────────────────

/**
 * Default ONNX filename used when `BgModelEntry.onnxFile` is not specified.
 * Most transformers.js-compatible repos use "onnx/model.onnx".
 */
export const DEFAULT_BG_ONNX_FILE = 'onnx/model.onnx';

/**
 * Files required to run a BgRemover model via transformers.js.
 *
 * These repos (e.g. briaai/RMBG-1.4, OS-Software/InSPyReNet-SwinB-Plus-Ultra-ONNX)
 * follow the HuggingFace transformers.js convention:
 *   - onnx/model.onnx (or custom path): The ONNX weights
 *   - config.json: Model architecture config (used by AutoModel)
 *   - preprocessor_config.json: Image preprocessing config (used by AutoProcessor)
 *
 * **IMPORTANT:** `preprocessor_config.json` is REQUIRED for BG remover models.
 * Unlike pure-ONNX upscaler models, BG remover relies on transformers.js
 * AutoProcessor which reads this file to determine input normalization,
 * resizing, and padding. Without it the model CANNOT run.
 */
export function getBgRemoverModelFiles(model: BgModelEntry): { filename: string; expectedBytes?: number }[] {
  // IMPORTANT: config files are listed FIRST so they're fetched before the
  // large ONNX file. If the repo is missing preprocessor_config.json, the
  // download will fail fast (~1s) instead of after downloading 100+MB of ONNX.
  return [
    { filename: 'preprocessor_config.json', expectedBytes: 500 },
    { filename: 'config.json', expectedBytes: 1000 },
    { filename: model.onnxFile ?? DEFAULT_BG_ONNX_FILE, expectedBytes: model.expectedBytes },
  ];
}

