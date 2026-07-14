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
 * Segmentation Worker — SAM 2 ONNX Runtime Web Inference Engine
 *
 * This Web Worker runs SAM 2 (Segment Anything Model 2) using ONNX Runtime Web
 * directly (NOT through transformers.js pipeline). The SharpAI/sam2-hiera-*-onnx
 * repos from samexporter provide:
 *   - encoder.onnx: Image encoder (image → embedding)
 *   - decoder.onnx: Mask decoder (embedding + prompts → masks)
 *
 * Architecture:
 *   1. WebGPU / WASM execution provider detection
 *   2. Model download from HuggingFace CDN (with cache)
 *   3. Image Encoder: RGBA image → 1024×1024 normalized → embedding tensor
 *   4. Mask Decoder: embedding + point/box prompts → binary mask → polygon rings
 *   5. Auto mode: grid prompts + NMS → multiple object polygons
 *
 * Two-stage design:
 *   - Encoder is heavy (~500ms WebGPU) but only runs once per image
 *   - Decoder is light (~10-30ms) and runs on every click/box interaction
 *   - Embedding cached in Worker memory (keyed by assetId, max 3)
 */

import type { SegRequest, SegProgress, SegResult, SegError, SegPrompt } from './worker.types';

// ─── Configuration ───────────────────────────────────────────────────────────

const HF_BASE = 'https://huggingface.co';
const IMAGE_SIZE = 1024;   // SAM 2 input size
const MASK_SIZE = 256;     // SAM 2 mask output size

// ONNX Runtime Web CDN
const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/';

// ─── Types ───────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OrtModule = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InferenceSession = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OrtTensor = any;

// ─── Session Cache ───────────────────────────────────────────────────────────

let ort: OrtModule = null;
let encoderSession: InferenceSession = null;
let decoderSession: InferenceSession = null;
let cachedModelId: string | null = null;
let cachedDevice: 'webgpu' | 'wasm' | null = null;

// ─── Embedding Cache ─────────────────────────────────────────────────────────

interface EmbeddingEntry {
  imageEmbed: OrtTensor;          // image_embed: Float32[1, 256, 64, 64]
  highResFeats0: OrtTensor;       // high_res_feats_0: Float32[1, 32, 256, 256]
  highResFeats1: OrtTensor;       // high_res_feats_1: Float32[1, 64, 128, 128]
  width: number;
  height: number;
}

const embeddingCache = new Map<string, EmbeddingEntry>();
const MAX_CACHED_EMBEDDINGS = 3;

// ─── ORT Loading ─────────────────────────────────────────────────────────────

async function loadOrt(): Promise<OrtModule> {
  if (ort) return ort;
  // Import ONNX Runtime Web
  ort = await import(/* webpackIgnore: true */ `${ORT_CDN}ort.all.mjs`);
  // Configure WASM paths
  ort.env.wasm.wasmPaths = ORT_CDN;
  return ort;
}

// ─── Device Detection ────────────────────────────────────────────────────────

async function detectDevice(): Promise<'webgpu' | 'wasm'> {
  if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adapter = await (navigator as any).gpu.requestAdapter();
      if (adapter) return 'webgpu';
    } catch {
      // WebGPU not available
    }
  }
  return 'wasm';
}

// ─── Model Download & Session Creation ───────────────────────────────────────

/**
 * Download an ONNX model file from HuggingFace with caching.
 * Uses Cache API for persistent storage.
 */
async function loadModelFile(
  modelId: string,
  filename: string,
): Promise<ArrayBuffer> {
  const url = `${HF_BASE}/${modelId}/resolve/main/${filename}`;

  // Check unified cache first (written by the download service on main thread)
  const unifiedCache = await caches.open('opengpex-ai-models');
  const unifiedHit = await unifiedCache.match(url);
  if (unifiedHit) {
    return unifiedHit.arrayBuffer();
  }

  // Fall back to legacy cache name (backward compat with older downloads)
  const legacyCache = await caches.open('opengpex-seg-models');
  const legacyHit = await legacyCache.match(url);
  if (legacyHit) {
    return legacyHit.arrayBuffer();
  }

  // No fallback fetch — model must be pre-downloaded via the download service
  throw new Error(
    `Model file not cached: ${filename} (${modelId}). Please download the model first.`
  );
}

/**
 * Load encoder and decoder ONNX sessions.
 *
 * Strategy: Try WebGPU first (faster), gracefully fall back to WASM if
 * session creation fails. ONNX Runtime Web's `['webgpu', 'wasm']` fallback
 * list does NOT work reliably — WebGPU session creation can throw opaque
 * numeric WASM errors instead of triggering the next provider. We handle
 * this explicitly with a try/catch retry.
 */
