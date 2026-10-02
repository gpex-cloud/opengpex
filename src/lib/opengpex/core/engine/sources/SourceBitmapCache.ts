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
 * SourceBitmapCache — the SINGLE main-thread cache for decoded asset bitmaps.
 *
 * Engine V2 version — reused from v1 with identical API.
 * This is the main-thread "truth source" for all decoded ImageBitmaps:
 *
 *   • Onscreen rendering (drawImage / tile fallback / bitmap mask)
 *   • FilterFastTrack preview
 *   • PixelFacade.decode.{bitmap, dimensions, contentBounds}
 *   • Plugin overlays (Brush, Clip wand, Adjustment histogram, AITools)
 *   • CanvasStage.subscribe → render loop redraw trigger
 *
 * Storage type is `ImageBitmap` because it is:
 *   - accepted directly by ctx.drawImage(...)
 *   - transferable to Web Workers with zero copy
 *   - decoded only once per URL
 *
 * Invariant: SourceBitmapCache is the main-thread
 * ONLY bitmap truth source.
 */

/**
 * Guard for non-browser (SSR / Node test) environments where
 * ImageBitmap APIs are absent.
 */
const isBitmapCapable =
  typeof globalThis !== 'undefined' &&
  typeof (globalThis as { createImageBitmap?: unknown }).createImageBitmap === 'function';

class SourceBitmapCache {
  private static instance: SourceBitmapCache;
  private cache: Map<string, ImageBitmap> = new Map();
  private pending: Map<string, Promise<ImageBitmap>> = new Map();
  private listeners: Set<() => void> = new Set();

  private constructor() {}

