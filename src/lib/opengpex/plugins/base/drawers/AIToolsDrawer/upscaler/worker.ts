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
 * Uses the shared createWorkerPipeline orchestrator for session lifecycle,
 * progress reporting, and error handling. This worker only provides:
 *   1. Model load configuration (tile params, backend selection)
 *   2. Scale mismatch post-processing (downsample when model > target scale)
 *
 * Tile-based inference, reflect-padding, overlap blending, and NCHW conversion
 * are all handled internally by the shared inference session layer.
 *
 * Architecture:
 *   - Persistent singleton Worker (Mode B): model session stays warm.
 *   - Uses `createWorkerPipeline` with `createSession(backend)` under the hood.
 *   - All model/backend resolution is done on the main thread (full transparency).
 *
 * Message protocol: see ./worker.types.ts
 */

import type { UpscaleRequest, UpscaleResult } from './worker.types';
import { createInference } from '../_shared/inference';

// ─── Scale Mismatch Post-Processing ─────────────────────────────────────────

/**
 * Area-average downsample when model native scale > target scale.
 * e.g. model=4×, target=2× → 2×2 block average.
 */
function downsampleIfNeeded(
  outputData: Uint8Array, outWidth: number, outHeight: number,
  srcWidth: number, srcHeight: number,
  modelScale: number, targetScale: number,
): { data: ArrayBuffer; width: number; height: number } {
  if (targetScale >= modelScale) {
    return { data: outputData.buffer as ArrayBuffer, width: outWidth, height: outHeight };
  }

  const downFactor = modelScale / targetScale;
  const finalWidth = srcWidth * targetScale;
  const finalHeight = srcHeight * targetScale;
  const resized = new Uint8Array(finalWidth * finalHeight * 4);
  const blockSize = downFactor;
  const blockArea = blockSize * blockSize;

  for (let y = 0; y < finalHeight; y++) {
    for (let x = 0; x < finalWidth; x++) {
      const sx = x * blockSize;
      const sy = y * blockSize;
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < blockSize; dy++) {
        for (let dx = 0; dx < blockSize; dx++) {
          const idx = ((sy + dy) * outWidth + (sx + dx)) * 4;
          r += outputData[idx];
          g += outputData[idx + 1];
          b += outputData[idx + 2];
          a += outputData[idx + 3];
        }
      }
      const dstIdx = (y * finalWidth + x) * 4;
      resized[dstIdx] = (r / blockArea) | 0;
      resized[dstIdx + 1] = (g / blockArea) | 0;
      resized[dstIdx + 2] = (b / blockArea) | 0;
      resized[dstIdx + 3] = (a / blockArea) | 0;
    }
  }
  return { data: resized.buffer, width: finalWidth, height: finalHeight };
}

// ─── Result Payload Type ─────────────────────────────────────────────────────

type UpscaleResultPayload = Omit<UpscaleResult, 'type' | 'reqId'>;

// ─── Pipeline ────────────────────────────────────────────────────────────────

const handleRequest = createInference<UpscaleRequest, UpscaleResultPayload>({
  validate: (req) => {
    if (!req.imageData) return 'No image data provided';
    return null;
  },

  loadArgs: (req) => {
    const backend = req.backend ?? 'ort';
    const modelScale = req.modelScale ?? 4;
    const maxTileForScale = Math.floor(512 / modelScale);
    const tileSize = Math.min(req.tileSize ?? 128, maxTileForScale);
    const overlap = Math.min(32, Math.floor(tileSize / 4));
    const task = backend === 'transformers' ? 'image-to-image' : undefined;

    return {
      backend,
      modelId: req.modelId,
      onnxFile: req.onnxFile ?? 'model.onnx',
      device: req.device,
      task,
      tile: { size: tileSize, overlap, modelScale },
    };
  },

  execute: async (session, req, { progress, device }) => {
    const { imageData, modelScale: reqModelScale, scale: targetScale } = req;
    const { data, width, height } = imageData!;
    const srcData = new Uint8Array(data);
    const modelScale = reqModelScale ?? 4;
    const startTime = performance.now();

    // Run inference (tile-based processing handled by session internally)
    const output = await session.run(
      { type: 'image', data: srcData, width, height },
      (done, total) => progress(done / total),
    );

    if (output.type !== 'image') {
      throw new Error('[Upscaler] Unexpected output type from session');
    }

    // Scale mismatch post-processing
    const effectiveTargetScale = targetScale ?? modelScale;
    const finalImage = downsampleIfNeeded(
      output.data, output.width, output.height,
      width, height, modelScale, effectiveTargetScale,
    );

    const totalMs = performance.now() - startTime;

    return {
      imageData: finalImage,
      debug: { deviceUsed: device, totalMs, tilesProcessed: 0 },
    };
  },

  transferables: (result) => result.imageData ? [result.imageData.data] : [],
});

// ─── Message Handler ─────────────────────────────────────────────────────────

self.onmessage = async (ev: MessageEvent<UpscaleRequest>) => {
  const req = ev.data;
  if (!req || typeof req.reqId !== 'number') return;
  await handleRequest(req);
};
