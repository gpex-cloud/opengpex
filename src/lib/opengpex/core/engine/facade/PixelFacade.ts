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
 * PixelFacade — the SINGLE external entry point for all pixel operations.
 *
 * Replaces v1 `createPixelService` (549 lines, 8 namespaces) with a thin
 * (<100 line) facade that delegates to specialized dispatchers.
 *
 * Architecture: external callers → PixelFacade → Dispatchers → Worker
 *
 * Design principles (from architecture doc):
 *   1. Main thread zero heavy computation
 *   2. Pure data boundaries (serializable descriptors across threads)
 *   3. Backend autonomy (degradation transparent to callers)
 *   4. Isomorphic rendering (painter shared between Worker and main thread)
 *   5. Unidirectional dependency (facade → dispatch → worker, no cycles)
 */

import { WorkerBridge } from '../dispatch/bridge/WorkerBridge';
import { ImageDispatcher } from '../dispatch/ImageDispatcher';
import { CompositeDispatcher } from '../dispatch/CompositeDispatcher';
import type { CompositeRequest } from '../dispatch/CompositeDispatcher';
import { FilterDispatcher } from '../dispatch/FilterDispatcher';
import { RasterizeDispatcher } from '../dispatch/RasterizeDispatcher';
import { FileIoDispatcher } from '../dispatch/FileIoDispatcher';
import { sourceBitmapCache } from '../cache/SourceBitmapCache';
import { tileCache } from '../cache/TileCache';
import { filterCache } from '../cache/FilterCache';
import { fetchFromUrl, download } from '../utils/pixel-utils';
import { computeFilterCacheKey, normalizeFilterDescriptors } from '../protocol/normalizer';
import type { CompositeResult } from '../results/CompositeResult';
import type {
  PixelService,
  GeometryService,
  AssetService,
  Layer,
  Frame,
  Shape,
  WorldShape,
  LocalShape,
  LocalPolygon,
  LocalRect,
  Rect,
} from '@opengpex/editor/core/types';
import { asWorldShape } from '@opengpex/editor/core/types';
import type { ImageMetadata } from '@opengpex/editor/core/files';

export interface PixelFacadeDeps {
  geometry: GeometryService;
  assets: AssetService;
  bridge: WorkerBridge;
}

/**
 * createPixelFacade — Factory function creating the unified PixelService.
 *
 * Target: < 100 lines of facade logic (the rest is type annotations).
 * All real work is delegated to specialized dispatchers.
 */
