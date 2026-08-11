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
 * BgRemover Worker — AI Background Removal Inference Engine
 *
 * Uses the shared createWorkerPipeline orchestrator for session lifecycle,
 * progress reporting, and error handling. This worker only provides:
 *   1. Model load configuration
 *   2. Mask post-processing: logits → threshold → binary mask → resize → contour → polygon
 *
 * All model loading, CDN import, device detection, caching, and WebGPU fallback
 * are delegated to the shared inference layer via the pipeline orchestrator.
 *
 * Per spec §2.4: Worker communication uses Transferable buffers (zero-copy).
 */

import type { BgRemoverRequest, BgRemoverResult } from './worker.types';
import { createInference } from '../_shared/inference';

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

// ─── Result Payload Type ─────────────────────────────────────────────────────

type BgRemoverResultPayload = Omit<BgRemoverResult, 'type' | 'reqId'>;

// ─── Pipeline ────────────────────────────────────────────────────────────────

const handleRequest = createInference<BgRemoverRequest, BgRemoverResultPayload>({
  validate: (req) => {
    if (!req.imageData) return 'Image data is required for background removal';
    return null;
  },

  loadArgs: (req) => ({
    backend: req.backend ?? 'transformers',
    modelId: req.modelId,
    onnxFile: req.onnxFile,
    device: req.device,
    transformersMode: 'auto-model',
  }),

  execute: async (session, req, { progress, device }) => {
    const { imageData, context } = req;
    const { width, height, data } = imageData!;
    const totalStart = performance.now();

    // Run inference
    progress(0.2);
    const inferenceStart = performance.now();
    const output = await session.run({ type: 'image', data: new Uint8Array(data), width, height });
    const inferenceMs = performance.now() - inferenceStart;
    progress(0.7);

    // Post-process: raw tensor → binary mask → contour → polygon
    if (output.type !== 'tensor') throw new Error('Expected tensor output from auto-model session');
    const postStart = performance.now();

    const dims = output.dims; // e.g. [1, 1, 1024, 1024]
    const modelH = dims[dims.length - 2];
    const modelW = dims[dims.length - 1];
    const rawData = output.data;
    const modelPixels = modelH * modelW;
    const offset = rawData.length - modelPixels;

    // Auto-detect if output is logits or probabilities
    let minVal = Infinity, maxVal = -Infinity;
    for (let i = 0; i < Math.min(1000, modelPixels); i++) {
      const v = rawData[offset + i];
      if (v < minVal) minVal = v;
      if (v > maxVal) maxVal = v;
    }
    const isLogits = minVal < -0.5 || maxVal > 1.5;
    const threshold = isLogits ? 0 : 0.5;

    // Threshold → binary mask at model resolution
    const binaryMaskModel = new Uint8Array(modelPixels);
    for (let i = 0; i < modelPixels; i++) {
      binaryMaskModel[i] = rawData[offset + i] > threshold ? 255 : 0;
    }

    // Resize binary mask to original image dimensions (nearest-neighbor)
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

    progress(0.85);

    // Trace contour + simplify
    const rawContour = traceContour(binaryMask, width, height);
    const simplified = rawContour.length > 0 ? simplifyRDP(rawContour, 1.5) : [];

    const postProcessMs = performance.now() - postStart;
    const totalMs = performance.now() - totalStart;

    return {
      context,
      rings: simplified.length >= 3 ? [simplified] : [],
      debug: { deviceUsed: device, inferenceMs, postProcessMs, totalMs },
    };
  },
});

// ─── Message Handler ─────────────────────────────────────────────────────────

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  self.addEventListener('message', (ev: MessageEvent<BgRemoverRequest>) => {
    handleRequest(ev.data);
  });
}

// ─── Test Exports ────────────────────────────────────────────────────────────

export const __test__ = { traceContour, simplifyRDP };
