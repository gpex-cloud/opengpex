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

import { workerBridge } from '@opengpex/editor/core/engine/worker/WorkerBridge';
import type { FilterDescriptor } from '@opengpex/editor/core/engine/protocol/IFilter';
import type { Layer } from '@opengpex/editor/core/types';
import {
  computeFilterCacheKey,
  normalizeFilterDescriptors,
} from '@opengpex/editor/core/engine/filters/normalizeDescriptors';

/**
 * AsyncFilterCache — main-thread cache of filtered layer bitmaps
 * (spec §5.2, §5.5).
 *
 * Ownership contract mirrors `TileCache`:
 *   - Lookup is synchronous (`get`) — Painter never blocks a frame.
 *   - Misses schedule an async `APPLY_FILTER` job on the engine worker.
 *   - Subscribers are notified when new results land so the render loop
 *     re-runs and picks up the fresh bitmap on the next frame.
 *   - LRU eviction disposes stale `ImageBitmap`s to bound memory.
 *
 * The cache key is produced by `computeFilterCacheKey` — the ONLY entry
 * point that touches Layer state and the ONLY authority for equality of
 * two "filter recipes". No caller should invent its own key.
 *
 * Split from TileCache because:
 *   - Values are per-layer (not per-tile), so LRU capacity is tighter.
 *   - `assetId` changes must not evict tiles, only filter entries.
 *   - Sources come from the caller (already-decoded ImageBitmap of the
 *     layer's source) — the cache does not know how to fetch them.
 */
class AsyncFilterCache {
  private static instance: AsyncFilterCache;

  /** Keyed by `computeFilterCacheKey(layer)`. */
  private cache: Map<string, ImageBitmap> = new Map();
  /** In-flight worker jobs — dedupes concurrent requests for the same key. */
  private pending: Set<string> = new Set();
  /** LRU tracking. */
  private usageOrder: string[] = [];
  /** Redraw subscribers (Painter, WebGL upgrader, snapshot exporter, …). */
  private listeners: Set<() => void> = new Set();
  /**
   * Most-recent cache key per assetId, used to serve a "stale but
   * plausible" bitmap while the actual worker job for a newer recipe is
   * still in flight. This eliminates the "flash the original raw image
   * for one frame every time the slider moves" flicker (spec §5.2 UX):
   * dragging a slider from X → Y produces a barrage of cache MISSES,
   * one per tick, and without this fallback each miss frame paints the
   * raw un-filtered source. With the fallback, we paint the previous
   * successful filter result until the new one lands — visually the
   * user sees "old filtered → new filtered" instead of "raw → filtered".
   */
  private lastKeyByAsset: Map<string, string> = new Map();


  /**
   * Filtered layer bitmaps are large (a full 4K RGBA is ~64 MB) so we
   * keep this cap intentionally small. UI wiring can `clearLayer(id)`
   * when a layer is deleted to release memory earlier.
   */
  private readonly MAX_ENTRIES = 32;

  private constructor() {}

  static getInstance(): AsyncFilterCache {
    if (!AsyncFilterCache.instance) {
      AsyncFilterCache.instance = new AsyncFilterCache();
    }
    return AsyncFilterCache.instance;
  }

  // ────────────────────────────────────────────────────────────
  // Subscription (mirrors TileCache)
  // ────────────────────────────────────────────────────────────

  public subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  private notify(): void {
    this.listeners.forEach((cb) => cb());
  }

  // ────────────────────────────────────────────────────────────
  // Read/write API used by painter.ts
  // ────────────────────────────────────────────────────────────

  /**
   * Look up a filtered bitmap for `layer`. Returns synchronously:
   *
   *   - a cached `ImageBitmap` if we already computed this recipe, OR
   *   - `null` if the entry is missing or in-flight.
   *
   * When the entry is missing, we DO NOT trigger the worker job here —
   * because that would require the source bitmap the cache does not own.
   * Painter is the source-of-truth for source bitmaps, so it calls
   * `schedule(layer, source)` explicitly when it hits a null.
   */
  public get(layer: Pick<Layer, 'assetId' | 'adjustments' | 'curves' | 'levels' | 'channelMix'>): ImageBitmap | null {
    // Fast path: no filters active → caller should skip us entirely.
    // We still return null so painter.ts falls back to its legacy path.
    const filters = normalizeFilterDescriptors(layer);
    if (filters.length === 0) return null;

    const key = computeFilterCacheKey(layer);
    const hit = this.cache.get(key);
    if (hit) {
      this.touch(key);
      return hit;
    }
    return null;
  }

  /**
   * "Stale-while-revalidate" lookup: return the most recent filtered
   * bitmap known for this layer's `assetId`, regardless of whether the
   * recipe matches the current layer state. Painter uses this on cache
   * MISS to avoid flashing the raw source for the frames between the
   * miss and the worker's response. Returns `null` when we've never
   * successfully filtered this asset yet — in that case the caller
   * legitimately has to paint the raw source (one-time flash).
   */
  public getStale(
    layer: Pick<Layer, 'assetId' | 'adjustments' | 'curves' | 'levels' | 'channelMix'>,
  ): ImageBitmap | null {
    if (!layer.assetId) return null;
    // Only serve stale results when the caller is actually asking for a
    // non-identity filter. If the layer has NO active filters we must
    // return null so painter falls back to the raw source (else we'd
    // "stick" the last filtered bitmap forever after a Reset).
    if (normalizeFilterDescriptors(layer).length === 0) return null;
    const lastKey = this.lastKeyByAsset.get(layer.assetId);
    if (!lastKey) return null;
    const bmp = this.cache.get(lastKey);
    if (!bmp) return null;
    this.touch(lastKey);
    return bmp;
  }

