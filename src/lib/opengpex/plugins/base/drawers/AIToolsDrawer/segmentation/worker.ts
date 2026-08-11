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
 * Segmentation Worker — SAM 2 via transformers.js
 *
 * Uses TransformersSession (auto-model mode) to manage:
 *   - transformers.js CDN loading
 *   - WebGPU → WASM device detection & fallback
 *   - AutoModel + AutoProcessor lifecycle
 *
 * Worker responsibilities (not delegated to TransformersSession):
 *   1. Action dispatch: encode / decode / segment-all
 *   2. Embedding cache: Map (max 3, keyed by assetId)
 *   3. Mask → polygon post-processing: traceContour + simplifyRDP
 *   4. Segment-all: grid prompts + NMS
 *   5. Progress reporting to commands.ts
 */

import type { SegRequest, SegProgress, SegResult, SegError, SegPrompt } from './worker.types';
import { TransformersSession } from '../_shared/inference/tfm-session';

// ─── Local Type Interfaces (for CDN-loaded transformers.js module) ───────────

/** Structural type for transformers.js Tensor. */
interface TensorLike {
  data: Float32Array;
  dims: number[];
  tolist(): unknown;
}

/** Structural type for transformers.js RawImage constructor. */
interface RawImageConstructor {
  new (data: Uint8ClampedArray, width: number, height: number, channels: number): unknown;
}

/** Structural type for transformers.js Tensor constructor. */
interface TensorConstructor {
  new (type: string, data: Float32Array | BigInt64Array | number[], dims: number[]): unknown;
}

/** Minimal transformers module surface used by this worker. */
interface TransformersModuleLike {
  RawImage: RawImageConstructor;
  Tensor: TensorConstructor;
}

/** Processor callable — preprocesses a RawImage for model input. */
interface ProcessorCallable {
  (image: unknown): Promise<Record<string, unknown>>;
}

/** SAM 2 model — supports get_image_embeddings and decode forward. */
interface Sam2ModelLike {
  get_image_embeddings(inputs: Record<string, unknown>): Promise<Record<string, unknown>>;
  (inputs: Record<string, unknown>): Promise<{
    pred_masks: TensorLike;
    iou_scores: TensorLike;
  }>;
}

// ─── Session & State ─────────────────────────────────────────────────────────

const session = new TransformersSession();
let cachedModelId: string | null = null;

// ─── Embedding Cache ─────────────────────────────────────────────────────────

interface EmbeddingEntry {
  embeddings: Record<string, unknown>;  // opaque tensor dict from get_image_embeddings
  width: number;
  height: number;
}

const embeddingCache = new Map<string, EmbeddingEntry>();
const MAX_CACHED_EMBEDDINGS = 3;

// ─── Model Loading ───────────────────────────────────────────────────────────

