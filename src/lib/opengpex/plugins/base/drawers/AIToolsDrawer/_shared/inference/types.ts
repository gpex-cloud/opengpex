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
 * Shared Inference Backend — Core Type Definitions
 *
 * Defines the unified interface for switching between Raw ORT and
 * Transformers.js inference backends. Workers use these types to
 * abstract over the underlying inference engine.
 *
 * ⚠️ This file is imported by Web Workers — keep it free of DOM/React deps.
 */

// ─── Worker Request Base ─────────────────────────────────────────────────────

/**
 * WorkerRequest — Base interface for all AI tool worker requests.
 *
 * Contains the common fields shared by bgremover, upscaler, segmentation,
 * and inpaint/eraser worker protocols. Each tool extends this with
 * tool-specific fields (e.g. `scale`, `polygonRings`).
 *
 * All model resolution is done on the main thread — the worker receives
 * fully resolved parameters and does not need access to model registries.
 */
export interface WorkerRequest {
  /** Correlation id (echoed back in all responses/progress). */
  reqId: number;
  /** HuggingFace model repository ID (e.g. "briaai/RMBG-1.4"). */
  modelId: string;
  /** ONNX filename within the repo (e.g. "onnx/model_fp16.onnx"). */
  onnxFile?: string;
  /** Inference backend to use. Default varies by tool. */
  backend?: BackendType;
  /**
   * Execution device. Determined by ModelEntry.device on the main thread.
   * - 'webgpu': Use WebGPU — if unavailable, throw (no fallback).
   * - 'wasm': Force WASM execution.
   * - undefined: Auto-detect (WebGPU preferred, WASM fallback).
   */
  device?: 'webgpu' | 'wasm';
  /** Image pixel data (RGBA8). Buffer is detached on postMessage (zero-copy). */
  imageData?: { data: ArrayBuffer; width: number; height: number };
}

// ─── Worker Progress & Error ─────────────────────────────────────────────────

/**
 * WorkerProgress — Base progress message sent from any AI tool worker.
 *
 * Workers send multiple progress messages during a single request lifecycle:
 *   detecting-device → loading → downloading → processing
 */
export interface WorkerProgress {
  type: 'progress';
  reqId: number;
  stage: 'detecting-device' | 'loading' | 'downloading' | 'processing';
  /** Device detected (only set after device detection). */
  device?: 'webgpu' | 'wasm';
  /** Current file being downloaded (only during 'downloading'). */
  file?: string;
  /** Download progress: bytes loaded so far. */
  loaded?: number;
  /** Download progress: total bytes expected. */
  total?: number;
  /** Processing progress 0-1 (only during 'processing'). */
  progress?: number;
}

/**
 * WorkerError — Base error message sent from any AI tool worker.
 */
export interface WorkerError {
  type: 'error';
  reqId: number;
  error: string;
}

// ─── Backend Type ────────────────────────────────────────────────────────────

/**
 * Inference backend discriminator:
 * - 'ort': Raw ONNX Runtime Web — manual tensor I/O, supports tile-based inference
 * - 'transformers': @huggingface/transformers pipeline — automatic pre/post-processing
 */
export type BackendType = 'ort' | 'transformers';

// ─── Model Configuration ─────────────────────────────────────────────────────

/**
 * Configuration for loading a model into an inference session.
 * Passed to `InferenceSession.load()` to initialize the backend.
 */
