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
 * BgRemoval Worker — AI Background Removal Inference Engine
 *
 * This Web Worker runs ONNX-based image segmentation models entirely in the
 * browser. It handles:
 *   1. WebGPU / WASM device detection
 *   2. Model loading (with download progress reporting)
 *   3. Image segmentation inference via AutoModel + AutoProcessor
 *   4. Post-processing: mask → contour tracing → polygon simplification
 *
 * The model/processor instances are cached across invocations (Mode B persistent
 * singleton) so subsequent calls skip model loading entirely. When a different
 * model is requested, the cached pipeline is replaced.
 *
 * Per spec §2.4: Worker communication uses Transferable buffers (zero-copy).
 */

import type { BgRemovalRequest, BgRemovalProgress, BgRemovalResult, BgRemovalError } from './protocol';

// ─── Model Configuration ─────────────────────────────────────────────────────

/**
 * CDN URL for @huggingface/transformers — loaded at runtime to bypass
 * Turbopack bundling. The library fetches its own ONNX/WASM backends.
 */
const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';

// ─── Pipeline Cache ──────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedModel: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedProcessor: any = null;
/** The model ID that the current cached pipeline was loaded from */
let cachedModelId: string | null = null;
/** The device that the current cached model was loaded with */
let _cachedDevice: 'webgpu' | 'wasm' | null = null;

// ─── Cache Storage Check ─────────────────────────────────────────────────────

/**
 * Check if a model's files exist in browser Cache Storage.
 * transformers.js uses the Cache API (not IndexedDB) for model files.
 * If the model is cached, from_pretrained() will read from cache (no network)
 * but still fires progress_callback with status='download' — this function
 * lets us pre-determine whether to report 'downloading' to the UI.
 */
async function isModelInCacheStorage(modelId: string): Promise<boolean> {
  try {
    const names = await caches.keys();
    for (const name of names) {
      if (name.includes('transformers') || name.includes('huggingface') || name.includes('onnx')) {
        const cache = await caches.open(name);
        const keys = await cache.keys();
        const hasModel = keys.some(req =>
          req.url.includes(modelId) || req.url.includes(modelId.replace('/', '%2F'))
        );
        if (hasModel) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}


// ─── Device Detection ────────────────────────────────────────────────────────

async function detectDevice(): Promise<'webgpu' | 'wasm'> {
  if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
    try {
      const adapter = await (navigator as unknown as { gpu: { requestAdapter(): Promise<unknown | null> } }).gpu.requestAdapter();
      if (adapter) return 'webgpu';
    } catch {
      // WebGPU not available, fall through to WASM
    }
  }
  return 'wasm';
}

// ─── Contour Tracing ─────────────────────────────────────────────────────────

/**
 * Trace the outer boundary of a binary mask using Moore neighborhood tracing.
 * Returns a clockwise-wound polygon in pixel coordinates.
 */
function traceContour(mask: Uint8Array, width: number, height: number): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];

  // Find the first foreground pixel (top-left scan)
  let startX = -1, startY = -1;
  outer:
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] > 0) {
        startX = x;
        startY = y;
        break outer;
      }
    }
  }

  if (startX === -1) return []; // No foreground pixels

  // Moore neighborhood: 8 directions (clockwise from right)
  const dx = [1, 1, 0, -1, -1, -1, 0, 1];
  const dy = [0, 1, 1, 1, 0, -1, -1, -1];

  const isFg = (x: number, y: number): boolean => {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    return mask[y * width + x] > 0;
  };

  let cx = startX, cy = startY;
  let dir = 7; // Start direction: up-right (looking for boundary from left)
  const maxIter = width * height * 2; // Safety limit

  for (let iter = 0; iter < maxIter; iter++) {
    points.push({ x: cx, y: cy });

    // Search clockwise from (dir + 5) % 8 for next boundary pixel
    let found = false;
    const searchStart = (dir + 6) % 8; // backtrack direction + 1
    for (let i = 0; i < 8; i++) {
      const d = (searchStart + i) % 8;
      const nx = cx + dx[d];
      const ny = cy + dy[d];
      if (isFg(nx, ny)) {
        cx = nx;
        cy = ny;
        dir = d;
        found = true;
        break;
      }
    }

    if (!found) break;
    // Termination: returned to start with same entry direction
    if (cx === startX && cy === startY && points.length > 2) break;
  }

  return points;
}

