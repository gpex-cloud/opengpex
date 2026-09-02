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
 * - Creates OffscreenCanvas → iterates layers via painter.drawLayerInstance → produces blob
 * - Handles ROI clipping, vector masks, bitmap masks, blend modes
 * - Bakes advanced filters (curves/levels/channelMix) inline before painting
 *
 * Runs exclusively in the Worker thread. Uses WorkerCache for bitmap resolution.
 */

import type { CompositeJob } from '../../protocol/jobs';
import type { LayerDescriptor } from '../../protocol/descriptors';
import { translateToRoi } from '../../protocol/descriptors';
import type { PixelResultData } from '../../protocol/results';
import type { ClipDescriptor, Shape, TRC } from '@opengpex/editor/core/types';
import { drawLayerInstance } from '../shared/painter2d';
import { workerCache } from '../../worker/cache/WorkerCache';
import { canvasToBlob, calculateHash, buildTileMeta } from '../../utils/pixel-utils';
import { shapeToPath2D } from '@opengpex/editor/core/helpers/path2d';
import { normalizeFilterDescriptors, hasFilters } from '../../protocol/normalizer';
import { applyFilterChainRGBA8 } from '../shared/filter2d';
import { convertBufferTRC } from '../shared/trc';
import { blendBuffersLinear } from '../shared/blend2d';

