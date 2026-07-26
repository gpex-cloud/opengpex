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
 * Canvas2dBackend — Worker-side 8-bit compositing engine.
 *
 * Refactored from v1 `worker/handlers/merger.ts`.
 *
 * Responsibilities:
 * - Accepts a CompositeJob with LayerDescriptor[]
 * - Creates OffscreenCanvas →逐层调用 painter.drawLayerInstance → produces blob
 * - Handles ROI clipping, vector masks, bitmap masks, blend modes
 * - Bakes advanced filters (curves/levels/channelMix) inline before painting
 *
 * Runs exclusively in the Worker thread. Uses WorkerCache for bitmap resolution.
 */

import type { CompositeJob } from '../../protocol/jobs';
import type { LayerDescriptor } from '../../protocol/descriptors';
import { translateToRoi } from '../../protocol/descriptors';
import type { PixelResultData } from '../../protocol/results';
import type { ClipDescriptor, Shape } from '@opengpex/editor/core/types';
import { drawLayerInstance } from '../shared/painter2d';
import { workerCache } from '../../worker/cache/WorkerCache';
import { canvasToBlob, calculateHash, buildTileMeta } from '../../utils/pixel-utils';
import { shapeToPath2D } from '@opengpex/editor/core/helpers/path2d';
import { shrinkInvertedMask } from '@opengpex/editor/core/helpers/sub-pixel';
import { normalizeFilterDescriptors } from '../../protocol/normalizer';
import { applyFilterChainRGBA8 } from '../shared/filter2d';

