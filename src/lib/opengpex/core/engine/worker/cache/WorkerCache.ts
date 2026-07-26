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
 * WorkerCache — Worker-side bitmap and raw buffer cache for Engine V2.
 *
 * Adapted from v1 `worker/core/WorkerCache.ts` with the following changes:
 * - Simplified API to match the Phase 0 design spec:
 *   • getBitmap(hash): single full-resolution bitmap (not pyramid).
 *   • getRawBuffer(hash): raw ArrayBuffer for high-precision paths.
 *   • ingest(hash, blob): decode blob → ImageBitmap, store both.
 *   • evict(hash): release resources for a single asset.
 *   • clear(): release all resources.
 * - LRU eviction policy with configurable capacity.
 *
 * Invariant (architecture doc §六.6): Worker is self-sufficient — it resolves
 * bitmaps from WorkerCache and NEVER requests pixels from the main thread.
 */

class WorkerCache {
  private static instance: WorkerCache;

  private blobCache: Map<string, Blob> = new Map();
  private bitmapCache: Map<string, ImageBitmap> = new Map();
  private rawBufferCache: Map<string, ArrayBuffer> = new Map();
  private usageOrder: string[] = [];

  private MAX_ASSETS = 15;

  private constructor() {}

  public static getInstance(): WorkerCache {
    if (!WorkerCache.instance) {
      WorkerCache.instance = new WorkerCache();
    }
    return WorkerCache.instance;
  }

  /**
   * Initialize configuration (called once at Worker startup).
   */
  public initialize(config: { memoryClass: 'low' | 'mid' | 'high' }): void {
    switch (config.memoryClass) {
      case 'low': this.MAX_ASSETS = 8; break;
      case 'mid': this.MAX_ASSETS = 15; break;
      case 'high': this.MAX_ASSETS = 30; break;
    }
  }

  /**
   * Ingest a blob: decode to ImageBitmap and store both.
   * Idempotent — if hash already exists, this is a no-op.
   */
  public async ingest(hash: string, blob: Blob): Promise<void> {
    if (this.bitmapCache.has(hash)) {
      this.touchUsage(hash);
      return;
    }

    // Evict if at capacity
    this.evictIfNeeded();

    // Decode blob to bitmap
    const bitmap = await createImageBitmap(blob);
    this.blobCache.set(hash, blob);
    this.bitmapCache.set(hash, bitmap);
    this.usageOrder.push(hash);
  }

  /**
   * Get the decoded bitmap for a given hash.
   */
  public getBitmap(hash: string): ImageBitmap | undefined {
    const bitmap = this.bitmapCache.get(hash);
    if (bitmap) this.touchUsage(hash);
    return bitmap;
  }

  /**
   * Get a raw ArrayBuffer for the given hash (for high-precision pipeline).
   */
  public getRawBuffer(hash: string): ArrayBuffer | undefined {
    return this.rawBufferCache.get(hash);
  }

  /**
   * Store a raw buffer (e.g. from vips decode for 16/32-bit data).
   */
  public setRawBuffer(hash: string, buffer: ArrayBuffer): void {
    this.rawBufferCache.set(hash, buffer);
  }

  /**
   * Evict a single asset by hash, releasing all associated resources.
   */
  public evict(hash: string): void {
    const bitmap = this.bitmapCache.get(hash);
    if (bitmap) {
      bitmap.close();
      this.bitmapCache.delete(hash);
    }
    this.blobCache.delete(hash);
    this.rawBufferCache.delete(hash);
    const idx = this.usageOrder.indexOf(hash);
    if (idx !== -1) this.usageOrder.splice(idx, 1);
  }

  /**
   * Clear all cached resources.
   */
  public clear(): void {
    for (const bitmap of this.bitmapCache.values()) {
      bitmap.close();
    }
    this.bitmapCache.clear();
    this.blobCache.clear();
    this.rawBufferCache.clear();
    this.usageOrder = [];
  }

  // ────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────

  private touchUsage(hash: string): void {
    const idx = this.usageOrder.indexOf(hash);
    if (idx !== -1) {
      this.usageOrder.splice(idx, 1);
    }
    this.usageOrder.push(hash);
  }

  private evictIfNeeded(): void {
    while (this.bitmapCache.size >= this.MAX_ASSETS && this.usageOrder.length > 0) {
      const oldest = this.usageOrder.shift();
      if (oldest) {
        const bitmap = this.bitmapCache.get(oldest);
        if (bitmap) bitmap.close();
        this.bitmapCache.delete(oldest);
        this.blobCache.delete(oldest);
        this.rawBufferCache.delete(oldest);
      }
    }
  }
}

export const workerCache = WorkerCache.getInstance();