export class Canvas2dBackend {
  /**
   * Compose layers into a single output bitmap.
   *
   * Algorithm:
   * 1. Create OffscreenCanvas at outputWidth × outputHeight
   * 2. Apply ROI clipping (translate + clip for non-rect shapes)
   * 3. For each layer descriptor: resolve bitmap → bake filters → draw
   * 4. Convert to blob, compute hash, return PixelResultData
   *
   * Phase B: When `compositeTRC === 'linear'`, uses manual per-pixel blending
   * in linear-light space instead of Canvas 2D's gamma-space globalCompositeOperation.
   */
  async compose(job: CompositeJob): Promise<PixelResultData> {
    const { layers, roi, dpr, outputWidth, outputHeight } = job;
    const compositeTRC: TRC = job.compositeTRC ?? 'srgb-trc';

    // ─── Phase B: Linear-light compositing path ───
    if (compositeTRC === 'linear') {
      return this.composeLinear(job);
    }

    // ─── Legacy gamma-space path (default) ───
    const canvasColorSpace: PredefinedColorSpace = job.compositeColorSpace ?? 'srgb';
    const canvas = new OffscreenCanvas(outputWidth, outputHeight);
    const ctx = canvas.getContext('2d', { colorSpace: canvasColorSpace })!;

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
      await this.drawLayer(ctx, canvas, desc, dpr, roi, canvasColorSpace);
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

  // ════════════════════════════════════════════════════════════════
  // Phase B: Linear-Light Compositing
  // ════════════════════════════════════════════════════════════════

  /**
   * Linear-light compositing path.
   *
   * Because Canvas 2D's `globalCompositeOperation` always operates in gamma space,
   * we must perform manual per-pixel blending when linear-light compositing is requested.
   *
   * Algorithm:
   * 1. Render each layer to an isolated temp canvas (using Canvas 2D for transforms/masks)
   * 2. Extract layer's ImageData, convert RGB to linear encoding
   * 3. Blend manually into the destination buffer using blend2d module
   * 4. After all layers, convert the accumulated result back to sRGB-TRC
   * 5. Write final result to output canvas → blob
   *
   * Performance: ~2ms TRC conversion + ~4ms blend per 4K layer (acceptable for offscreen export).
   * Onscreen preview (Canvas2dEngine) continues to use the native gamma-space path.
   *
   */
  private async composeLinear(job: CompositeJob): Promise<PixelResultData> {
    const { layers, roi, dpr, outputWidth, outputHeight } = job;
    const canvasColorSpace: PredefinedColorSpace = job.compositeColorSpace ?? 'srgb';

    // Destination accumulator buffer (starts as transparent black, linear encoding)
    const dstData = new Uint8ClampedArray(outputWidth * outputHeight * 4);

    // Process each layer
    for (const desc of layers) {
      const layerPixels = await this.renderLayerToPixels(desc, dpr, roi, outputWidth, outputHeight, canvasColorSpace);
      if (!layerPixels) continue;

      // Convert layer pixels from sRGB-TRC to linear-light
      convertBufferTRC(layerPixels, 'srgb-trc', 'linear');

      // Manual per-pixel blend in linear space
      const blendMode = desc.blendMode ?? 'source-over';
      const opacity = desc.opacity ?? 1;
      const blendColorSpace: 'srgb' | 'display-p3' = canvasColorSpace === 'display-p3' ? 'display-p3' : 'srgb';
      blendBuffersLinear(dstData, layerPixels, blendMode, opacity, blendColorSpace);
    }

    // Convert accumulated result from linear back to sRGB-TRC for display/export
    convertBufferTRC(dstData, 'linear', 'srgb-trc');

    // Write to output canvas
    const canvas = new OffscreenCanvas(outputWidth, outputHeight);
    const ctx = canvas.getContext('2d', { colorSpace: canvasColorSpace })!;
    const imageData = new ImageData(dstData, outputWidth, outputHeight, { colorSpace: canvasColorSpace });
    ctx.putImageData(imageData, 0, 0);

    // Apply ROI shape clipping if non-rect
    if (roi.type !== 'rect') {
      const maskCanvas = new OffscreenCanvas(outputWidth, outputHeight);
      const maskCtx = maskCanvas.getContext('2d', { colorSpace: canvasColorSpace })!;
      maskCtx.scale(dpr, dpr);
      maskCtx.translate(-roi.rect.x, -roi.rect.y);
      const clipPath = shapeToPath2D(roi as Shape);
      maskCtx.clip(clipPath, roi.type === 'path' ? 'evenodd' : 'nonzero');
      maskCtx.setTransform(1, 0, 0, 1, 0, 0);
      maskCtx.drawImage(canvas, 0, 0);
      ctx.clearRect(0, 0, outputWidth, outputHeight);
      ctx.drawImage(maskCanvas, 0, 0);
    }

    // Produce output
    const blob = await canvasToBlob(canvas);
    const hash = await calculateHash(blob);
    const tileMeta = buildTileMeta(outputWidth, outputHeight, dpr);

    return { blob, hash, tileMeta, depth: 8, bounds: roi.rect };
  }

  /**
   * Render a single layer descriptor to an RGBA8 pixel buffer at the target composite size.
   *
   * Uses a temporary OffscreenCanvas with identity blend mode (source-over) to handle:
   * - World matrix transforms
   * - Vector/bitmap masks
   * - Filter baking
   *
   * The resulting pixels are encoded in the specified `canvasColorSpace` (sRGB-TRC values
   * within that color space). The caller is responsible for converting to linear if needed.
   *
   * @param canvasColorSpace - The color space for intermediate canvases. Ensures P3 bitmaps
   *   are not implicitly converted to sRGB when drawn. Defaults to 'srgb'.
   *
   * Returns null if the layer cannot be rendered (e.g., missing bitmap cache).
   */
  private async renderLayerToPixels(
    desc: LayerDescriptor,
    dpr: number,
    roi: CompositeJob['roi'],
    outputWidth: number,
    outputHeight: number,
    canvasColorSpace: PredefinedColorSpace = 'srgb',
  ): Promise<Uint8ClampedArray | null> {
    // Create isolated temp canvas for this layer
    const tempCanvas = new OffscreenCanvas(outputWidth, outputHeight);
    const tempCtx = tempCanvas.getContext('2d', { colorSpace: canvasColorSpace })!;

    // Resolve pixel source
    let source: ImageBitmap | null = null;

    switch (desc.type) {
      case 'color':
        break;
      case 'text':
        throw new Error('[Canvas2dBackend] Unexpected text layer in linear path.');
      case 'image':
      case 'paint':
      default:
        if (desc.hash) {
          source = workerCache.getBitmap(desc.hash) ?? null;
          if (!source) {
            console.warn(
              `[Canvas2dBackend/linear] WorkerCache miss: hash=${desc.hash}. Skipping layer.`,
            );
            return null;
          }
        }
        break;
    }

    // Bake filters
    let effectiveDesc = desc;
    let ownedBitmap: ImageBitmap | null = null;

    if (source && this.hasFiltersForBaking(desc)) {
      const baked = await this.bakeFilters(source, desc, canvasColorSpace);
      if (baked) {
        source = baked.bitmap;
        ownedBitmap = baked.bitmap;
        effectiveDesc = baked.strippedDesc;
      }
    }

    // Draw layer with source-over (no blend mode — blend is done manually later)
    // We render the layer "as-is" into the temp canvas at full opacity,
    // because opacity and blend mode are applied during the manual blend step.
    const roiMatrix = translateToRoi(desc.worldMatrix, { x: roi.rect.x, y: roi.rect.y });
    const scaledMatrix = {
      a: roiMatrix.a * dpr,
      b: roiMatrix.b * dpr,
      c: roiMatrix.c * dpr,
      d: roiMatrix.d * dpr,
      tx: roiMatrix.tx * dpr,
      ty: roiMatrix.ty * dpr,
    };

    const clipSequence = this.buildClipSequence(effectiveDesc);

    // Override blend mode and opacity for isolated rendering
    const isolatedDesc: LayerDescriptor = {
      ...effectiveDesc,
      blendMode: 'source-over',
      opacity: 1,
    };

    // Handle bitmap masks
    const hasBitmapMasks = effectiveDesc.bitmapMasks?.some(m => m.enabled) ?? false;

    if (hasBitmapMasks) {
      const layerCanvas = new OffscreenCanvas(outputWidth, outputHeight);
      const layerCtx = layerCanvas.getContext('2d', { colorSpace: canvasColorSpace })!;

      drawLayerInstance(layerCtx, isolatedDesc, source, {
        matrix: scaledMatrix,
        width: effectiveDesc.bounding.w,
        height: effectiveDesc.bounding.h,
        clipSequence,
        dprScale: effectiveDesc.dprScale,
      });

      // Apply bitmap masks
      for (const bm of effectiveDesc.bitmapMasks!.filter(m => m.enabled)) {
        const maskHash = (bm as { hash?: string }).hash ?? (bm as { assetId?: string }).assetId;
        if (!maskHash) continue;
        const maskBitmap = workerCache.getBitmap(maskHash);
        if (!maskBitmap) continue;

        layerCtx.save();
        layerCtx.setTransform(
          scaledMatrix.a, scaledMatrix.b,
          scaledMatrix.c, scaledMatrix.d,
          scaledMatrix.tx, scaledMatrix.ty,
        );
        const feather = (bm as { feather?: number }).feather ?? 0;
        if (feather > 0) {
          layerCtx.filter = `blur(${feather * scaledMatrix.a}px)`;
        }
        const inverted = (bm as { inverted?: boolean }).inverted ?? false;
        layerCtx.globalCompositeOperation = inverted ? 'destination-out' : 'destination-in';
        const bounds = (bm as { bounds?: { x: number; y: number; w: number; h: number } }).bounds;
        if (bounds) {
          layerCtx.drawImage(maskBitmap, bounds.x, bounds.y, bounds.w, bounds.h);
        } else {
          layerCtx.drawImage(maskBitmap, 0, 0);
        }
        layerCtx.restore();
      }

      tempCtx.drawImage(layerCanvas, 0, 0);
    } else {
      drawLayerInstance(tempCtx, isolatedDesc, source, {
        matrix: scaledMatrix,
        width: effectiveDesc.bounding.w,
        height: effectiveDesc.bounding.h,
        clipSequence,
        dprScale: effectiveDesc.dprScale,
      });
    }

    // Release owned bitmap
    if (ownedBitmap) {
      ownedBitmap.close();
    }

    // Extract pixel data
    const imageData = tempCtx.getImageData(0, 0, outputWidth, outputHeight);
    return imageData.data;
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
    canvasColorSpace: PredefinedColorSpace = 'srgb',
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

    if (source && this.hasFiltersForBaking(desc)) {
      const baked = await this.bakeFilters(source, desc, canvasColorSpace);
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
      const tempCtx = tempCanvas.getContext('2d', { colorSpace: canvasColorSpace })!;

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
   *
   * NOTE: No `shrinkInvertedMask` here. That helper is a **viewport-only** seam
   * prevention trick — it shifts inverted clips inward by 0.75/scale physical
   * pixels so the fragment layer covers the AA border at non-100% zoom levels.
   *
   * In the offline compositing path (mergeVisible / mergeDown / rasterize / export),
   * the result is permanently baked into pixel data. Shrinking would:
   *   1. Push integer-coordinate rect clips to non-integer → introduce Canvas2D AA
   *      on edges that were originally pixel-perfect.
   *   2. Shift curve clips (ellipse/path) inward with no paired fragment expansion
   *      to compensate → visible gap between hole and fragment after merge.
   *   3. Bake the AA artifact permanently into the merged asset.
   *
   * At 1:1 compositing scale there is no sub-pixel zoom seam to prevent, so the
   * original shape coordinates are used as-is.
   */
  private buildClipSequence(desc: LayerDescriptor): ClipDescriptor[] | undefined {
    const pipeline: ClipDescriptor[] = [];

    // ── visibleShape clip (mirrors StageComposer.getRenderPipeline) ───────────
    // When visibleShape is non-rect (circle/path), drawLayerContent's drawImage
    // only reads .rect (bounding box), so the irregular outline must be enforced
    // via an explicit clip. For plain rect visibleShape, the drawImage source
    // rectangle already achieves the same effect — no clip needed.
    if (desc.visibleShape && desc.visibleShape.type !== 'rect') {
      pipeline.push({
        shape: desc.visibleShape,
        inverted: false,
        feather: 0,
        __compiledPath2D: shapeToPath2D(desc.visibleShape),
      } as ClipDescriptor);
    }

    // ── vectorMask clips ─────────────────────────────────────────────────────
    if (desc.vectorMasks) {
      for (const m of desc.vectorMasks) {
        pipeline.push({
          shape: m.shape,
          inverted: m.inverted,
          feather: m.feather || 0,
          __compiledPath2D: shapeToPath2D(m.shape),
        } as ClipDescriptor);
      }
    }

    return pipeline.length > 0 ? pipeline : undefined;
  }

  /**
   * Check whether a descriptor has ANY non-identity filter that needs pixel-level baking.
   * All adjustments (brightness/contrast/saturation/hueRotate) plus advanced filters
   * (curves/levels/channelMix/colorBalance) are now baked via the unified LUT/Matrix pipeline.
   * Only blur is excluded (handled separately by the offscreen composite path).
   */
  private hasFiltersForBaking(desc: LayerDescriptor): boolean {
    return hasFilters(desc as Parameters<typeof hasFilters>[0]);
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
    canvasColorSpace: PredefinedColorSpace = 'srgb',
  ): Promise<{ bitmap: ImageBitmap; strippedDesc: LayerDescriptor } | null> {
    // Convert raw layer state (curves/levels/channelMix) into the unified
    // FilterDescriptor[] format that applyFilterChainRGBA8 consumes.
    const descriptors = normalizeFilterDescriptors(desc);
    if (descriptors.length === 0) return null;

    // Decode source bitmap into RGBA8 pixels.
    // Use the correct colorSpace to prevent implicit P3→sRGB conversion when drawing the bitmap.
    const { width, height } = source;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { colorSpace: canvasColorSpace })!;
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
      adjustments: desc.adjustments?.blur
        ? { brightness: 100, contrast: 100, saturation: 100, hueRotate: 0, blur: desc.adjustments.blur }
        : undefined,
      curves: undefined,
      levels: undefined,
      channelMix: undefined,
      colorBalance: undefined,
    };

    return { bitmap, strippedDesc };
  }
}
