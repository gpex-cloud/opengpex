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

'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  useEditorState,
  useEditorServices,
} from '@opengpex/editor/core/context';

// ─── useLayerHistogram ─────────────────────────────────────────────────────────

/**
 * useLayerHistogram — full-resolution, per-layer RGB composite histogram via Worker.
 *
 * Returns `{ luminance }` where `luminance` is a `Uint32Array(256)` of bin
 * counts (RGB composite = sum of per-channel R+G+B counts, matching Photoshop's
 * Levels dialog "RGB" channel histogram) or `null` while the computation is
 * still pending. The hook is careful to:
 *
 * 1. Only compute once per `layer.assetId` — swapping the active layer or
 *    replacing its bitmap invalidates the cache; a pure `layer.levels` mutation
 *    does not trigger recomputation.
 * 2. Compute on FULL resolution pixels in the Worker thread — no downsampling.
 *    This eliminates the bilinear interpolation artifacts that the old 256px
 *    thumbnail approach introduced, producing results that match Photoshop's
 *    Levels dialog histogram.
 * 3. Use the same algorithm as Photoshop: for each pixel, independently count
 *    R, G, B channel values, then sum the three histograms into one composite.
 *    This preserves individual channel peaks rather than collapsing them into
 *    a single weighted-luminance value.
 * 4. Run entirely in the engine Worker via `pixels.image.histogram()`, so the
 *    main thread is never blocked by pixel iteration (zero main-thread compute).
 * 5. Ignore fully-transparent pixels (`a === 0`) so a masked layer's alpha-
 *    padded borders don't crush the histogram's black bin (handled in the
 *    Worker-side HistogramHandler).
 *
 * This hook lives in the plugin (not `core/engine`) because it's a UI-only
 * concern: the runtime filter path uses `generateLevelsLUT` directly and
 * doesn't need histograms.
 */

/**
 * Module-scoped LRU-ish cache: key is `layer.assetId`.
 * Bounded to a handful of entries because histograms are cheap to recompute
 * and users don't tend to keep dozens of layers open at once.
 */
const HISTOGRAM_CACHE = new Map<string, Uint32Array>();
const HISTOGRAM_CACHE_MAX = 16;

function rememberHistogram(key: string, hist: Uint32Array) {
  if (HISTOGRAM_CACHE.size >= HISTOGRAM_CACHE_MAX) {
    // Drop the oldest entry (Map preserves insertion order).
    const firstKey = HISTOGRAM_CACHE.keys().next().value;
    if (firstKey !== undefined) HISTOGRAM_CACHE.delete(firstKey);
  }
  HISTOGRAM_CACHE.set(key, hist);
}

export interface LayerHistogram {
  /** 256-bin luminance counts, indexed 0..255. `null` while pending or unavailable. */
  luminance: Uint32Array | null;
  /** True during the async Worker computation. False once the histogram is cached or has failed. */
  loading: boolean;
}

export function useLayerHistogram(): LayerHistogram {
  const { activeLayer } = useEditorState();
  const { pixels } = useEditorServices();

  // Cache key: use assetId as the stable identity of the bitmap content.
  // When the user replaces an image, assetId changes → new histogram is computed.
  // When the user tweaks levels/curves/adjustments, assetId stays the same → cache hit.
  const cacheKey = useMemo(() => {
    if (!activeLayer?.assetId) return '';
    return activeLayer.assetId;
  }, [activeLayer?.assetId]);

  // Version counter that ticks whenever a new histogram lands in the module
  // cache — lets us re-derive `luminance` (and `loading`) synchronously from
  // the cache during render.
  const [cacheVersion, setCacheVersion] = useState(0);

  // Both `luminance` and `loading` are pure derivations off the module cache
  // + `cacheVersion` bump.
  const luminance = useMemo<Uint32Array | null>(() => {
    if (!cacheKey) return null;
    return HISTOGRAM_CACHE.get(cacheKey) ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, cacheVersion]);
  const loading = useMemo<boolean>(() => {
    if (!cacheKey) return false;
    return !HISTOGRAM_CACHE.has(cacheKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, cacheVersion]);

  useEffect(() => {
    if (!cacheKey) return;
    // Cache hit — nothing to schedule; `loading` already resolves to false.
    if (HISTOGRAM_CACHE.has(cacheKey)) return;

    let cancelled = false;

    const compute = async () => {
      if (cancelled) return;
      try {
        // Dispatch HISTOGRAM job to the engine Worker.
        // The Worker operates on the full-resolution bitmap (no downsampling),
        // producing an accurate 256-bin Rec. 601 luminance histogram.
        const hist = await pixels.image.histogram(cacheKey);
        if (cancelled) return;
        rememberHistogram(cacheKey, hist);
      } catch {
        // Worker failed (e.g. asset not in cache, canvas tainted).
        // Histogram stays null — panel still renders, user just loses the graph.
      }
      // Bump the version so the `luminance` memo re-reads from the module
      // cache on the next render.
      setCacheVersion((v) => v + 1);
    };

    compute();

    return () => {
      cancelled = true;
    };
  }, [cacheKey, pixels]);

  return { luminance, loading };
}
