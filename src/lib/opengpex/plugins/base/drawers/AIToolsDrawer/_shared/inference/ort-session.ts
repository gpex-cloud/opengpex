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
 * Shared Inference Backend — Raw ORT Session
 *
 * Encapsulates the ONNX Runtime Web session management pattern used by
 * upscaler and inpaint/eraser workers. Provides:
 *   - Lazy ORT module loading from CDN
 *   - Session creation with WebGPU or WASM (no fallback — WebGPU failure = error)
 *   - Built-in fp16 auto-detection: inference failure + "float16" in error → auto-retry
 *   - Session persistence: load once, run many times (reused across tile loops)
 *   - `run()` with `{ type: 'image' }` input: automatic tile-based or single-pass inference
 *   - `runWithFeeds()` for workers that need custom multi-tensor feeds (e.g. inpaint)
 *   - `getOrt()` / `getRawSession()` / `getInputNames()` / `getOutputNames()` for advanced use
 *
 * Device selection:
 *   - `forceDevice` declared → use it directly
 *   - Otherwise → `detectDevice()` probes WebGPU availability
 *   - WebGPU session creation fails → throws error (no degradation to WASM)
 *
 * ⚠️ This file is imported by Web Workers — keep it free of DOM/React deps.
 */

import type { InferenceSession, InferenceInput, InferenceOutput, InferenceArgs } from './types';
import { rgbaToNchw, tensorToRgba } from './tensor-utils';

// ─── ORT CDN Config (single source of truth) ────────────────────────────────

/** ONNX Runtime Web version — single source of truth for all workers. */
export const ORT_VERSION = '1.27.0';

/** CDN base path for onnxruntime-web WASM/JS assets. */
export const ORT_CDN_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

/** Full CDN URL for the all-in-one ORT module (used by workers that import a single entry). */
export const ORT_CDN_MODULE = `${ORT_CDN_BASE}ort.all.min.mjs`;
import { computeTiles, extractTile, padTile, unpadTile, pasteTileBlend } from './tile-utils';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Cache Storage bucket name (shared with other AI tools) */
const CACHE_NAME = 'opengpex-ai-models';

/** HuggingFace CDN base for model files */
const HF_BASE = 'https://huggingface.co';

/** Timeout for WebGPU session creation (ms) */
const SESSION_CREATE_TIMEOUT_MS = 20_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getCacheUrl(modelId: string, filename: string): string {
  return `${HF_BASE}/${modelId}/resolve/main/${filename}`;
}

// ─── ORT Session Implementation ──────────────────────────────────────────────

/**
 * Raw ONNX Runtime Web inference session.
 *
 * Manages lazy ORT module loading, session lifecycle, and WebGPU/WASM
 * device selection. Implements the unified InferenceSession interface.
 *
 * Key features:
 *   - `run()` supports three paths:
 *       1. `{ type: 'tensor' }` — direct tensor inference (original behavior)
 *       2. `{ type: 'image' }` + tileConfig — automatic tile-based inference with blend
 *       3. `{ type: 'image' }` without tileConfig — single-pass full-image inference
 *   - fp16 auto-detection: if inference fails with "float16" in error, auto-retry
 *   - No WASM fallback: inference failure on WebGPU throws directly
 *   - Session persistent: load() once, run() many times
 *   - `runWithFeeds()` for custom multi-tensor feeds (e.g. inpaint eraser)
 *
 * Usage (image + tile):
 * ```ts
 * const session = new OrtSession();
 * await session.load({ backend: 'ort', modelId, onnxFile,
 *   tile: { size: 128, overlap: 32, modelScale: 4 } });
 * const output = await session.run(
 *   { type: 'image', data: rgbaUint8, width, height },
 *   (done, total) => console.log(`${done}/${total}`),
 * );
 * // output.type === 'image', output.data is RGBA Uint8Array at scaled dimensions
 * ```
 */
export class OrtSession implements InferenceSession {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ort: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private session: any = null;
  private modelId: string | null = null;
  private onnxFile: string | null = null;
  /** Auto-detected input dtype — starts as float32, switches to float16 if needed. */
  private inputDtype: 'float32' | 'float16' = 'float32';
  /** Tile configuration set during load(). */
  private tileConfig: { size: number; overlap: number; modelScale: number } | null = null;

  device: 'webgpu' | 'wasm' | 'cpu' = 'wasm';

  // ─── Public API ──────────────────────────────────────────────────────────