async function loadModel(
  modelId: string,
  reqId: number,
  report: (p: Partial<SegProgress>) => void,
): Promise<void> {
  if (encoderSession && decoderSession && cachedModelId === modelId) return;

  await loadOrt();

  // Detect device
  report({ stage: 'detecting-device' });
  const device = await detectDevice();
  report({ stage: 'detecting-device', device });

  // Load model files from cache.
  // The .ort format (pre-optimized) is used for BOTH WebGPU and WASM —
  // the raw encoder.onnx is for Python/desktop only and may contain ops
  // unsupported by onnxruntime-web.
  report({ stage: 'downloading', file: 'encoder.with_runtime_opt.ort' });
  const encoderBuffer = await loadModelFile(modelId, 'encoder.with_runtime_opt.ort');

  report({ stage: 'downloading', file: 'decoder.onnx' });
  const decoderBuffer = await loadModelFile(modelId, 'decoder.onnx');

  // Create sessions — try WebGPU first, fall back to WASM.
  // The .ort format requires graphOptimizationLevel: 'disabled' (already optimized).
  report({ stage: 'detecting-device', progress: 0.5 });

  let actualDevice: 'webgpu' | 'wasm' = 'wasm';

  if (device === 'webgpu') {
    try {
      encoderSession = await ort.InferenceSession.create(encoderBuffer.slice(0), {
        executionProviders: ['webgpu'],
        graphOptimizationLevel: 'disabled',
      });
      decoderSession = await ort.InferenceSession.create(decoderBuffer.slice(0), {
        executionProviders: ['webgpu'],
      });
      actualDevice = 'webgpu';
    } catch {
      // WebGPU failed — fall through to WASM
      encoderSession = null;
      decoderSession = null;
    }
  }

  // WASM fallback (or primary if no WebGPU)
  if (!encoderSession || !decoderSession) {
    try {
      encoderSession = await ort.InferenceSession.create(encoderBuffer.slice(0), {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'disabled',
      });
      decoderSession = await ort.InferenceSession.create(decoderBuffer.slice(0), {
        executionProviders: ['wasm'],
      });
      actualDevice = 'wasm';
    } catch (err) {
      throw new Error(
        `Failed to create ONNX session. ` +
        `Error: ${err instanceof Error ? err.message : String(err)}. ` +
        `Try deleting and re-downloading the model.`
      );
    }
  }

  cachedDevice = actualDevice;
  report({ stage: 'detecting-device', device: actualDevice });

  // Invalidate embeddings on model change
  if (cachedModelId !== modelId) {
    embeddingCache.clear();
  }
  cachedModelId = modelId;
}

// ─── Image Preprocessing ─────────────────────────────────────────────────────

/**
 * Preprocess RGBA ImageData for SAM 2 encoder:
 * 1. Resize to 1024×1024 (bilinear)
 * 2. Convert to RGB float32 normalized [0, 1] in CHW format
 * Returns Float32Array [1, 3, 1024, 1024]
 */
