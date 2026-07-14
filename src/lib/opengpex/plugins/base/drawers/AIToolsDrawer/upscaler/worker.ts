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
 * upscale.worker.ts — AI Image Upscaling Worker
 *
 * Runs Real-ESRGAN (or compatible ONNX model) inference entirely in-browser
 * using ONNX Runtime Web (WebGPU EP preferred, WASM fallback).
 *
 * Architecture:
 *   - Persistent singleton Worker (Mode B): model session stays warm.
 *   - Tile-based inference: input split into 256×256 tiles with 32px overlap.
 *   - Linear blending in overlap regions to eliminate seams.
 *   - Progress reports at tile granularity.
 *
 * Message protocol: see ./upscale-protocol.ts
 */

import type { UpscaleRequest, UpscaleProgress, UpscaleResult, UpscaleError } from './worker.types';

// ─── State ───────────────────────────────────────────────────────────────────

let session: unknown = null; // ONNX InferenceSession (typed as unknown to avoid import issues until onnxruntime-web is configured)
let currentModelId: string | null = null;
let device: 'webgpu' | 'wasm' = 'wasm';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function post(msg: UpscaleProgress | UpscaleResult | UpscaleError): void {
  self.postMessage(msg);
}

function progress(reqId: number, data: Omit<UpscaleProgress, 'type' | 'reqId'>): void {
  post({ type: 'progress', reqId, ...data });
}

function result(reqId: number, data: Omit<UpscaleResult, 'type' | 'reqId'>): void {
  post({ type: 'result', reqId, ...data });
}

function error(reqId: number, msg: string): void {
  post({ type: 'error', reqId, error: msg });
}

// ─── Device Detection ────────────────────────────────────────────────────────

async function detectDevice(reqId: number): Promise<'webgpu' | 'wasm'> {
  progress(reqId, { stage: 'detecting-device' });
  try {
    if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
      const adapter = await (navigator as unknown as { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter();
      if (adapter) {
        device = 'webgpu';
        progress(reqId, { stage: 'detecting-device', device: 'webgpu' });
        return 'webgpu';
      }
    }
  } catch {
    // WebGPU not available, fall back to WASM
  }
  device = 'wasm';
  progress(reqId, { stage: 'detecting-device', device: 'wasm' });
  return 'wasm';
}

// ─── Model Loading ───────────────────────────────────────────────────────────

async function ensureModel(reqId: number, modelId: string): Promise<void> {
  if (session && currentModelId === modelId) return; // Already loaded

  // Dispose previous session
  if (session) {
    try {
      await (session as { release?: () => Promise<void> }).release?.();
    } catch { /* ignore */ }
    session = null;
    currentModelId = null;
  }

  progress(reqId, { stage: 'loading' });

  // TODO: Implement actual ONNX model loading via @huggingface/transformers or
  // direct onnxruntime-web InferenceSession.create() with the model URL.
  //
  // For now, this is a skeleton that will be filled in during Step 1 of the
  // implementation plan. The key integration points:
  //
  // 1. Use `env.backends.onnx.wasm.proxy = false` (we ARE the worker)
  // 2. Set execution provider based on detected device
  // 3. Load from HuggingFace CDN with Cache Storage caching
  // 4. Report download progress via the progress callback

  // Placeholder: simulate model load
  progress(reqId, { stage: 'downloading', loaded: 0, total: 5_000_000 });

  // In real implementation:
  // const ort = await import('onnxruntime-web');
  // session = await ort.InferenceSession.create(modelUrl, { executionProviders: [device] });

  currentModelId = modelId;
}

// ─── Tile-based Inference ────────────────────────────────────────────────────

interface TileSpec {
  sx: number; sy: number;  // Source position (input image coords)
  sw: number; sh: number;  // Source tile size
  dx: number; dy: number;  // Destination position (output image coords)
}

/**
 * Split input image into tiles with overlap for seamless blending.
 */
function computeTiles(
  width: number, height: number,
  tileSize: number, overlap: number
): TileSpec[] {
  const tiles: TileSpec[] = [];
  const step = tileSize - overlap;
  const scale = 4; // Output scale factor

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const sx = x;
      const sy = y;
      const sw = Math.min(tileSize, width - x);
      const sh = Math.min(tileSize, height - y);
      const dx = x * scale;
      const dy = y * scale;
      tiles.push({ sx, sy, sw, sh, dx, dy });
    }
  }
  return tiles;
}

/**
 * Process a single tile through the ONNX model.
 * Returns the upscaled tile as RGBA Uint8Array.
 */
async function processTile(
  _inputRgba: Uint8Array,
  _width: number,
  _height: number,
): Promise<{ data: Uint8Array; width: number; height: number }> {
  // TODO: Implement actual ONNX inference for a single tile.
  //
  // Steps:
  // 1. Convert RGBA → RGB float32 tensor (normalize to 0-1)
  // 2. Run inference: session.run({ input: tensor })
  // 3. Convert output RGB float32 → RGBA Uint8Array
  // 4. Return upscaled tile (4x dimensions)

  const scale = 4;
  const outW = _width * scale;
  const outH = _height * scale;
  const outData = new Uint8Array(outW * outH * 4);

  // Placeholder: fill with scaled nearest-neighbor (for skeleton testing)
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const srcX = Math.floor(x / scale);
      const srcY = Math.floor(y / scale);
      const srcIdx = (srcY * _width + srcX) * 4;
      const dstIdx = (y * outW + x) * 4;
      outData[dstIdx] = _inputRgba[srcIdx];
      outData[dstIdx + 1] = _inputRgba[srcIdx + 1];
      outData[dstIdx + 2] = _inputRgba[srcIdx + 2];
      outData[dstIdx + 3] = _inputRgba[srcIdx + 3];
    }
  }

  return { data: outData, width: outW, height: outH };
}