  async load(config: InferenceArgs): Promise<void> {
    const { modelId, onnxFile = 'model.onnx' } = config;

    // Already loaded same model — skip (but update tile config)
    if (this.session && this.modelId === modelId && this.onnxFile === onnxFile) {
      this.tileConfig = config.tile ?? null;
      return;
    }

    // Dispose previous session
    await this.release();

    // Ensure ORT module is available
    await this.ensureOrt();

    // Detect device (respect forceDevice from model registry)
    const forceDevice = config.device;
    if (forceDevice) {
      this.device = forceDevice;
    } else {
      await this.detectDevice();
    }

    // Load model from cache
    const modelBuffer = await this.loadModelFromCache(modelId, onnxFile);

    // Create session with EP selection
    await this.createSession(modelBuffer);

    this.modelId = modelId;
    this.onnxFile = onnxFile;
    // Reset dtype detection for new model — will be auto-detected on first inference
    this.inputDtype = config.ortOptions?.inputDtype ?? 'float32';
    // Store tile config
    this.tileConfig = config.tile ?? null;

    console.log(`[OrtSession] Model loaded: ${onnxFile} on ${this.device}`);
    console.log(`[OrtSession] Inputs: ${this.session.inputNames.join(', ')}`);
    console.log(`[OrtSession] Outputs: ${this.session.outputNames.join(', ')}`);
  }

  /**
   * Run inference on the given input.
   *
   * Three paths:
   *   1. `{ type: 'image' }` + tileConfig → automatic tile-based inference
   *   2. `{ type: 'image' }` without tileConfig → single-pass full-image inference
   *   3. `{ type: 'tensor' }` → direct tensor inference (original behavior)
   *
   * Built-in resilience (for tensor path):
   *   - fp16 auto-detection: if inference fails and error contains "float16",
   *     automatically converts input to float16 and retries.
   */
  async run(input: InferenceInput, onTileProgress?: (done: number, total: number) => void): Promise<InferenceOutput> {
    if (!this.session || !this.ort) {
      throw new Error('[OrtSession] Session not initialized. Call load() first.');
    }

    if (input.type === 'image' && this.tileConfig) {
      return this.runWithTiles(input, onTileProgress);
    }

    if (input.type === 'image' && !this.tileConfig) {
      return this.runImageDirect(input);
    }

    // Original tensor path
    return this.runTensor(input);
  }

  /**
   * Run inference with custom feeds (multiple named tensors).
   *
   * Use this when your model has multiple inputs (e.g. inpaint eraser: image + mask)
   * and you need to construct the tensors yourself using `getOrt()`.
   *
   * @param feeds - Record mapping input tensor names to ORT Tensor objects.
   *               Create tensors using `new session.getOrt().Tensor(...)`.
   * @returns Record mapping output tensor names to their data and dims.
   */
  async runWithFeeds(
    feeds: Record<string, unknown>,
  ): Promise<Record<string, { data: Float32Array; dims: number[] }>> {
    if (!this.session || !this.ort) {
      throw new Error('[OrtSession] Session not initialized. Call load() first.');
    }

    const results = await this.session.run(feeds);

    // Collect all output tensors
    const output: Record<string, { data: Float32Array; dims: number[] }> = {};
    for (const name of this.session.outputNames as string[]) {
      if (results[name]) {
        output[name] = {
          data: results[name].data as Float32Array,
          dims: results[name].dims as number[],
        };
      }
    }
    return output;
  }

  async release(): Promise<void> {
    if (this.session) {
      try {
        await this.session.release();
      } catch { /* ignore */ }
      this.session = null;
      this.modelId = null;
      this.onnxFile = null;
      this.inputDtype = 'float32';
      this.tileConfig = null;
    }
  }

  // ─── Accessors for advanced use ──────────────────────────────────────────

  /** Get the raw ORT module (for creating custom tensors, etc.) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getOrt(): any {
    return this.ort;
  }

  /** Get the raw InferenceSession (for direct session.run with custom feeds) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getRawSession(): any {
    return this.session;
  }

  /** Get input tensor names */
  getInputNames(): string[] {
    return this.session?.inputNames ?? [];
  }

  /** Get output tensor names */
  getOutputNames(): string[] {
    return this.session?.outputNames ?? [];
  }

  /** Get the current auto-detected input dtype */
  getInputDtype(): 'float32' | 'float16' {
    return this.inputDtype;
  }

  // ─── Image Inference Paths ────────────────────────────────────────────────

