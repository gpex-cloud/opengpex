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
 * Shared Inference Backend — Transformers.js Pipeline
 *
 * Encapsulates the @huggingface/transformers pipeline pattern used by
 * upscaler (Swin2SR) and other tools. Provides:
 *   - Lazy transformers.js CDN loading
 *   - Pipeline creation with WebGPU → WASM fallback
 *   - Unified InferenceSession interface for image I/O
 *   - Built-in tile-based inference (optional, via ModelConfig.tile)
 *   - Auto-model mode: AutoModel + AutoProcessor for raw tensor output
 *
 * Two modes of operation:
 *   1. 'pipeline' (default): Uses high-level pipeline() API — automatic pre/post-processing
 *   2. 'auto-model': Uses AutoModel + AutoProcessor — returns raw tensor output
 *      (used by bgremover which needs raw logits + session introspection)
 *
 * ⚠️ This file is imported by Web Workers — keep it free of DOM/React deps.
 */

import type { InferenceSession, InferenceInput, InferenceOutput, InferenceArgs } from './types';
import { computeTiles, extractTile, padTile, unpadTile, pasteTileBlend } from './tile-utils';

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * CDN URL for @huggingface/transformers — loaded at runtime to bypass
 * Turbopack bundling. The library fetches its own ONNX/WASM backends.
 */
const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Derive the transformers.js `dtype` option from the ONNX filename.
 * Ensures from_pretrained loads the exact file variant we downloaded.
 */
function deriveDtype(onnxFile?: string): string {
  if (!onnxFile) return 'fp32';
  const lower = onnxFile.toLowerCase();
  if (lower.includes('fp16')) return 'fp16';
  if (lower.includes('quantized') || lower.includes('q8') || lower.includes('int8')) return 'q8';
  if (lower.includes('q4') || lower.includes('int4')) return 'q4';
  if (lower.includes('uint8')) return 'uint8';
  return 'fp32';
}

/**
 * Check if a model's files exist in browser Cache Storage.
 * Used to suppress download progress reporting for cached models.
 */
async function isModelInCacheStorage(modelId: string): Promise<boolean> {
  try {
    const cache = await caches.open('opengpex-ai-models');
    const keys = await cache.keys();
    return keys.some(req =>
      req.url.includes(modelId) || req.url.includes(modelId.replace('/', '%2F'))
    );
  } catch {
    return false;
  }
}

// ─── Session Introspection ───────────────────────────────────────────────────

/**
 * Introspect the ONNX model's session to discover actual input tensor names.
 * Probes multiple known paths (structure varies by model architecture).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getSessionInputNames(model: any): string[] {
  try {
    if (model?.session?.inputNames?.length) {
      return [...model.session.inputNames];
    }
    if (model?.sessions) {
      for (const key of Object.keys(model.sessions)) {
        const session = model.sessions[key];
        if (session?.inputNames?.length) {
          return [...session.inputNames];
        }
      }
    }
    if (model?.model?.session?.inputNames?.length) {
      return [...model.model.session.inputNames];
    }
  } catch { /* graceful fallback */ }
  return [];
}

/**
 * Introspect the ONNX model's session to discover actual output tensor names.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getSessionOutputNames(model: any): string[] {
  try {
    if (model?.session?.outputNames?.length) {
      return [...model.session.outputNames];
    }
    if (model?.sessions) {
      for (const key of Object.keys(model.sessions)) {
        const session = model.sessions[key];
        if (session?.outputNames?.length) {
          return [...session.outputNames];
        }
      }
    }
    if (model?.model?.session?.outputNames?.length) {
      return [...model.model.session.outputNames];
    }
  } catch { /* graceful fallback */ }
  return [];
}

// ─── Transformers Pipeline Implementation ────────────────────────────────────

