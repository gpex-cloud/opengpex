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
import type { LayerHistogramData } from '@opengpex/editor/core/engine/color/histograms';
import {
  useEditorState,
  useEditorServices,
} from '@opengpex/editor/core/context';

// ─── useLayerHistogram ─────────────────────────────────────────────────────────

/**
 * useLayerHistogram — full-resolution, per-layer source histograms via Worker.
 *
 * Returns `{ histogram }` where `histogram` is a `LayerHistogramData` — five
 * 256-bin arrays (`r` / `g` / `b` / `luma` / `composite`) — or `null` while
 * the computation is still pending. `composite` is the per-bin r+g+b sum
 * matching Photoshop's Levels dialog "RGB" channel; `luma` is per-pixel
 * Rec.601. These are SOURCE histograms: they describe the layer's bitmap and
 * deliberately do NOT react to levels/curves edits — panels derive the output
 * distribution from them via `deriveLayerHistogram` (see
 * `core/engine/color/histograms.ts`). The hook is careful to:
 *
 * 1. Only compute once per `layer.assetId` — swapping the active layer or
 *    replacing its bitmap invalidates the cache; a pure `layer.levels` or
 *    `layer.curves` mutation does not trigger recomputation.
 * 2. Compute on FULL resolution pixels in the Worker thread — no downsampling.
 *    This eliminates the bilinear interpolation artifacts that the old 256px
 *    thumbnail approach introduced, producing results that match Photoshop's
 *    Levels dialog histogram.
 * 3. Use the Photoshop composite algorithm: for each pixel, independently
 *    count R, G, B channel values, then sum the three histograms into one
 *    composite. This preserves individual channel peaks rather than collapsing
 *    them into a single weighted-luminance value.
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
 * Module-scoped FIFO cache: key is `layer.assetId`. Eviction drops the entry
 * that was inserted first (Map preserves insertion order); cache hits do NOT
 * re-insert, so this is not an LRU. Bounded to a handful of entries because
 * histograms are cheap to recompute and users don't tend to keep dozens of
 * layers open at once.
 */
const HISTOGRAM_CACHE = new Map<string, LayerHistogramData>();
const HISTOGRAM_CACHE_MAX = 16;

function rememberHistogram(key: string, hist: LayerHistogramData) {
  if (HISTOGRAM_CACHE.size >= HISTOGRAM_CACHE_MAX) {
    // Drop the oldest entry (Map preserves insertion order).
    const firstKey = HISTOGRAM_CACHE.keys().next().value;
    if (firstKey !== undefined) HISTOGRAM_CACHE.delete(firstKey);
  }
  HISTOGRAM_CACHE.set(key, hist);
}

export interface LayerHistogram {
  /** Five 256-bin source histograms. `null` while pending or unavailable. */
  histogram: LayerHistogramData | null;
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
  // cache — lets us re-derive `histogram` (and `loading`) synchronously from
  // the cache during render.
  const [cacheVersion, setCacheVersion] = useState(0);

  // Both `histogram` and `loading` are pure derivations off the module cache
  // + `cacheVersion` bump.
  const histogram = useMemo<LayerHistogramData | null>(() => {
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
        // producing the five 256-bin source histograms.
        const hist = await pixels.image.histogram(cacheKey);
        if (cancelled) return;
        rememberHistogram(cacheKey, hist);
      } catch {
        // Worker failed (e.g. asset not in cache, canvas tainted).
        // Histogram stays null — panel still renders, user just loses the graph.
      }
      // Bump the version so the `histogram` memo re-reads from the module
      // cache on the next render.
      setCacheVersion((v) => v + 1);
    };

    compute();

    return () => {
      cancelled = true;
    };
  }, [cacheKey, pixels]);

  return { histogram, loading };
}