  /**
   * Tile-based image inference path.
   *
   * Automatically splits the input image into tiles, processes each through
   * the ONNX model (RGBA → NCHW → inference → NCHW → RGBA), and blends
   * them back together using overlap linear blending.
   */
  private async runWithTiles(
    input: { type: 'image'; data: Uint8Array; width: number; height: number },
    onTileProgress?: (done: number, total: number) => void,
  ): Promise<InferenceOutput> {
    const { data, width, height } = input;
    const { size: tileSize, overlap, modelScale } = this.tileConfig!;

    const tiles = computeTiles(width, height, tileSize, overlap);
    const totalTiles = tiles.length;

    // Allocate output buffer at scaled dimensions
    const outWidth = width * modelScale;
    const outHeight = height * modelScale;
    const output = new Uint8Array(outWidth * outHeight * 4);

    const overlapPx = overlap * modelScale;

    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      const isFirstCol = tile.sx === 0;
      const isFirstRow = tile.sy === 0;

      // Extract tile from source
      const tileInput = extractTile(data, width, tile.sx, tile.sy, tile.sw, tile.sh);

      // Pad if needed (edge tiles may be smaller than tileSize)
      const needsPad = tile.sw !== tileSize || tile.sh !== tileSize;
      const paddedInput = needsPad ? padTile(tileInput, tile.sw, tile.sh, tileSize) : tileInput;

      // RGBA → NCHW float32
      const inputF32 = rgbaToNchw(paddedInput, tileSize, tileSize);

      // Run inference on this tile
      const tileOutput = await this.runTensor({
        type: 'tensor',
        data: inputF32,
        dims: [1, 3, tileSize, tileSize],
      });

      if (tileOutput.type !== 'tensor') {
        throw new Error('[OrtSession] Unexpected output type from tensor inference');
      }

      // NCHW → RGBA
      const { rgba: tileRgba } = tensorToRgba(tileOutput.data, tileOutput.dims);

      // Determine valid output region
      const paddedOutW = tileSize * modelScale;
      const validOutW = tile.sw * modelScale;
      const validOutH = tile.sh * modelScale;

      // Unpad if needed
      let tileData: Uint8Array;
      if (needsPad) {
        tileData = unpadTile(tileRgba, paddedOutW, validOutW, validOutH);
      } else {
        tileData = tileRgba;
      }

      // Compute destination position in output space
      const dx = tile.sx * modelScale;
      const dy = tile.sy * modelScale;

      // Paste into output with overlap blending
      pasteTileBlend(
        output, outWidth, outHeight,
        tileData, validOutW, validOutH,
        dx, dy,
        overlapPx,
        isFirstCol,
        isFirstRow,
      );

      // Report progress
      if (onTileProgress) {
        onTileProgress(i + 1, totalTiles);
      }
    }

