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
 * inpaint-eraser.worker.ts — AI Inpainting (Smart Eraser) Worker
 *
 * Uses the shared createWorkerPipeline orchestrator for session lifecycle,
 * progress reporting, and error handling. This worker only provides:
 *   1. Input validation & model configuration
 *   2. Mask rasterization (polygon → binary mask via OffscreenCanvas)
 *   3. Image/mask resize to model input size
 *   4. ONNX inference via OrtSession.runWithFeeds (LaMa multi-tensor input)
 *   5. Output resize + patch extraction
 *
 * Pipeline:
 *   1. OffscreenCanvas rasterize polygon → binary mask
 *   2. Resize image + mask to model input size (e.g. 512×512)
 *   3. ONNX inference (LaMa) → inpainted image at model size
 *   4. Resize inpainted output back to original dimensions
 *   5. Extract patch: only maskBounds region, mask-outside → transparent
 *
 * Message protocol: see ./worker.types.ts
 */

import type { InpaintEraserRequest, InpaintEraserResult } from './worker.types';
import { createInference, OrtSession, rgbaToNchw, tensorToRgba } from '../../_shared/inference';

// ─── Mask Rasterization ──────────────────────────────────────────────────────

/**
 * Rasterize polygon rings into a binary mask using OffscreenCanvas.
 * Returns a single-channel Uint8Array (0 or 255) at the given dimensions.
 */
function rasterizePolygon(rings: number[][][], width: number, height: number): Uint8Array {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'white';

  for (const ring of rings) {
    if (ring.length < 3) continue;
    ctx.beginPath();
    ctx.moveTo(ring[0][0], ring[0][1]);
    for (let i = 1; i < ring.length; i++) {
      ctx.lineTo(ring[i][0], ring[i][1]);
    }
    ctx.closePath();
    ctx.fill();
  }

  const imageData = ctx.getImageData(0, 0, width, height);
  // Extract single-channel mask (R channel, 0 or 255)
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = imageData.data[i * 4]; // R channel
  }
  return mask;
}

// ─── Image Resize (Bilinear) ─────────────────────────────────────────────────

/**
 * Resize RGBA image to target dimensions using OffscreenCanvas (hardware-accelerated).
 */
function resizeImage(
  srcData: Uint8Array, srcW: number, srcH: number,
  dstW: number, dstH: number
): Uint8Array {
  const srcCanvas = new OffscreenCanvas(srcW, srcH);
  const srcCtx = srcCanvas.getContext('2d')!;
  const clampedData = new Uint8ClampedArray(srcData.length);
  clampedData.set(srcData);
  const imgData = new ImageData(clampedData, srcW, srcH);
  srcCtx.putImageData(imgData, 0, 0);

  const dstCanvas = new OffscreenCanvas(dstW, dstH);
  const dstCtx = dstCanvas.getContext('2d')!;
  dstCtx.drawImage(srcCanvas, 0, 0, dstW, dstH);

  const result = dstCtx.getImageData(0, 0, dstW, dstH);
  return new Uint8Array(result.data.buffer);
}

/**
 * Resize single-channel mask to target dimensions using OffscreenCanvas.
 */
function resizeMask(
  mask: Uint8Array, srcW: number, srcH: number,
  dstW: number, dstH: number
): Uint8Array {
  // Convert single-channel to RGBA for OffscreenCanvas
  const rgba = new Uint8Array(srcW * srcH * 4);
  for (let i = 0; i < mask.length; i++) {
    rgba[i * 4] = mask[i];
    rgba[i * 4 + 1] = mask[i];
    rgba[i * 4 + 2] = mask[i];
    rgba[i * 4 + 3] = 255;
  }

  const resized = resizeImage(rgba, srcW, srcH, dstW, dstH);

  // Extract back to single-channel
  const result = new Uint8Array(dstW * dstH);
  for (let i = 0; i < result.length; i++) {
    result[i] = resized[i * 4]; // R channel
  }
  return result;
}