export interface InferenceArgs {
  /** Which backend to use for this model. */
  backend: BackendType;
  /**
   * Execution device preference.
   * - 'webgpu': Use WebGPU — if unavailable, throw (no fallback).
   * - 'wasm': Force WASM execution.
   * Both ORT and Transformers backends respect this field.
   * @default 'webgpu'
   */
  device?: 'webgpu' | 'wasm';
  /**
   * HuggingFace model identifier (e.g. 'onnx-community/swin2SR-realworld-sr-x4-64-bsrgan-psnr-ONNX').
   * For ORT backend, this is used to locate the model in Cache Storage.
   * For Transformers backend, this is passed to `from_pretrained()` / `pipeline()`.
   */
  modelId: string;
  /**
   * ONNX filename within the repo (e.g. 'onnx/model_fp16.onnx').
   * Required for ORT backend. For Transformers backend, used to derive dtype.
   */
  onnxFile?: string;
  /**
   * Transformers.js pipeline task type.
   * Only used when backend === 'transformers' and transformersMode === 'pipeline'.
   * Examples: 'image-to-image', 'image-segmentation', 'background-removal'
   */
  task?: string;
  /**
   * Transformers.js loading mode (only when backend === 'transformers'):
   *   - 'pipeline' (default): Uses `pipeline(task, model)` — automatic pre/post-processing
   *   - 'auto-model': Uses `AutoModel.from_pretrained` + `AutoProcessor.from_pretrained`
   *     — returns raw tensor output (logits), caller does own post-processing
   */
  transformersMode?: 'pipeline' | 'auto-model';
  /**
   * Optional callback for reporting model download progress.
   * Fired during `load()` when model files are fetched from the network.
   * Only effective for transformers backend.
   */
  onDownloadProgress?: (loaded: number, total: number, file?: string) => void;
  /** Additional ORT-specific options. */
  ortOptions?: {
    /** Expected input data type. Auto-detected if not specified. */
    inputDtype?: 'float32' | 'float16';
  };

  /**
   * If provided, run() internally performs tile-based inference:
   * computeTiles → pad → infer each tile → unpad → blend.
   *
   * Only effective when run() receives `{ type: 'image' }` input.
   */
  tile?: {
    /** Input tile size in pixels (before padding). */
    size: number;
    /** Overlap between adjacent tiles in pixels. */
    overlap: number;
    /** Model output scale factor (e.g. 4 for 4× upscaler, 1 for non-upscale). */
    modelScale: number;
  };
}

// ─── Inference I/O Types ─────────────────────────────────────────────────────

/**
 * Input to an inference session.
 * - 'tensor': Raw float tensor (used by ORT backend for manual NCHW data)
 * - 'image': RGBA pixel data (used for built-in tile path or Transformers backend)
 */
export type InferenceInput =
  | { type: 'tensor'; data: Float32Array; dims: number[] }
  | { type: 'image'; data: Uint8Array; width: number; height: number };

/**
 * Output from an inference session.
 * - 'tensor': Raw float tensor (ORT backend returns NCHW data)
 * - 'image': RGBA pixel data (Transformers backend or built-in tile path returns processed image)
 */
export type InferenceOutput =
  | { type: 'tensor'; data: Float32Array; dims: number[] }
  | { type: 'image'; data: Uint8Array; width: number; height: number };

// ─── Unified Session Interface ───────────────────────────────────────────────

/**
 * Unified inference session interface.
 *
 * Workers interact with this interface regardless of whether the underlying
 * engine is Raw ORT or Transformers.js. This enables:
 *   - ESRGAN models to use ORT with automatic tile + NCHW processing
 *   - Swin2SR models to use Transformers.js pipeline with automatic pre/post-processing
 *   - Future models to pick the best backend without worker changes
 */
export interface InferenceSession {
  /** Load and initialize the model. */
  load(args: InferenceArgs): Promise<void>;

  /**
   * Run inference on the given input.
   *
   * Behavior depends on input type and configuration:
   *   - `{ type: 'tensor' }`: Direct tensor inference (ORT only)
   *   - `{ type: 'image' }` + tileConfig: Automatic tile-based inference with blending
   *   - `{ type: 'image' }` without tileConfig: Single-pass full-image inference
   *
   * @param input - Input data (tensor or image)
   * @param onTileProgress - Optional callback for tile progress (done, total)
   */
  run(input: InferenceInput, onTileProgress?: (done: number, total: number) => void): Promise<InferenceOutput>;

  /** Release all resources (model, session, GPU buffers). */
  release(): Promise<void>;

  /** The device currently in use for inference. */
  device: 'webgpu' | 'wasm' | 'cpu';
}
