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
import {
  hasAdvancedFilters,
  normalizeFilterDescriptors,
} from '@opengpex/editor/core/engine/filters/normalizeDescriptors';
import { FilterFactory } from '@opengpex/editor/core/engine/FilterFactory';

/**
 * Bake curves / levels / channelMix into the source ImageBitmap **inline**
 * inside the export worker (filter_pipeline_spec §5.1b.4).
 *
 * Runtime rendering (Canvas2dEngine) uses `AsyncFilterCache` because it
 * needs to remain responsive on the main thread — cache miss → paint the
 * raw bitmap → next frame paints filtered. Exports have no such luxury:
 * they must produce a **filtered** blob synchronously in one shot. So we
 * skip the async cache and drive `Canvas2dFilter.apply` directly inside
 * the worker instead — no postMessage overhead, no cache eviction races,
 * no partial-first-frame artefacts.
 *
 * The helper is intentionally a no-op when `hasAdvancedFilters` is false:
 * the vast majority of exports have no advanced grading, so we pay zero
 * cost on that path. When it fires, it returns:
 *   - `bitmap`: a newly-owned ImageBitmap the caller must dispose after
 *     draw. Passed to EngineProvider **instead** of the shared cache
 *     bitmap so we don't corrupt the worker's LRU.
 *   - `strippedLayer`: a shallow clone of the LayerItemForWorker payload
 *     with curves/levels/channelMix zeroed out. This is what we pass to
 *     `EngineProvider.drawLayerInstance` — the effect is already baked
 *     into the bitmap, and painter's `ctx.filter` fast path must not
 *     re-apply anything downstream (see spec §5.1b.4).
 *
 * NOTE: `adjustments` is intentionally kept on `strippedLayer`. Basic
 * adjustments (brightness/contrast/saturation/hueRotate/blur) are painted
 * via `ctx.filter` inside painter.ts — that path is deliberately kept
 * hot in the merger for backwards compatibility with the pre-Step-5
 * baseline. Curves/Levels/ChannelMix go through this pixel-loop instead.
 */
let _cachedFilter: Awaited<ReturnType<typeof FilterFactory.create>> | null = null;
async function getFilterRuntime() {
  if (!_cachedFilter) _cachedFilter = await FilterFactory.create('canvas2d');
  return _cachedFilter;
}

async function bakeAdvancedFilters(
  layerItem: LayerItemForWorker,
  source: ImageBitmap,
): Promise<{ bitmap: ImageBitmap; strippedLayer: LayerItemForWorker; owned: true } | null> {
  if (!hasAdvancedFilters(layerItem)) return null;
  const filter = await getFilterRuntime();
  const descriptors = normalizeFilterDescriptors(layerItem);
  if (descriptors.length === 0) return null;
  const filtered = await filter.apply(source, descriptors);
  // Canvas2dFilter's 8-bit path always returns an ImageBitmap; type-guard
  // for the 16-bit union (which this worker never emits) so TS is happy.
  if (!(filtered instanceof ImageBitmap)) return null;
  const strippedLayer: LayerItemForWorker = {
    ...layerItem,
    curves: undefined,
    levels: undefined,
    channelMix: undefined,
  };
  return { bitmap: filtered, strippedLayer, owned: true };
}

