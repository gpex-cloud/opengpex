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

import { WorkerBridge } from './dispatch/bridge/WorkerBridge';
import { getGpuEngine } from './pipeline/WebGpuEngine';
import { ImageDispatcher } from './dispatch/ImageDispatcher';
import { CompositeDispatcher } from './dispatch/CompositeDispatcher';
import type { CompositeRequest } from './dispatch/CompositeDispatcher';
import { ExportDispatcher } from './dispatch/ExportDispatcher';
import type { ExportRequest } from './dispatch/ExportDispatcher';
import { sourceBitmapCache } from './sources/SourceBitmapCache';
import { download } from './utils/pixel-utils';
import type { CompositedImage, SampledPixels } from './types';
import type {
  PixelService,
  GeometryService,
  AssetService,
  Layer,
  Frame,
  Shape,
  WorldShape,
  LocalShape,
  Rect,
  GamutId,
} from '@opengpex/editor/core/types';
import { asWorldShape } from '@opengpex/editor/core/types';
import type { ImageMetadata, EncodeSource, FileService } from '@opengpex/editor/core/files';

export interface PixelFacadeDeps {
  geometry: GeometryService;
  assets: AssetService;
  bridge: WorkerBridge;
  files: FileService;
}

/**
 * createPixelFacade — Factory function creating the unified PixelService.
 *
 * Target: < 100 lines of facade logic (the rest is type annotations).
 * All real work is delegated to specialized dispatchers.
 */