/**
 * Transformers.js inference session supporting both pipeline and auto-model modes.
 *
 * Manages CDN loading, model lifecycle, and device selection.
 * Implements the unified InferenceSession interface.
 *
 * **Pipeline mode** (default): Uses high-level pipeline() API with automatic
 * pre/post-processing. Returns image output.
 *
 * **Auto-model mode**: Uses AutoModel + AutoProcessor for raw tensor I/O.
 * Returns raw tensor output (e.g. logits). Used by bgremover which needs
 * custom post-processing (threshold → mask → contour).
 *
 * Usage (pipeline mode):
 * ```ts
 * const session = new TransformersSession();
 * await session.load({ backend: 'transformers', modelId, task: 'image-to-image',
 *   tile: { size: 128, overlap: 32, modelScale: 4 } });
 * const output = await session.run({ type: 'image', data: rgbaUint8, width, height });
 * // output.type === 'image'
 * ```
 *
 * Usage (auto-model mode):
 * ```ts
 * const session = new TransformersSession();
 * await session.load({ backend: 'transformers', modelId, onnxFile,
 *   transformersMode: 'auto-model',
 *   onDownloadProgress: (loaded, total) => reportProgress(loaded, total) });
 * const output = await session.run({ type: 'image', data: rgbaUint8, width, height });
 * // output.type === 'tensor' — raw model output (logits)
 * ```
 */
export class TransformersSession implements InferenceSession {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private transformers: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pipelineInstance: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private autoModel: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private autoProcessor: any = null;
  private modelId: string | null = null;
  private task: string | null = null;
  private mode: 'pipeline' | 'auto-model' = 'pipeline';
  /** Tile configuration set during load(). */
  private tileConfig: { size: number; overlap: number; modelScale: number } | null = null;

  device: 'webgpu' | 'wasm' | 'cpu' = 'wasm';

  // ─── Public API ──────────────────────────────────────────────────────────

  async load(config: InferenceArgs): Promise<void> {
    const { modelId, task = 'image-to-image' } = config;
    const mode = config.transformersMode ?? 'pipeline';

    // Already loaded same model + mode — skip (but update tile config)
    if (mode === 'pipeline' && this.pipelineInstance && this.modelId === modelId && this.task === task && this.mode === 'pipeline') {
      this.tileConfig = config.tile ?? null;
      return;
    }
    if (mode === 'auto-model' && this.autoModel && this.autoProcessor && this.modelId === modelId && this.mode === 'auto-model') {
      this.tileConfig = config.tile ?? null;
      return;
    }

    // Dispose previous pipeline/model
    await this.release();

    // Load transformers.js from CDN
    await this.ensureTransformers();

    // Detect device
    await this.detectDevice();

    this.mode = mode;
    this.tileConfig = config.tile ?? null;

    if (mode === 'auto-model') {
      await this.loadAutoModel(config);
    } else {
      await this.loadPipeline(config);
    }

    this.modelId = modelId;
    this.task = task;
    console.log(`[TransformersPipeline] Ready: ${modelId} on ${this.device} (mode=${this.mode})`);
  }

  async run(input: InferenceInput, onTileProgress?: (done: number, total: number) => void): Promise<InferenceOutput> {
    if (this.mode === 'auto-model') {
      if (!this.autoModel || !this.autoProcessor || !this.transformers) {
        throw new Error('[TransformersPipeline] Auto-model not initialized. Call load() first.');
      }
    } else {
      if (!this.pipelineInstance || !this.transformers) {
        throw new Error('[TransformersPipeline] Pipeline not initialized. Call load() first.');
      }
    }

    if (input.type !== 'image') {
      throw new Error('[TransformersPipeline] Transformers backend only accepts image input.');
    }

    if (this.mode === 'auto-model') {
      return this.runAutoModel(input);
    }

    if (this.tileConfig) {
      return this.runWithTiles(input, onTileProgress);
    }

    return this.runSingleImage(input);
  }

  async release(): Promise<void> {
    // Release pipeline
    if (this.pipelineInstance) {
      try {
        if (typeof this.pipelineInstance.dispose === 'function') {
          await this.pipelineInstance.dispose();
        }
      } catch { /* ignore */ }
      this.pipelineInstance = null;
    }
    // Release auto-model
    if (this.autoModel) {
      try {
        if (typeof this.autoModel.dispose === 'function') {
          await this.autoModel.dispose();
        }
      } catch { /* ignore */ }
      this.autoModel = null;
    }
    this.autoProcessor = null;
    this.modelId = null;
    this.task = null;
    this.tileConfig = null;
  }

