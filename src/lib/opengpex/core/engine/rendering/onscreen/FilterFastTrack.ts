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
import { hasAdvancedFilters, normalizeFilterDescriptors } from '../../protocol/normalizer';

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
   * NOTE: We intentionally do NOT set `willReadFrequently: true` here.
   * The source ImageBitmap is GPU-resident; a software-backed canvas would
   * penalize every `drawImage` call (~20ms GPU→CPU transfer per frame).
   * Without it, only the first `getImageData` triggers a one-time Chrome
   * console warning, but subsequent frames stay fast because Chrome
   * auto-optimizes the canvas backing store after the first readback.
   */
  private tempCanvas: OffscreenCanvas | null = null;
  private tempCtx: OffscreenCanvasRenderingContext2D | null = null;

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
   * Check if fast-track should be applied for this layer.
   * Returns true when the layer has advanced filters (curves/levels/channelMix)
   * AND the user is currently interacting (dragging a slider).
   */
  shouldApply(layer: FilterableLayer, isInteracting: boolean): boolean {
    if (!isInteracting) return false;
    return hasAdvancedFilters(layer as Parameters<typeof hasAdvancedFilters>[0]);
  }

  /**
   * Check if the layer has advanced filters (regardless of interaction state).
   * Used by Canvas2dEngine to decide routing.
   */
  hasAdvanced(layer: FilterableLayer): boolean {
    return hasAdvancedFilters(layer as Parameters<typeof hasAdvancedFilters>[0]);
  }

  /**
   * Normalize a layer's filter state into an ordered FilterDescriptor[].
   */
  normalize(layer: FilterableLayer): FilterDescriptor[] {
    return normalizeFilterDescriptors(layer as Parameters<typeof normalizeFilterDescriptors>[0]) as FilterDescriptor[];
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
   */
  applyInteractionPreview(
    layer: FilterableLayer,
    source: ImageBitmap,
  ): OffscreenCanvas | null {
    if (!(source instanceof ImageBitmap)) return null;

    const filters = this.normalize(layer);
    if (filters.length === 0) return null;

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

    // Reuse persistent temp canvas + context (resize only when too small)
    if (!this.tempCanvas || this.tempCanvas.width < targetW || this.tempCanvas.height < targetH) {
      this.tempCanvas = new OffscreenCanvas(targetW, targetH);
      this.tempCtx = this.tempCanvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
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

      // Produce result canvas at original dimensions
      const resultCanvas = new OffscreenCanvas(origW, origH);
      const resultCtx = resultCanvas.getContext('2d')!;
      resultCtx.drawImage(this.tempCanvas!, 0, 0, targetW, targetH, 0, 0, origW, origH);

      // Cache for bridge use after mouseUp
      if (layer.assetId) {
        this.lastInteractionResult.set(layer.assetId, resultCanvas);
      }

      return resultCanvas;
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
    this.lastInteractionResult.clear();
  }
}
