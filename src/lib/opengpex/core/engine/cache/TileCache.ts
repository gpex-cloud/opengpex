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
 * TileCache — Tiled bitmap cache for the Engine V2 rendering pipeline.
 *
 * Adapted from v1 TileCache with the following changes:
 * - Uses Engine V2's WorkerBridge (via injected fetcher) instead of v1 workerBridge global.
 * - Maintains the same reactive subscription model for zero-idle-CPU rendering.
 * - LRU eviction prevents memory overflow (MAX_TILES = 500).
 *
 * [Performance Optimization: Reactive Redraw]
 * The rendering engine subscribes to this cache. Only when a new tile completes
 * loading does it trigger a frame redraw, reducing CPU/GPU usage to 0 in static states.
 */

/** Tile fetch function — injected by the consumer (decouples from WorkerBridge). */
export type TileFetcher = (hash: string, level: number, x: number, y: number) => Promise<ImageBitmap>;

class TileCache {
  private static instance: TileCache;
  private cache: Map<string, ImageBitmap> = new Map();
  private pending: Set<string> = new Set();
  private listeners: Set<() => void> = new Set();
  private usageOrder: string[] = [];
  private retryCount: Map<string, number> = new Map();
  private readonly MAX_TILES = 500;

  /** Injected tile fetcher. Must be set before first `get()` call. */
  private fetcher: TileFetcher | null = null;

  private constructor() {}

  static getInstance(): TileCache {
    if (!TileCache.instance) {
      TileCache.instance = new TileCache();
    }
    return TileCache.instance;
  }

  /**
   * Inject the tile fetch function (called once during initialization).
   * Decouples TileCache from WorkerBridge to maintain single-directional dependency.
   */
  public setFetcher(fetcher: TileFetcher): void {
    this.fetcher = fetcher;
  }

  /**
   * Subscribe to cache changes (used to trigger UI redraws).
   */
  public subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  private notify(): void {
    this.listeners.forEach((cb) => cb());
  }

  /**
   * Gets tile. If absent, triggers asynchronous loading and returns undefined.
   */
  public get(hash: string, level: number, x: number, y: number): ImageBitmap | undefined {
    const key = `${hash}-${level}-${x}-${y}`;

    if (this.cache.has(key)) {
      this.updateUsage(key);
      return this.cache.get(key);
    }

    if (!this.pending.has(key)) {
      const count = this.retryCount.get(key) || 0;
      if (count >= 3) return undefined;

      if (!this.fetcher) {
        console.warn('[TileCache] No fetcher injected — cannot load tile');
        return undefined;
      }

      this.pending.add(key);
      this.fetcher(hash, level, x, y)
        .then((bitmap: ImageBitmap) => {
          this.addToCache(key, bitmap);
          this.pending.delete(key);
          this.retryCount.delete(key);
        })
        .catch(() => {
          this.pending.delete(key);
          this.retryCount.set(key, count + 1);
          setTimeout(() => this.notify(), 1000);
        });
    }

    return undefined;
  }

  private updateUsage(key: string): void {
    const index = this.usageOrder.indexOf(key);
    if (index > -1) {
      this.usageOrder.splice(index, 1);
    }
    this.usageOrder.push(key);
  }

  private addToCache(key: string, bitmap: ImageBitmap): void {
    if (this.cache.size >= this.MAX_TILES) {
      const oldestKey = this.usageOrder.shift();
      if (oldestKey) {
        const oldBitmap = this.cache.get(oldestKey);
        oldBitmap?.close();
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, bitmap);
    this.usageOrder.push(key);
    this.notify();
  }

  /**
   * Clears all cached tiles for a given asset hash.
   */
  public clearAsset(hash: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(hash)) {
        const bitmap = this.cache.get(key);
        bitmap?.close();
        this.cache.delete(key);
        this.usageOrder = this.usageOrder.filter((k) => k !== key);
      }
    }
  }

  /**
   * Wipe all cached tiles.
   */
  public clear(): void {
    for (const bitmap of this.cache.values()) {
      bitmap.close();
    }
    this.cache.clear();
    this.pending.clear();
    this.usageOrder = [];
    this.retryCount.clear();
  }
}

export const tileCache = TileCache.getInstance();