/**
 * Extract a tile from the source image.
 */
function extractTile(
  srcData: Uint8Array, srcWidth: number,
  sx: number, sy: number, sw: number, sh: number
): Uint8Array {
  const tile = new Uint8Array(sw * sh * 4);
  for (let y = 0; y < sh; y++) {
    const srcOffset = ((sy + y) * srcWidth + sx) * 4;
    const dstOffset = y * sw * 4;
    tile.set(srcData.subarray(srcOffset, srcOffset + sw * 4), dstOffset);
  }
  return tile;
}

/**
 * Paste a processed tile into the output buffer with overlap blending.
 */
function pasteTile(
  output: Uint8Array, outWidth: number,
  tileData: Uint8Array, tileWidth: number, tileHeight: number,
  dx: number, dy: number
): void {
  for (let y = 0; y < tileHeight; y++) {
    const outY = dy + y;
    if (outY < 0) continue;
    const srcOffset = y * tileWidth * 4;
    const dstOffset = (outY * outWidth + dx) * 4;
    // Simple overwrite for now — TODO: add linear blending in overlap regions
    output.set(tileData.subarray(srcOffset, srcOffset + tileWidth * 4), dstOffset);
  }
}

// ─── Main Upscale Pipeline ───────────────────────────────────────────────────

async function runUpscale(req: UpscaleRequest): Promise<void> {
  const { reqId, modelId, imageData, scale: targetScale, tileSize: rawTileSize } = req;

  if (!imageData) {
    error(reqId, 'No image data provided');
    return;
  }

  const tileSize = rawTileSize ?? 256;
  const overlap = 32;
  const modelScale = 4; // Real-ESRGAN is always 4x
  const startTime = performance.now();

  try {
    // 1. Detect device
    await detectDevice(reqId);

    // 2. Ensure model is loaded
    await ensureModel(reqId, modelId);

    // 3. Compute tiles
    const { data, width, height } = imageData;
    const srcData = new Uint8Array(data);
    const tiles = computeTiles(width, height, tileSize, overlap);
    const totalTiles = tiles.length;

    // 4. Allocate output buffer
    const outWidth = width * modelScale;
    const outHeight = height * modelScale;
    const output = new Uint8Array(outWidth * outHeight * 4);

    // 5. Process tiles
    progress(reqId, { stage: 'processing', progress: 0, currentTile: 0, totalTiles });

    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];

      // Extract tile from source
      const tileInput = extractTile(srcData, width, tile.sx, tile.sy, tile.sw, tile.sh);

      // Run inference
      const tileResult = await processTile(tileInput, tile.sw, tile.sh);

      // Paste into output
      pasteTile(output, outWidth, tileResult.data, tileResult.width, tileResult.height, tile.dx, tile.dy);

      // Report progress
      progress(reqId, {
        stage: 'processing',
        progress: (i + 1) / totalTiles,
        currentTile: i + 1,
        totalTiles,
      });
    }

    // 6. If target scale is 2x but model is 4x, resize output
    let finalData = output.buffer;
    let finalWidth = outWidth;
    let finalHeight = outHeight;

    if (targetScale === 2 && modelScale === 4) {
      // Downsample 4x → 2x using simple area averaging
      finalWidth = width * 2;
      finalHeight = height * 2;
      const resized = new Uint8Array(finalWidth * finalHeight * 4);
      for (let y = 0; y < finalHeight; y++) {
        for (let x = 0; x < finalWidth; x++) {
          // Average 2x2 block from 4x output
          const sx = x * 2;
          const sy = y * 2;
          let r = 0, g = 0, b = 0, a = 0;
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              const idx = ((sy + dy) * outWidth + (sx + dx)) * 4;
              r += output[idx];
              g += output[idx + 1];
              b += output[idx + 2];
              a += output[idx + 3];
            }
          }
          const dstIdx = (y * finalWidth + x) * 4;
          resized[dstIdx] = (r / 4) | 0;
          resized[dstIdx + 1] = (g / 4) | 0;
          resized[dstIdx + 2] = (b / 4) | 0;
          resized[dstIdx + 3] = (a / 4) | 0;
        }
      }
      finalData = resized.buffer;
    }

    const totalMs = performance.now() - startTime;

    // 7. Send result (transfer buffer ownership)
    result(reqId, {
      action: 'upscale',
      imageData: { data: finalData, width: finalWidth, height: finalHeight },
      debug: {
        deviceUsed: device,
        totalMs,
        tilesProcessed: totalTiles,
      },
    });

  } catch (err) {
    error(reqId, err instanceof Error ? err.message : String(err));
  }
}

// ─── Download-only action ────────────────────────────────────────────────────

async function runDownload(req: UpscaleRequest): Promise<void> {
  const { reqId, modelId } = req;

  try {
    await detectDevice(reqId);
    await ensureModel(reqId, modelId);
    result(reqId, { action: 'download' });
  } catch (err) {
    error(reqId, err instanceof Error ? err.message : String(err));
  }
}

// ─── Message Handler ─────────────────────────────────────────────────────────

self.onmessage = async (ev: MessageEvent<UpscaleRequest>) => {
  const req = ev.data;
  if (!req || typeof req.reqId !== 'number') return;

  switch (req.action) {
    case 'upscale':
      await runUpscale(req);
      break;
    case 'download':
      await runDownload(req);
      break;
    default:
      error(req.reqId, `Unknown action: ${(req as UpscaleRequest).action}`);
  }
};