/**
 * Douglas-Peucker polyline simplification.
 * Reduces vertex count while preserving shape within `epsilon` tolerance.
 */
function simplifyRDP(points: { x: number; y: number }[], epsilon: number): { x: number; y: number }[] {
  if (points.length <= 2) return points;

  // Find the point with maximum distance from the line segment [first, last]
  const first = points[0];
  const last = points[points.length - 1];
  let maxDist = 0;
  let maxIdx = 0;

  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  if (maxDist > epsilon) {
    const left = simplifyRDP(points.slice(0, maxIdx + 1), epsilon);
    const right = simplifyRDP(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }

  return [first, last];
}

function perpendicularDistance(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number }
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / Math.sqrt(lenSq);
}

// ─── Session Introspection ───────────────────────────────────────────────────

/**
 * Introspect the ONNX model's session to discover actual input tensor names.
 *
 * transformers.js models expose their ONNX session(s) which contain `inputNames`
 * and `outputNames` arrays. This avoids hardcoding tensor names for each model
 * architecture, making custom user-added models work correctly.
 *
 * Probes multiple known paths because the internal structure varies:
 *   - model.session.inputNames (most common for single-session models)
 *   - model.sessions[key].inputNames (multi-session models)
 *   - model.model?.session?.inputNames (nested model wrappers)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getSessionInputNames(model: any): string[] {
  try {
    // Path 1: Direct session
    if (model?.session?.inputNames?.length) {
      return [...model.session.inputNames];
    }
    // Path 2: Named sessions (e.g. { encoder: session, decoder: session })
    if (model?.sessions) {
      for (const key of Object.keys(model.sessions)) {
        const session = model.sessions[key];
        if (session?.inputNames?.length) {
          return [...session.inputNames];
        }
      }
    }
    // Path 3: Nested model wrapper
    if (model?.model?.session?.inputNames?.length) {
      return [...model.model.session.inputNames];
    }
  } catch {
    // Graceful fallback on any access error
  }
  return [];
}

/**
 * Introspect the ONNX model's session to discover actual output tensor names.
 * Same probing strategy as getSessionInputNames.
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
  } catch {
    // Graceful fallback
  }
  return [];
}

// ─── Main Inference Pipeline ─────────────────────────────────────────────────

async function runInference(req: BgRemovalRequest): Promise<void> {
  const { reqId, modelId, imageData, context } = req;
  const totalStart = performance.now();

  try {
    // 1. Detect device
    self.postMessage({
      type: 'progress',
      reqId,
      stage: 'detecting-device',
    } satisfies BgRemovalProgress);

    const device = await detectDevice();

    self.postMessage({
      type: 'progress',
      reqId,
      stage: 'detecting-device',
      device,
    } satisfies BgRemovalProgress);

    // 2. Load transformers.js from CDN (bypasses Turbopack bundling)
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — CDN import bypasses Turbopack bundling (worker-only)
    const transformers = await import(/* webpackIgnore: true */ TRANSFORMERS_CDN);
    const { AutoModel, AutoProcessor, RawImage, env } = transformers;

    // Suppress "Unknown model class" warning
    env.logLevel = 'error';

    // 3. Load or reuse model + processor
    //    Since workers are disposed on model switch, this block runs on every
    //    fresh worker. The pipeline is cached within the same worker for
    //    consecutive runs of the same model.
    if (!cachedModel || !cachedProcessor || cachedModelId !== modelId) {
      cachedModel = null;
      cachedProcessor = null;
      cachedModelId = null;

      // Pre-check: is model already in Cache Storage?
      // transformers.js fires status='download' even for cache reads (fetch API),
      // so we check upfront to determine if 'downloading' should be reported.
      const modelAlreadyCached = await isModelInCacheStorage(modelId);

      // Report 'loading' stage — model is being loaded into memory.
      self.postMessage({
        type: 'progress',
        reqId,
        stage: 'loading',
        device,
      } satisfies BgRemovalProgress);

      // Only report 'downloading' if model is NOT in cache.
      // When cached, from_pretrained reads from Cache Storage (fast, no network).
      let hasRealDownload = false;

      // Load processor (lightweight, usually cached)
      cachedProcessor = await AutoProcessor.from_pretrained(modelId);

      // Load model with progress tracking.
      // If model is already in Cache Storage, suppress all 'downloading' reports
      // (transformers.js fires 'download' status even for cache reads via fetch API).
      cachedModel = await AutoModel.from_pretrained(modelId, {
        device,
        progress_callback: (progress: { status: string; file?: string; loaded?: number; total?: number; progress?: number }) => {
          // Skip all download reporting if model was pre-checked as cached
          if (modelAlreadyCached) return;

          // 'download' status = transformers.js initiated a fetch
          if (progress.status === 'download') {
            hasRealDownload = true;
          }

          if (hasRealDownload && (progress.status === 'progress' || progress.status === 'download')) {
            const loaded = progress.loaded ?? 0;
            const total = progress.total ?? 0;
            if (total > 0) {
              self.postMessage({
                type: 'progress',
                reqId,
                stage: 'downloading',
                device,
                file: progress.file,
                loaded,
                total,
              } satisfies BgRemovalProgress);
            }
          }
        },
      });

      cachedModelId = modelId;
      _cachedDevice = device;
    }

    // 4. Prepare input — create RawImage from RGBA buffer
    self.postMessage({
      type: 'progress',
      reqId,
      stage: 'processing',
      device,
      progress: 0.1,
    } satisfies BgRemovalProgress);

    const { width, height, data } = imageData;
    const inputImage = new RawImage(new Uint8ClampedArray(data), width, height, 4);

    // 5. Process input through the processor
    self.postMessage({
      type: 'progress',
      reqId,
      stage: 'processing',
      device,
      progress: 0.2,
    } satisfies BgRemovalProgress);

    const { pixel_values } = await cachedProcessor(inputImage);

    // 6. Run inference
    self.postMessage({
      type: 'progress',
      reqId,
      stage: 'processing',
      device,
      progress: 0.3,
    } satisfies BgRemovalProgress);

    const inferenceStart = performance.now();

    // Different models use different ONNX input tensor names:
    //   - RMBG-1.4: "input"
    //   - BiRefNet-ONNX: "input_image"
    //   - InSPyReNet: "pixel_values" or "input"
    //
    // Instead of hardcoding all possible names, we introspect the model's ONNX
    // session to discover the actual input name at runtime. This correctly supports
    // custom user-added models with arbitrary input tensor names.
    //
    // Fallback: if introspection fails (e.g. older transformers.js version),
    // we broadcast to all known names as a last resort.
    const inputNames = getSessionInputNames(cachedModel);
    let modelInput: Record<string, unknown>;
    if (inputNames.length > 0) {
      // Use the model's declared input name(s) — robust for any ONNX model
      modelInput = {};
      for (const name of inputNames) {
        modelInput[name] = pixel_values;
      }
      console.log(`[BgRemoval] Using introspected input name(s): [${inputNames.join(', ')}]`);
    } else {
      // Fallback: broadcast to all known names (legacy behavior)
      console.warn(`[BgRemoval] Could not introspect session inputNames, using broadcast fallback`);
      modelInput = {
        input: pixel_values,
        input_image: pixel_values,
        pixel_values: pixel_values,
      };
    }

    const modelOutput = await cachedModel(modelInput);
    const inferenceMs = performance.now() - inferenceStart;

    self.postMessage({
      type: 'progress',
      reqId,
      stage: 'processing',
      device,
      progress: 0.7,
    } satisfies BgRemovalProgress);

    // 7. Post-process: extract mask tensor → binary mask → contour
    const postStart = performance.now();

    // The model output may be { logits }, { output }, { pred }, etc.
    // Use session introspection to identify the actual output tensor name,
    // with fallback to known names for compatibility.
    const outputNames = getSessionOutputNames(cachedModel);
    let rawOutput = null;

    if (outputNames.length > 0) {
      // Try each declared output name — pick the first tensor that has .dims
      for (const name of outputNames) {
        if (modelOutput[name]?.dims) {
          rawOutput = modelOutput[name];
          console.log(`[BgRemoval] Using introspected output name: "${name}"`);
          break;
        }
      }
    }

    // Fallback: try common output names
    if (!rawOutput) {
      rawOutput = modelOutput.logits ?? modelOutput.output ?? modelOutput.pred ?? modelOutput.mask;
    }

    if (!rawOutput) {
      throw new Error(`Unexpected model output keys: ${Object.keys(modelOutput).join(', ')}. Introspected output names: [${outputNames.join(', ')}]`);
    }

    // Work directly with the raw tensor data to avoid RawImage.fromTensor issues.
    // rawOutput shape: [1, 1, H, W] or [1, H, W] — may be logits or probabilities
    const dims = rawOutput.dims; // e.g. [1, 1, 1024, 1024]
    const modelH = dims[dims.length - 2];
    const modelW = dims[dims.length - 1];
    const rawData = rawOutput.data as Float32Array; // flat data array

    const modelPixels = modelH * modelW;
    // The tensor may have batch/channel prefix; take last H*W elements
    const offset = rawData.length - modelPixels;

    // Auto-detect if output is logits or probabilities by checking value range
    let minVal = Infinity, maxVal = -Infinity;
    for (let i = 0; i < Math.min(1000, modelPixels); i++) {
      const v = rawData[offset + i];
      if (v < minVal) minVal = v;
      if (v > maxVal) maxVal = v;
    }
    const isLogits = minVal < -0.5 || maxVal > 1.5; // Logits have values outside [0,1]

    console.log(`[BgRemoval] model=${modelId} output dims=${JSON.stringify(dims)}, range=[${minVal.toFixed(3)}, ${maxVal.toFixed(3)}], isLogits=${isLogits}`);

    // Apply threshold: for logits, threshold at 0 (sigmoid(0)=0.5); for probabilities, threshold at 0.5
    const threshold = isLogits ? 0 : 0.5;
    const binaryMaskModel = new Uint8Array(modelPixels);
    let fgCount = 0;
    for (let i = 0; i < modelPixels; i++) {
      const val = rawData[offset + i];
      const isFg = isLogits ? val > threshold : val > threshold;
      binaryMaskModel[i] = isFg ? 255 : 0;
      if (isFg) fgCount++;
    }

    console.log(`[BgRemoval] mask: ${fgCount}/${modelPixels} foreground pixels (${(fgCount/modelPixels*100).toFixed(1)}%)`);

    // Resize binary mask from model resolution to original image dimensions
    // using nearest-neighbor interpolation
    const binaryMask = new Uint8Array(width * height);
    if (modelW === width && modelH === height) {
      binaryMask.set(binaryMaskModel);
    } else {
      const xRatio = modelW / width;
      const yRatio = modelH / height;
      for (let y = 0; y < height; y++) {
        const srcY = Math.min(Math.floor(y * yRatio), modelH - 1);
        for (let x = 0; x < width; x++) {
          const srcX = Math.min(Math.floor(x * xRatio), modelW - 1);
          binaryMask[y * width + x] = binaryMaskModel[srcY * modelW + srcX];
        }
      }
    }

    self.postMessage({
      type: 'progress',
      reqId,
      stage: 'processing',
      device,
      progress: 0.85,
    } satisfies BgRemovalProgress);

    // 8. Trace contour
    const rawContour = traceContour(binaryMask, width, height);

    // 9. Simplify with RDP (epsilon = 1.5 pixels for good balance)
    const simplified = rawContour.length > 0
      ? simplifyRDP(rawContour, 1.5)
      : [];

    const postProcessMs = performance.now() - postStart;
    const totalMs = performance.now() - totalStart;

    // 10. Send result
    const result: BgRemovalResult = {
      type: 'result',
      reqId,
      context,
      rings: simplified.length >= 3 ? [simplified] : [],
      debug: {
        deviceUsed: device,
        inferenceMs,
        postProcessMs,
        totalMs,
      },
    };

    self.postMessage(result);
  } catch (err) {
    // IMPORTANT: Invalidate the pipeline cache on ANY error.
    // This prevents a broken model/processor/env state from poisoning
    // subsequent requests (including requests for different models).
    // Without this, a model that loads but fails at inference would keep
    // its cached (broken) instance and re-fail on every retry.
    cachedModel = null;
    cachedProcessor = null;
    cachedModelId = null;
    _cachedDevice = null;

    const errorMsg = err instanceof Error ? err.message : String(err);

    self.postMessage({
      type: 'error',
      reqId,
      error: errorMsg,
    } satisfies BgRemovalError);
  }
}

// ─── Message Handler ─────────────────────────────────────────────────────────

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  self.addEventListener('message', (ev: MessageEvent<BgRemovalRequest>) => {
    runInference(ev.data);
  });
}

// ─── Test Exports ────────────────────────────────────────────────────────────

export const __test__ = { traceContour, simplifyRDP, detectDevice };
