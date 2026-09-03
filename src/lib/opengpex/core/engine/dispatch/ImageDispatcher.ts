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
 * ImageDispatcher — unified dispatcher for the `image` namespace of PixelService.
 *
 * Consolidates the former DecodeDispatcher and ResampleDispatcher into a single
 * class that backs the entire `PixelService.image.*` surface:
 *   - loadBitmap / ensureBitmap / cacheBitmap (decode + cache)
 *   - imageData (pixel extraction)
 *   - resample (resize)
 *   - ensureAsset / evict (Worker cache lifecycle)
 *
 * Design:
 *   - Cache-first: returns from SourceBitmapCache on hit.
 *   - In-flight dedup: concurrent requests for the same src share one Worker job.
 *   - High-quality resample via Worker (bicubic interpolation).
 *
 * Architecture: facade → ImageDispatcher → WorkerBridge → Worker (DecoderHandler / ResampleHandler)
 */

import { sourceBitmapCache } from '../cache/SourceBitmapCache';
import { WorkerBridge } from './bridge/WorkerBridge';
import { ResampleResult } from '../results/ResampleResult';
import type { PixelResultData } from '../protocol/results';
import type { AssetService, Rect } from '@opengpex/editor/core/types';

/** Inferred type of the SourceBitmapCache singleton (class not exported — singleton pattern). */
type SourceBitmapCache = typeof sourceBitmapCache;

/** Shape returned by Worker for BITMAP subType */
interface DecodeBitmapResult {
  bitmap: ImageBitmap;
}

export interface ResampleOptions {
  /** Exact target dimensions. Ignored when maxSize or scale is provided. */
  targetSize?: { w: number; h: number };
  /** Scale longest edge to this value, maintaining aspect ratio. Takes priority over targetSize. */
  maxSize?: number;
  /**
   * Uniform scale factor applied to the source's TRUE pixel dimensions.
   * The source size is resolved in-dispatcher (cache hit = zero cost, else a
   * decode round-trip), so callers never need to know src dimensions up front.
   * Takes priority over targetSize (but maxSize wins if both are set).
   */
  scale?: number;
}

export class ImageDispatcher {
  private inflight = new Map<string, Promise<ImageBitmap>>();

  constructor(
    private cache: SourceBitmapCache,
    private bridge: WorkerBridge,
    private assets: AssetService,
  ) {}

  // ════════════════════════════════════════════════════════════
  // Decode / Cache operations
  // ════════════════════════════════════════════════════════════

  /**
   * Get the shared bitmap (cache-first + in-flight dedup).
   *
   * Dedup mechanism: multiple callers requesting the same src concurrently
   * will only trigger a single DECODE Job. Common scenario: multiple components
   * mounting simultaneously, Canvas2dEngine + merge both needing the same bitmap.
   */
  async loadBitmap(src: string): Promise<ImageBitmap> {
    // 1. Cache hit → return immediately
    const cached = this.cache.get(src);
    if (cached) return cached;

    // 2. In-flight dedup → reuse existing promise
    const existing = this.inflight.get(src);
    if (existing) return existing;

    // 3. Dispatch new DECODE job
    const promise = this.bridge
      .request<DecodeBitmapResult>({
        type: 'DECODE',
        subType: 'BITMAP',
        src,
      })
      .then((result) => {
        this.cache.set(src, result.bitmap);
        this.inflight.delete(src);
        return result.bitmap;
      })
      .catch((err: unknown) => {
        this.inflight.delete(src);
        throw err;
      });

    this.inflight.set(src, promise);
    return promise;
  }

  /**
   * Get a caller-owned clone (suitable for transfer to another Worker).
   * Near-zero cost — GPU-side refcount, not a full re-decode.
   */
  async ownedBitmap(src: string): Promise<ImageBitmap> {
    const shared = await this.loadBitmap(src);
    return createImageBitmap(shared);
  }

  /**
   * Ensure an asset is available in the Worker cache.
   * Called by EditorContext when AssetService registers/hydrates an asset.
   */
  async ensureAsset(hash: string, blob: Blob): Promise<void> {
    await this.bridge.request<boolean>({
      type: 'ENSURE_ASSET',
      hash,
      blob,
    });
  }

  /**
   * Synchronous cache read + background fetch trigger.
   *
   * Returns the cached ImageBitmap if already decoded, otherwise kicks off
   * a background decode and returns undefined. Equivalent to the old
   * sourceBitmapCache.getOrFetch() but exposed through the Dispatcher layer.
   *
   * Use case: BrushOverlay mask initialization on gesture hot-path where
   * awaiting is not acceptable.
   */
  ensureBitmap(src: string): ImageBitmap | undefined {
    const cached = this.cache.get(src);
    if (cached) return cached;
    // Fire-and-forget: start decode in background, cache will be populated
    // when the promise resolves. The caller should fall back to `await loadBitmap(src)`.
    this.loadBitmap(src).catch(() => { /* silent — caller handles fallback */ });
    return undefined;
  }