export function createPixelFacade(deps: PixelFacadeDeps): PixelService {
  const { geometry, assets, bridge } = deps;

  // ── Dispatcher instances ──
  const image = new ImageDispatcher(sourceBitmapCache, bridge, assets);
  const composite = new CompositeDispatcher(bridge, geometry, assets);
  const filter = new FilterDispatcher(bridge);
  const rasterize = new RasterizeDispatcher(bridge, assets);
  const fileIo = new FileIoDispatcher(bridge);

  // ── Initialize FilterCache with DI (Phase 6.9) ──
  filterCache.initialize({
    keyFn: computeFilterCacheKey,
    normalizerFn: normalizeFilterDescriptors,
    dispatchFn: filter.createDispatchFn(),
  });

  // ── Initialize TileCache fetcher (decouples TileCache from WorkerBridge) ──
  tileCache.setFetcher((hash, level, x, y) =>
    bridge.request<ImageBitmap>({ type: 'GET_TILE', hash, level, x, y }),
  );

  // ── Wire AssetService lifecycle → Engine cache warming/eviction ──
  // Previously done in EditorContext useEffect; internalized here since
  // PixelFacade already receives `assets` as a dep (no extra coupling).
  assets.setCallbacks({
    onRegistered: (hash, blob) => {
      image.ensureAsset(hash, blob).catch(() => { /* non-fatal */ });
      const url = assets.getURL(hash);
      if (url) {
        sourceBitmapCache.warmFromBlob(url, blob).catch(() => { /* non-fatal */ });
      }
    },
    onReleased: (hash) => {
      image.evict(hash).catch(() => { /* non-fatal */ });
    },
  });

  // ── External encoders registry ──
  const externalEncoders = new Map<
    string,
    (bitmap: ImageBitmap, options: { quality?: number; metadata?: ImageMetadata }) => Promise<Blob>
  >();

  const service: PixelService = {
    // ════════════════════════════════════════════════════════════
    // 1. Image namespace (decode + analyze + cache)
    // ════════════════════════════════════════════════════════════
    image: {
      /** Async load + decode → guaranteed ImageBitmap (cache-first, in-flight dedup). */
      async loadBitmap(src: string): Promise<ImageBitmap> {
        return image.loadBitmap(src);
      },
      /** Pre-warm cache from a Blob (no Worker round-trip). Use after bake/composite. */
      async cacheBitmap(src: string, blob: Blob): Promise<void> {
        await sourceBitmapCache.warmFromBlob(src, blob);
      },
      /** Sync probe: returns cached bitmap or undefined (fires background decode on miss). */
      ensureBitmap(src: string): ImageBitmap | undefined {
        return image.ensureBitmap(src);
      },
      /** Calculate non-transparent content bounding box. */
      async contentBounds(src: string, assetId?: string): Promise<LocalRect> {
        if (assetId) {
          const meta = assets.get(assetId)?.tileMeta;
          if (meta?.contentBounds) return geometry.asLocalRect(meta.contentBounds);
        }
        const bmp = await image.loadBitmap(src);
        const { calculateContentBounds } = await import('../utils/pixel-utils');
        return calculateContentBounds(bmp);
      },
      /** Extract raw RGBA ImageData via Worker (zero main-thread blocking). */
      async imageData(src: string, rect?: Rect): Promise<ImageData> {
        return image.imageData(src, rect);
      },
      /** Compute full-resolution RGB composite histogram via Worker (zero main-thread blocking). */
      async histogram(assetId: string): Promise<Uint32Array> {
        return image.histogram(assetId);
      },
      /** Resample (resize) an image. Accepts targetSize or maxSize. */
      async resample(src: string, options: { targetSize?: { w: number; h: number }; maxSize?: number }) {
        return image.resample(src, options);
      },
      /** Clear all bitmap caches. */
      clearCache() {
        sourceBitmapCache.clear();
      },
    },

    // ════════════════════════════════════════════════════════════
    // 3. Render namespace (high-level composite APIs)
    // ════════════════════════════════════════════════════════════
    render: {
      async compositeFrame(frame: Frame, roi?: LocalShape, options?: { precision?: 8 | 16; dpr?: number }) {
        const layers = frame.layers.order
          .map(id => frame.layers.byId[id])
          .filter(l => l.visible);

        const worldRoi: WorldShape = roi
          ? geometry.shape.localToWorldShape(roi, frame)
          : asWorldShape({ x: -frame.canvas.w / 2, y: -frame.canvas.h / 2, w: frame.canvas.w, h: frame.canvas.h });

        return composite.composite({
          layers,
          roi: worldRoi,
          precision: options?.precision ?? 8,
          dpr: options?.dpr ?? 1,
          compositeTRC: frame.trc,
          compositeColorSpace: frame.colorSpace,
        });
      },
      async compositeLayers(layers: Layer[], frame: Frame, roi?: Shape) {
        const effectiveRoi = roi
          ? geometry.shape.localToWorldShape(roi, frame)
          : geometry.shape.unitedShapeOfLayers(layers);
        if (!effectiveRoi) throw new Error('Could not calculate bounding union');

        const roiW = effectiveRoi.rect.w;
        const roiH = effectiveRoi.rect.h;
        const { x: roiCx, y: roiCy } = geometry.space.getRectCenter(effectiveRoi.rect);

        const result = await composite.composite({
          layers,
          roi: effectiveRoi,
          precision: (frame.bitDepth as 8 | 16 | 32) ?? 8,
          dpr: 1,
          compositeTRC: frame.trc,
          compositeColorSpace: frame.colorSpace,
        });

        return {
          result: result as CompositeResult,
          bounds: { w: roiW, h: roiH, cx: roiCx, cy: roiCy },
        };
      },
      async compositeResizedLayers(layers: Layer[], frame: Frame, outputSize: { w: number; h: number }) {
        const effectiveRoi = geometry.shape.unitedShapeOfLayers(layers);
        if (!effectiveRoi) throw new Error('Could not calculate bounding union');

        const result = await composite.composite({
          layers,
          roi: effectiveRoi,
          precision: (frame.bitDepth as 8 | 16 | 32) ?? 8,
          dpr: 1,
          outputSize,
          compositeTRC: frame.trc,
          compositeColorSpace: frame.colorSpace,
        });

        return { result: result as CompositeResult };
      },
      registerEncoder(mimeType, encoder) {
        externalEncoders.set(mimeType, encoder);
        return () => { externalEncoders.delete(mimeType); };
      },
    },

    // ════════════════════════════════════════════════════════════
    // 4. Rasterize namespace
    // ════════════════════════════════════════════════════════════
    rasterize: {
      async layer(layer: Layer, opts?: { dpr?: number }) {
        const result = await rasterize.layer(layer, opts);
        const { id, url } = await result.toAsset();
        return { id, url };
      },
      async mask(polygon: LocalPolygon, bounds: { w: number; h: number }, feather = 0) {
        const result = await rasterize.mask(polygon, bounds, feather);
        if (!result) return null;
        const { id, url } = await result.toAsset();
        return { id, url };
      },
    },

    // ════════════════════════════════════════════════════════════
    // 5. Utils namespace
    // ════════════════════════════════════════════════════════════
    utils: {
      fetchFromUrl,
      download,
    },

    // ════════════════════════════════════════════════════════════
    // 7. File I/O namespace (Phase 7.2 — vips unification)
    // ════════════════════════════════════════════════════════════
    fileIO: {
      decodeTiff: (bytes: Uint8Array, options?: { preserveColorSpace?: boolean }) => fileIo.decodeTiff(bytes, options),
      encodeTiff: (rgbaData: Uint8Array, w: number, h: number, opts: Record<string, unknown>) =>
        fileIo.encodeTiff(rgbaData, w, h, opts),
      getPageCount: (bytes: Uint8Array) => fileIo.getPageCount(bytes),
      decodePage: (bytes: Uint8Array, page: number) => fileIo.decodePage(bytes, page),
      composite16bit: (params) => fileIo.composite16bit(params),
      exportHighRes: (rawBytes: Uint8Array, opts: Record<string, unknown>) =>
        fileIo.exportHighRes(rawBytes, opts),
      iccToSrgb: (bytes: Uint8Array) => fileIo.iccToSrgb(bytes),
      srgbToIcc: (rgbaData: Uint8Array, w: number, h: number, iccProfileData: Uint8Array) =>
        fileIo.srgbToIcc(rgbaData, w, h, iccProfileData),
      encodeAvif: (rgbaData: Uint8Array, w: number, h: number, options: { quality?: number; lossless?: boolean; effort?: number; iccProfileBytes?: Uint8Array; bitDepth?: number }) =>
        fileIo.encodeAvif(rgbaData, w, h, options),
    },

    // ════════════════════════════════════════════════════════════
    // 8. Unified composite pipeline entry point
    // ════════════════════════════════════════════════════════════
    composite: (request: CompositeRequest): Promise<CompositeResult> => {
      return composite.composite(request) as Promise<CompositeResult>;
    },

  };

  return service;
}