  // ─── Public: Session Introspection ────────────────────────────────────────

  /**
   * Get input tensor names from the underlying ONNX session.
   * Only meaningful in auto-model mode.
   */
  getInputNames(): string[] {
    if (this.autoModel) return getSessionInputNames(this.autoModel);
    return [];
  }

  /**
   * Get output tensor names from the underlying ONNX session.
   * Only meaningful in auto-model mode.
   */
  getOutputNames(): string[] {
    if (this.autoModel) return getSessionOutputNames(this.autoModel);
    return [];
  }

  // ─── Public: Raw Instance Accessors ───────────────────────────────────────
  //
  // Exposes underlying model/processor/module for advanced two-stage use cases
  // (e.g. SAM 2 encode/decode). Analogous to OrtSession.getOrt()/getRawSession().
  // Returns `unknown` since the transformers.js module is loaded dynamically from CDN.

  /**
   * Get the raw AutoModel instance (for SAM-style encode/decode calls).
   * Callers should narrow with local type interfaces at the consumption site.
   */
  getModel(): unknown { return this.autoModel; }

  /**
   * Get the raw AutoProcessor instance.
   * Callers should narrow with local type interfaces at the consumption site.
   */
  getProcessor(): unknown { return this.autoProcessor; }

  /**
   * Get the raw transformers module (for RawImage, Tensor, etc.).
   * Callers should narrow with local type interfaces at the consumption site.
   */
  getTransformers(): unknown { return this.transformers; }

  // ─── Private: Auto-model Loading ──────────────────────────────────────────

  /**
   * Load model using AutoModel + AutoProcessor.
   * Includes: progress_callback, isModelInCacheStorage pre-check, WebGPU→WASM fallback.
   */
  private async loadAutoModel(config: InferenceArgs): Promise<void> {
    const { modelId, onnxFile, onDownloadProgress } = config;
    const { AutoModel, AutoProcessor, env } = this.transformers;

    // Configure cache — MUST match the cache name used by download service
    env.cacheKey = 'opengpex-ai-models';
    env.logLevel = 'error';

    const dtype = deriveDtype(onnxFile);

    // Pre-check cache to suppress false download reports
    const modelAlreadyCached = await isModelInCacheStorage(modelId);

    // Build progress callback (only fires download reports if model is NOT cached)
    let hasRealDownload = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const progressCallback = onDownloadProgress ? (progress: any) => {
      if (modelAlreadyCached) return;
      if (progress.status === 'download') hasRealDownload = true;
      if (hasRealDownload && (progress.status === 'progress' || progress.status === 'download')) {
        const loaded = progress.loaded ?? 0;
        const total = progress.total ?? 0;
        if (total > 0) {
          onDownloadProgress(loaded, total, progress.file);
        }
      }
    } : undefined;

    // Load processor (lightweight)
    this.autoProcessor = await AutoProcessor.from_pretrained(modelId);

    // Load model with WebGPU → WASM fallback
    const loadModel = (targetDevice: 'webgpu' | 'wasm') =>
      AutoModel.from_pretrained(modelId, {
        device: targetDevice,
        dtype,
        ...(progressCallback ? { progress_callback: progressCallback } : {}),
      });

    if (this.device === 'webgpu') {
      try {
        this.autoModel = await loadModel('webgpu');
      } catch (gpuErr) {
        const msg = gpuErr instanceof Error ? gpuErr.message : String(gpuErr);
        console.warn(`[TransformersPipeline] WebGPU AutoModel load failed (${msg}), falling back to WASM...`);
        this.device = 'wasm';
        this.autoModel = await loadModel('wasm');
      }
    } else {
      this.autoModel = await loadModel('wasm');
    }
  }