// ─── Patch Extraction ────────────────────────────────────────────────────────

/**
 * Extract patch from inpainted image, applying mask transparency.
 * Only pixels within the mask are kept; mask-outside pixels are transparent.
 */
function extractPatch(
  inpaintedRgba: Uint8Array,
  inpaintedW: number,
  mask: Uint8Array,
  bounds: { x: number; y: number; w: number; h: number }
): { data: ArrayBuffer; width: number; height: number; offsetX: number; offsetY: number } {
  const { x, y, w, h } = bounds;
  const patch = new Uint8ClampedArray(w * h * 4);

  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const srcIdx = ((y + row) * inpaintedW + (x + col));
      const dstIdx = (row * w + col) * 4;

      if (mask[srcIdx] > 128) {
        // mask 内：使用 inpainted 像素
        const si = srcIdx * 4;
        patch[dstIdx] = inpaintedRgba[si];
        patch[dstIdx + 1] = inpaintedRgba[si + 1];
        patch[dstIdx + 2] = inpaintedRgba[si + 2];
        patch[dstIdx + 3] = 255;
      } else {
        // mask 外：transparent
        patch[dstIdx + 3] = 0;
      }
    }
  }

  return { data: patch.buffer, width: w, height: h, offsetX: x, offsetY: y };
}

// ─── ONNX Inference (LaMa) ──────────────────────────────────────────────────

/**
 * Run LaMa inpainting inference on the given image and mask.
 *
 * LaMa model (Carve/LaMa-ONNX lama_fp32.onnx):
 *   - Input "image": float32 [1, 3, 512, 512] — RGB normalized to [0, 1]
 *   - Input "mask":  float32 [1, 1, 512, 512] — binary mask (0 or 1)
 *   - Output:        float32 [1, 3, 512, 512] — inpainted RGB [0, 1]
 *
 * Uses OrtSession.runWithFeeds() for custom multi-tensor input.
 *
 * Returns RGBA Uint8Array at model input dimensions.
 */
async function runLamaInference(
  ortSession: OrtSession,
  imageRgba: Uint8Array,
  mask: Uint8Array,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const ort = ortSession.getOrt();
  const pixels = width * height;

  // 1. Convert RGBA image → RGB float32 tensor [1, 3, H, W] normalized to [0, 1]
  const imageFloat = rgbaToNchw(imageRgba, width, height);

  // 2. Convert binary mask → float32 tensor [1, 1, H, W], values 0.0 or 1.0
  const maskFloat = new Float32Array(pixels);
  for (let i = 0; i < pixels; i++) {
    maskFloat[i] = mask[i] > 128 ? 1.0 : 0.0;
  }

  // 3. Create ONNX tensors
  const imageTensor = new ort.Tensor('float32', imageFloat, [1, 3, height, width]);
  const maskTensor = new ort.Tensor('float32', maskFloat, [1, 1, height, width]);

  // 4. Build feeds — detect input names dynamically
  const inputNames = ortSession.getInputNames();
  const feeds: Record<string, unknown> = {};

  if (inputNames.length >= 2) {
    // Standard LaMa: two inputs (image + mask)
    const maskInputIdx = inputNames.findIndex((n: string) => n.toLowerCase().includes('mask'));
    if (maskInputIdx >= 0) {
      feeds[inputNames[maskInputIdx]] = maskTensor;
      const imageInputIdx = maskInputIdx === 0 ? 1 : 0;
      feeds[inputNames[imageInputIdx]] = imageTensor;
    } else {
      // Fallback: assume first = image, second = mask (LaMa convention)
      feeds[inputNames[0]] = imageTensor;
      feeds[inputNames[1]] = maskTensor;
    }
  } else if (inputNames.length === 1) {
    // Single concatenated input: [1, 4, H, W] (RGB + mask)
    const concat = new Float32Array(4 * pixels);
    concat.set(imageFloat, 0);
    concat.set(maskFloat, 3 * pixels);
    feeds[inputNames[0]] = new ort.Tensor('float32', concat, [1, 4, height, width]);
  } else {
    throw new Error(`Unexpected number of model inputs: ${inputNames.length}`);
  }

  console.log(`[InpaintEraser] Running inference: inputs=[${Object.keys(feeds).join(', ')}], size=${width}x${height}, device=${ortSession.device}`);

  // 5. Run inference via OrtSession (WASM fallback built in)
  const results = await ortSession.runWithFeeds(feeds);

  // 6. Extract output tensor (first output)
  const outputNames = ortSession.getOutputNames();
  const outputEntry = results[outputNames[0]];
  if (!outputEntry) {
    throw new Error(`No output tensor found. Available: ${Object.keys(results).join(', ')}`);
  }

  const outputData = outputEntry.data;
  const outputDims = outputEntry.dims;
  console.log(`[InpaintEraser] Output dims: [${outputDims.join(', ')}]`);

  // 7. Convert output tensor → RGBA (auto-detects value range and layout)
  const { rgba } = tensorToRgba(outputData, outputDims);
  return rgba;
}