    return { type: 'image', data: output, width: outWidth, height: outHeight };
  }

  /**
   * Single-pass full-image inference path (no tiling).
   *
   * Converts RGBA → NCHW, runs inference, converts output NCHW → RGBA.
   */
  private async runImageDirect(
    input: { type: 'image'; data: Uint8Array; width: number; height: number },
  ): Promise<InferenceOutput> {
    const { data, width, height } = input;

    // RGBA → NCHW float32
    const inputF32 = rgbaToNchw(data, width, height);

    // Run inference
    const tensorOutput = await this.runTensor({
      type: 'tensor',
      data: inputF32,
      dims: [1, 3, height, width],
    });

    if (tensorOutput.type !== 'tensor') {
      throw new Error('[OrtSession] Unexpected output type from tensor inference');
    }

    // NCHW → RGBA
    const { rgba, width: outW, height: outH } = tensorToRgba(tensorOutput.data, tensorOutput.dims);
    return { type: 'image', data: rgba, width: outW, height: outH };
  }

  // ─── Tensor Inference Path ────────────────────────────────────────────────

  /**
   * Direct tensor inference with fp16 auto-detection.
   *
   * If inference fails and the error mentions "float16", automatically switches
   * input dtype to float16 and retries once. Otherwise throws directly.
   */
  private async runTensor(input: InferenceInput): Promise<InferenceOutput> {
    if (input.type !== 'tensor') {
      throw new Error('[OrtSession] runTensor only accepts tensor input.');
    }

    const inputName = this.session.inputNames[0];

    // Try inference with current dtype
    let results;
    try {
      const tensor = this.createTensor(input.data, input.dims, this.inputDtype);
      results = await this.session.run({ [inputName]: tensor });
    } catch (inferErr) {
      const errMsg = inferErr instanceof Error ? inferErr.message : String(inferErr);

      // fp16 auto-detection: if error mentions float16 and we're on float32
      if (errMsg.includes('float16') && this.inputDtype === 'float32') {
        console.log(`[OrtSession] Model expects float16 input — switching dtype and retrying...`);
        this.inputDtype = 'float16';
        const tensor = this.createTensor(input.data, input.dims, 'float16');
        results = await this.session.run({ [inputName]: tensor });
      } else {
        throw inferErr;
      }
    }

    const outputTensor = results[this.session.outputNames[0]];

    return {
      type: 'tensor',
      data: outputTensor.data as Float32Array,
      dims: outputTensor.dims as number[],
    };
  }

  // ─── Private Methods ─────────────────────────────────────────────────────

  private async ensureOrt(): Promise<void> {
    if (this.ort) return;

    const ortModule = await import(/* webpackIgnore: true */ ORT_CDN_MODULE);
    this.ort = ortModule;

    this.ort.env.wasm.wasmPaths = ORT_CDN_BASE;
    this.ort.env.wasm.numThreads = 1;
    this.ort.env.wasm.proxy = false;
    this.ort.env.logLevel = 'error';
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

  private async loadModelFromCache(modelId: string, onnxFile: string): Promise<ArrayBuffer> {
    const url = getCacheUrl(modelId, onnxFile);
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(url);

    if (cached) {
      console.log(`[OrtSession] Model loaded from cache: ${onnxFile}`);
      return cached.arrayBuffer();
    }

    throw new Error(
      `Model not found in cache. Please download the model first using the Download button.\n` +
      `Expected: ${onnxFile} (model: ${modelId})`
    );
  }

  private async createSession(modelBuffer: ArrayBuffer): Promise<void> {
    const createWithEP = (ep: string) =>
      this.ort.InferenceSession.create(modelBuffer, {
        executionProviders: [ep],
        logSeverityLevel: 3, // Suppress ORT warnings (shape ops assigned to CPU is normal)
      });

    if (this.device === 'webgpu') {
      try {
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('WebGPU_TIMEOUT')), SESSION_CREATE_TIMEOUT_MS)
        );
        this.session = await Promise.race([createWithEP('webgpu'), timeoutPromise]);
        console.log(`[OrtSession] Session created with WebGPU`);
      } catch (gpuErr) {
        const msg = gpuErr instanceof Error ? gpuErr.message : String(gpuErr);
        throw new Error(
          `WebGPU session creation failed: ${msg}. ` +
          `This model may not be compatible with WebGPU on the current browser/GPU.`
        );
      }
    } else {
      this.session = await createWithEP('wasm');
      console.log(`[OrtSession] Session created with WASM`);
    }
  }

  /**
   * Create an ORT Tensor with the given dtype.
   * If dtype is 'float16', converts Float32Array → Uint16Array (IEEE 754 half-precision).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private createTensor(data: Float32Array, dims: number[], dtype: 'float32' | 'float16'): any {
    if (dtype === 'float16') {
      const f16Data = this.float32ToFloat16(data);
      return new this.ort.Tensor('float16', f16Data, dims);
    }
    return new this.ort.Tensor('float32', data, dims);
  }

  /**
   * Convert Float32Array to Uint16Array of IEEE 754 half-precision (float16) values.
   * Used internally for models that expect float16 input.
   */
  private float32ToFloat16(float32: Float32Array): Uint16Array {
    const float16 = new Uint16Array(float32.length);
    const view = new DataView(new ArrayBuffer(4));

    for (let i = 0; i < float32.length; i++) {
      view.setFloat32(0, float32[i], true);
      const x = view.getInt32(0, true);

      // Extract components
      const sign = (x >>> 31) & 0x1;
      const exp = (x >>> 23) & 0xFF;
      const frac = x & 0x7FFFFF;

      let h: number;
      if (exp === 0) {
        // Zero / denorm → fp16 zero (denorms too small for fp16)
        h = sign << 15;
      } else if (exp === 0xFF) {
        // Inf / NaN
        h = (sign << 15) | 0x7C00 | (frac ? 0x0200 : 0);
      } else {
        // Normalized
        const newExp = exp - 127 + 15;
        if (newExp >= 31) {
          // Overflow → Inf
          h = (sign << 15) | 0x7C00;
        } else if (newExp <= 0) {
          // Underflow → denorm or zero
          if (newExp >= -10) {
            const mant = (frac | 0x800000) >> (1 - newExp + 13);
            h = (sign << 15) | (mant >> 10);
          } else {
            h = sign << 15; // too small → zero
          }
        } else {
          h = (sign << 15) | (newExp << 10) | (frac >> 13);
        }
      }
      float16[i] = h;
    }
    return float16;
  }
}
