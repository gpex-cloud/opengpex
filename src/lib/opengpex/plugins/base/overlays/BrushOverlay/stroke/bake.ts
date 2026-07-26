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
 * Bake Pipeline
 *
 * Executes the bake process for completed strokes:
 * - Paint: composite existing layer + stroke → crop → encode → register asset → CMD_BAKE
 * - Mask: register encoded blob → update/add bitmap mask → fast.commit
 *
 * Future (Part B): The paint bake pipeline will be offloaded to a Worker.
 */

import type { InteractionEvent, Layer } from '@opengpex/editor/core/types';
import { asLocalRect, asLocalShape } from '@opengpex/editor/core/types';
import { calculateContentBoundsFromImageData } from '@opengpex/editor/core/engine/filters';
import { _CMD_BAKE_UID } from '../protocols';
import type { BakeRequest, PaintBakeRequest, MaskBakeRequest } from './types';

/** Command UID (from protocols, Single Source of Truth) */
const CMD_BAKE_UID = _CMD_BAKE_UID;

// ─── Main Entry ────────────────────────────────────────────────────────────────

/**
 * Executes the bake process for a completed stroke.
 *
 * Routes to paint or mask bake based on request type.
 */
export async function executeBake(request: BakeRequest, e: InteractionEvent): Promise<void> {
  if (request.type === 'paint') {
    await executePaintBake(request, e);
  } else {
    await executeMaskBake(request, e);
  }
}

// ─── Paint Bake ────────────────────────────────────────────────────────────────

async function executePaintBake(request: PaintBakeRequest, e: InteractionEvent): Promise<void> {
  const { strokeBitmap, targetLayer, isNewLayer, canvasSize, strokeDirtyRect } = request;
  const frame = e.activeFrame;

  const compositeCanvas = new OffscreenCanvas(canvasSize.w, canvasSize.h);
  const compositeCtx = compositeCanvas.getContext('2d');
  if (!compositeCtx) throw new Error('Failed to get composite canvas context');

  // Draw existing layer content (if reusing an existing layer)
  if (targetLayer.src && !isNewLayer) {
    try {
      // Use SourceBitmapCache (nearly always a cache hit — layer is being rendered)
      const existingBitmap = await e.pixels.image.loadBitmap(targetLayer.src);
      // If existing layer was cropped (bounding < canvas), draw at correct offset
      const drawX = canvasSize.w / 2 + targetLayer.cx - targetLayer.bounding.w / 2;
      const drawY = canvasSize.h / 2 + targetLayer.cy - targetLayer.bounding.h / 2;
      compositeCtx.drawImage(existingBitmap, drawX, drawY);
      // Note: do NOT close() — bitmap is owned by SourceBitmapCache (shared reference)
    } catch (loadErr) {
      console.warn('[BrushOverlay] Failed to load existing layer bitmap:', loadErr);
    }
  }

  // Composite stroke bitmap onto the layer (zero-copy from transferToImageBitmap)
  compositeCtx.globalCompositeOperation = 'source-over';
  compositeCtx.drawImage(strokeBitmap, 0, 0);
  strokeBitmap.close(); // Release GPU bitmap resource

  // ── Content bounds detection (optimized via dirty rect) ──
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
  } else if (strokeDirtyRect && !isNewLayer) {
    // Existing layer: scan within expanded dirty rect union with existing layer bounds
    // The existing layer content is at [drawX, drawY, bounding.w, bounding.h]
    // The stroke content is at strokeDirtyRect. Union both to get scan region.
    const drawX = canvasSize.w / 2 + targetLayer.cx - targetLayer.bounding.w / 2;
    const drawY = canvasSize.h / 2 + targetLayer.cy - targetLayer.bounding.h / 2;
    const existR = drawX + targetLayer.bounding.w;
    const existB = drawY + targetLayer.bounding.h;
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

  // Only crop if content is smaller than the full canvas
  let finalCanvas: OffscreenCanvas;
  if (cropW < canvasSize.w || cropH < canvasSize.h) {
    finalCanvas = new OffscreenCanvas(cropW, cropH);
    const finalCtx = finalCanvas.getContext('2d')!;
    finalCtx.drawImage(compositeCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
  } else {
    finalCanvas = compositeCanvas;
  }

  // Encode to WebP lossless (3-4x faster than PNG, pixel-perfect, smaller file size)
  const blob = await finalCanvas.convertToBlob({ type: 'image/webp', quality: 1.0 });
  const asset = await e.assets.register(blob);

  // Pre-warm the decode cache so the freshly baked layer renders
  // immediately without a one-frame flash of the previous asset.
  await e.pixels.image.cacheBitmap(asset.url, blob);

  // Calculate cx/cy: convert from canvas-local crop rect center to world center offset
  const cropCenterLocalX = cropX + cropW / 2;
  const cropCenterLocalY = cropY + cropH / 2;
  const newCx = cropCenterLocalX - canvasSize.w / 2;
  const newCy = cropCenterLocalY - canvasSize.h / 2;

  const completeLayer: Layer = {
    ...targetLayer,
    assetId: asset.id,
    src: asset.url,
    bounding: { w: cropW, h: cropH },
    visibleShape: asLocalShape({ x: 0, y: 0, w: cropW, h: cropH }),
    cx: newCx,
    cy: newCy,
  };

  e.actions.executeCommand(CMD_BAKE_UID, {
    frameId: frame.id,
    layer: completeLayer,
    isNew: isNewLayer,
  });
}

// ─── Mask Bake ─────────────────────────────────────────────────────────────────

async function executeMaskBake(request: MaskBakeRequest, e: InteractionEvent): Promise<void> {
  const { blob, targetLayerId, existingMaskId, maskBounds } = request;
  const frame = e.activeFrame;

  try {
    // Register mask blob as asset
    const asset = await e.assets.register(blob);

    // Pre-warm the decode cache for the baked mask asset
    await e.pixels.image.cacheBitmap(asset.url, blob);

    // Update existing mask or add new mask
    if (existingMaskId) {
      await e.actions.adv.layer.bitmapMask.update.execute({
        frameId: frame.id,
        layerId: targetLayerId,
        maskId: existingMaskId,
        patch: {
          src: asset.url,
          assetId: asset.id,
        },
      });
    } else {
      await e.actions.adv.layer.bitmapMask.add.execute({
        frameId: frame.id,
        layerId: targetLayerId,
        src: asset.url,
        assetId: asset.id,
        bounds: asLocalRect({ x: 0, y: 0, w: maskBounds.w, h: maskBounds.h }),
      });
    }
  } finally {
    // Commit the fast-track override (clear live preview)
    e.actions.fast.commit(targetLayerId, 'layer');
  }
}