export async function mergeLayersToLayer(
  canvasDim: { w: number, h: number },
  layers: LayerItemForWorker[],
  options?: { targetDpr?: number }
): Promise<WorkerResult> {
  const targetDpr = options?.targetDpr || 1;
  const offscreen = new OffscreenCanvas(Math.ceil(canvasDim.w * targetDpr), Math.ceil(canvasDim.h * targetDpr));
  const offCtx2d = offscreen.getContext('2d')!;

  for (const layer of layers) {
    // Phase 3: color layers render via fillRect — no bitmap needed.
    // Skip the bitmap lookup entirely and go straight to drawing.
    if (layer.type === 'color') {
      const effLayer = layer;
      const dummyLayer: Partial<Layer> = {
        type: 'color',
        bounding: { w: effLayer.boundingRect.w, h: effLayer.boundingRect.h },
        visibleShape: effLayer.visibleShape,
        opacity: effLayer.opacity ?? 1,
        blendMode: effLayer.blendMode,
        fill: effLayer.fill,
        adjustments: effLayer.adjustments,
        metadata: effLayer.metadata,
      };
      const scaledMatrix = {
        a: effLayer.matrix.a * targetDpr,
        b: effLayer.matrix.b * targetDpr,
        c: effLayer.matrix.c * targetDpr,
        d: effLayer.matrix.d * targetDpr,
        tx: effLayer.matrix.tx * targetDpr,
        ty: effLayer.matrix.ty * targetDpr
      };
      EngineProvider.drawLayerInstance(offCtx2d, dummyLayer as Layer, null, {
        matrix: scaledMatrix,
        width: effLayer.boundingRect.w,
        height: effLayer.boundingRect.h,
        dprScale: effLayer.dprScale
      });
      continue;
    }

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

    // [Filter §5.1b.4] Bake curves/levels/channelMix into an owned bitmap
    // inside the worker BEFORE building `dummyLayer`. The stripped layer
    // has those three fields cleared so downstream paint code cannot
    // apply them twice.
    const bakedRuntime = await bakeAdvancedFilters(
      layer, workerCache.getBitmaps(layer.hash)![0],
    );
    const source = bakedRuntime?.bitmap ?? workerCache.getBitmaps(layer.hash)![0];
    const effLayer = bakedRuntime?.strippedLayer ?? layer;

    const dummyLayer: Partial<Layer> = {
      type: effLayer.type || 'image',
      bounding: { w: effLayer.boundingRect.w, h: effLayer.boundingRect.h },
      visibleShape: effLayer.visibleShape,
      opacity: effLayer.opacity ?? 1,
      blendMode: effLayer.blendMode,
      fill: effLayer.fill,
      adjustments: effLayer.adjustments,
      vectorMasks: effLayer.vectorMasks,
      bitmapMasks: effLayer.bitmapMasks
    };

    const clipSequence = effLayer.vectorMasks?.map(m => ({
      shape: m.shape,
      inverted: m.inverted,
      feather: m.feather || 0,
      __compiledPath2D: shapeToPath2D(shrinkInvertedMask(m.shape, m.inverted))
    })) as ClipDescriptor[];

    // Scale layer matrix components by targetDpr
    const scaledMatrix = {
      a: effLayer.matrix.a * targetDpr,
      b: effLayer.matrix.b * targetDpr,
      c: effLayer.matrix.c * targetDpr,
      d: effLayer.matrix.d * targetDpr,
      tx: effLayer.matrix.tx * targetDpr,
      ty: effLayer.matrix.ty * targetDpr
    };

    const hasBitmapMasks = effLayer.bitmapMasks && effLayer.bitmapMasks.some(m => m.enabled);
    if (hasBitmapMasks) {
      const tempCanvas = new OffscreenCanvas(offscreen.width, offscreen.height);
      const tempCtx = tempCanvas.getContext('2d')!;

      EngineProvider.drawLayerInstance(tempCtx, dummyLayer as Layer, source, {
        matrix: scaledMatrix,
        width: effLayer.boundingRect.w,
        height: effLayer.boundingRect.h,
        clipSequence,
        dprScale: effLayer.dprScale
      });

      for (const bm of effLayer.bitmapMasks!.filter(m => m.enabled)) {
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
          // Apply feather (Gaussian blur) if specified on this bitmap mask
          if (bm.feather > 0) {
            const physicalRadius = bm.feather * scaledMatrix.a;
            tempCtx.filter = `blur(${physicalRadius}px)`;
          }
          tempCtx.globalCompositeOperation = bm.inverted ? 'destination-out' : 'destination-in';
          tempCtx.drawImage(maskBitmap, bm.bounds.x, bm.bounds.y, bm.bounds.w, bm.bounds.h);
          tempCtx.restore();
        }
      }

      offCtx2d.drawImage(tempCanvas, 0, 0);
    } else {
      EngineProvider.drawLayerInstance(offCtx2d, dummyLayer as Layer, source, {
        matrix: scaledMatrix,
        width: effLayer.boundingRect.w,
        height: effLayer.boundingRect.h,
        clipSequence, // Apply masks
        dprScale: effLayer.dprScale
      });
    }

    // Release the transiently-owned filtered bitmap now that all draws
    // referencing it have committed to the offscreen canvas. Skipping
    // this would leak one ImageBitmap per graded layer per export.
    if (bakedRuntime?.owned) bakedRuntime.bitmap.close();
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
  // Path-type shapes (polygon-derived, e.g. inverted selections with outer+inner rings)
  // require 'evenodd' fill rule to correctly produce holes. Simple shapes (rect/circle)
  // are single-path and work with either rule, so 'evenodd' is universally safe.
  offCtx2d.clip(path, shape.type === 'path' ? 'evenodd' : 'nonzero');
  offCtx2d.setTransform(1, 0, 0, 1, 0, 0);

  // 2. Stacked drawing
  for (const layer of layers) {
    // Phase 3: color layers render via fillRect — no bitmap needed.
    // Skip the bitmap lookup entirely and go straight to drawing.
    if (layer.type === 'color') {
      const effLayer = layer;
      const dummyLayer: Partial<Layer> = {
        type: 'color',
        bounding: { w: effLayer.boundingRect.w, h: effLayer.boundingRect.h },
        visibleShape: effLayer.visibleShape,
        opacity: effLayer.opacity ?? 1,
        blendMode: effLayer.blendMode,
        fill: effLayer.fill,
        adjustments: effLayer.adjustments,
        metadata: effLayer.metadata,
      };
      const scaledMatrix = {
        a: effLayer.matrix.a * targetDpr,
        b: effLayer.matrix.b * targetDpr,
        c: effLayer.matrix.c * targetDpr,
        d: effLayer.matrix.d * targetDpr,
        tx: effLayer.matrix.tx * targetDpr,
        ty: effLayer.matrix.ty * targetDpr
      };
      EngineProvider.drawLayerInstance(offCtx2d, dummyLayer as Layer, null, {
        matrix: scaledMatrix,
        width: effLayer.boundingRect.w,
        height: effLayer.boundingRect.h,
        dprScale: effLayer.dprScale
      });
      continue;
    }

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

    // [Filter §5.1b.4] Bake curves/levels/channelMix synchronously inside
    // the worker before the paint loop. Same rationale as
    // `mergeLayersToLayer` above — export must produce a filtered blob
    // in one shot; the runtime AsyncFilterCache is bypassed on purpose.
    const bakedRuntime = await bakeAdvancedFilters(
      layer, workerCache.getBitmaps(layer.hash)![0],
    );
    const source = bakedRuntime?.bitmap ?? workerCache.getBitmaps(layer.hash)![0];
    const effLayer = bakedRuntime?.strippedLayer ?? layer;

    const dummyLayer: Partial<Layer> = {
      type: effLayer.type || 'image',
      bounding: { w: effLayer.boundingRect.w, h: effLayer.boundingRect.h },
      visibleShape: effLayer.visibleShape,
      opacity: effLayer.opacity ?? 1,
      blendMode: effLayer.blendMode,
      fill: effLayer.fill,
      adjustments: effLayer.adjustments,
      vectorMasks: effLayer.vectorMasks,
      bitmapMasks: effLayer.bitmapMasks
    };

    const clipSequence = effLayer.vectorMasks?.map(m => ({
      shape: m.shape,
      inverted: m.inverted,
      feather: m.feather || 0,
      __compiledPath2D: shapeToPath2D(shrinkInvertedMask(m.shape, m.inverted))
    })) as ClipDescriptor[];

    // Scale layer matrix components by targetDpr
    const scaledMatrix = {
      a: effLayer.matrix.a * targetDpr,
      b: effLayer.matrix.b * targetDpr,
      c: effLayer.matrix.c * targetDpr,
      d: effLayer.matrix.d * targetDpr,
      tx: effLayer.matrix.tx * targetDpr,
      ty: effLayer.matrix.ty * targetDpr
    };

    // Check for active bitmapMask (erase mask)
    const hasBitmapMasks = effLayer.bitmapMasks && effLayer.bitmapMasks.some(m => m.enabled);
    if (hasBitmapMasks) {
      // Same processing as mergeLayersToLayer: draw to temporary canvas first, then apply mask
      const tempCanvas = new OffscreenCanvas(offscreen.width, offscreen.height);
      const tempCtx = tempCanvas.getContext('2d')!;

      EngineProvider.drawLayerInstance(tempCtx, dummyLayer as Layer, source, {
        matrix: scaledMatrix,
        width: effLayer.boundingRect.w,
        height: effLayer.boundingRect.h,
        clipSequence,
        dprScale: effLayer.dprScale
      });

      for (const bm of effLayer.bitmapMasks!.filter(m => m.enabled)) {
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
          // Apply feather (Gaussian blur) if specified on this bitmap mask
          if (bm.feather > 0) {
            const physicalRadius = bm.feather * scaledMatrix.a;
            tempCtx.filter = `blur(${physicalRadius}px)`;
          }
          tempCtx.globalCompositeOperation = bm.inverted ? 'destination-out' : 'destination-in';
          tempCtx.drawImage(maskBitmap, bm.bounds.x, bm.bounds.y, bm.bounds.w, bm.bounds.h);
          tempCtx.restore();
        }
      }

      offCtx2d.drawImage(tempCanvas, 0, 0);
    } else {
      EngineProvider.drawLayerInstance(offCtx2d, dummyLayer as Layer, source, {
        matrix: scaledMatrix,
        width: effLayer.boundingRect.w,
        height: effLayer.boundingRect.h,
        clipSequence,
        dprScale: effLayer.dprScale
      });
    }

    if (bakedRuntime?.owned) bakedRuntime.bitmap.close();
  }

  if (options?.format === 'raw') {
    const bitmap = offscreen.transferToImageBitmap();
    return { bitmap };
  }

  const blob = await PixelUtils.canvasToBlob(offscreen, options?.format, options?.quality);
  return PixelUtils.wrapResult(blob, targetDpr);
}