export class Canvas2dBackend {
  /**
   * Compose layers into a single output bitmap.
   *
   * Algorithm:
   * 1. Create OffscreenCanvas at outputWidth × outputHeight
   * 2. Apply ROI clipping (translate + clip for non-rect shapes)
   * 3. For each layer descriptor: resolve bitmap → bake filters → draw
   * 4. Convert to blob, compute hash, return PixelResultData
   */
  async compose(job: CompositeJob): Promise<PixelResultData> {
    const { layers, roi, dpr, outputWidth, outputHeight } = job;

    const canvas = new OffscreenCanvas(outputWidth, outputHeight);
    const ctx = canvas.getContext('2d')!;

    // 1. ROI: set up coordinate space
    // We apply shape clipping in the scaled+translated space, then reset for layer drawing
    if (roi.type !== 'rect') {
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.translate(-roi.rect.x, -roi.rect.y);
      const clipPath = shapeToPath2D(roi as Shape);
      ctx.clip(clipPath, roi.type === 'path' ? 'evenodd' : 'nonzero');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.restore();
      // Re-apply clip in identity space via a fresh save
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.translate(-roi.rect.x, -roi.rect.y);
      const clipPath2 = shapeToPath2D(roi as Shape);
      ctx.clip(clipPath2, roi.type === 'path' ? 'evenodd' : 'nonzero');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    // 2. Draw each layer
    for (const desc of layers) {
      await this.drawLayer(ctx, canvas, desc, dpr, roi);
    }

    if (roi.type !== 'rect') {
      ctx.restore();
    }

    // 3. Produce output
    const blob = await canvasToBlob(canvas);
    const hash = await calculateHash(blob);
    const tileMeta = buildTileMeta(outputWidth, outputHeight, dpr);

    return { blob, hash, tileMeta, depth: 8, bounds: roi.rect };
  }

  /**
   * Draw a single layer descriptor onto the compositing canvas.
   */
  private async drawLayer(
    ctx: OffscreenCanvasRenderingContext2D,
    canvas: OffscreenCanvas,
    desc: LayerDescriptor,
    dpr: number,
    roi: CompositeJob['roi'],
  ): Promise<void> {
    // ─── Resolve pixel source ───
    let source: ImageBitmap | null = null;

    switch (desc.type) {
      case 'color':
        // Color layers use fillRect — no bitmap needed
        break;

      case 'text':
        // Text layers should have been pre-rasterized by CompositeDispatcher.
        // This branch is a defensive fallback — it should never be reached.
        throw new Error(
          '[Canvas2dBackend] Unexpected text layer in Worker. ' +
          'Text should be pre-rasterized by CompositeDispatcher.',
        );

      case 'image':
      case 'paint':
      default:
        if (desc.hash) {
          source = workerCache.getBitmap(desc.hash) ?? null;
          if (!source) {
            // Cache miss — this indicates ensureAssetsReady failed
            console.warn(
              `[Canvas2dBackend] WorkerCache miss: hash=${desc.hash}, assetId=${desc.assetId}. Skipping layer.`,
            );
            return;
          }
        }
        break;
    }

    // ─── Bake advanced filters (curves/levels/channelMix) inline ───
    let effectiveDesc = desc;
    let ownedBitmap: ImageBitmap | null = null;

    if (source && this.hasAdvancedFilters(desc)) {
      const baked = await this.bakeFilters(source, desc);
      if (baked) {
        source = baked.bitmap;
        ownedBitmap = baked.bitmap;
        effectiveDesc = baked.strippedDesc;
      }
    }

    // ─── Compute ROI-adjusted matrix ───
    const roiMatrix = translateToRoi(desc.worldMatrix, { x: roi.rect.x, y: roi.rect.y });
    const scaledMatrix = {
      a: roiMatrix.a * dpr,
      b: roiMatrix.b * dpr,
      c: roiMatrix.c * dpr,
      d: roiMatrix.d * dpr,
      tx: roiMatrix.tx * dpr,
      ty: roiMatrix.ty * dpr,
    };

    // ─── Build clip sequence from vector masks ───
    const clipSequence = this.buildClipSequence(effectiveDesc);

    // ─── Bitmap mask path (requires temp canvas) ───
    const hasBitmapMasks = effectiveDesc.bitmapMasks?.some(m => m.enabled) ?? false;

    if (hasBitmapMasks) {
      const tempCanvas = new OffscreenCanvas(canvas.width, canvas.height);
      const tempCtx = tempCanvas.getContext('2d')!;

      // Draw layer content to temp canvas
      drawLayerInstance(tempCtx, effectiveDesc, source, {
        matrix: scaledMatrix,
        width: effectiveDesc.bounding.w,
        height: effectiveDesc.bounding.h,
        clipSequence,
        dprScale: effectiveDesc.dprScale,
      });

      // Apply each enabled bitmap mask
      for (const bm of effectiveDesc.bitmapMasks!.filter(m => m.enabled)) {
        const maskHash = (bm as { hash?: string }).hash ?? (bm as { assetId?: string }).assetId;
        if (!maskHash) continue;

        const maskBitmap = workerCache.getBitmap(maskHash);
        if (!maskBitmap) {
          console.warn(`[Canvas2dBackend] Bitmap mask not in cache: ${maskHash}`);
          continue;
        }

        tempCtx.save();
        tempCtx.setTransform(
          scaledMatrix.a, scaledMatrix.b,
          scaledMatrix.c, scaledMatrix.d,
          scaledMatrix.tx, scaledMatrix.ty,
        );

        // Apply feather blur if specified
        const feather = (bm as { feather?: number }).feather ?? 0;
        if (feather > 0) {
          const physicalRadius = feather * scaledMatrix.a;
          tempCtx.filter = `blur(${physicalRadius}px)`;
        }

        const inverted = (bm as { inverted?: boolean }).inverted ?? false;
        tempCtx.globalCompositeOperation = inverted ? 'destination-out' : 'destination-in';

        const bounds = (bm as { bounds?: { x: number; y: number; w: number; h: number } }).bounds;
        if (bounds) {
          tempCtx.drawImage(maskBitmap, bounds.x, bounds.y, bounds.w, bounds.h);
        } else {
          tempCtx.drawImage(maskBitmap, 0, 0);
        }
        tempCtx.restore();
      }

      // Composite temp result onto main canvas
      ctx.drawImage(tempCanvas, 0, 0);
    } else {
      // ─── Standard path (no bitmap masks) ───
      drawLayerInstance(ctx, effectiveDesc, source, {
        matrix: scaledMatrix,
        width: effectiveDesc.bounding.w,
        height: effectiveDesc.bounding.h,
        clipSequence,
        dprScale: effectiveDesc.dprScale,
      });
    }

    // Release owned filtered bitmap to prevent leaks
    if (ownedBitmap) {
      ownedBitmap.close();
    }
  }

  /**
   * Build ClipDescriptor[] from vector masks in the descriptor.
   */
  private buildClipSequence(desc: LayerDescriptor): ClipDescriptor[] | undefined {
    if (!desc.vectorMasks || desc.vectorMasks.length === 0) return undefined;

    return desc.vectorMasks.map(m => ({
      shape: m.shape,
      inverted: m.inverted,
      feather: m.feather || 0,
      __compiledPath2D: shapeToPath2D(shrinkInvertedMask(m.shape, m.inverted)),
    })) as ClipDescriptor[];
  }

  /**
   * Check whether a descriptor has advanced filters that need pixel-level baking.
   * Basic adjustments (brightness/contrast/saturate/hue-rotate/blur) are handled
   * by CSS filter in painter.ts — only curves/levels/channelMix need baking.
   */
  private hasAdvancedFilters(desc: LayerDescriptor): boolean {
    return !!(desc.curves || desc.levels || desc.channelMix);
  }

  /**
   * Bake advanced filters (curves/levels/channelMix) into source bitmap.
   *
   * Uses the engine filter pipeline:
   *   1. `normalizeFilterDescriptors(desc)` (protocol/normalizer.ts) → canonical `FilterDescriptor[]`
   *   2. `applyFilterChainRGBA8(pixels, w, h, descriptors)` (rendering/shared/filter2d.ts) → pixel-level application
   *
   * This is the same algorithm used by Track B (FilterDispatcher → Worker → filterHandler)
   * and FilterFastTrack, ensuring pixel-identical results across all paths.
   *
   * Returns an owned bitmap (caller must close) and a stripped descriptor
   * with curves/levels/channelMix cleared to prevent double-application.
   */
  private async bakeFilters(
    source: ImageBitmap,
    desc: LayerDescriptor,
  ): Promise<{ bitmap: ImageBitmap; strippedDesc: LayerDescriptor } | null> {
    // Convert raw layer state (curves/levels/channelMix) into the unified
    // FilterDescriptor[] format that applyFilterChainRGBA8 consumes.
    const descriptors = normalizeFilterDescriptors(desc);
    if (descriptors.length === 0) return null;

    // Decode source bitmap into RGBA8 pixels.
    const { width, height } = source;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(source, 0, 0);
    const imageData = ctx.getImageData(0, 0, width, height);

    // Apply the full filter chain (point-ops → matrix-ops → neighborhood-ops)
    // in the canonical pipeline order via the shared isomorphic filter2d module.
    applyFilterChainRGBA8(imageData.data, width, height, descriptors);

    // Encode back to ImageBitmap.
    ctx.putImageData(imageData, 0, 0);
    const bitmap = await createImageBitmap(canvas);

    const strippedDesc: LayerDescriptor = {
      ...desc,
      curves: undefined,
      levels: undefined,
      channelMix: undefined,
    };

    return { bitmap, strippedDesc };
  }
}
