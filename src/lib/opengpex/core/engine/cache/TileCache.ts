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

/**
 * TileCache: Tiled cache manager
 * Specially designed for Canvas rendering engines, supporting asynchronous tile retrieval and hit management.
 * 
 * [Performance Optimization: Reactive Redraw]
 * Introduced subscribe/notify mechanism. This is key to solving "high fan noise due to large images":
 * The rendering engine no longer uses a 60fps busy loop, but subscribes to this cache. Only when a new tile completes loading,
 * a frame redraw is triggered, reducing CPU/GPU usage to 0 in static states.
 * 
 * Introduced LRU (Least Recently Used) eviction policy to prevent memory overflow.
 */
class TileCache {
  private static instance: TileCache;
  private cache: Map<string, ImageBitmap> = new Map();
  private pending: Set<string> = new Set();
  private listeners: Set<() => void> = new Set();
  private usageOrder: string[] = []; // Tracks usage order for LRU
  private retryCount: Map<string, number> = new Map(); // Tracks failure count
  private MAX_TILES = 500;           // Maximum tile cache size

  private constructor() { }

  /**
   * Subscribe to cache changes (used to trigger UI redraws)
   */
  public subscribe(callback: () => void) {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  private notify() {
    this.listeners.forEach(cb => cb());
  }

  static getInstance(): TileCache {
    if (!TileCache.instance) {
      TileCache.instance = new TileCache();
    }
    return TileCache.instance;
  }

  /**
   * Gets tile. If absent, triggers asynchronous loading and returns undefined.
   */
  get(hash: string, level: number, x: number, y: number): ImageBitmap | undefined {
    const key = `${hash}-${level}-${x}-${y}`;

    if (this.cache.has(key)) {
      this.updateUsage(key);
      return this.cache.get(key);
    }

    if (!this.pending.has(key)) {
      const count = this.retryCount.get(key) || 0;
      if (count >= 3) return undefined; // Exceeded retry limit, abort

      this.pending.add(key);

      workerBridge.request<ImageBitmap>('GET_TILE', { hash, level, x, y })
        .then((bitmap: ImageBitmap) => {
          this.addToCache(key, bitmap);
          this.pending.delete(key);
          this.retryCount.delete(key);
        })
        .catch(() => {
          this.pending.delete(key);
          this.retryCount.set(key, count + 1);
          // Delay redraw to try again in next loop (if limit not exceeded)
          setTimeout(() => this.notify(), 1000);
        });
    }

    return undefined;
  }

  private updateUsage(key: string) {
    const index = this.usageOrder.indexOf(key);
    if (index > -1) {
      this.usageOrder.splice(index, 1);
    }
    this.usageOrder.push(key);
  }

  private addToCache(key: string, bitmap: ImageBitmap) {
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
   * Clears all cache of specified asset (for GC)
   */
  clearAsset(hash: string) {
    for (const key of this.cache.keys()) {
      if (key.startsWith(hash)) {
        const bitmap = this.cache.get(key);
        bitmap?.close();
        this.cache.delete(key);
        this.usageOrder = this.usageOrder.filter(k => k !== key);
      }
    }
  }

  clear() {
    for (const bitmap of this.cache.values()) {
      bitmap.close();
    }
    this.cache.clear();
    this.pending.clear();
    this.usageOrder = [];
  }
}

export const tileCache = TileCache.getInstance();
