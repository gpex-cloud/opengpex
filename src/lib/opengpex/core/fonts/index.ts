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

import { WebFont, FONT_REGISTRY } from './registry';
import { fontStore } from '@opengpex/editor/core/storage/font/FontStore';
import { getUserDiscoveredFonts } from './discovery';
import { getPersistedLocalFonts } from './local';

export type { WebFont } from './registry';
export { FONT_REGISTRY } from './registry';
export { getUserLocaleHint, getRecommendedFonts, splitFontsByLocale } from './locale';
export { searchGoogleFonts, getUserDiscoveredFonts, saveUserDiscoveredFont, removeUserDiscoveredFont } from './discovery';
export { isLocalFontAccessSupported, queryLocalFonts, getPersistedLocalFonts, clearPersistedLocalFonts } from './local';
export type { LocalFontScanResult } from './local';

/**
 * FontService: Core font loading and management service.
 *
 * Provides unified font loading, caching, and availability checking for the editor.
 * Mounted on EditorServiceContextValue as `ctx.fonts`.
 *
 * Design principles:
 * - Three-tier cache: Memory (Set + document.fonts) → IndexedDB (FontStore) → CDN (Network)
 * - CJK fonts use CSS stylesheet injection (unicode-range subsetting, browser auto-downloads needed glyphs)
 * - Non-CJK fonts download WOFF2 binary and register via FontFace API for offline use
 * - Graceful degradation: CDN unavailable → fallback CSS font rendering (FOUT strategy)
 */