function preprocessImage(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Float32Array {
  // Step 1: Resize to IMAGE_SIZE × IMAGE_SIZE (simple bilinear)
  const resized = new Float32Array(3 * IMAGE_SIZE * IMAGE_SIZE);

  const scaleX = width / IMAGE_SIZE;
  const scaleY = height / IMAGE_SIZE;

  for (let y = 0; y < IMAGE_SIZE; y++) {
    for (let x = 0; x < IMAGE_SIZE; x++) {
      // Source coordinates
      const srcX = Math.min(x * scaleX, width - 1);
      const srcY = Math.min(y * scaleY, height - 1);

      // Simple nearest-neighbor for speed (bilinear is overkill for 1024px)
      const sx = Math.round(srcX);
      const sy = Math.round(srcY);
      const srcIdx = (sy * width + sx) * 4;

      // SAM 2 expects RGB normalized to [0, 1]
      const dstIdx = y * IMAGE_SIZE + x;
      resized[0 * IMAGE_SIZE * IMAGE_SIZE + dstIdx] = rgba[srcIdx + 0] / 255.0;  // R
      resized[1 * IMAGE_SIZE * IMAGE_SIZE + dstIdx] = rgba[srcIdx + 1] / 255.0;  // G
      resized[2 * IMAGE_SIZE * IMAGE_SIZE + dstIdx] = rgba[srcIdx + 2] / 255.0;  // B
    }
  }

  return resized;
}

// ─── Image Encoding ──────────────────────────────────────────────────────────

async function encodeImage(
  imageData: { data: ArrayBuffer; width: number; height: number },
  assetId: string,
  reqId: number,
  report: (p: Partial<SegProgress>) => void,
): Promise<void> {
  if (embeddingCache.has(assetId)) return;

  report({ stage: 'encoding', progress: 0 });

  // Preprocess
  const rgba = new Uint8ClampedArray(imageData.data);
  const inputData = preprocessImage(rgba, imageData.width, imageData.height);

  report({ stage: 'encoding', progress: 0.2 });

  // Create input tensor [1, 3, 1024, 1024]
  const inputTensor = new ort.Tensor('float32', inputData, [1, 3, IMAGE_SIZE, IMAGE_SIZE]);

  // Run encoder
  const feeds: Record<string, OrtTensor> = {};
  const encoderInputNames = encoderSession.inputNames as string[];
  feeds[encoderInputNames[0]] = inputTensor;

  report({ stage: 'encoding', progress: 0.4 });

  const encoderOutput = await encoderSession.run(feeds);

  report({ stage: 'encoding', progress: 1.0 });

  // Cache ALL encoder outputs (SAM2 produces 3):
  //   image_embed: Float32[1, 256, 64, 64]
  //   high_res_feats_0: Float32[1, 32, 256, 256]
  //   high_res_feats_1: Float32[1, 64, 128, 128]
  const outputNames = encoderSession.outputNames as string[];
  let imageEmbed: OrtTensor = null;
  let highResFeats0: OrtTensor = null;
  let highResFeats1: OrtTensor = null;

  for (const name of outputNames) {
    const lower = name.toLowerCase();
    if (lower.includes('image_embed') || lower === 'image_embed') {
      imageEmbed = encoderOutput[name];
    } else if (lower.includes('high_res_feats_0') || lower === 'high_res_feats_0') {
      highResFeats0 = encoderOutput[name];
    } else if (lower.includes('high_res_feats_1') || lower === 'high_res_feats_1') {
      highResFeats1 = encoderOutput[name];
    }
  }

  // Fallback: positional (index 0=image_embed, 1=high_res_feats_0, 2=high_res_feats_1)
  if (!imageEmbed) imageEmbed = encoderOutput[outputNames[0]];
  if (!highResFeats0 && outputNames.length > 1) highResFeats0 = encoderOutput[outputNames[1]];
  if (!highResFeats1 && outputNames.length > 2) highResFeats1 = encoderOutput[outputNames[2]];

  // Evict oldest if at capacity
  if (embeddingCache.size >= MAX_CACHED_EMBEDDINGS) {
    const firstKey = embeddingCache.keys().next().value;
    if (firstKey) embeddingCache.delete(firstKey);
  }

  embeddingCache.set(assetId, {
    imageEmbed,
    highResFeats0,
    highResFeats1,
    width: imageData.width,
    height: imageData.height,
  });
}

// ─── Mask Decoding ───────────────────────────────────────────────────────────

/**
 * Run SAM 2 decoder with given prompts against a cached embedding.
 * Returns up to 4 candidate masks sorted by score (descending).
 */
async function decodeMask(
  assetId: string,
  prompts: SegPrompt[],
  report: (p: Partial<SegProgress>) => void,
): Promise<Array<{ rings: { x: number; y: number }[][]; score: number }>> {
  const entry = embeddingCache.get(assetId);
  if (!entry) {
    throw new Error(`No cached embedding for assetId: ${assetId}`);
  }

  report({ stage: 'decoding', progress: 0 });

  // Build point coordinates and labels in 1024×1024 space.
  // SAM2 decoder expects point_coords: Float32[1, N, 2] and point_labels: Float32[1, N]
  // with a padding point [0, 0] label=-1 appended (per official usage).
  const scaleX = IMAGE_SIZE / entry.width;
  const scaleY = IMAGE_SIZE / entry.height;

  const coords: number[] = [];
  const labels: number[] = [];

  for (const prompt of prompts) {
    if (prompt.type === 'point') {
      coords.push(prompt.x * scaleX, prompt.y * scaleY);
      labels.push(prompt.label);
    } else if (prompt.type === 'box') {
      // Box prompt: top-left with label 2, bottom-right with label 3
      coords.push(prompt.x1 * scaleX, prompt.y1 * scaleY);
      labels.push(2);
      coords.push(prompt.x2 * scaleX, prompt.y2 * scaleY);
      labels.push(3);
    }
  }

  // Append padding point [0, 0] with label -1 (required by SAM2 decoder)
  coords.push(0, 0);
  labels.push(-1);

  const numPoints = coords.length / 2;

  // Build decoder feed tensors
  const pointCoordsTensor = new ort.Tensor(
    'float32',
    Float32Array.from(coords),
    [1, numPoints, 2]
  );
  const pointLabelsTensor = new ort.Tensor(
    'float32',
    Float32Array.from(labels),
    [1, numPoints]
  );
  // No prior mask input
  const maskInput = new ort.Tensor(
    'float32',
    new Float32Array(1 * 1 * MASK_SIZE * MASK_SIZE),
    [1, 1, MASK_SIZE, MASK_SIZE]
  );
  const hasMaskInput = new ort.Tensor(
    'float32',
    Float32Array.from([0.0]),
    [1]
  );

  report({ stage: 'decoding', progress: 0.3 });

  // Build feeds — map to decoder input names by semantic matching.
  // SAM2 decoder inputs: image_embed, high_res_feats_0, high_res_feats_1,
  //                      point_coords, point_labels, mask_input, has_mask_input
  const decoderInputNames = decoderSession.inputNames as string[];
  const feeds: Record<string, OrtTensor> = {};

  for (const name of decoderInputNames) {
    const lower = name.toLowerCase();
    if (lower === 'image_embed' || lower.includes('image_embed')) {
      feeds[name] = entry.imageEmbed;
    } else if (lower === 'high_res_feats_0' || lower.includes('high_res_feats_0')) {
      feeds[name] = entry.highResFeats0;
    } else if (lower === 'high_res_feats_1' || lower.includes('high_res_feats_1')) {
      feeds[name] = entry.highResFeats1;
    } else if (lower.includes('point_coord') || lower.includes('input_point')) {
      feeds[name] = pointCoordsTensor;
    } else if (lower.includes('point_label') || lower.includes('input_label')) {
      feeds[name] = pointLabelsTensor;
    } else if (lower.includes('has_mask')) {
      // Must check 'has_mask' BEFORE 'mask_input' because
      // 'has_mask_input'.includes('mask_input') === true
      feeds[name] = hasMaskInput;
    } else if (lower === 'mask_input' || lower.includes('mask_input')) {
      feeds[name] = maskInput;
    }
  }

  // Fallback: positional mapping if not all matched
  if (Object.keys(feeds).length < decoderInputNames.length) {
    const expectedFeeds = [
      entry.imageEmbed, entry.highResFeats0, entry.highResFeats1,
      pointCoordsTensor, pointLabelsTensor, maskInput, hasMaskInput,
    ];
    for (let i = 0; i < decoderInputNames.length && i < expectedFeeds.length; i++) {
      if (!feeds[decoderInputNames[i]]) {
        feeds[decoderInputNames[i]] = expectedFeeds[i];
      }
    }
  }

  // Run decoder
  const decoderOutput = await decoderSession.run(feeds);

  report({ stage: 'decoding', progress: 0.7 });

  // Extract masks and scores
  const decoderOutputNames = decoderSession.outputNames as string[];

  let masksData: Float32Array | null = null;
  let masksDims: number[] = [];
  let scoresData: Float32Array | null = null;

  for (const name of decoderOutputNames) {
    const tensor = decoderOutput[name];
    const lower = name.toLowerCase();
    if (lower.includes('mask') && !lower.includes('low_res') && !lower.includes('iou')) {
      masksData = tensor.data as Float32Array;
      masksDims = tensor.dims as number[];
    } else if (lower.includes('iou') || lower.includes('score') || lower.includes('prediction')) {
      scoresData = tensor.data as Float32Array;
    }
  }

  // Fallback: first output = masks, second = scores (if not matched by name)
  if (!masksData && decoderOutputNames.length >= 1) {
    const first = decoderOutput[decoderOutputNames[0]];
    masksData = first.data as Float32Array;
    masksDims = first.dims as number[];
  }
  if (!scoresData && decoderOutputNames.length >= 2) {
    scoresData = decoderOutput[decoderOutputNames[1]].data as Float32Array;
  }

  if (!masksData || masksDims.length < 3) {
    throw new Error('Decoder did not return mask tensor');
  }

  // Parse mask dimensions: typically [1, K, H, W] or [K, H, W]
  let numMasks: number;
  let maskH: number;
  let maskW: number;

  if (masksDims.length === 4) {
    numMasks = masksDims[1];
    maskH = masksDims[2];
    maskW = masksDims[3];
  } else {
    numMasks = masksDims[0];
    maskH = masksDims[1];
    maskW = masksDims[2];
  }

  // Convert each mask to polygon
  const results: Array<{ rings: { x: number; y: number }[][]; score: number }> = [];

  for (let i = 0; i < numMasks; i++) {
    const offset = i * maskH * maskW;
    const singleMask = masksData.slice(offset, offset + maskH * maskW);
    const score = scoresData ? scoresData[i] : 0.5;

    const rings = maskToPolygonRings(singleMask, maskW, maskH, entry.width, entry.height);
    if (rings.length > 0 && rings[0].length >= 3) {
      results.push({ rings, score });
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  report({ stage: 'decoding', progress: 1.0 });
  return results;
}

// ─── Mask → Polygon Post-Processing ─────────────────────────────────────────

function traceContour(mask: Float32Array, width: number, height: number): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];

  // Find first foreground pixel
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

  if (startX === -1) return [];

  const dx = [1, 1, 0, -1, -1, -1, 0, 1];
  const dy = [0, 1, 1, 1, 0, -1, -1, -1];

  const isFg = (x: number, y: number): boolean => {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    return mask[y * width + x] > 0;
  };

  let cx = startX, cy = startY;
  let dir = 7;
  const maxIter = width * height * 2;

  for (let iter = 0; iter < maxIter; iter++) {
    points.push({ x: cx, y: cy });

    let found = false;
    const searchStart = (dir + 6) % 8;
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
    if (cx === startX && cy === startY && points.length > 2) break;
  }

  return points;
}

function simplifyRDP(points: { x: number; y: number }[], epsilon: number): { x: number; y: number }[] {
  if (points.length <= 2) return points;

  const first = points[0];
  const last = points[points.length - 1];
  let maxDist = 0;
  let maxIdx = 0;

  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], first, last);
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

