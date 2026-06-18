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
 * core/worker/core/WorkerCache.ts: Worker-side bitmap and metadata cache center
 */

import { TileMetadata } from '@opengpex/editor/core/types';

export class WorkerCache {
  private static instance: WorkerCache;

  public blobCache = new Map<string, Blob>();
  public bitmapCache = new Map<string, ImageBitmap[]>();
  public assetUsageOrder: string[] = [];
  public pendingDecodes = new Map<string, Promise<TileMetadata>>();
  
  public MAX_ASSETS = 15;

  private constructor() {}

  public static getInstance(): WorkerCache {
    if (!WorkerCache.instance) {
      WorkerCache.instance = new WorkerCache();
    }
    return WorkerCache.instance;
  }

  /**
   * Initializes configuration
   */
  public initialize(config: { memoryClass: 'low' | 'mid' | 'high' }) {
    switch (config.memoryClass) {
      case 'low': this.MAX_ASSETS = 8; break;
      case 'mid': this.MAX_ASSETS = 15; break;
      case 'high': this.MAX_ASSETS = 30; break;
    }
    console.log(`[Worker] Initialized with memory class: ${config.memoryClass}, MAX_ASSETS: ${this.MAX_ASSETS}`);
  }

  /**
   * Records usage and executes LRU eviction
   */
  public touch(id: string, levels: ImageBitmap[]) {
    // If already exists, remove old position first
    const idx = this.assetUsageOrder.indexOf(id);
    if (idx !== -1) {
      this.assetUsageOrder.splice(idx, 1);
    }

    // Evict old assets
    if (this.bitmapCache.size >= this.MAX_ASSETS && !this.bitmapCache.has(id)) {
      const oldestId = this.assetUsageOrder.shift();
      if (oldestId) {
        // 1. Clean up bitmap (ImageBitmap)
        const oldBitmaps = this.bitmapCache.get(oldestId);
        oldBitmaps?.forEach(b => b.close());
        this.bitmapCache.delete(oldestId);

        // 2. [Critical Fix]: Clean up Blob references, otherwise raw data will blow up memory
        this.blobCache.delete(oldestId);

        // 3. Clean up pending decoding tasks
        this.pendingDecodes.delete(oldestId);
      }
    }

    this.bitmapCache.set(id, levels);
    this.assetUsageOrder.push(id);
  }

  /**
   * Gets cached bitmap pyramid
   */
  public getBitmaps(id: string): ImageBitmap[] | undefined {
    return this.bitmapCache.get(id);
  }

  /**
   * Completely forgets asset
   */
  public forget(id: string) {
    const bitmaps = this.bitmapCache.get(id);
    bitmaps?.forEach(b => b.close());
    this.bitmapCache.delete(id);
    this.blobCache.delete(id);
    const idx = this.assetUsageOrder.indexOf(id);
    if (idx !== -1) this.assetUsageOrder.splice(idx, 1);
  }
}

export const workerCache = WorkerCache.getInstance();
