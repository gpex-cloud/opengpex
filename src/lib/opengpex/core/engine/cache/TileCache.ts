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
 * - LRU eviction prevents memory overflow (MAX_TILES = 512).
 *
 * [Performance Optimization: Reactive Redraw]
 * The rendering engine subscribes to this cache. Only when a new tile completes
 * loading does it trigger a frame redraw, reducing CPU/GPU usage to 0 in static states.
 */

import { TILE_EMPTY, type TileEmpty } from '@opengpex/editor/core/helpers/tiling';

// ─── Diagnostic Logging (toggle via: window.__TILE_FLICKER_DEBUG = true) ───
function _tileDbg(): boolean {
  return typeof window !== 'undefined' && !!(window as unknown as Record<string, unknown>).__TILE_FLICKER_DEBUG;
}

/**
 * Tile fetch function — injected by the consumer (decouples from WorkerBridge).
 * Returns ImageBitmap for tiles with content, or null for fully-transparent (empty) tiles.
 */
export type TileFetcher = (hash: string, level: number, x: number, y: number) => Promise<ImageBitmap | null>;

class TileCache {
  private static instance: TileCache;
  private cache: Map<string, ImageBitmap> = new Map();
  /** Known-empty tiles (fully transparent). Lightweight — no LRU eviction needed. */
  private emptyTiles: Set<string> = new Set();
  private pending: Set<string> = new Set();
  private listeners: Set<() => void> = new Set();
  private usageOrder: string[] = [];
  private retryCount: Map<string, number> = new Map();
  private readonly MAX_TILES = 512;

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
   * Gets tile. Returns:
   * - ImageBitmap — tile has content, ready to draw.
   * - TILE_EMPTY — tile is known to be fully transparent (skip drawing, not a miss).
   * - undefined — tile not yet loaded (cache miss, triggers async fetch).
   */
  public get(hash: string, level: number, x: number, y: number): ImageBitmap | TileEmpty | undefined {
    const key = `${hash}-${level}-${x}-${y}`;

    // [Sparse Tile] Known-empty tiles return immediately — zero cost, no LRU slot.
    if (this.emptyTiles.has(key)) {
      return TILE_EMPTY;
    }

    if (this.cache.has(key)) {
      this.updateUsage(key);
      return this.cache.get(key);
    }

    if (!this.pending.has(key)) {
      const count = this.retryCount.get(key) || 0;
      if (count >= 3) {
        if (_tileDbg()) {
          console.warn(`[TileCache.get] MISS key=${key} reason=MAX_RETRY(${count})`);
        }
        return undefined;
      }

      if (!this.fetcher) {
        console.warn('[TileCache] No fetcher injected — cannot load tile');
        return undefined;
      }

      if (_tileDbg()) {
        console.log(`[TileCache.get] MISS key=${key} reason=FIRST_FETCH | cacheSize=${this.cache.size} pendingSize=${this.pending.size}`);
      }

      this.pending.add(key);
      this.fetcher(hash, level, x, y)
        .then((bitmap: ImageBitmap | null) => {
          this.pending.delete(key);
          this.retryCount.delete(key);

          if (bitmap === null) {
            // [Sparse Tile] Worker detected fully-transparent tile → store as empty sentinel.
            // Does NOT occupy an LRU slot — only a lightweight Set entry.
            if (_tileDbg()) {
              console.log(`[TileCache.get] EMPTY key=${key} → stored as sentinel`);
            }
            this.emptyTiles.add(key);
          } else {
            if (_tileDbg()) {
              console.log(`[TileCache.get] LOADED key=${key} bitmap=${bitmap.width}×${bitmap.height}`);
            }
            this.addToCache(key, bitmap);
          }
        })
        .catch((err) => {
          if (_tileDbg()) {
            console.warn(`[TileCache.get] FETCH_ERROR key=${key} err=${err}`);
          }
          this.pending.delete(key);
          this.retryCount.set(key, count + 1);
          setTimeout(() => this.notify(), 1000);
        });
    } else {
      // Already pending — just waiting
      if (_tileDbg()) {
        console.log(`[TileCache.get] MISS key=${key} reason=PENDING`);
      }
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
        if (_tileDbg()) {
          console.warn(`[TileCache] EVICT key=${oldestKey} | cacheSize=${this.cache.size}/${this.MAX_TILES}`);
        }
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
    // [Sparse Tile] Also clear empty sentinels for this asset
    for (const key of this.emptyTiles) {
      if (key.startsWith(hash)) {
        this.emptyTiles.delete(key);
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
    this.emptyTiles.clear();
    this.pending.clear();
    this.usageOrder = [];
    this.retryCount.clear();
  }
}

export const tileCache = TileCache.getInstance();