function perpDist(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const ddx = b.x - a.x;
  const ddy = b.y - a.y;
  const lenSq = ddx * ddx + ddy * ddy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(ddy * p.x - ddx * p.y + b.x * a.y - b.y * a.x) / Math.sqrt(lenSq);
}

function maskToPolygonRings(
  maskData: Float32Array,
  maskW: number,
  maskH: number,
  origW: number,
  origH: number,
  simplifyEpsilon: number = 1.5,
): { x: number; y: number }[][] {
  // 1. Trace contour on thresholded mask (> 0.0)
  const rawContour = traceContour(maskData, maskW, maskH);
  if (rawContour.length < 3) return [];

  // 2. Scale from mask coordinates to original image coordinates
  const scaleX = origW / maskW;
  const scaleY = origH / maskH;
  const scaled = rawContour.map(p => ({
    x: p.x * scaleX,
    y: p.y * scaleY,
  }));

  // 3. Simplify
  const simplified = simplifyRDP(scaled, simplifyEpsilon);
  if (simplified.length < 3) return [];

  return [simplified];
}

// ─── NMS (Non-Maximum Suppression) ──────────────────────────────────────────

interface SegmentEntry {
  id: number;
  rings: { x: number; y: number }[][];
  score: number;
  bounds: { x: number; y: number; w: number; h: number };
}