  /**
   * Schedule an async filter job. Returns `true` when the job was
   * enqueued (or was already pending), `false` when it was a duplicate
   * request for an already-cached entry.
   *
   * `source` MUST be an `ImageBitmap` — after the SourceBitmapCache
   * refactor (docs/opengpex/plans/20260710_source_bitmap_cache_refactor_plan.md)
   * every main-thread pixel source is an ImageBitmap. We clone it
   * internally via `createImageBitmap` (browser-native, near-zero cost
   * — it's really a GPU-side refcount, NOT a re-decode) before
   * transferring the clone to the worker, so `source` stays valid for
   * the caller's fallback render path.
   */

  public schedule(
    layer: Pick<Layer, 'assetId' | 'adjustments' | 'curves' | 'levels' | 'channelMix'>,
    source: ImageBitmap,
  ): boolean {
    const filters = normalizeFilterDescriptors(layer);
    if (filters.length === 0) return false;

    const key = computeFilterCacheKey(layer);
    if (this.cache.has(key)) return false;
    if (this.pending.has(key)) return true;

    this.pending.add(key);
    this.dispatch(key, source, filters);
    return true;
  }

  /**
   * Force a specific entry to be evicted (e.g. layer deleted, source
   * asset swapped). Silently no-op if nothing is cached under `key`.
   */
  public forget(key: string): void {
    const bmp = this.cache.get(key);
    if (bmp) {
      bmp.close();
      this.cache.delete(key);
      this.usageOrder = this.usageOrder.filter((k) => k !== key);
      // Sweep any lastKeyByAsset pointer that pointed at this key so
      // `getStale()` doesn't return a hollow reference.
      for (const [asset, lastKey] of this.lastKeyByAsset) {
        if (lastKey === key) this.lastKeyByAsset.delete(asset);
      }
    }
  }

  /**
   * Evict every entry tied to `assetId`. Called when the layer's source
   * asset is replaced or the layer is deleted.
   */
  public clearAsset(assetId: string): void {
    // Cache keys are stable-stringified JSON containing `"assetId":"…"`.
    const needle = `"assetId":${JSON.stringify(assetId)}`;
    for (const key of Array.from(this.cache.keys())) {
      if (key.includes(needle)) this.forget(key);
    }
    this.lastKeyByAsset.delete(assetId);
  }

  /** Wipe every cached bitmap (session teardown / hot-reload). */
  public clear(): void {
    for (const bmp of this.cache.values()) bmp.close();
    this.cache.clear();
    this.pending.clear();
    this.usageOrder = [];
    this.lastKeyByAsset.clear();
  }

  // ────────────────────────────────────────────────────────────
  // Introspection helpers (mostly for tests & diagnostics)
  // ────────────────────────────────────────────────────────────

  public size(): number {
    return this.cache.size;
  }

  public isPending(
    layer: Pick<Layer, 'assetId' | 'adjustments' | 'curves' | 'levels' | 'channelMix'>,
  ): boolean {
    return this.pending.has(computeFilterCacheKey(layer));
  }

  // ────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────

  private dispatch(key: string, source: ImageBitmap, filters: FilterDescriptor[]): void {
    // Clone the source before transferring to the worker: the transfer
    // would neuter the caller's bitmap and painter's fallback render
    // path still needs it for the "loading — degraded overlay" phase
    // (filter_pipeline_spec §5.1). `createImageBitmap(bmp)` on an
    // existing ImageBitmap is a GPU-side refcount (near-zero cost),
    // NOT a full re-decode. This is the same primitive used by
    // `sourceBitmapCache.acquireOwned()` — see
    // docs/opengpex/plans/20260710_source_bitmap_cache_refactor_plan.md §4.
    //
    // NOTE (Step 3 retrospective): the previous `workerBridge.applyFilter`
    // convenience wrapper was removed to keep WorkerBridge minimal. We now
    // talk the generic RPC (`APPLY_FILTER`) directly with explicit
    // Transferable list, which is exactly what applyFilter used to do.
    createImageBitmap(source)
      .then((owned) =>
        workerBridge.request<{ bitmap: ImageBitmap; key?: string }>(
          'APPLY_FILTER',
          { source: owned, filters, key },
          [owned],
        ),
      )
      .then((res) => {
        this.pending.delete(key);
        this.store(key, res.bitmap);
      })
      .catch((err) => {
        this.pending.delete(key);
        console.error('[AsyncFilterCache] APPLY_FILTER failed:', err);
      });
  }


  private store(key: string, bitmap: ImageBitmap): void {
    // Evict LRU if we would overflow — closing the bitmap releases the
    // underlying GPU/GC-tracked memory promptly.
    if (this.cache.size >= this.MAX_ENTRIES) {
      const oldestKey = this.usageOrder.shift();
      if (oldestKey) {
        this.cache.get(oldestKey)?.close();
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, bitmap);
    this.usageOrder.push(key);
    // Update the "most recent successful recipe" pointer for this asset
    // so `getStale()` can serve as a bridge across in-flight filter jobs.
    // Keys are stable-stringified JSON: pull the assetId literal out
    // without paying for a full JSON.parse.
    const m = /"assetId":("[^"]*"|null)/.exec(key);
    if (m) {
      try {
        const parsed = JSON.parse(m[1]);
        if (typeof parsed === 'string') this.lastKeyByAsset.set(parsed, key);
      } catch {
        /* ignore malformed key */
      }
    }
    this.notify();
  }

  private touch(key: string): void {
    const idx = this.usageOrder.indexOf(key);
    if (idx > -1) this.usageOrder.splice(idx, 1);
    this.usageOrder.push(key);
  }
}

export const asyncFilterCache = AsyncFilterCache.getInstance();