// ─── Result Payload Type ─────────────────────────────────────────────────────

type InpaintEraserResultPayload = Omit<InpaintEraserResult, 'type' | 'reqId'>;

// ─── Pipeline ────────────────────────────────────────────────────────────────

const handleRequest = createInference<InpaintEraserRequest, InpaintEraserResultPayload>({
  validate: (req) => {
    if (!req.imageData) return 'No image data provided';
    if (!req.polygonRings || req.polygonRings.length === 0) return 'No polygon mask provided';
    if (!req.maskBounds) return 'No mask bounds provided';
    return null;
  },

  loadArgs: (req) => ({
    backend: req.backend ?? 'ort',
    modelId: req.modelId,
    onnxFile: req.onnxFile ?? 'lama_fp32.onnx',
    device: req.device,
  }),

  execute: async (session, req, { progress, device }) => {
    const { imageData, polygonRings, maskBounds, inputSize: rawInputSize } = req;
    const { data, width, height } = imageData!;
    const inputSize = rawInputSize ?? 512;
    const srcData = new Uint8Array(data);

    // Cast to OrtSession for runWithFeeds (LaMa requires multi-tensor input)
    const ortSession = session as OrtSession;

    // 1. Rasterize polygon mask at original image dimensions
    progress(0.1);
    const mask = rasterizePolygon(polygonRings!, width, height);

    // 2. Resize image + mask to model input size
    progress(0.2);
    const resizedImage = resizeImage(srcData, width, height, inputSize, inputSize);
    const resizedMask = resizeMask(mask, width, height, inputSize, inputSize);
    progress(0.3);

    // 3. Run ONNX inference
    const inferenceStart = performance.now();
    const inpaintedSmall = await runLamaInference(ortSession, resizedImage, resizedMask, inputSize, inputSize);
    const inferenceMs = performance.now() - inferenceStart;

    console.log(`[InpaintEraser] Inference completed in ${inferenceMs.toFixed(0)}ms`);
    progress(0.7);

    // 4. Resize inpainted output back to original dimensions
    const inpaintedFull = resizeImage(inpaintedSmall, inputSize, inputSize, width, height);
    progress(0.9);

    // 5. Extract patch from mask bounds
    const patch = extractPatch(inpaintedFull, width, mask, maskBounds!);

    return {
      patchData: patch.data,
      offsetX: patch.offsetX,
      offsetY: patch.offsetY,
      width: patch.width,
      height: patch.height,
      debug: { deviceUsed: device, inferenceMs, totalMs: performance.now() - inferenceStart },
    };
  },

  transferables: (result) => result.patchData ? [result.patchData] : [],
});

// ─── Message Handler ─────────────────────────────────────────────────────────

self.onmessage = async (ev: MessageEvent<InpaintEraserRequest>) => {
  const req = ev.data;
  if (!req || typeof req.reqId !== 'number') return;
  await handleRequest(req);
};