function nmsSegments(segments: SegmentEntry[], threshold: number): SegmentEntry[] {
  const sorted = [...segments].sort((a, b) => b.score - a.score);
  const kept: SegmentEntry[] = [];

  for (const seg of sorted) {
    let suppress = false;
    for (const existing of kept) {
      if (boundsIoU(seg.bounds, existing.bounds) > threshold) {
        suppress = true;
        break;
      }
    }
    if (!suppress) kept.push(seg);
  }
  return kept;
}

function boundsIoU(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);

  if (x2 <= x1 || y2 <= y1) return 0;
  const intersection = (x2 - x1) * (y2 - y1);
  const union = a.w * a.h + b.w * b.h - intersection;
  return union > 0 ? intersection / union : 0;
}

// ─── Message Handler ─────────────────────────────────────────────────────────

self.onmessage = async (ev: MessageEvent<SegRequest>) => {
  const req = ev.data;
  const { reqId, action, modelId } = req;

  const post = (msg: SegProgress | SegResult | SegError) => {
    (self as unknown as Worker).postMessage(msg);
  };

  const report = (partial: Partial<SegProgress>) => {
    post({
      type: 'progress',
      reqId,
      stage: 'detecting-device',
      device: cachedDevice ?? undefined,
      ...partial,
    } as SegProgress);
  };

  const t0 = performance.now();

  try {
    switch (action) {
      // ─── Download ──────────────────────────────────────────────────
      case 'download': {
        await loadModel(modelId, reqId, report);
        post({
          type: 'result',
          reqId,
          action: 'download',
          context: req.context ?? null,
          debug: {
            deviceUsed: cachedDevice!,
            totalMs: performance.now() - t0,
          },
        });
        break;
      }

      // ─── Encode ────────────────────────────────────────────────────
      case 'encode': {
        if (!req.imageData) {
          throw new Error('encode action requires imageData');
        }
        const assetId = req.context?.assetId ?? `anon_${reqId}`;

        await loadModel(modelId, reqId, report);
        await encodeImage(req.imageData, assetId, reqId, report);

        post({
          type: 'result',
          reqId,
          action: 'encode',
          embeddingReady: true,
          context: req.context ?? null,
          debug: {
            deviceUsed: cachedDevice!,
            encodeMs: performance.now() - t0,
            totalMs: performance.now() - t0,
          },
        });
        break;
      }

      // ─── Decode ────────────────────────────────────────────────────
      case 'decode': {
        if (!req.prompts || req.prompts.length === 0) {
          throw new Error('decode action requires at least one prompt');
        }
        const decodeAssetId = req.context?.assetId ?? [...embeddingCache.keys()].pop();
        if (!decodeAssetId || !embeddingCache.has(decodeAssetId)) {
          throw new Error('No embedding available. Run "encode" first.');
        }

        await loadModel(modelId, reqId, report);

        const tDecode = performance.now();
        const masks = await decodeMask(decodeAssetId, req.prompts, report);
        const decodeMs = performance.now() - tDecode;

        report({ stage: 'post-processing', progress: 1.0 });

        post({
          type: 'result',
          reqId,
          action: 'decode',
          masks,
          context: req.context ?? null,
          debug: {
            deviceUsed: cachedDevice!,
            decodeMs,
            postProcessMs: 0,
            totalMs: performance.now() - t0,
          },
        });
        break;
      }

      // ─── Segment All ───────────────────────────────────────────────
      case 'segment-all': {
        const segAssetId = req.context?.assetId ?? [...embeddingCache.keys()].pop();
        if (!segAssetId || !embeddingCache.has(segAssetId)) {
          throw new Error('No embedding available. Run "encode" first.');
        }

        const entry = embeddingCache.get(segAssetId)!;
        await loadModel(modelId, reqId, report);

        report({ stage: 'decoding', progress: 0 });

        // Generate 8×8 grid prompts
        const GRID_SIZE = 8;
        const gridPrompts: { x: number; y: number }[] = [];
        for (let gy = 0; gy < GRID_SIZE; gy++) {
          for (let gx = 0; gx < GRID_SIZE; gx++) {
            gridPrompts.push({
              x: ((gx + 0.5) / GRID_SIZE) * entry.width,
              y: ((gy + 0.5) / GRID_SIZE) * entry.height,
            });
          }
        }

        const allSegments: SegmentEntry[] = [];
        let segId = 0;

        for (let i = 0; i < gridPrompts.length; i++) {
          const gp = gridPrompts[i];
          report({ stage: 'decoding', progress: (i + 1) / gridPrompts.length });

          try {
            const masks = await decodeMask(
              segAssetId,
              [{ type: 'point', x: gp.x, y: gp.y, label: 1 }],
              () => {},
            );

            if (masks.length > 0 && masks[0].score > 0.7) {
              const best = masks[0];
              let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
              for (const ring of best.rings) {
                for (const p of ring) {
                  if (p.x < minX) minX = p.x;
                  if (p.y < minY) minY = p.y;
                  if (p.x > maxX) maxX = p.x;
                  if (p.y > maxY) maxY = p.y;
                }
              }
              allSegments.push({
                id: segId++,
                rings: best.rings,
                score: best.score,
                bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
              });
            }
          } catch {
            // Skip failed grid points
          }
        }

        const filtered = nmsSegments(allSegments, 0.8);

        report({ stage: 'post-processing', progress: 1.0 });

        post({
          type: 'result',
          reqId,
          action: 'segment-all',
          segments: filtered,
          context: req.context ?? null,
          debug: {
            deviceUsed: cachedDevice!,
            totalMs: performance.now() - t0,
          },
        });
        break;
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  } catch (err) {
    post({
      type: 'error',
      reqId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
