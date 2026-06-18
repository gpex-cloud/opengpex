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
 * handlers/merger.ts: Layer merging handlers
 */

import { workerCache } from '../core/WorkerCache';
import { PixelUtils } from '../../PixelUtils';
import { EngineProvider } from '../core/EngineProvider';
import { shapeToPath2D } from '@opengpex/editor/core/helpers/path2d';
import { shrinkInvertedMask } from '@opengpex/editor/core/helpers/sub-pixel';
import { Layer, LayerItemForWorker, ClipDescriptor, Shape, WorkerResult } from '@opengpex/editor/core/types';

export async function mergeLayersToLayer(
  canvasDim: { w: number, h: number },
  layers: LayerItemForWorker[],
  options?: { targetDpr?: number }
): Promise<WorkerResult> {
  const targetDpr = options?.targetDpr || 1;
  const offscreen = new OffscreenCanvas(Math.ceil(canvasDim.w * targetDpr), Math.ceil(canvasDim.h * targetDpr));
  const offCtx2d = offscreen.getContext('2d')!;

  for (const layer of layers) {
    const bitmaps = workerCache.getBitmaps(layer.hash);
    if (!bitmaps || !bitmaps[0]) {
      // Attempt automatic restoration
      const blob = workerCache.blobCache.get(layer.hash);
      if (blob) {
        // Here we could call decoding in explorer, but to avoid circular dependencies, we handle it simply here
        const source = await createImageBitmap(blob);
        workerCache.touch(layer.hash, [source]);
      } else {
        // Special assets (such as asset-transparent-pixel) or un-rasterized layers (text/color)
        // Skip this layer instead of throwing error; this layer contributes transparent pixels in merged result
        console.warn(`[Worker] Asset ${layer.hash} not available for merging, skipping layer`);
        continue;
      }
    }

    const source = workerCache.getBitmaps(layer.hash)![0];

    const dummyLayer: Partial<Layer> = {
      type: 'image',
      bounding: { w: layer.boundingRect.w, h: layer.boundingRect.h },
      visibleShape: layer.visibleShape,
      opacity: layer.opacity ?? 1,
      adjustments: layer.adjustments,
      vectorMasks: layer.vectorMasks,
      bitmapMasks: layer.bitmapMasks
    };

    const clipSequence = layer.vectorMasks?.map(m => ({
      shape: m.shape,
      inverted: m.inverted,
      __compiledPath2D: shapeToPath2D(shrinkInvertedMask(m.shape, m.inverted))
    })) as ClipDescriptor[];

    // Scale layer matrix components by targetDpr
    const scaledMatrix = {
      a: layer.matrix.a * targetDpr,
      b: layer.matrix.b * targetDpr,
      c: layer.matrix.c * targetDpr,
      d: layer.matrix.d * targetDpr,
      tx: layer.matrix.tx * targetDpr,
      ty: layer.matrix.ty * targetDpr
    };

    const hasBitmapMasks = layer.bitmapMasks && layer.bitmapMasks.some(m => m.enabled);
    if (hasBitmapMasks) {
      const tempCanvas = new OffscreenCanvas(offscreen.width, offscreen.height);
      const tempCtx = tempCanvas.getContext('2d')!;

      EngineProvider.drawLayerInstance(tempCtx, dummyLayer as Layer, source, {
        matrix: scaledMatrix,
        width: layer.boundingRect.w,
        height: layer.boundingRect.h,
        clipSequence,
        dprScale: layer.dprScale
      });

      for (const bm of layer.bitmapMasks!.filter(m => m.enabled)) {
        const maskBitmaps = workerCache.getBitmaps(bm.assetId);
        let maskBitmap = maskBitmaps?.[0];
        if (!maskBitmap) {
          const blob = workerCache.blobCache.get(bm.assetId);
          if (blob) {
            maskBitmap = await createImageBitmap(blob);
            workerCache.touch(bm.assetId, [maskBitmap]);
          } else if (bm.src) {
            try {
              const res = await fetch(bm.src);
              const fetchedBlob = await res.blob();
              maskBitmap = await createImageBitmap(fetchedBlob);
              workerCache.touch(bm.assetId, [maskBitmap]);
            } catch (fetchErr) {
              console.warn(`[Worker] Failed to fetch bitmap mask from src ${bm.src}`, fetchErr);
            }
          }
        }

        if (maskBitmap) {
          tempCtx.save();
          tempCtx.setTransform(scaledMatrix.a, scaledMatrix.b, scaledMatrix.c, scaledMatrix.d, scaledMatrix.tx, scaledMatrix.ty);
          tempCtx.globalCompositeOperation = bm.inverted ? 'destination-out' : 'destination-in';
          tempCtx.drawImage(maskBitmap, bm.bounds.x, bm.bounds.y, bm.bounds.w, bm.bounds.h);
          tempCtx.restore();
        }
      }

      offCtx2d.drawImage(tempCanvas, 0, 0);
    } else {
      EngineProvider.drawLayerInstance(offCtx2d, dummyLayer as Layer, source, {
        matrix: scaledMatrix,
        width: layer.boundingRect.w,
        height: layer.boundingRect.h,
        clipSequence, // Apply masks
        dprScale: layer.dprScale
      });
    }
  }

  const blob = await PixelUtils.canvasToBlob(offscreen);
  return PixelUtils.wrapResult(blob, targetDpr);
}

