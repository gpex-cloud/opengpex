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
 * denoise.worker.ts — AI Image Denoising Worker (NAFNet)
 *
 * Uses the shared createWorkerPipeline orchestrator for session lifecycle,
 * progress reporting, and error handling. This worker only provides:
 *   1. Model load configuration (tile params, backend selection)
 *
 * Tile-based inference, reflect-padding, overlap blending, and NCHW conversion
 * are all handled internally by the shared inference session layer. NAFNet is
 * resolution-preserving (modelScale 1): output dimensions equal input ones,
 * so no scale post-processing is needed.
 *
 * Architecture:
 *   - Persistent singleton Worker (Mode B): model session stays warm.
 *   - Uses `createWorkerPipeline` with `createSession(backend)` under the hood.
 *   - All model/backend resolution is done on the main thread (full transparency).
 *
 * Message protocol: see ./worker.types.ts
 */

import type { DenoiseRequest, DenoiseResult } from './worker.types';
import { createInference } from '../_shared/inference';
import { quantizeRgbaF32To8 } from '../_shared/inference/highDepthSource';

// ─── Result Payload Type ─────────────────────────────────────────────────────

type DenoiseResultPayload = Omit<DenoiseResult, 'type' | 'reqId'>;

// ─── Pipeline ────────────────────────────────────────────────────────────────

const handleRequest = createInference<DenoiseRequest, DenoiseResultPayload>({
  validate: (req) => {
    if (!req.imageData) return 'No image data provided';
    return null;
  },

  loadArgs: (req) => {
    const backend = req.backend ?? 'ort';
    const tileSize = Math.min(req.tileSize ?? 256, 512);
    const overlap = Math.min(32, Math.floor(tileSize / 4));
    const task = backend === 'transformers' ? 'image-to-image' : undefined;

    return {
      backend,
      modelId: req.modelId,
      onnxFile: req.onnxFile ?? 'model.onnx',
      device: req.device,
      task,
      tile: { size: tileSize, overlap, modelScale: 1 },
    };
  },

  execute: async (session, req, { progress, device }) => {
    const startTime = performance.now();

    // ── f32 precision path (16-bit source) ──
    // Interleaved RGBA f32 [0, 1] straight through the session's f32 entry —
    // no ÷255 / ×255 quantization at either end. The result ships BOTH the
    // f32 truth AND its 8-bit display proxy (the caller persists the truth
    // through the highDepthData ingest channel and encodes the proxy as the
    // display blob).
    if (req.f32ImageData) {
      if (req.imageData) {
        throw new Error('[Denoise] Both f32ImageData and imageData provided — feed exactly one');
      }
      if (!session.runImageF32) {
        throw new Error('[Denoise] Backend does not support f32 precision inference');
      }
      const { data, width, height } = req.f32ImageData;
      const srcRaster = new Float32Array(data);

      const output = await session.runImageF32(
        { data: srcRaster, width, height },
        (done, total) => progress(done / total),
      );

      if (output.width !== width || output.height !== height) {
        throw new Error(
          `[Denoise] Model output ${output.width}x${output.height} does not match input ${width}x${height} — denoising is resolution-preserving`,
        );
      }

      const totalMs = performance.now() - startTime;

      // 8-bit display proxy of the f32 truth (round-to-nearest, clamped).
      const display = quantizeRgbaF32To8(output.data);

      return {
        imageData: {
          data: display.buffer as ArrayBuffer,
          width: output.width,
          height: output.height,
        },
        f32ImageData: {
          data: output.data.buffer as ArrayBuffer,
          width: output.width,
          height: output.height,
        },
        debug: { deviceUsed: device, totalMs, tilesProcessed: 0 },
      };
    }

    // ── 8-bit path (unchanged legacy behavior) ──
    const { imageData } = req;
    const { data, width, height } = imageData!;
    const srcData = new Uint8Array(data);
    const startTime8 = startTime;

    // Run inference (tile-based processing handled by session internally)
    const output = await session.run(
      { type: 'image', data: srcData, width, height },
      (done, total) => progress(done / total),
    );

    if (output.type !== 'image') {
      throw new Error('[Denoise] Unexpected output type from session');
    }

    if (output.width !== width || output.height !== height) {
      throw new Error(
        `[Denoise] Model output ${output.width}x${output.height} does not match input ${width}x${height} — denoising is resolution-preserving`,
      );
    }

    const totalMs = performance.now() - startTime8;

    return {
      imageData: { data: output.data.buffer as ArrayBuffer, width: output.width, height: output.height },
      debug: { deviceUsed: device, totalMs, tilesProcessed: 0 },
    };
  },

  transferables: (result) =>
    result.f32ImageData
      ? [result.imageData!.data, result.f32ImageData.data]
      : result.imageData
        ? [result.imageData.data]
        : [],
});

// ─── Message Handler ─────────────────────────────────────────────────────────

self.onmessage = async (ev: MessageEvent<DenoiseRequest>) => {
  const req = ev.data;
  if (!req || typeof req.reqId !== 'number') return;
  await handleRequest(req);
};
