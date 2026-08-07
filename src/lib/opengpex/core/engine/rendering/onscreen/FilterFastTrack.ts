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
 * FilterFastTrack — Track A: Main-thread synchronous filter preview.
 *
 * Architecture (Phase 1 / Phase 4 dual-track):
 * - Track A (this module): During `isInteracting=true`, applies LUT + ColorMatrix
 *   directly on the main thread in <1ms. Guarantees 60fps slider response.
 * - Track B (Worker): Full-resolution async filter via AsyncFilterCache (Phase 4).
 *
 * Flow in Canvas2dEngine.flush():
 *   1. `shouldApply()` checks if the layer has advanced filters AND user is interacting.
 *   2. `applyInteractionPreview()` builds fused LUT/matrix, applies to a temp canvas,
 *      returns an OffscreenCanvas ready for painter to use as `source`.
 *   3. On mouseUp, the bridge cache keeps the last Track A frame visible until
 *      Worker returns the full-res result (no flash).
 *
 * Extracted from v1 Canvas2dEngine.resolveFilteredSource (interaction path).
 */

import type { Layer } from '@opengpex/editor/core/types';
import type { FilterDescriptor } from '../../protocol/IFilter';
import { MAX_REALTIME_FILTER_PIXELS } from '@opengpex/editor/core/helpers/config';
import { buildFusedLUTs, applyLUTsRGBA8, buildFusedColorMatrix, applyMatrixRGBA8, applyColorBalanceRGBA8 } from '../shared/filter2d';
import { hasFilters as hasFiltersGate, normalizeFilterDescriptors } from '../../protocol/normalizer';

/**
 * Minimal layer shape consumed by FilterFastTrack.
 */
export interface FilterableLayer {
  assetId?: string;
  adjustments?: Layer['adjustments'];
  curves?: Layer['curves'];
  levels?: Layer['levels'];
  channelMix?: Layer['channelMix'];
  colorBalance?: Layer['colorBalance'];
}

/**
 * FilterFastTrack — main-thread synchronous LUT/matrix preview engine.
 */
export class FilterFastTrack {
  /**
   * Reusable temp canvas — avoids per-frame allocation.
   * Resized only when current canvas is too small.
   *
   * Uses `willReadFrequently: true` because Track A always calls
   * `getImageData` after `drawImage`. With a CPU-backed canvas the
   * `getImageData` call is nearly zero-copy (~0.1ms) instead of triggering
   * a GPU→CPU readback stall (~5-8ms). The trade-off is a slightly slower
   * initial `drawImage` from GPU ImageBitmap → CPU canvas (~3-5ms), but
   * the net per-frame cost is lower (3-5ms vs 6-9ms without the flag).
   */
  private tempCanvas: OffscreenCanvas | null = null;
  private tempCtx: OffscreenCanvasRenderingContext2D | null = null;

  /**
   * Per-asset result canvases — each layer gets its own dedicated canvas to
   * prevent cross-layer data corruption when multiple layers have filters.
   *
   * Bug fix: previously a single shared `resultCanvas` was reused. When two
   * layers had filters, the second layer's computation overwrote the first's
   * data. On the transitional frame (isInteracting → false), BRIDGE returned
   * the shared canvas now containing the wrong layer's pixels → flash.
   */
  private resultCanvasMap: Map<string, { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D }> = new Map();

  /**
   * Frame cache: stores the filter parameter hash per assetId.
   * When pan/zoom causes redraws without filter param changes,
   * we skip the expensive recompute and return the cached result directly.
   */
  private cachedFilterHash: Map<string, string> = new Map();

  /**
   * Bridge cache: last Track A result per assetId.
   * Used to prevent flash on mouseUp — keeps the last synchronous LUT frame
   * visible until Worker returns the full-res result.
   */
  private lastInteractionResult: Map<string, OffscreenCanvas> = new Map();

  // ────────────────────────────────────────────────────────────
  // Public API
  // ────────────────────────────────────────────────────────────

  /**
   * Check if the layer has ANY non-identity filter (regardless of interaction state).
   * Used by Canvas2dEngine to decide routing into the filter pipeline.
   * Replaces the former hasAdvanced() which only checked curves/levels/channelMix/colorBalance.
   */
  hasFilters(layer: FilterableLayer): boolean {
    return hasFiltersGate(layer as Parameters<typeof hasFiltersGate>[0]);
  }

  /**
   * Normalize a layer's filter state into an ordered FilterDescriptor[].
   */
  normalize(layer: FilterableLayer): FilterDescriptor[] {
    return normalizeFilterDescriptors(layer as Parameters<typeof normalizeFilterDescriptors>[0]) as FilterDescriptor[];
  }

  /**
   * Compute a lightweight hash of the layer's filter state.
   * Used to detect whether filters actually changed between frames.
   * JSON.stringify on these small objects is faster than any custom hash
   * for this data size (~0.01ms).
   */
  private computeFilterHash(layer: FilterableLayer): string {
    return JSON.stringify([
      layer.adjustments,
      layer.curves,
      layer.levels,
      layer.channelMix,
      layer.colorBalance,
    ]);
  }

