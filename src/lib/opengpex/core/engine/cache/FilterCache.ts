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
 * FilterCache — main-thread cache of filtered layer bitmaps for Engine V2.
 *
 * Adapted from v1 `filters/FilterCache.ts` with the following changes:
 * - Decoupled from v1 workerBridge — dispatch is handled via injected callback.
 * - Import paths updated for engine layout.
 * - Maintains identical sync get/stale/schedule contract for painter consumption.
 *
 * Ownership contract:
 *   - Lookup is synchronous (get) — Painter never blocks a frame.
 *   - Misses schedule an async filter job via the injected dispatcher.
 *   - Subscribers are notified when new results land.
 *   - LRU eviction bounds memory usage.
 */

import type { FilterDescriptor } from '../protocol/IFilter';
import type { Layer } from '@opengpex/editor/core/types';

/** Minimal layer shape consumed by FilterCache — matches Layer's filter-relevant fields. */
export type FilterCacheLayer = Pick<Layer, 'assetId' | 'adjustments' | 'curves' | 'levels' | 'channelMix'>;

/** Key computation function — injected during initialization. */
export type FilterKeyFn = (layer: FilterCacheLayer) => string;

/** Filter dispatch function — injected during initialization. */
export type FilterDispatchFn = (
  key: string,
  source: ImageBitmap,
  filters: FilterDescriptor[],
) => Promise<ImageBitmap>;

/** Normalizer function to extract FilterDescriptor[] from a layer. */
export type FilterNormalizerFn = (layer: FilterCacheLayer) => FilterDescriptor[];

class FilterCache {
  private static instance: FilterCache;

  private cache: Map<string, ImageBitmap> = new Map();
  private pending: Set<string> = new Set();
  private usageOrder: string[] = [];
  private listeners: Set<() => void> = new Set();
  private lastKeyByAsset: Map<string, string> = new Map();
  private dragging = false;

  private readonly MAX_ENTRIES = 12;

  /** Injected functions — must be set before use. */
  private keyFn: FilterKeyFn | null = null;
  private normalizerFn: FilterNormalizerFn | null = null;
  private dispatchFn: FilterDispatchFn | null = null;

  private constructor() {}

  static getInstance(): FilterCache {
    if (!FilterCache.instance) {
      FilterCache.instance = new FilterCache();
    }
    return FilterCache.instance;
  }

  /**
   * Initialize with injected dependencies (called once during setup).
   */
  public initialize(deps: {
    keyFn: FilterKeyFn;
    normalizerFn: FilterNormalizerFn;
    dispatchFn: FilterDispatchFn;
  }): void {
    this.keyFn = deps.keyFn;
    this.normalizerFn = deps.normalizerFn;
    this.dispatchFn = deps.dispatchFn;
  }

  // ────────────────────────────────────────────────────────────
  // Subscription
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
  // Read API
  // ────────────────────────────────────────────────────────────

  /**
   * Sync lookup for a filtered bitmap. Returns null on miss.
   */
  public get(layer: FilterCacheLayer): ImageBitmap | null {
    if (!this.normalizerFn || !this.keyFn) return null;
    const filters = this.normalizerFn(layer);
    if (filters.length === 0) return null;

    const key = this.keyFn(layer);
    const hit = this.cache.get(key);
    if (hit) {
      this.touch(key);
      return hit;
    }
    return null;
  }

  /**
   * "Stale-while-revalidate" — return the most recent result for this asset,
   * regardless of whether the recipe matches. Avoids raw-source flash.
   */
  public getStale(layer: FilterCacheLayer): ImageBitmap | null {
    if (!this.normalizerFn || !layer.assetId) return null;
    if (this.normalizerFn(layer).length === 0) return null;
    const lastKey = this.lastKeyByAsset.get(layer.assetId);
    if (!lastKey) return null;
    const bmp = this.cache.get(lastKey);
    if (!bmp) return null;
    this.touch(lastKey);
    return bmp;
  }

  /**
   * Schedule an async filter job. Returns true when enqueued.
   */
  public schedule(layer: FilterCacheLayer, source: ImageBitmap): boolean {
    if (!this.normalizerFn || !this.keyFn || !this.dispatchFn) return false;
    const filters = this.normalizerFn(layer);
    if (filters.length === 0) return false;

    const key = this.keyFn(layer);
    if (this.cache.has(key)) return false;
    if (this.pending.has(key)) return true;

    this.pending.add(key);
    this.dispatch(key, source, filters);
    return true;
  }

  // ────────────────────────────────────────────────────────────
  // Drag coordination
  // ────────────────────────────────────────────────────────────

  public setDragging(value: boolean): void {
    if (this.dragging === value) return;
    this.dragging = value;
    if (!value) this.notify();
  }

  public isDragging(): boolean {
    return this.dragging;
  }

  // ────────────────────────────────────────────────────────────
  // Eviction
  // ────────────────────────────────────────────────────────────

  public forget(key: string): void {
    const bmp = this.cache.get(key);
    if (bmp) {
      bmp.close();
      this.cache.delete(key);
      this.usageOrder = this.usageOrder.filter((k) => k !== key);
      for (const [asset, lastKey] of this.lastKeyByAsset) {
        if (lastKey === key) this.lastKeyByAsset.delete(asset);
      }
    }
  }

  public clearAsset(assetId: string): void {
    const needle = `"assetId":${JSON.stringify(assetId)}`;
    for (const key of Array.from(this.cache.keys())) {
      if (key.includes(needle)) this.forget(key);
    }
    this.lastKeyByAsset.delete(assetId);
  }

  public clear(): void {
    for (const bmp of this.cache.values()) bmp.close();
    this.cache.clear();
    this.pending.clear();
    this.usageOrder = [];
    this.lastKeyByAsset.clear();
  }

  // ────────────────────────────────────────────────────────────
  // Introspection
  // ────────────────────────────────────────────────────────────

  public size(): number {
    return this.cache.size;
  }

  // ────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────

  private dispatch(key: string, source: ImageBitmap, filters: FilterDescriptor[]): void {
    if (!this.dispatchFn) return;

    createImageBitmap(source)
      .then((owned) => this.dispatchFn!(key, owned, filters))
      .then((bitmap) => {
        this.pending.delete(key);
        this.store(key, bitmap);
      })
      .catch((err) => {
        this.pending.delete(key);
        console.error('[FilterCache] dispatch failed:', err);
      });
  }

  private store(key: string, bitmap: ImageBitmap): void {
    if (this.cache.size >= this.MAX_ENTRIES) {
      const oldestKey = this.usageOrder.shift();
      if (oldestKey) {
        this.cache.get(oldestKey)?.close();
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, bitmap);
    this.usageOrder.push(key);

    // Track last successful key per asset for stale lookup
    const m = /"assetId":("[^"]*"|null)/.exec(key);
    if (m) {
      try {
        const parsed = JSON.parse(m[1]) as string | null;
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

export const filterCache = FilterCache.getInstance();