  // ─── Private: Pipeline Loading ────────────────────────────────────────────

  private async loadPipeline(config: InferenceArgs): Promise<void> {
    const { modelId, onnxFile, task = 'image-to-image' } = config;
    const dtype = deriveDtype(onnxFile);
    console.log(`[TransformersPipeline] Pipeline loading: model=${modelId}, task=${task}, dtype=${dtype}, device=${this.device}`);

    const { pipeline, env } = this.transformers;

    env.cacheKey = 'opengpex-ai-models';
    env.logLevel = 'error';

    try {
      this.pipelineInstance = await pipeline(task, modelId, {
        device: this.device,
        dtype,
      });
    } catch (gpuErr) {
      if (this.device === 'webgpu') {
        const msg = gpuErr instanceof Error ? gpuErr.message : String(gpuErr);
        console.warn(`[TransformersPipeline] WebGPU failed (${msg}), falling back to WASM...`);
        this.device = 'wasm';
        this.pipelineInstance = await pipeline(task, modelId, {
          device: 'wasm' as unknown as string,
          dtype,
        });
      } else {
        throw gpuErr;
      }
    }
  }

  // ─── Private: Auto-model Inference ────────────────────────────────────────

  /**
   * Run inference via AutoModel + AutoProcessor.
   * Returns raw tensor output (type: 'tensor') — no post-processing.
   */
  private async runAutoModel(
    input: { type: 'image'; data: Uint8Array; width: number; height: number },
  ): Promise<InferenceOutput> {
    const { RawImage } = this.transformers;
    const { width, height, data } = input;

    // Create RawImage from RGBA
    const inputImage = new RawImage(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width, height, 4);

    // Preprocess via processor
    const { pixel_values } = await this.autoProcessor(inputImage);

    // Build model input feeds using session introspection
    const inputNames = getSessionInputNames(this.autoModel);
    let modelInput: Record<string, unknown>;

    if (inputNames.length > 0) {
      modelInput = {};
      for (const name of inputNames) {
        modelInput[name] = pixel_values;
      }
    } else {
      // Fallback: broadcast to all known input name variants
      modelInput = {
        input: pixel_values,
        input_image: pixel_values,
        pixel_values: pixel_values,
      };
    }

    // Run model
    const modelOutput = await this.autoModel(modelInput);

    // Extract output tensor — try introspected names first, then common names
    const outputNames = getSessionOutputNames(this.autoModel);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rawOutput: any = null;

    if (outputNames.length > 0) {
      for (const name of outputNames) {
        if (modelOutput[name]?.dims) {
          rawOutput = modelOutput[name];
          break;
        }
      }
    }

    if (!rawOutput) {
      rawOutput = modelOutput.logits ?? modelOutput.output ?? modelOutput.pred ?? modelOutput.mask;
    }

    if (!rawOutput) {
      throw new Error(`[TransformersPipeline] Unexpected model output keys: ${Object.keys(modelOutput).join(', ')}`);
    }

    // Return raw tensor
    const tensorData = rawOutput.data instanceof Float32Array
      ? rawOutput.data
      : new Float32Array(rawOutput.data);
    const dims: number[] = [...rawOutput.dims];

    return { type: 'tensor', data: tensorData, dims };
  }

  // ─── Private: Tile-based inference ────────────────────────────────────────