  static getInstance(): SourceBitmapCache {
    if (!SourceBitmapCache.instance) {
      SourceBitmapCache.instance = new SourceBitmapCache();
    }
    return SourceBitmapCache.instance;
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

  /** Sync lookup — returns the cached bitmap or undefined. */
  public get(src: string): ImageBitmap | undefined {
    return this.cache.get(src);
  }

  /**
   * Sync-return + async-load contract:
   *   - Cached → return immediately.
   *   - Missing → kick off fetch → blob → createImageBitmap;
   *     subscribers notified when bitmap lands; returns undefined.
   */
  public getOrFetch(src: string): ImageBitmap | undefined {
    const hit = this.cache.get(src);
    if (hit) return hit;
    if (!isBitmapCapable) return undefined;
    if (this.pending.has(src)) return undefined;
    this.startLoad(src);
    return undefined;
  }

  // ────────────────────────────────────────────────────────────
  // Write API
  // ────────────────────────────────────────────────────────────

  /**
   * Directly install a bitmap (e.g. produced by Worker result or overlay bake).
   * Overwrites any previous entry and closes the old bitmap.
   */
  public set(src: string, bitmap: ImageBitmap): void {
    const prev = this.cache.get(src);
    if (prev && prev !== bitmap) {
      try { prev.close(); } catch { /* ignore */ }
    }
    this.cache.set(src, bitmap);
    this.notify();
  }

  /**
   * Warm cache from a Blob (e.g. after Worker produces a result blob).
   * Decodes the blob into an ImageBitmap and stores it.
   *
   * Skips decode when the cache already holds a bitmap for `src`.
   * This prevents a redundant decode + notify cycle when writeBitmap()
   * has already injected a pre-decoded bitmap (paint bake pipeline).
   */
  public async warmFromBlob(src: string, blob: Blob): Promise<void> {
    if (!isBitmapCapable) return;
    // Fast exit: another path (e.g. writeBitmap) already populated the cache.
    if (this.cache.has(src)) {
      // [P3-Debug][1a] warmFromBlob fast-exit: cache already had this src BEFORE
      // createImageBitmap. This means a prior path (writeBitmap / another
      // warmFromBlob call) beat us here. The bitmap that will be used for
      // rendering is NOT the one we would have decoded here.
      console.log('[ColorProfile-Debug][1a.warmFromBlob-FAST-EXIT]', {
        src: src.slice(0, 32),
        reason: 'cache already populated before decode',
      });
      return;
    }
    try {
      // Decode image blob using default color management so embedded ICC profiles
      // (e.g. Display P3) are preserved and correctly tagged on the ImageBitmap.
      // This ensures WebGPU's copyExternalImageToTexture performs an identity copy.
      const bitmap = await createImageBitmap(blob, {
        imageOrientation: 'from-image',
      });

      try {
        const cvs = new OffscreenCanvas(1, 1);
        const ctx = cvs.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(bitmap, Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1, 0, 0, 1, 1);
        const px = ctx.getImageData(0, 0, 1, 1).data;
        console.log('[ColorProfile-Debug][1b.warmFromBlob-DECODED]', {
          src: src.slice(0, 32),
          width: bitmap.width,
          height: bitmap.height,
          colorSpaceConversion: 'default',
          centerPixel: [px[0], px[1], px[2], px[3]],
        });
      } catch {
        // ignore
      }

      // Re-check after async gap — writeBitmap may have populated the entry
      // while createImageBitmap was in progress.
      if (this.cache.has(src)) {
        bitmap.close();
        // [P3-Debug][1c] warmFromBlob async-gap-exit: cache was populated by
        // another path DURING our createImageBitmap await. The bitmap we just
        // decoded is discarded; the winner's bitmap will be used for rendering.
        console.log('[ColorProfile-Debug][1c.warmFromBlob-ASYNC-GAP-EXIT]', {
          src: src.slice(0, 32),
          reason: 'cache populated by another path during createImageBitmap',
        });
        return;
      }
      this.set(src, bitmap);
    } catch (err) {
      console.warn('[SourceBitmapCache] warmFromBlob failed for', src, err);
    }
  }

  /**
   * Return a caller-owned clone suitable for postMessage transfer.
   * Near-zero cost (GPU-side refcount, NOT full re-decode).
   */
  public async acquireOwned(src: string): Promise<ImageBitmap | null> {
    const hit = this.cache.get(src);
    if (!hit) return null;
    if (!isBitmapCapable) return null;
    try {
      return await createImageBitmap(hit);
    } catch (err) {
      console.warn('[SourceBitmapCache] acquireOwned failed for', src, err);
      return null;
    }
  }

  // ────────────────────────────────────────────────────────────
  // Eviction
  // ────────────────────────────────────────────────────────────

  public delete(src: string): void {
    const prev = this.cache.get(src);
    if (prev) {
      try { prev.close(); } catch { /* ignore */ }
    }
    this.cache.delete(src);
    this.pending.delete(src);
    this.notify();
  }

  public clear(): void {
    for (const bmp of this.cache.values()) {
      try { bmp.close(); } catch { /* ignore */ }
    }
    this.cache.clear();
    this.pending.clear();
    this.notify();
  }

  // ────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────

  private startLoad(src: string): void {
    // [P3-Debug][2] startLoad triggered — SceneAssembler called getOrFetch() and
    // found a cache miss. This path fetches from the ObjectURL and decodes with
    // default color management. If this fires during cold recovery, it means
    // warmFromBlob either hadn't resolved yet or was fast-exited.
    console.log('[ColorProfile-Debug][2.startLoad-TRIGGERED]', { src: src.slice(0, 32) });
    const promise = (async (): Promise<ImageBitmap> => {
      const response = await fetch(src, { credentials: 'omit' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      // Decode image blob using default color management so embedded ICC profiles
      // are respected and appropriately tagged for identity upload.
      const bitmap = await createImageBitmap(blob, {
        imageOrientation: 'from-image',
      });

      try {
        const cvs = new OffscreenCanvas(1, 1);
        const ctx = cvs.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(bitmap, Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1, 0, 0, 1, 1);
        const px = ctx.getImageData(0, 0, 1, 1).data;
        console.log('[ColorProfile-Debug][SourceBitmapCache-startLoad]', {
          src: src.slice(0, 32),
          width: bitmap.width,
          height: bitmap.height,
          colorSpaceConversion: 'default',
          centerPixel: [px[0], px[1], px[2], px[3]],
        });
      } catch {
        // ignore
      }

      return bitmap;
    })();
    this.pending.set(src, promise);

    promise.then(
      (bmp) => {
        if (this.pending.get(src) !== promise) {
          try { bmp.close(); } catch { /* ignore */ }
          return;
        }
        this.pending.delete(src);
        const prev = this.cache.get(src);
        if (prev && prev !== bmp) {
          try { prev.close(); } catch { /* ignore */ }
        }
        this.cache.set(src, bmp);
        this.notify();
      },
      (err) => {
        if (this.pending.get(src) === promise) {
          this.pending.delete(src);
        }
        console.warn('[SourceBitmapCache] fetch failed for', src, err);
      },
    );
  }
}

export const sourceBitmapCache = SourceBitmapCache.getInstance();