export function createPixelFacade(deps: PixelFacadeDeps): PixelService {
  const { geometry, assets, bridge, files } = deps;

  // ── Dispatcher instances ──
  const imageDispatcher = new ImageDispatcher(sourceBitmapCache, bridge, assets);
  // Internal composite runs on the main-thread GPU engine (no WorkerBridge).
  // `files` is injected directly so the dispatcher can call `files.recover` for
  // cold high-depth recovery — plain constructor DI, no post-construction setter.
  const compositeDispatcher = new CompositeDispatcher(geometry, assets, files);
  // Unified document export, symmetric to composite.
  const exportDispatcher = new ExportDispatcher(geometry, assets, files);
  // ICC colour conversion (and all other vips-backed file transcoding) now lives
  // in the files-layer shared lib-vips worker (`core/files/shared/lib-vips.ts`).
  // The engine Worker no longer loads wasm-vips at all (20260912 migration).

  // ── (removed in v2) FilterDispatcher + FilterCache DI ──
  //
  // v1 wired `filterCache.initialize({ keyFn, normalizerFn, dispatchFn })` here
  // so a cache miss would fire a FILTER job at the Worker and notify subscribers
  // when the bitmap came back. The entire chain — FilterDispatcher →
  // WorkerBridge → FilterHandler → Canvas2dFilterBackend → filter2d — has been
  // deleted. Adjustments are shader state in v2: no descriptor
  // normalization, no cache key, no round-trip.

  // ── Wire AssetService lifecycle → Rendering cache warming/eviction ──
  //
  // AssetService handles registration + IDB persistence + pool lifecycle.
  // It knows nothing about rendering caches. These callbacks bridge the gap:
  //
  // onRegistered: Pre-warm BOTH rendering caches so the asset renders immediately
  //   without a flash/decode delay on first frame:
  //   1. Worker-side: ensureAsset → ENSURE_ASSET job → workerCache.ingest (bitmapCache + blobCache)
  //   2. Main-thread: sourceBitmapCache.warmFromBlob → decode blob → ImageBitmap cache
  //
  // onReleased: Evict from Worker cache when AssetService revokes the asset (GC).
  //
  // Note: source assets (noCache) never trigger onRegistered — they are stored
  // in IDB for lossless re-export only, never displayed or rendered.
  assets.setCallbacks({
    onRegistered: (assetId, blob) => {
      imageDispatcher.ensureAsset(assetId, blob).catch(() => { /* non-fatal */ });
      const url = assets.getURL(assetId);
      if (url) {
        sourceBitmapCache.warmFromBlob(url, blob).catch(() => { /* non-fatal */ });
      }
    },
    onReleased: (assetId) => {
      imageDispatcher.evict(assetId).catch(() => { /* non-fatal */ });
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
        return imageDispatcher.loadBitmap(src);
      },
      /** Pre-warm cache from a Blob (no Worker round-trip). Use after bake/composite. */
      async cacheBitmap(src: string, blob: Blob): Promise<void> {
        await sourceBitmapCache.warmFromBlob(src, blob);
      },
      /** Sync probe: returns cached bitmap or undefined (fires background decode on miss). */
      ensureBitmap(src: string): ImageBitmap | undefined {
        return imageDispatcher.ensureBitmap(src);
      },
      /** Extract raw RGBA ImageData via Worker (zero main-thread blocking). */
      async imageData(src: string, rect?: Rect): Promise<ImageData> {
        return imageDispatcher.imageData(src, rect);
      },
      /** Compute full-resolution RGB composite histogram via Worker (zero main-thread blocking). */
      async histogram(assetId: string): Promise<Uint32Array> {
        return imageDispatcher.histogram(assetId);
      },
      /** Resample (resize) an image. Accepts targetSize, maxSize, or scale. */
      async resample(src: string, options: { targetSize?: { w: number; h: number }; maxSize?: number; scale?: number; sourceGamut?: GamutId }) {
        return imageDispatcher.resample(src, options);
      },
      /** Clear all bitmap caches. */
      clearCache() {
        sourceBitmapCache.clear();
      },
      /** Return a caller-owned clone suitable for postMessage transfer (GPU refcount, near-zero cost). */
      async acquireOwned(src: string): Promise<ImageBitmap | null> {
        return sourceBitmapCache.acquireOwned(src);
      },
      /** Write a pre-decoded ImageBitmap directly into the cache (skip blob→decode). */
      writeBitmap(src: string, bitmap: ImageBitmap): void {
        sourceBitmapCache.set(src, bitmap);
      },
    },

    // ════════════════════════════════════════════════════════════
    // 3. Render namespace (high-level composite APIs)
    // ════════════════════════════════════════════════════════════
    render: {
      async compositeFrame(frame: Frame, roi?: LocalShape): Promise<CompositedImage> {
        const layers = frame.layers.order
          .map(id => frame.layers.byId[id])
          .filter(l => !l.hostId && l.visible !== false && l.type !== 'group');

        const worldRoi: WorldShape = roi
          ? geometry.shape.localToWorldShape(roi, frame)
          : asWorldShape({ x: -frame.canvas.w / 2, y: -frame.canvas.h / 2, w: frame.canvas.w, h: frame.canvas.h });

        return compositeDispatcher.composite({ layers, roi: worldRoi, frame });
      },
      async compositeLayers(layers: Layer[], frame: Frame, roi?: Shape): Promise<CompositedImage> {
        const effectiveRoi = roi
          ? geometry.shape.localToWorldShape(roi, frame)
          : geometry.shape.unitedShapeOfLayers(layers);
        if (!effectiveRoi) throw new Error('Could not calculate bounding union');

        return compositeDispatcher.composite({ layers, roi: effectiveRoi, frame });
      },
      async compositeResizedLayers(layers: Layer[], frame: Frame, outputSize: { w: number; h: number }): Promise<CompositedImage> {
        const effectiveRoi = geometry.shape.unitedShapeOfLayers(layers);
        if (!effectiveRoi) throw new Error('Could not calculate bounding union');

        return compositeDispatcher.composite({ layers, roi: effectiveRoi, frame, outputSize });
      },
      registerEncoder(mimeType, encoder) {
        externalEncoders.set(mimeType, encoder);
        return () => { externalEncoders.delete(mimeType); };
      },
      /**
       * Pure-memory pixel capture — the WebGPU colour sampler /
       * mosaic hot path. Skips `canvasToBlob`/`blobToImageData` AND the terminal
       * encode: returns the raw premultiplied-linear readback for the caller to
       * decode per-sample via `sampleGpuRawData`.
       */
      capture: (
        frame: Frame,
        opts?: { roi?: WorldShape; layers?: Layer[]; scale?: number },
      ): Promise<SampledPixels> => {
        return compositeDispatcher.capture(frame, opts);
      },
      renderForExport: (request: ExportRequest): Promise<EncodeSource> => {
        return exportDispatcher.export(request);
      },
    },

    // ════════════════════════════════════════════════════════════
    // 5. Utils namespace
    // ════════════════════════════════════════════════════════════
    utils: {
      download,
    },

    // ════════════════════════════════════════════════════════════
    // 6. System namespace (read-only engine/device diagnostics)
    // ════════════════════════════════════════════════════════════
    system: {
      // GPU info service. Reads the resident
      // main-thread engine singleton synchronously — no cross-thread pipeline.
      // See `GpuInfo` for the WebGPU "no true VRAM total" contract.
      gpuInfo: () => getGpuEngine().getGpuInfo(),
    },

    // ════════════════════════════════════════════════════════════
    // 8. Unified composite pipeline entry point
    // ════════════════════════════════════════════════════════════
    composite: (request: CompositeRequest): Promise<CompositedImage> => {
      return compositeDispatcher.composite(request);
    },

  };

  return service;
}