  /**
   * Apply synchronous LUT + ColorMatrix preview to an ImageBitmap source.
   *
   * Returns a replacement OffscreenCanvas (or null if processing fails).
   * The returned canvas has all advanced filters "baked in", so the caller
   * should strip `adjustments` from the layer before painting (to avoid
   * double-applying via ctx.filter).
   *
   * Performance budget: <2ms for 4MP images (downsampled), <5ms for 1MP.
   *
   * Frame Cache Strategy:
   * - On pan/zoom the filter params don't change → hash matches → return
   *   cached OffscreenCanvas immediately (<0.1ms instead of ~16ms).
   * - On slider drag the params change each frame → hash differs → full
   *   recompute (same cost as before, no regression).
   */
  applyInteractionPreview(
    layer: FilterableLayer,
    source: ImageBitmap,
  ): OffscreenCanvas | null {
    if (!(source instanceof ImageBitmap)) return null;

    const filters = this.normalize(layer);
    if (filters.length === 0) return null;

    const assetId = layer.assetId;

    // ──── Frame Cache Hit ────
    // If filter params haven't changed since last frame, return cached result
    // directly. This is the pan/zoom case — viewport moved but filters are identical.
    if (assetId) {
      const newHash = this.computeFilterHash(layer);
      const oldHash = this.cachedFilterHash.get(assetId);
      if (oldHash === newHash) {
        const cached = this.lastInteractionResult.get(assetId);
        if (cached) return cached; // ← zero-cost return!
      }
      this.cachedFilterHash.set(assetId, newHash);
    }

    // ──── Cache Miss: Full Recompute ────
    const origW = source.width;
    const origH = source.height;
    const pixels = origW * origH;
    const needsDownsample = pixels > MAX_REALTIME_FILTER_PIXELS;

    let targetW = origW;
    let targetH = origH;
    if (needsDownsample) {
      const scale = Math.sqrt(MAX_REALTIME_FILTER_PIXELS / pixels);
      targetW = Math.round(origW * scale);
      targetH = Math.round(origH * scale);
    }

    // Reuse persistent temp canvas + context (resize only when too small).
    // `willReadFrequently: true` ensures CPU-backed storage so getImageData
    // is near zero-copy instead of triggering GPU readback stalls.
    if (!this.tempCanvas || this.tempCanvas.width < targetW || this.tempCanvas.height < targetH) {
      this.tempCanvas = new OffscreenCanvas(targetW, targetH);
      this.tempCtx = this.tempCanvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null;
    }
    const tempCtx = this.tempCtx;
    if (!tempCtx) return null;

    try {
      tempCtx.clearRect(0, 0, targetW, targetH);
      tempCtx.drawImage(source, 0, 0, targetW, targetH);

      const imgData = tempCtx.getImageData(0, 0, targetW, targetH);

      // Apply collapsed LUT filters (curves, levels, brightness, contrast)
      const luts = buildFusedLUTs(filters, 256, 'u8');
      if (luts) {
        applyLUTsRGBA8(imgData.data, luts);
      }

      // Apply color matrix filters (saturation, hueRotate, channelMix)
      const mtx = buildFusedColorMatrix(filters);
      if (mtx) {
        applyMatrixRGBA8(imgData.data, mtx.matrix, mtx.constant);
      }

      // Apply color balance (per-pixel luminance-weighted offset — cannot fuse into LUT/matrix)
      const cb = filters.find((f): f is Extract<FilterDescriptor, { type: 'colorBalance' }> => f.type === 'colorBalance');
      if (cb) {
        applyColorBalanceRGBA8(
          imgData.data,
          cb.data.shadows,
          cb.data.midtones,
          cb.data.highlights,
          cb.data.preserveLuminosity,
        );
      }

      tempCtx.putImageData(imgData, 0, 0);

      // Produce result canvas at original dimensions.
      // Per-asset canvases ensure BRIDGE never returns another layer's data.
      const key = assetId || '__no_asset__';
      let entry = this.resultCanvasMap.get(key);
      if (!entry || entry.canvas.width !== origW || entry.canvas.height !== origH) {
        entry = {
          canvas: new OffscreenCanvas(origW, origH),
          ctx: null!,
        };
        entry.ctx = entry.canvas.getContext('2d')!;
        this.resultCanvasMap.set(key, entry);
        // Bound pool size (evict oldest if > 8 entries)
        if (this.resultCanvasMap.size > 8) {
          const firstKey = this.resultCanvasMap.keys().next().value;
          if (firstKey && firstKey !== key) this.resultCanvasMap.delete(firstKey);
        }
      }
      entry.ctx.clearRect(0, 0, origW, origH);
      entry.ctx.drawImage(this.tempCanvas!, 0, 0, targetW, targetH, 0, 0, origW, origH);

      // Cache for bridge use after mouseUp + frame cache reuse on next pan/zoom frame
      if (assetId) {
        this.lastInteractionResult.set(assetId, entry.canvas);
      }

      return entry.canvas;
    } catch (err) {
      console.warn('[FilterFastTrack] Synchronous filter apply failed:', err);
      return null;
    }
  }

  /**
   * Retrieve the last Track A result for an asset (bridge cache).
   * Used when isInteracting flips to false but Worker hasn't returned yet.
   */
  getBridgeResult(assetId: string): OffscreenCanvas | null {
    return this.lastInteractionResult.get(assetId) ?? null;
  }

  /**
   * Clear the bridge cache entry for an asset (called when Worker delivers full-res).
   */
  clearBridgeResult(assetId: string): void {
    this.lastInteractionResult.delete(assetId);
  }

  /**
   * Release all cached resources.
   */
  dispose(): void {
    this.tempCanvas = null;
    this.tempCtx = null;
    this.resultCanvasMap.clear();
    this.cachedFilterHash.clear();
    this.lastInteractionResult.clear();
  }
}