  /**
   * Tile-based inference path (pipeline mode only).
   */
  private async runWithTiles(
    input: { type: 'image'; data: Uint8Array; width: number; height: number },
    onTileProgress?: (done: number, total: number) => void,
  ): Promise<InferenceOutput> {
    const { data, width, height } = input;
    const { size: tileSize, overlap, modelScale } = this.tileConfig!;

    const tiles = computeTiles(width, height, tileSize, overlap);
    const totalTiles = tiles.length;

    const outWidth = width * modelScale;
    const outHeight = height * modelScale;
    const outputBuf = new Uint8Array(outWidth * outHeight * 4);

    const overlapPx = overlap * modelScale;

    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      const isFirstCol = tile.sx === 0;
      const isFirstRow = tile.sy === 0;

      const tileInput = extractTile(data, width, tile.sx, tile.sy, tile.sw, tile.sh);

      const needsPad = tile.sw !== tileSize || tile.sh !== tileSize;
      const paddedInput = needsPad ? padTile(tileInput, tile.sw, tile.sh, tileSize) : tileInput;

      const tileOutput = await this.runSingleImage({
        type: 'image',
        data: paddedInput,
        width: tileSize,
        height: tileSize,
      });

      if (tileOutput.type !== 'image') {
        throw new Error('[TransformersPipeline] Unexpected output type from pipeline');
      }

      const validOutW = tile.sw * modelScale;
      const validOutH = tile.sh * modelScale;
      let tileData: Uint8Array;

      if (needsPad) {
        tileData = unpadTile(tileOutput.data, tileSize * modelScale, validOutW, validOutH);
      } else {
        tileData = tileOutput.data;
      }

      const dx = tile.sx * modelScale;
      const dy = tile.sy * modelScale;

      pasteTileBlend(
        outputBuf, outWidth, outHeight,
        tileData, validOutW, validOutH,
        dx, dy,
        overlapPx,
        isFirstCol,
        isFirstRow,
      );

      if (onTileProgress) {
        onTileProgress(i + 1, totalTiles);
      }
    }

    return { type: 'image', data: outputBuf, width: outWidth, height: outHeight };
  }

  // ─── Private: Single image inference (pipeline mode) ──────────────────────

  private async runSingleImage(
    input: { type: 'image'; data: Uint8Array; width: number; height: number },
  ): Promise<InferenceOutput> {
    const { RawImage } = this.transformers;

    const rawImage = new RawImage(
      new Uint8ClampedArray(input.data.buffer, input.data.byteOffset, input.data.byteLength),
      input.width,
      input.height,
      4,
    );

    const result = await this.pipelineInstance(rawImage);

    const outputImage = Array.isArray(result) ? result[0] : result;

    const outWidth = outputImage.width as number;
    const outHeight = outputImage.height as number;
    const outChannels = outputImage.channels as number;
    const outData = outputImage.data as Uint8ClampedArray;

    let rgbaData: Uint8Array;

    if (outChannels === 4) {
      rgbaData = new Uint8Array(outData.buffer, outData.byteOffset, outData.byteLength);
    } else if (outChannels === 3) {
      const pixels = outWidth * outHeight;
      rgbaData = new Uint8Array(pixels * 4);
      for (let i = 0; i < pixels; i++) {
        rgbaData[i * 4] = outData[i * 3];
        rgbaData[i * 4 + 1] = outData[i * 3 + 1];
        rgbaData[i * 4 + 2] = outData[i * 3 + 2];
        rgbaData[i * 4 + 3] = 255;
      }
    } else if (outChannels === 1) {
      const pixels = outWidth * outHeight;
      rgbaData = new Uint8Array(pixels * 4);
      for (let i = 0; i < pixels; i++) {
        rgbaData[i * 4] = outData[i];
        rgbaData[i * 4 + 1] = outData[i];
        rgbaData[i * 4 + 2] = outData[i];
        rgbaData[i * 4 + 3] = 255;
      }
    } else {
      throw new Error(`[TransformersPipeline] Unexpected output channels: ${outChannels}`);
    }

    return { type: 'image', data: rgbaData, width: outWidth, height: outHeight };
  }

  // ─── Private Methods ─────────────────────────────────────────────────────

  private async ensureTransformers(): Promise<void> {
    if (this.transformers) return;

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — CDN import bypasses Turbopack bundling (worker-only)
    this.transformers = await import(/* webpackIgnore: true */ TRANSFORMERS_CDN);
  }

  private async detectDevice(): Promise<void> {
    try {
      if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
        const adapter = await (navigator as unknown as { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter();
        if (adapter) {
          this.device = 'webgpu';
          return;
        }
      }
    } catch {
      // WebGPU not available
    }
    this.device = 'wasm';
  }
}
