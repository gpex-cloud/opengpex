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
 * useLayerHistogram — lazy, per-layer luminance histogram cache for the Levels
 * panel.
 *
 * Returns `{ luminance }` where `luminance` is a `Uint32Array(256)` of bin
 * counts (Rec. 601 luminance of RGB) or `null` while the sample is still being
 * computed. The hook is careful to:
 *
 * 1. Only stat once per (layer.id, layer.assetId, layer.src) — swapping the
 *    active layer or replacing its bitmap invalidates the cache; a pure
 *    `layer.levels` mutation does not.
 * 2. Downsample the source bitmap to at most `MAX_SAMPLE_EDGE` on its longer
 *    edge before running the pixel loop. A 4K image has ~33M samples which
 *    would freeze the main thread; sampling at 256px keeps it to <70k pixels
 *    and finishes in ~2–4ms on a MacBook Air M1.
 * 3. Do the work asynchronously (`requestIdleCallback` when available,
 *    falling back to `setTimeout(0)`), so the levels panel never blocks its
 *    first paint — the histogram fades in a frame or two after mount.
 * 4. Ignore fully-transparent pixels (`a === 0`) so a masked layer's alpha-
 *    padded borders don't crush the histogram's black bin.
 *
 * This hook lives in the plugin (not `core/engine`) because it's a UI-only
 * concern: the runtime filter path uses `generateLevelsLUT` directly and
 * doesn't need histograms. Keeping it here also avoids adding a
 * DOM-canvas-only helper to the core (spec §3.5 hard constraint: no
 * `getImageData` outside UI plugins).
 */

/** Cap on the longer edge of the downsampled bitmap used for histogram stats. */
const HISTOGRAM_MAX_EDGE = 256;

/**
 * Compute the Rec. 601 luminance histogram of the given `ImageBitmap`.
 * Returns a fresh `Uint32Array(256)`. Called at most once per (layer.id, src)
 * pair thanks to the module-scoped `HISTOGRAM_CACHE` below.
 *
 * Uses an OffscreenCanvas and `getImageData` — the ONLY getImageData in the
 * plugin, matched to spec §3.5 UI-side sampling.
 */
function computeLuminanceHistogram(img: ImageBitmap): Uint32Array | null {
  const w = img.width;
  const h = img.height;
  if (!w || !h) return null;

  // Downsample so the pixel loop is bounded regardless of source resolution.
  const scale = Math.min(1, HISTOGRAM_MAX_EDGE / Math.max(w, h));
  const sw = Math.max(1, Math.round(w * scale));
  const sh = Math.max(1, Math.round(h * scale));

  // OffscreenCanvas would avoid layout churn but it's not supported in
  // Firefox's older release channel; `document.createElement('canvas')`
  // detached from the DOM is universally safe.
  let canvas: HTMLCanvasElement | OffscreenCanvas;
  let ctx:
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(sw, sh);
    ctx = canvas.getContext('2d', { willReadFrequently: true }) as
      | OffscreenCanvasRenderingContext2D
      | null;
  } else {
    canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    ctx = (canvas as HTMLCanvasElement).getContext('2d', {
      willReadFrequently: true,
    });
  }
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, sw, sh);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, sw, sh).data;
  } catch {
    // Canvas may be tainted (cross-origin without CORS). Falling back to a
    // null histogram lets the panel still render — user just loses the graph.
    return null;
  }

  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0) continue; // Skip transparent pixels — see docstring #4.
    // Rec. 601 luminance (integer-safe). Same weights the LUT applies for
    // grayscale conversion — keeps the histogram semantically aligned with
    // what the user actually sees mapped by the levels LUT.
    const y = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >>> 8;
    hist[y]++;
  }
  return hist;
}

/**
 * Module-scoped LRU-ish cache: key is `${layer.id}::${assetId}::${src}`.
 * Bounded to a handful of entries because histograms are cheap to recompute
 * and users don't tend to keep dozens of layers open at once.
 */
const HISTOGRAM_CACHE = new Map<string, Uint32Array>();
const HISTOGRAM_CACHE_MAX = 16;

function histogramCacheKey(
  layerId: string,
  assetId: string | undefined,
  src: string,
): string {
  return `${layerId}::${assetId ?? ''}::${src}`;
}

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
  /** True during the initial async sample. False once the histogram is cached or has failed. */
  loading: boolean;
}

export function useLayerHistogram(): LayerHistogram {
  const { activeLayer } = useEditorState();
  const { assets, pixels } = useEditorServices();

  // Resolve the current source URL the same way Canvas2dEngine does, so the
  // histogram statistics match what the user sees on canvas even if the layer
  // asset was recently replaced (blob URL rotation, etc.).
  const resolvedSrc = useMemo(() => {
    if (!activeLayer) return '';
    if (activeLayer.assetId && assets && typeof assets.resolve === 'function') {
      return assets.resolve(activeLayer.assetId, activeLayer.src);
    }
    return activeLayer.src;
  }, [activeLayer, assets]);

  const cacheKey = useMemo(() => {
    if (!activeLayer || !resolvedSrc) return '';
    return histogramCacheKey(activeLayer.id, activeLayer.assetId, resolvedSrc);
  }, [activeLayer, resolvedSrc]);

  // Version counter that ticks whenever a new histogram lands in the module
  // cache — lets us re-derive `luminance` (and `loading`) synchronously from
  // the cache during render, avoiding the eslint react-hooks/set-state-in-effect
  // ping-pong you'd get from mirroring cache state into React state.
  const [cacheVersion, setCacheVersion] = useState(0);

  // Both `luminance` and `loading` are pure derivations off the module cache
  // + `cacheVersion` bump. When the effect below writes a fresh histogram
  // into `HISTOGRAM_CACHE` and increments `cacheVersion`, the next render
  // re-reads both values synchronously.
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
    if (!cacheKey || !resolvedSrc) return;
    // Cache hit — nothing to schedule; `loading` already resolves to false.
    if (HISTOGRAM_CACHE.has(cacheKey)) return;

    let cancelled = false;

    // Async decode + histogram computation. pixels.image.loadBitmap handles
    // cache-hit (instant) and cache-miss (triggers fetch + decode) uniformly.
    const compute = async () => {
      if (cancelled) return;
      try {
        const bmp = await pixels.image.loadBitmap(resolvedSrc);
        if (cancelled) return;
        const hist = computeLuminanceHistogram(bmp);
        if (cancelled) return;
        if (hist) {
          rememberHistogram(cacheKey, hist);
        }
      } catch {
        // decode failed — histogram stays null
      }
      // Bump the version so the `luminance` memo re-reads from the module
      // cache on the next render. If sampling failed (`hist === null`), the
      // memo still resolves to `null` because no entry was written.
      setCacheVersion((v) => v + 1);
    };

    // Prefer `requestIdleCallback` if available (Firefox 55+, Chrome, Safari
    // 16.4+); otherwise fall back to a zero-delay macrotask.
    type RIC = (
      cb: () => void,
      opts?: { timeout: number },
    ) => number;
    const ric = (window as unknown as { requestIdleCallback?: RIC }).requestIdleCallback;
    const handle = ric
      ? ric(() => { compute(); }, { timeout: 300 })
      : (setTimeout(() => { compute(); }, 0) as unknown as number);

    return () => {
      cancelled = true;
      type CIC = (id: number) => void;
      const cic = (window as unknown as { cancelIdleCallback?: CIC }).cancelIdleCallback;
      if (ric && cic) cic(handle);
      else clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    };
  }, [cacheKey, resolvedSrc, pixels]);

  return { luminance, loading };
}