export interface FontService {
  /** Check whether a font is already loaded into the current browser context */
  isLoaded(family: string): boolean;
  /** Dynamically download and register a font (IDB cache priority, network fallback) */
  load(family: string): Promise<boolean>;
  /**
   * Load a discovered font (not in built-in registry) by providing its WebFont descriptor.
   * Used when the user selects a font from Google Fonts search results.
   */
  loadDiscovered(font: WebFont): Promise<boolean>;
  /** Hydrate: Restore cached fonts from IndexedDB on startup */
  hydrate(): Promise<void>;
  /** Get all supported font descriptors from the registry (built-in + user-discovered) */
  getRegistry(): WebFont[];
  /** Get the list of currently loaded font family names */
  getLoadedFamilies(): string[];
  /** Clear all cached font data from IndexedDB (memory state reset on next page load) */
  clearCache(): Promise<void>;
  /** Subscribe to font state changes (loaded/cleared). Returns unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/**
 * createFontService: Factory function that creates a FontService instance.
 *
 * Loading strategy:
 * 1. If font is already loaded (in-memory Set or document.fonts.check), return immediately
 * 2. Check IndexedDB (FontStore) for cached WOFF2 binary → register FontFace
 * 3. If not cached, download from CDN:
 *    - Subsetted CJK fonts: inject <link> stylesheet (browser handles unicode-range auto-subsetting)
 *    - Non-CJK fonts: fetch WOFF2 → register FontFace → persist to IndexedDB
 * 4. On failure: mark as failed with retry cooldown, use CSS fallback rendering
 */
export function createFontService(): FontService {
  const loadedFonts = new Set<string>();
  const failedFonts = new Map<string, { count: number; lastAttempt: number }>();
  const pendingLoads = new Map<string, Promise<boolean>>();
  const listeners = new Set<() => void>();

  // Cached snapshot for useSyncExternalStore (must be referentially stable between changes)
  let cachedFamilies: string[] = [];
  let cacheVersion = 0;

  const MAX_RETRIES = 3;
  const RETRY_COOLDOWN_MS = 30_000;
  const FETCH_TIMEOUT_MS = 8_000;

  function invalidateCache(): void {
    cacheVersion++;
    cachedFamilies = Array.from(loadedFonts);
  }

  function notify(): void {
    invalidateCache();
    for (const listener of listeners) {
      try { listener(); } catch { /* ignore */ }
    }
  }

  function canRetry(family: string): boolean {
    const record = failedFonts.get(family);
    if (!record) return true;
    if (record.count >= MAX_RETRIES) return false;
    return Date.now() - record.lastAttempt > RETRY_COOLDOWN_MS;
  }

  function markFailed(family: string): void {
    const r = failedFonts.get(family) || { count: 0, lastAttempt: 0 };
    failedFonts.set(family, { count: r.count + 1, lastAttempt: Date.now() });
  }

  /**
   * Register a font from binary data using the FontFace API
   */
  async function registerFontFace(family: string, blob: Blob, weights: number[]): Promise<void> {
    const buffer = await blob.arrayBuffer();
    for (const weight of weights) {
      const face = new FontFace(family, buffer, {
        weight: String(weight),
        style: 'normal',
      });
      await face.load();
      document.fonts.add(face);
    }
  }

  /**
   * Load a font via CSS stylesheet injection (used for subsetted CJK fonts)
   */
  async function loadViaStylesheet(cssUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Avoid duplicate injection
      if (document.querySelector(`link[href="${cssUrl}"]`)) {
        resolve();
        return;
      }
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = cssUrl;
      link.onload = () => resolve();
      link.onerror = () => reject(new Error(`Stylesheet load failed: ${cssUrl}`));
      document.head.appendChild(link);
    });
  }

  /**
   * Fetch a WOFF2 binary with timeout
   */
  async function fetchWoff2(url: string): Promise<Blob> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.blob();
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Load a font using an explicit WebFont descriptor (for discovered fonts not in FONT_REGISTRY)
   */
  async function loadDiscoveredImpl(fontInfo: WebFont): Promise<boolean> {
    const family = fontInfo.family;
    try {
      // Strategy 1: Restore from IndexedDB persistent cache
      const cached = await fontStore.get(family);
      if (cached) {
        await registerFontFace(cached.family, cached.blob, cached.weights);
        loadedFonts.add(family);
        await fontStore.set(family, cached.blob, {
          format: cached.format,
          weights: cached.weights,
          unicodeRange: cached.unicodeRange,
        });
        return true;
      }

      // Strategy 2: Download from network using the provided descriptor
      if (fontInfo.subsetted && fontInfo.googleUrl) {
        await loadViaStylesheet(fontInfo.googleUrl);
      } else if (fontInfo.woff2Url) {
        const blob = await fetchWoff2(fontInfo.woff2Url);
        await registerFontFace(family, blob, fontInfo.weights);
        await fontStore.set(family, blob, { format: 'woff2', weights: fontInfo.weights });
      } else if (fontInfo.googleUrl) {
        await loadViaStylesheet(fontInfo.googleUrl);
        try {
          const cssRes = await fetch(fontInfo.googleUrl);
          const cssText = await cssRes.text();
          const urlMatch = cssText.match(/url\(([^)]+\.woff2[^)]*)\)/);
          if (urlMatch) {
            const woff2Url = urlMatch[1].replace(/['"]/g, '');
            const blob = await fetchWoff2(woff2Url);
            await fontStore.set(family, blob, { format: 'woff2', weights: fontInfo.weights });
          }
        } catch {
          // Non-fatal
        }
      }

      await document.fonts.load(`16px "${family}"`);
      loadedFonts.add(family);
      failedFonts.delete(family);
      return true;
    } catch (e) {
      console.error(`[FontService] Failed to load discovered font: ${family}`, e);
      markFailed(family);
      return false;
    }
  }

  /**
   * Core load implementation (deduped via pendingLoads map)
   */
  async function loadImpl(family: string): Promise<boolean> {
    // Check built-in registry first
    let fontInfo: WebFont | undefined = FONT_REGISTRY.find(f => f.family === family);

    // If not in built-in registry, check user-discovered fonts
    if (!fontInfo) {
      const discovered = getUserDiscoveredFonts();
      fontInfo = discovered.find(f => f.family === family);
    }

    // Unknown font (not in any registry) — treat as system font, assume available
    if (!fontInfo) return true;

    // System font — no download needed
    if (fontInfo.isSystem) {
      loadedFonts.add(family);
      return true;
    }

    try {
      // Strategy 1: Restore from IndexedDB persistent cache
      const cached = await fontStore.get(family);
      if (cached) {
        await registerFontFace(cached.family, cached.blob, cached.weights);
        loadedFonts.add(family);
        // Touch timestamp to prevent GC
        await fontStore.set(family, cached.blob, {
          format: cached.format,
          weights: cached.weights,
          unicodeRange: cached.unicodeRange,
        });
        return true;
      }

      // Strategy 2: Download from network
      if (fontInfo.subsetted && fontInfo.googleUrl) {
        // CJK subsetted fonts: inject stylesheet, browser auto-downloads needed glyphs
        await loadViaStylesheet(fontInfo.googleUrl);
      } else if (fontInfo.woff2Url) {
        // Direct WOFF2 URL: download binary, register, and persist
        const blob = await fetchWoff2(fontInfo.woff2Url);
        await registerFontFace(family, blob, fontInfo.weights);
        await fontStore.set(family, blob, { format: 'woff2', weights: fontInfo.weights });
      } else if (fontInfo.googleUrl) {
        // Google Fonts CSS: inject stylesheet first, then attempt to extract and cache WOFF2
        await loadViaStylesheet(fontInfo.googleUrl);
        // Best-effort: try to extract and persist the WOFF2 binary for offline use
        try {
          const cssRes = await fetch(fontInfo.googleUrl);
          const cssText = await cssRes.text();
          const urlMatch = cssText.match(/url\(([^)]+\.woff2[^)]*)\)/);
          if (urlMatch) {
            const woff2Url = urlMatch[1].replace(/['"]/g, '');
            const blob = await fetchWoff2(woff2Url);
            await fontStore.set(family, blob, { format: 'woff2', weights: fontInfo.weights });
          }
        } catch {
          // Non-fatal: CSS loaded successfully, persist failed — font still works via stylesheet
        }
      }

      // Wait for browser to confirm font is usable
      await document.fonts.load(`16px "${family}"`);
      loadedFonts.add(family);
      failedFonts.delete(family);
      return true;
    } catch (e) {
      console.error(`[FontService] Failed to load: ${family}`, e);
      markFailed(family);
      return false;
    }
  }

  return {
    isLoaded(family: string): boolean {
      if (typeof window === 'undefined') return true; // SSR safety
      // Only trust the in-memory Set (document.fonts.check is unreliable —
      // it returns true for any font name because text can render with fallbacks)
      return loadedFonts.has(family);
    },

    async load(family: string): Promise<boolean> {
      // Already loaded
      if (this.isLoaded(family)) return true;
      // Exceeded retry limit
      if (!canRetry(family)) return false;

      // Deduplicate concurrent loads for the same font
      const existing = pendingLoads.get(family);
      if (existing) return existing;

      const promise = loadImpl(family).then((ok) => {
        if (ok) notify();
        return ok;
      }).finally(() => {
        pendingLoads.delete(family);
      });
      pendingLoads.set(family, promise);
      return promise;
    },

    async hydrate(): Promise<void> {
      if (typeof window === 'undefined') return; // SSR safety

      // 1. Pre-populate system fonts (always available, no download needed)
      for (const font of FONT_REGISTRY) {
        if (font.isSystem) {
          loadedFonts.add(font.family);
        }
      }

      // 2. Restore cached fonts from IndexedDB
      try {
        const allCached = await fontStore.getAll();
        for (const cached of allCached) {
          if (!document.fonts.check(`16px "${cached.family}"`)) {
            try {
              await registerFontFace(cached.family, cached.blob, cached.weights);
              loadedFonts.add(cached.family);
            } catch (e) {
              console.warn(`[FontService] Failed to hydrate font: ${cached.family}`, e);
              // Remove corrupted entry
              await fontStore.remove(cached.family);
            }
          } else {
            loadedFonts.add(cached.family);
          }
        }
      } catch (e) {
        console.warn('[FontService] Hydration failed (non-fatal):', e);
      }

      // Notify listeners after hydration completes
      notify();
    },

    async loadDiscovered(font: WebFont): Promise<boolean> {
      if (this.isLoaded(font.family)) return true;
      if (!canRetry(font.family)) return false;

      const existing = pendingLoads.get(font.family);
      if (existing) return existing;

      const promise = loadDiscoveredImpl(font).then((ok) => {
        if (ok) notify();
        return ok;
      }).finally(() => {
        pendingLoads.delete(font.family);
      });
      pendingLoads.set(font.family, promise);
      return promise;
    },

    getRegistry(): WebFont[] {
      // Merge built-in registry + user-discovered fonts + persisted local fonts
      const discovered = getUserDiscoveredFonts();
      const localFonts = getPersistedLocalFonts();
      const builtInFamilies = new Set(FONT_REGISTRY.map(f => f.family));
      const uniqueDiscovered = discovered.filter(f => !builtInFamilies.has(f.family));
      const allFamilies = new Set([...builtInFamilies, ...uniqueDiscovered.map(f => f.family)]);
      const uniqueLocal = localFonts.filter(f => !allFamilies.has(f.family));
      if (uniqueDiscovered.length === 0 && uniqueLocal.length === 0) return FONT_REGISTRY;
      return [...FONT_REGISTRY, ...uniqueDiscovered, ...uniqueLocal];
    },

    getLoadedFamilies(): string[] {
      // Return cached snapshot (referentially stable for useSyncExternalStore)
      return cachedFamilies;
    },

    async clearCache(): Promise<void> {
      await fontStore.clear();
      loadedFonts.clear();
      failedFonts.clear();
      pendingLoads.clear();
      notify();
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