  /**
   * Extract raw RGBA pixel data from the Worker (zero main-thread blocking).
   *
   * Internally ensures the asset is decoded in Worker cache, then dispatches
   * an EXTRACT_PIXELS job that performs OffscreenCanvas → getImageData in the
   * Worker thread and transfers the ArrayBuffer back (zero-copy).
   *
   * @param hash - Content hash (AssetService ID / WorkerCache key).
   *              Callers MUST pass `layer.assetId`, NOT `layer.src` (blob URL).
   * @param rect - Optional crop region. Omit for full image extraction.
   */
  async imageData(hash: string, rect?: Rect): Promise<ImageData> {
    // Ensure the Worker has this asset in its cache.
    // AssetService.onRegistered → ensureAsset warms WorkerCache on register,
    // but the bitmap may have been LRU-evicted during long sessions.
    // workerCache.ingest() is idempotent — immediate no-op on cache hit.
    const entry = this.assets.get(hash);
    if (entry) {
      await this.ensureAsset(hash, entry.blob);
    }

    const result = await this.bridge.request<{ data: ArrayBuffer; width: number; height: number }>({
      type: 'EXTRACT_PIXELS',
      src: hash,
      ...(rect && { rect }),
    });
    const uint8 = new Uint8ClampedArray(result.data);
    return new ImageData(uint8, result.width, result.height);
  }

  /**
   * Compute a full-resolution RGB composite histogram via the Worker thread.
   *
   * Returns a 256-bin Uint32Array (sum of per-channel R+G+B counts). The
   * computation runs entirely in the Worker (no main-thread pixel iteration,
   * no downsampling), producing results that match Photoshop's Levels dialog
   * "RGB" channel histogram.
   *
   * @param hash - Content hash (AssetService ID / WorkerCache key).
   */
  async histogram(hash: string): Promise<Uint32Array> {
    // Ensure the Worker has this asset in its cache.
    const entry = this.assets.get(hash);
    if (entry) {
      await this.ensureAsset(hash, entry.blob);
    }

    const result = await this.bridge.request<{ histogram: ArrayBuffer }>({
      type: 'HISTOGRAM',
      src: hash,
    });
    return new Uint32Array(result.histogram);
  }

  /**
   * Evict an asset from the Worker cache.
   * Called by EditorContext when AssetService releases/revokes an asset.
   */
  async evict(hash: string): Promise<void> {
    await this.bridge.request<boolean>({
      type: 'FORGET',
      hash,
    });
  }

  // ════════════════════════════════════════════════════════════
  // Resample operations
  // ════════════════════════════════════════════════════════════

  /**
   * Resample a source image to the specified target dimensions.
   *
   * Accepts either `targetSize` (exact) or `maxSize` (scale longest edge, maintain ratio)
   * or `scale` (uniform factor on the source's true pixel dimensions).
   * When `maxSize` / `scale` is provided, source dimensions are resolved from SourceBitmapCache
   * (cache hit = zero cost) or via loadBitmap (triggers Worker decode on miss).
   *
   * Uses high-quality bicubic interpolation in the Worker.
   * Returns a ResampleResult which can be consumed via `.toAsset()` or `.toBlob()`.
   */
  async resample(src: string, options: ResampleOptions | { w: number; h: number }): Promise<ResampleResult> {
    let target: { w: number; h: number };

    // Legacy overload: plain { w, h } object
    if ('w' in options && 'h' in options) {
      target = options as { w: number; h: number };
    } else {
      const opts = options as ResampleOptions;
      if (opts.maxSize != null) {
        // Resolve maxSize → targetSize from source bitmap dimensions
        const bmp = this.resolveSourceDimensions(src);
        const bitmap = bmp ?? await this.loadSourceDimensions(src);
        const ratio = bitmap.width / bitmap.height;
        const ms = opts.maxSize;
        target = ratio > 1
          ? { w: Math.round(ms), h: Math.round(ms / ratio) }
          : { w: Math.round(ms * ratio), h: Math.round(ms) };
      } else if (opts.scale != null) {
        // Resolve scale → targetSize from the source's TRUE pixel dimensions.
        // Zero-cost on cache hit; decode round-trip otherwise. This is what lets
        // the resample pipeline scale a shared full-image src correctly (resize
        // spec §4.1 route X) instead of squashing it into the selection window.
        const bmp = this.resolveSourceDimensions(src);
        const bitmap = bmp ?? await this.loadSourceDimensions(src);
        target = {
          w: Math.max(1, Math.round(bitmap.width * opts.scale)),
          h: Math.max(1, Math.round(bitmap.height * opts.scale)),
        };
      } else if (opts.targetSize) {
        target = opts.targetSize;
      } else {
        throw new Error('[ImageDispatcher] resample requires either targetSize, maxSize, or scale');
      }
    }

    const data = await this.bridge.request<PixelResultData>({
      type: 'RESAMPLE',
      src,
      targetWidth: target.w,
      targetHeight: target.h,
    });

    return new ResampleResult(data, this.assets);
  }

  // ── Private helpers ──

  /** Sync probe: returns cached bitmap or null (zero cost). */
  private resolveSourceDimensions(src: string): ImageBitmap | null {
    return sourceBitmapCache.get(src) ?? null;
  }

  /** Async fallback: triggers decode if not in cache. */
  private async loadSourceDimensions(src: string): Promise<ImageBitmap> {
    return this.loadBitmap(src);
  }
}