async function ensureModel(
  modelId: string,
  report: (p: Partial<SegProgress>) => void,
): Promise<void> {
  if (cachedModelId === modelId && session.getModel()) return;

  report({ stage: 'detecting-device' });

  await session.load({
    backend: 'transformers',
    modelId,
    transformersMode: 'auto-model',
    onDownloadProgress: (loaded, total, file) => {
      report({ stage: 'downloading', loaded, total, file });
    },
  });

  report({ stage: 'detecting-device', device: session.device as 'webgpu' | 'wasm' });

  // Invalidate embeddings on model change
  if (cachedModelId !== modelId) {
    embeddingCache.clear();
  }
  cachedModelId = modelId;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getModel(): Sam2ModelLike {
  return session.getModel() as Sam2ModelLike;
}

function getProcessor(): ProcessorCallable {
  return session.getProcessor() as ProcessorCallable;
}

function getTransformers(): TransformersModuleLike {
  return session.getTransformers() as TransformersModuleLike;
}

// ─── Image Encoding ──────────────────────────────────────────────────────────

async function encodeImage(
  imageData: { data: ArrayBuffer; width: number; height: number },
  assetId: string,
  report: (p: Partial<SegProgress>) => void,
): Promise<void> {
  if (embeddingCache.has(assetId)) return;

  report({ stage: 'encoding', progress: 0 });

  const tfm = getTransformers();
  const processor = getProcessor();
  const model = getModel();

  // Create RawImage from RGBA buffer
  const rgba = new Uint8ClampedArray(imageData.data);
  const image = new tfm.RawImage(rgba, imageData.width, imageData.height, 4);

  report({ stage: 'encoding', progress: 0.2 });

  // Preprocess via SAM processor
  const inputs = await processor(image);

  report({ stage: 'encoding', progress: 0.4 });

  // Run encoder → get image embeddings
  const embeddings = await model.get_image_embeddings(inputs);

  report({ stage: 'encoding', progress: 1.0 });

  // Evict oldest if at capacity
  if (embeddingCache.size >= MAX_CACHED_EMBEDDINGS) {
    const firstKey = embeddingCache.keys().next().value;
    if (firstKey) embeddingCache.delete(firstKey);
  }

  embeddingCache.set(assetId, {
    embeddings,
    width: imageData.width,
    height: imageData.height,
  });
}

// ─── Mask Decoding ───────────────────────────────────────────────────────────

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

  const tfm = getTransformers();
  const model = getModel();

  // ⚠️ SAM 2.1 ONNX coordinate convention:
  // The decoder expects input_points in the model's internal coordinate space
  // (1024×1024), NOT the original image resolution. Prompts arrive in
  // image-local pixel coordinates → must scale to [0, 1024].
  const MODEL_SIZE = 1024;
  const scaleX = MODEL_SIZE / entry.width;
  const scaleY = MODEL_SIZE / entry.height;

  const coords: number[] = [];
  const labels: bigint[] = [];

  for (const prompt of prompts) {
    if (prompt.type === 'point') {
      coords.push(prompt.x * scaleX, prompt.y * scaleY);
      labels.push(BigInt(prompt.label));
    } else if (prompt.type === 'box') {
      // Box prompt: top-left with label 2, bottom-right with label 3
      coords.push(prompt.x1 * scaleX, prompt.y1 * scaleY);
      labels.push(BigInt(2));
      coords.push(prompt.x2 * scaleX, prompt.y2 * scaleY);
      labels.push(BigInt(3));
    }
  }

  const numPoints = coords.length / 2;

  // Build input tensors for decode.
  // ⚠️ SAM 2.1 ONNX tensor rank requirements (different from SAM 1 / other SAM2 formats):
  //   input_points: rank 4 → [batch=1, num_labels=1, num_points, 2]
  //   input_labels: rank 3 → [batch=1, num_labels=1, num_points]
  // Using rank 3/2 causes "Invalid rank for input" ORT error.
  const inputPoints = new tfm.Tensor(
    'float32',
    Float32Array.from(coords),
    [1, 1, numPoints, 2],
  );
  const inputLabels = new tfm.Tensor(
    'int64',
    BigInt64Array.from(labels),
    [1, 1, numPoints],
  );

  report({ stage: 'decoding', progress: 0.3 });

  // Run decoder — call model with embeddings + prompts
  const outputs = await model({
    ...entry.embeddings,
    input_points: inputPoints,
    input_labels: inputLabels,
  }) as Record<string, unknown>;

  report({ stage: 'decoding', progress: 0.7 });

  // Extract masks — handle multiple possible output key names
  const masksOutput = (outputs.pred_masks ?? outputs.masks ?? outputs.low_res_masks) as TensorLike | undefined;
  const scoresOutput = (outputs.iou_scores ?? outputs.iou_predictions ?? outputs.scores) as TensorLike | undefined;

  if (!masksOutput || !masksOutput.dims) {
    throw new Error(`SAM2 decode did not return masks. Output keys: ${Object.keys(outputs).join(', ')}`);
  }

  const masksData = masksOutput.data instanceof Float32Array
    ? masksOutput.data
    : new Float32Array(masksOutput.data as ArrayLike<number>);
  const masksDims = masksOutput.dims;
  const scoresData = scoresOutput?.data instanceof Float32Array
    ? scoresOutput.data
    : scoresOutput ? new Float32Array(scoresOutput.data as ArrayLike<number>) : null;

  // Parse mask dimensions.
  // ⚠️ SAM 2.1 ONNX (onnx-community/sam2.1-hiera-tiny-ONNX) outputs 5D masks:
  //   [batch=1, num_labels=1, num_masks=3, H=256, W=256]
  // This differs from typical SAM implementations which output 4D [1, N, H, W].
  // We handle all known formats defensively:
  let numMasks: number;
  let maskH: number;
  let maskW: number;
  if (masksDims.length === 5) {
    // [1, 1, 3, 256, 256] — SAM 2.1 ONNX output
    numMasks = masksDims[2];
    maskH = masksDims[3];
    maskW = masksDims[4];
  } else if (masksDims.length === 4) {
    numMasks = masksDims[1];
    maskH = masksDims[2];
    maskW = masksDims[3];
  } else if (masksDims.length === 3) {
    numMasks = masksDims[0];
    maskH = masksDims[1];
    maskW = masksDims[2];
  } else {
    throw new Error(`Unexpected mask dims: [${masksDims.join(', ')}]`);
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

  // Sort by mask area (largest first) — more useful for interactive selection
  // than score-based sorting, since SAM2 often assigns similar scores.
  results.sort((a, b) => {
    const areaA = computeRingsArea(a.rings);
    const areaB = computeRingsArea(b.rings);
    return areaB - areaA;
  });

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

/**
 * Compute the area of polygon rings using the Shoelace formula.
 * Used for sorting mask candidates by size (largest first).
 */
function computeRingsArea(rings: { x: number; y: number }[][]): number {
  let totalArea = 0;
  for (const ring of rings) {
    if (ring.length < 3) continue;
    let area = 0;
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      area += ring[i].x * ring[j].y;
      area -= ring[j].x * ring[i].y;
    }
    totalArea += Math.abs(area) / 2;
  }
  return totalArea;
}

function maskToPolygonRings(
  maskData: Float32Array,
  maskW: number,
  maskH: number,
  origW: number,
  origH: number,
  simplifyEpsilon: number = 1.5,
): { x: number; y: number }[][] {
  const rawContour = traceContour(maskData, maskW, maskH);
  if (rawContour.length < 3) return [];

  const scaleX = origW / maskW;
  const scaleY = origH / maskH;
  const scaled = rawContour.map(p => ({
    x: p.x * scaleX,
    y: p.y * scaleY,
  }));

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
      device: (session.device === 'cpu' ? 'wasm' : session.device) as 'webgpu' | 'wasm' | undefined,
      ...partial,
    } as SegProgress);
  };

  const t0 = performance.now();

  try {
    switch (action) {
      // ─── Download ──────────────────────────────────────────────────
      case 'download': {
        await ensureModel(modelId, report);
        post({
          type: 'result',
          reqId,
          action: 'download',
          context: req.context ?? null,
          debug: {
            deviceUsed: session.device === 'cpu' ? 'wasm' : session.device,
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

        await ensureModel(modelId, report);
        await encodeImage(req.imageData, assetId, report);

        post({
          type: 'result',
          reqId,
          action: 'encode',
          embeddingReady: true,
          context: req.context ?? null,
          debug: {
            deviceUsed: session.device === 'cpu' ? 'wasm' : session.device,
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

        await ensureModel(modelId, report);

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
            deviceUsed: session.device === 'cpu' ? 'wasm' : session.device,
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
        await ensureModel(modelId, report);

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

            // In segment-all, pick by highest score (not area) as quality filter
            const bestByScore = masks.reduce((a, b) => b.score > a.score ? b : a, masks[0]);
            if (masks.length > 0 && bestByScore.score > 0.7) {
              const best = bestByScore;
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

        // Sort final segments by area (largest first)
        filtered.sort((a, b) => {
          const areaA = computeRingsArea(a.rings);
          const areaB = computeRingsArea(b.rings);
          return areaB - areaA;
        });

        report({ stage: 'post-processing', progress: 1.0 });

        post({
          type: 'result',
          reqId,
          action: 'segment-all',
          segments: filtered,
          context: req.context ?? null,
          debug: {
            deviceUsed: session.device === 'cpu' ? 'wasm' : session.device,
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
