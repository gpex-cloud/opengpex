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
 *   • Canvas2dEngine.drawLayerDirect (drawImage / tile fallback / bitmap mask)
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
 * Invariant (architecture doc §六.5): SourceBitmapCache is the main-thread
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
   */
  public async warmFromBlob(src: string, blob: Blob): Promise<void> {
    if (!isBitmapCapable) return;
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
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
    const promise = (async (): Promise<ImageBitmap> => {
      const response = await fetch(src, { credentials: 'omit' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      return createImageBitmap(blob, { imageOrientation: 'from-image' });
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