export async function mergeLayersWithShape(
  canvasDim: { w: number, h: number },
  shape: Shape,
  layers: LayerItemForWorker[],
  options?: { format?: string; quality?: number; targetDpr?: number }
): Promise<WorkerResult | { bitmap: ImageBitmap }> {
  const targetDpr = options?.targetDpr || 1;
  const offscreen = new OffscreenCanvas(Math.ceil(canvasDim.w * targetDpr), Math.ceil(canvasDim.h * targetDpr));
  const offCtx2d = offscreen.getContext('2d')!;

  // 1. Apply shape clipping (clipping under zoom context, then reset transformation to retain clipping area)
  offCtx2d.scale(targetDpr, targetDpr);
  const path = shapeToPath2D(shape);
  offCtx2d.clip(path);
  offCtx2d.setTransform(1, 0, 0, 1, 0, 0);

  // 2. Stacked drawing
  for (const layer of layers) {
    const bitmaps = workerCache.getBitmaps(layer.hash);
    if (!bitmaps || !bitmaps[0]) {
      const blob = workerCache.blobCache.get(layer.hash);
      if (blob) {
        const source = await createImageBitmap(blob);
        workerCache.touch(layer.hash, [source]);
      } else {
        // Special assets (such as asset-transparent-pixel) or un-rasterized layers (text/color)
        // Skip this layer instead of throwing error; this layer contributes transparent pixels in merged result
        console.warn(`[Worker] Asset ${layer.hash} not available for clipping, skipping layer`);
        continue;
      }
    }

    const source = workerCache.getBitmaps(layer.hash)![0];

    const dummyLayer: Partial<Layer> = {
      type: 'image',
      bounding: { w: layer.boundingRect.w, h: layer.boundingRect.h },
      visibleShape: layer.visibleShape,
      opacity: layer.opacity ?? 1,
      adjustments: layer.adjustments,
      vectorMasks: layer.vectorMasks,
      bitmapMasks: layer.bitmapMasks
    };

    const clipSequence = layer.vectorMasks?.map(m => ({
      shape: m.shape,
      inverted: m.inverted,
      __compiledPath2D: shapeToPath2D(shrinkInvertedMask(m.shape, m.inverted))
    })) as ClipDescriptor[];

    // Scale layer matrix components by targetDpr
    const scaledMatrix = {
      a: layer.matrix.a * targetDpr,
      b: layer.matrix.b * targetDpr,
      c: layer.matrix.c * targetDpr,
      d: layer.matrix.d * targetDpr,
      tx: layer.matrix.tx * targetDpr,
      ty: layer.matrix.ty * targetDpr
    };

    // Check for active bitmapMask (erase mask)
    const hasBitmapMasks = layer.bitmapMasks && layer.bitmapMasks.some(m => m.enabled);
    if (hasBitmapMasks) {
      // Same processing as mergeLayersToLayer: draw to temporary canvas first, then apply mask
      const tempCanvas = new OffscreenCanvas(offscreen.width, offscreen.height);
      const tempCtx = tempCanvas.getContext('2d')!;

      EngineProvider.drawLayerInstance(tempCtx, dummyLayer as Layer, source, {
        matrix: scaledMatrix,
        width: layer.boundingRect.w,
        height: layer.boundingRect.h,
        clipSequence,
        dprScale: layer.dprScale
      });

      for (const bm of layer.bitmapMasks!.filter(m => m.enabled)) {
        const maskBitmaps = workerCache.getBitmaps(bm.assetId);
        let maskBitmap = maskBitmaps?.[0];
        if (!maskBitmap) {
          const blob = workerCache.blobCache.get(bm.assetId);
          if (blob) {
            maskBitmap = await createImageBitmap(blob);
            workerCache.touch(bm.assetId, [maskBitmap]);
          } else if (bm.src) {
            try {
              const res = await fetch(bm.src);
              const fetchedBlob = await res.blob();
              maskBitmap = await createImageBitmap(fetchedBlob);
              workerCache.touch(bm.assetId, [maskBitmap]);
            } catch (fetchErr) {
              console.warn(`[Worker] Failed to fetch bitmap mask from src ${bm.src}`, fetchErr);
            }
          }
        }

        if (maskBitmap) {
          tempCtx.save();
          tempCtx.setTransform(scaledMatrix.a, scaledMatrix.b, scaledMatrix.c, scaledMatrix.d, scaledMatrix.tx, scaledMatrix.ty);
          tempCtx.globalCompositeOperation = bm.inverted ? 'destination-out' : 'destination-in';
          tempCtx.drawImage(maskBitmap, bm.bounds.x, bm.bounds.y, bm.bounds.w, bm.bounds.h);
          tempCtx.restore();
        }
      }

      offCtx2d.drawImage(tempCanvas, 0, 0);
    } else {
      EngineProvider.drawLayerInstance(offCtx2d, dummyLayer as Layer, source, {
        matrix: scaledMatrix,
        width: layer.boundingRect.w,
        height: layer.boundingRect.h,
        clipSequence,
        dprScale: layer.dprScale
      });
    }
  }

  if (options?.format === 'raw') {
    const bitmap = offscreen.transferToImageBitmap();
    return { bitmap };
  }

  const blob = await PixelUtils.canvasToBlob(offscreen, options?.format, options?.quality);
  return PixelUtils.wrapResult(blob, targetDpr);
}
