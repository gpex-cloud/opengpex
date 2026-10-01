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
 * TexturePool.ts — Power-of-2 bucketed VRAM texture pool.
 *
 * HARD PRINCIPLES:
 *   1. On-demand layer bounding box allocation: Never allocate a full
 *      4K/8K canvas texture for an arbitrary small layer.
 *   2. Bucketed recycling: Texture dimensions snap up to powers of 2
 *      (e.g. 64, 128, 256, 512, 1024, 2048, 4096...) to avoid frequent VRAM
 *      allocations and smooth out frame delivery.
 *   3. LRU Eviction: Free textures are evicted when total VRAM crosses limits
 *      or on explicit trim requests.
 *
 * @module core/gpu/resources/TexturePool
 */

import { GPUTextureUsage } from '../constants';

export interface TexturePoolStats {
  readonly inUseCount: number;
  readonly freeCount: number;
  readonly inUseBytes: number;
  readonly freeBytes: number;
  readonly totalBytes: number;
  readonly peakBytes: number;
}

export interface AcquireTextureOptions {
  readonly width: number;
  readonly height: number;
  readonly format?: GPUTextureFormat;
  readonly usage?: number;
  readonly label?: string;
}

interface PooledTextureEntry {
  readonly texture: GPUTexture;
  readonly bucketW: number;
  readonly bucketH: number;
  readonly format: GPUTextureFormat;
  readonly usage: number;
  readonly bytes: number;
  lastUsedTime: number;
}

/** Round up to next power of 2, clamped to minimum bucket size. */
export function snapToPowerOfTwo(value: number, minBucket = 64): number {
  if (value <= minBucket) return minBucket;
  return 1 << Math.ceil(Math.log2(value));
}

/** Calculate approximate memory footprint in bytes for an uncompressed 2D texture. */
export function estimateTextureBytes(width: number, height: number, format: GPUTextureFormat): number {
  let bytesPerPixel = 4;
  if (format.includes('16float') || format.includes('16uint') || format.includes('16sint')) {
    bytesPerPixel = 8;
  } else if (format.includes('32float') || format.includes('32uint') || format.includes('32sint')) {
    bytesPerPixel = 16;
  }
  return width * height * bytesPerPixel;
}

export class TexturePool {
  private readonly freeBuckets = new Map<string, PooledTextureEntry[]>();
  private readonly inUse = new Map<GPUTexture, PooledTextureEntry>();

  private inUseBytes = 0;
  private freeBytes = 0;
  private peakBytes = 0;

  /** Maximum cached free VRAM before LRU eviction triggers (default 256 MB). */
  private readonly maxFreeBytes: number;

  constructor(
    readonly device: GPUDevice,
    options?: { maxFreeBytes?: number },
  ) {
    this.maxFreeBytes = options?.maxFreeBytes ?? 256 * 1024 * 1024;
  }

  private makeBucketKey(w: number, h: number, format: GPUTextureFormat, usage: number): string {
    return `${w}x${h}:${format}:${usage}`;
  }

  /**
   * Acquire a texture matching or exceeding the requested dimensions.
   * Dimensions are snapped to the nearest power of 2.
   */
  acquire(options: AcquireTextureOptions): GPUTexture {
    const bucketW = snapToPowerOfTwo(options.width);
    const bucketH = snapToPowerOfTwo(options.height);
    const format = options.format ?? 'rgba16float';
    const usage =
      options.usage ??
      (GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST);

    const key = this.makeBucketKey(bucketW, bucketH, format, usage);
    const bucket = this.freeBuckets.get(key);

    let entry: PooledTextureEntry;
    if (bucket && bucket.length > 0) {
      entry = bucket.pop()!;
      this.freeBytes -= entry.bytes;
    } else {
      const bytes = estimateTextureBytes(bucketW, bucketH, format);
      const texture = this.device.createTexture({
        size: [bucketW, bucketH, 1],
        format,
        usage,
        label: options.label ?? `TexturePool ${bucketW}x${bucketH}`,
      });
      entry = {
        texture,
        bucketW,
        bucketH,
        format,
        usage,
        bytes,
        lastUsedTime: performance.now(),
      };
    }

    entry.lastUsedTime = performance.now();
    this.inUse.set(entry.texture, entry);
    this.inUseBytes += entry.bytes;

    const currentTotal = this.inUseBytes + this.freeBytes;
    if (currentTotal > this.peakBytes) {
      this.peakBytes = currentTotal;
    }

    return entry.texture;
  }

  /**
   * Return a texture to the pool for reuse.
   */
  release(texture: GPUTexture): void {
    const entry = this.inUse.get(texture);
    if (!entry) {
      // Texture wasn't tracked in pool — destroy directly
      texture.destroy();
      return;
    }

    this.inUse.delete(texture);
    this.inUseBytes -= entry.bytes;

    entry.lastUsedTime = performance.now();
    const key = this.makeBucketKey(entry.bucketW, entry.bucketH, entry.format, entry.usage);
    let bucket = this.freeBuckets.get(key);
    if (!bucket) {
      bucket = [];
      this.freeBuckets.set(key, bucket);
    }
    bucket.push(entry);
    this.freeBytes += entry.bytes;

    if (this.freeBytes > this.maxFreeBytes) {
      this.evictOldest();
    }
  }

  /**
   * Evict the oldest unused textures until freeBytes falls below threshold.
   */
  private evictOldest(): void {
    const allFree: PooledTextureEntry[] = [];
    for (const list of this.freeBuckets.values()) {
      allFree.push(...list);
    }
    allFree.sort((a, b) => a.lastUsedTime - b.lastUsedTime);

    while (this.freeBytes > this.maxFreeBytes && allFree.length > 0) {
      const entry = allFree.shift()!;
      const key = this.makeBucketKey(entry.bucketW, entry.bucketH, entry.format, entry.usage);
      const bucket = this.freeBuckets.get(key);
      if (bucket) {
        const idx = bucket.indexOf(entry);
        if (idx !== -1) {
          bucket.splice(idx, 1);
        }
      }
      this.freeBytes -= entry.bytes;
      entry.texture.destroy();
    }
  }

  /** Evict all free textures unused for longer than `maxAgeMs`. */
  evictUnused(maxAgeMs = 10000): void {
    const now = performance.now();
    for (const [key, list] of this.freeBuckets.entries()) {
      const remaining: PooledTextureEntry[] = [];
      for (const entry of list) {
        if (now - entry.lastUsedTime > maxAgeMs) {
          this.freeBytes -= entry.bytes;
          entry.texture.destroy();
        } else {
          remaining.push(entry);
        }
      }
      if (remaining.length === 0) {
        this.freeBuckets.delete(key);
      } else {
        this.freeBuckets.set(key, remaining);
      }
    }
  }

  getStats(): TexturePoolStats {
    let freeCount = 0;
    for (const list of this.freeBuckets.values()) {
      freeCount += list.length;
    }
    return {
      inUseCount: this.inUse.size,
      freeCount,
      inUseBytes: this.inUseBytes,
      freeBytes: this.freeBytes,
      totalBytes: this.inUseBytes + this.freeBytes,
      peakBytes: this.peakBytes,
    };
  }

  destroy(): void {
    for (const list of this.freeBuckets.values()) {
      for (const entry of list) {
        entry.texture.destroy();
      }
    }
    this.freeBuckets.clear();

    for (const entry of this.inUse.values()) {
      entry.texture.destroy();
    }
    this.inUse.clear();

    this.inUseBytes = 0;
    this.freeBytes = 0;
  }
}
