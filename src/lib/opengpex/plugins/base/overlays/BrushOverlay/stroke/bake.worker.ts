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
 * Paint Bake Worker
 *
 * Plugin-owned Worker that offloads the heavy composite → bounds → encode
 * pipeline from the main thread. Receives two transferable ImageBitmaps
 * (existing layer + stroke), composites them onto an OffscreenCanvas,
 * detects content bounds, crops, encodes to WebP lossless, and returns
 * the result blob + a transferable ImageBitmap of the final cropped canvas.
 *
 * All imported utilities are Worker-safe (no DOM, no side effects).
 */

import { calculateContentBoundsFromImageData } from '@opengpex/editor/core/engine/utils/pixel-utils';
import { calculateContentHash } from '@opengpex/editor/core/helpers/hash';
import type { BakeWorkerRequest, BakeWorkerResult } from './bake-worker-client';

self.onmessage = async (e: MessageEvent<BakeWorkerRequest>) => {
  const {
    existingBitmap, existingLayerRect, strokeBitmap,
    canvasSize, isNewLayer, strokeDirtyRect, existingLayerBounding,
  } = e.data;

  // ── Composite ──
  const compositeCanvas = new OffscreenCanvas(canvasSize.w, canvasSize.h);
  const compositeCtx = compositeCanvas.getContext('2d');
  if (!compositeCtx) throw new Error('Failed to get composite canvas context');

  if (existingBitmap && existingLayerRect) {
    compositeCtx.drawImage(existingBitmap, existingLayerRect.x, existingLayerRect.y);
    existingBitmap.close();
  }
  compositeCtx.globalCompositeOperation = 'source-over';
  compositeCtx.drawImage(strokeBitmap, 0, 0);
  strokeBitmap.close();

  // ── Content bounds detection (3-tier logic, identical to original bake.ts) ──
  let cropX: number, cropY: number, cropW: number, cropH: number;

  if (isNewLayer && strokeDirtyRect) {
    // Fast path: new layer has ONLY stroke content → stroke dirty rect IS content bounds
    // No getImageData needed (~0ms vs ~5-8ms for 4K canvas)
    cropX = Math.max(0, strokeDirtyRect.x - 1);
    cropY = Math.max(0, strokeDirtyRect.y - 1);
    const cropR = Math.min(canvasSize.w, strokeDirtyRect.x + strokeDirtyRect.w + 1);
    const cropB = Math.min(canvasSize.h, strokeDirtyRect.y + strokeDirtyRect.h + 1);
    cropW = cropR - cropX;
    cropH = cropB - cropY;
  } else if (strokeDirtyRect && !isNewLayer && existingLayerBounding && existingLayerRect) {
    // Existing layer: scan within expanded dirty rect union with existing layer bounds
    const drawX = existingLayerRect.x;
    const drawY = existingLayerRect.y;
    const existR = drawX + existingLayerBounding.w;
    const existB = drawY + existingLayerBounding.h;
    const strokeR = strokeDirtyRect.x + strokeDirtyRect.w;
    const strokeB = strokeDirtyRect.y + strokeDirtyRect.h;

    // Union of existing layer rect + stroke dirty rect (clamped to canvas)
    const scanX = Math.max(0, Math.floor(Math.min(drawX, strokeDirtyRect.x)) - 1);
    const scanY = Math.max(0, Math.floor(Math.min(drawY, strokeDirtyRect.y)) - 1);
    const scanR = Math.min(canvasSize.w, Math.ceil(Math.max(existR, strokeR)) + 1);
    const scanB = Math.min(canvasSize.h, Math.ceil(Math.max(existB, strokeB)) + 1);
    const scanW = scanR - scanX;
    const scanH = scanB - scanY;

    // Only scan the union region (much smaller than full canvas for typical strokes)
    const regionImageData = compositeCtx.getImageData(scanX, scanY, scanW, scanH);
    const contentBounds = calculateContentBoundsFromImageData(regionImageData, scanW, scanH);

    // Offset back to canvas coordinates + 1px padding
    cropX = Math.max(0, scanX + contentBounds.x - 1);
    cropY = Math.max(0, scanY + contentBounds.y - 1);
    const cropR = Math.min(canvasSize.w, scanX + contentBounds.x + contentBounds.w + 1);
    const cropB = Math.min(canvasSize.h, scanY + contentBounds.y + contentBounds.h + 1);
    cropW = cropR - cropX;
    cropH = cropB - cropY;
  } else {
    // Fallback: no dirty rect available — full canvas scan (original behavior)
    const compositeImageData = compositeCtx.getImageData(0, 0, canvasSize.w, canvasSize.h);
    const contentBounds = calculateContentBoundsFromImageData(compositeImageData, canvasSize.w, canvasSize.h);
    cropX = Math.max(0, contentBounds.x - 1);
    cropY = Math.max(0, contentBounds.y - 1);
    const cropR = Math.min(canvasSize.w, contentBounds.x + contentBounds.w + 1);
    const cropB = Math.min(canvasSize.h, contentBounds.y + contentBounds.h + 1);
    cropW = cropR - cropX;
    cropH = cropB - cropY;
  }

  // ── Crop ──
  let finalCanvas: OffscreenCanvas;
  if (cropW < canvasSize.w || cropH < canvasSize.h) {
    finalCanvas = new OffscreenCanvas(cropW, cropH);
    const finalCtx = finalCanvas.getContext('2d')!;
    finalCtx.drawImage(compositeCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
  } else {
    finalCanvas = compositeCanvas;
  }

  // ── Encode + bitmap + hash in parallel ──
  const [blob, bitmap] = await Promise.all([
    finalCanvas.convertToBlob({ type: 'image/webp', quality: 1.0 }),
    createImageBitmap(finalCanvas),
  ]);
  const hash = await calculateContentHash(blob);

  // Transfer bitmap back to main thread (zero-copy)
  const result: BakeWorkerResult = { blob, bitmap, cropX, cropY, cropW, cropH, hash };
  (self as unknown as { postMessage(msg: BakeWorkerResult, transfer: Transferable[]): void })
    .postMessage(result, [bitmap]);
};

