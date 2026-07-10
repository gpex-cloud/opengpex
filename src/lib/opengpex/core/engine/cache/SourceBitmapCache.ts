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
 * SourceBitmapCache — the SINGLE main-thread cache for decoded asset
 * bitmaps. Replaces the legacy `imageCache` (HTMLImageElement) and
 * unifies the type across every consumer:
 *
 *   • Canvas2dEngine.drawLayerDirect          (drawImage / tile fallback / bitmap mask)
 *   • Canvas2dEngine.resolveFilteredSource    (feeds AsyncFilterCache — see §4 of the plan)
 *   • PixelService.decode.{bitmap,dimensions,contentBounds}
 *   • BrushOverlay / ClipOverlay wand / ColorGradingDrawer histogram / BgRemovalDrawer
 *   • CanvasStage.subscribe → render loop redraw trigger
 *
 * Storage type is `ImageBitmap` because it is:
 *   - accepted directly by `ctx.drawImage(...)`
 *   - transferable to Web Workers with zero copy
 *   - decoded only once per URL — no double-representation with HTMLImageElement
 *
 * See `docs/opengpex/plans/20260710_source_bitmap_cache_refactor_plan.md`
 * for background & rationale.
 */

/**
 * Guard for non-browser (SSR / Node test) environments where the
 * ImageBitmap APIs are absent. Consumers all expect "undefined = not
 * yet available", so we simply short-circuit reads and swallow writes.
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
  // Subscription — mirror of the legacy ImageCache contract so
  // CanvasStage's redraw signal wiring is a one-liner grep-replace.
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

  /** Sync lookup — returns the cached bitmap or `undefined`. */
  public get(src: string): ImageBitmap | undefined {
    return this.cache.get(src);
  }

  /**
   * Sync-return + async-load contract identical to legacy
   * `imageCache.getOrFetch`:
   *   - Cached → return immediately (sync).
   *   - Missing → kick off `fetch → blob → createImageBitmap`;
   *              subscribers are notified when the bitmap lands;
   *              return `undefined` for this call.
   *
   * Loading errors are logged and swallowed so a broken URL cannot
   * poison the render loop (the caller will keep receiving `undefined`
   * and can decide how to react — same behaviour as the legacy cache).
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
   * Directly install a bitmap (e.g. produced by BrushOverlay bake or
   * a Worker result). Overwrites any previous entry for `src` and
   * closes the previous bitmap to release GPU memory.
   *
   * If a `getOrFetch(src)` load is in flight, its result will be
   * discarded (see race-guard in `startLoad`) so the caller-provided
   * bitmap wins — this matches the legacy `imageCache.set()` semantics
   * used by BrushOverlay bake.
   */
  public set(src: string, bitmap: ImageBitmap): void {
    const prev = this.cache.get(src);
    if (prev && prev !== bitmap) {
      try { prev.close(); } catch { /* ignore */ }
    }
    this.cache.set(src, bitmap);
    // Any in-flight loader will detect its promise is no longer the
    // authoritative pending entry (because we set `.cache` directly)
    // and close its bitmap on completion.
    this.notify();
  }

  /**
   * Return a caller-owned clone of the cached bitmap suitable for
   * `postMessage(msg, [ownedBitmap])` transfer. Under the hood this
   * is `createImageBitmap(cachedBitmap)` — the browser implements it
   * as a GPU-side refcount, NOT a full re-decode, so the CPU cost is
   * near-zero even for 4K sources.
   *
   * Returns `null` when the bitmap is not (yet) cached or when the
   * runtime lacks `createImageBitmap` (SSR / Node tests).
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

  public remove(src: string): void {
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

  /**
   * Kick off a `fetch → blob → createImageBitmap` job for `src`.
   * The resulting promise is registered in `this.pending` under the
   * same key so concurrent `getOrFetch(src)` calls deduplicate onto
   * it. On success we notify subscribers so the render loop picks up
   * the freshly-decoded bitmap on the next frame.
   *
   * Race guard: if `set()` runs while the fetch is in flight, our
   * `pending` entry is cleared out from under us; on completion we
   * detect that we're no longer the authoritative loader and close
   * our bitmap instead of clobbering the caller-installed one.
   */
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
        // Only commit if we're still the authoritative loader.
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
