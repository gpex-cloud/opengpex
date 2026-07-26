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
 * VipsBackend — Worker-side 16/32-bit high-precision compositing engine.
 *
 * Refactored from v1 `files/handlers/tiff.ts` multi-layer composite logic.
 *
 * Architecture (phase5_highdepth.md §2):
 * - Accepts any CompositeJob with precision >= 16
 * - Layers with vectorMask / bitmapMask / text type → Canvas2dBackend pre-render (8-bit fallback)
 * - Plain image layers → native vips float compositing (full precision)
 * - Non-rect ROI → vips native alpha mask clip (shape → 8-bit mask → float, source data stays float)
 * - Output: uint16 TIFF (precision 16) or float32 TIFF (precision 32)
 *
 * Invariants (architecture doc §六):
 * - §六.7: Full-depth fidelity — no "downgrade to 8-bit then back" in the main path
 * - §六.8: Degradation is a compromise — fallback code marked with TODO comments
 * - §六.9: No `any` types — uses typed VipsImage/VipsInstance from worker/vips/types.d.ts
 *
 * Resource management:
 * - Every VipsImage created MUST be .delete()'d to avoid WASM memory leaks
 * - Intermediate images are tracked and cleaned up in finally blocks
 */

import type { CompositeJob } from '../../protocol/jobs';
import type { LayerDescriptor } from '../../protocol/descriptors';
import type { PixelResultData } from '../../protocol/results';
import type { Shape } from '@opengpex/editor/core/types';
import type { VipsInstance, VipsImage } from '../../worker/vips/types';
import { getVips } from '../../worker/vips/loader';
import { Canvas2dBackend } from './Canvas2dBackend';
import { workerCache } from '../../worker/cache/WorkerCache';
import { calculateHash, buildTileMeta, canvasToBlob } from '../../utils/pixel-utils';
import { shapeToPath2D } from '@opengpex/editor/core/helpers/path2d';

// ─── Internal Types ───

interface VipsLayerInput {
  image: VipsImage;
  opacity: number;
  blendMode: string;
  /** True when this layer was pre-rendered via Canvas2d (8-bit precision loss) */
  is8bitFallback: boolean;
}

// ─── Blend Mode Mapping ───

/**
 * CSS/canvas blend mode → vips VipsBlendMode enum.
 * Reference: libvips documentation — `VipsBlendMode` enum values.
 */
const BLEND_MODE_MAP: Record<string, number> = {
  'normal': 0,       // VIPS_BLEND_MODE_OVER
  'multiply': 1,     // VIPS_BLEND_MODE_MULTIPLY
  'screen': 2,       // VIPS_BLEND_MODE_SCREEN
  'overlay': 3,      // VIPS_BLEND_MODE_OVERLAY
  'darken': 4,       // VIPS_BLEND_MODE_DARKEN
  'lighten': 5,      // VIPS_BLEND_MODE_LIGHTEN
  'colour-dodge': 6, // VIPS_BLEND_MODE_COLOUR_DODGE
  'color-dodge': 6,  // alias
  'colour-burn': 7,  // VIPS_BLEND_MODE_COLOUR_BURN
  'color-burn': 7,   // alias
  'hard-light': 8,   // VIPS_BLEND_MODE_HARD_LIGHT
  'soft-light': 9,   // VIPS_BLEND_MODE_SOFT_LIGHT
  'difference': 10,  // VIPS_BLEND_MODE_DIFFERENCE
  'exclusion': 11,   // VIPS_BLEND_MODE_EXCLUSION
};

export class VipsBackend {
  private canvas2dFallback: Canvas2dBackend;

  constructor() {
    this.canvas2dFallback = new Canvas2dBackend();
  }

  /**
   * Compose layers at high precision (16 or 32 bit).
   *
   * Algorithm:
   * 1. Pre-process each layer (native vips or Canvas2d fallback)
   * 2. Composite all layers onto a float canvas
   * 3. Apply non-rect ROI clip via vips alpha mask
   * 4. Encode output as TIFF (uint16 or float32)
   * 5. Clean up all vips image resources
   */
  async compose(job: CompositeJob): Promise<PixelResultData> {
    const vips = await getVips();
    const { layers, roi, outputWidth, outputHeight, precision, dpr } = job;

    const processedLayers: VipsLayerInput[] = [];
    const imagesToCleanup: VipsImage[] = [];

    try {
      // 1. Pre-process each layer
      for (const desc of layers) {
        const layerInput = await this.processLayer(desc, job, vips);
        processedLayers.push(layerInput);
        imagesToCleanup.push(layerInput.image);
      }

      // 2. Composite all layers
      let composited = this.composeLayers(processedLayers, outputWidth, outputHeight, vips);
      imagesToCleanup.push(composited);

      // 3. Non-rect ROI clip (vips native alpha mask — no precision downgrade)
      if (roi.type !== 'rect') {
        const clipped = await this.applyShapeClip(composited, roi, outputWidth, outputHeight, vips);
        imagesToCleanup.push(clipped);
        composited = clipped;
      }

      // 4. Encode output
      let outputBuffer: Uint8Array;
      let depth: 8 | 16 | 32;

      if (precision >= 32) {
        // float32 TIFF
        outputBuffer = composited.writeToBuffer('.tiff', { depth: 'float' });
        depth = 32;
      } else {
        // uint16 TIFF
        outputBuffer = composited.writeToBuffer('.tiff', { depth: 'ushort' });
        depth = 16;
      }

      const outputBlob = new Blob([outputBuffer.buffer as ArrayBuffer], { type: 'image/tiff' });
      const hash = await calculateHash(outputBlob);
      const tileMeta = buildTileMeta(outputWidth, outputHeight, dpr);

      return { blob: outputBlob, hash, tileMeta, depth, bounds: roi.rect };
    } finally {
      // 5. Clean up all vips images to prevent WASM memory leaks
      for (const img of imagesToCleanup) {
        try {
          img.delete();
        } catch {
          // Best-effort cleanup — image may already be deleted if shared
        }
      }
    }
  }

  // ─── Layer Processing ───────────────────────────────────────────────────────

  /**
   * Process a single layer descriptor into a VipsLayerInput.
   *
   * Decides between native vips path (high precision) and Canvas2d fallback (8-bit).
   */
  private async processLayer(
    desc: LayerDescriptor,
    job: CompositeJob,
    vips: VipsInstance,
  ): Promise<VipsLayerInput> {
    if (this.needsFallback(desc)) {
      // TODO: Replace with native vips implementation when available
      // Degradation: Canvas2d pre-render → 8-bit PNG → vips Image
      return this.processLayerViaFallback(desc, job, vips);
    }

    // Native vips: load from raw buffer in WorkerCache
    return this.processLayerNative(desc, vips);
  }

  /**
   * Native vips path: load high-precision buffer directly.
   */
  private processLayerNative(desc: LayerDescriptor, vips: VipsInstance): VipsLayerInput {
    const assetId = desc.assetId ?? desc.hash;
    if (!assetId) {
      throw new Error('[VipsBackend] Layer has no assetId or hash for native vips path');
    }

    // Try raw buffer first (16/32-bit source), then fall back to blob
    const rawBuffer = workerCache.getRawBuffer(assetId);
    let image: VipsImage;

    if (rawBuffer) {
      image = vips.Image.newFromBuffer(new Uint8Array(rawBuffer));
    } else {
      // Fallback: try the hash-based raw buffer
      const hashBuffer = workerCache.getRawBuffer(desc.hash);
      if (hashBuffer) {
        image = vips.Image.newFromBuffer(new Uint8Array(hashBuffer));
      } else {
        throw new Error(
          `[VipsBackend] No raw buffer in WorkerCache for assetId=${assetId}, hash=${desc.hash}. ` +
          'Ensure high-precision assets are ingested with setRawBuffer().',
        );
      }
    }

    return {
      image,
      opacity: desc.opacity,
      blendMode: desc.blendMode,
      is8bitFallback: false,
    };
  }

  /**
   * Fallback path: pre-render layer via Canvas2dBackend → read into vips.
   *
   * Used for layers that vips cannot handle natively:
   * - vectorMask, bitmapMask, text (needs rasterization)
   *
   * NOTE: This introduces an 8-bit precision bottleneck for this specific layer.
   * The compositing still happens in float, but the layer data is 8-bit.
   */
  private async processLayerViaFallback(
    desc: LayerDescriptor,
    job: CompositeJob,
    vips: VipsInstance,
  ): Promise<VipsLayerInput> {
    // TODO: Replace with native vips implementation when available
    // Pre-render single layer at 8-bit via Canvas2dBackend
    const singleLayerJob: CompositeJob = {
      ...job,
      layers: [desc],
      precision: 8,
    };

    const fallbackResult = await this.canvas2dFallback.compose(singleLayerJob);
    const pngBuffer = new Uint8Array(await fallbackResult.blob.arrayBuffer());
    const image = vips.Image.newFromBuffer(pngBuffer);

    return {
      image,
      opacity: 1.0, // Opacity already applied by Canvas2dBackend
      blendMode: 'normal', // Blend mode already applied by Canvas2dBackend
      is8bitFallback: true,
    };
  }

  // ─── Compositing ───────────────────────────────────────────────────────────

  /**
   * Composite all processed layers onto a transparent float canvas.
   *
   * Algorithm:
   * 1. Create transparent float RGBA base image
   * 2. For each layer: cast to float → apply opacity → composite with blend mode
   */
  private composeLayers(
    layers: VipsLayerInput[],
    width: number,
    height: number,
    vips: VipsInstance,
  ): VipsImage {
    // Create transparent float RGBA base: black with alpha=0
    const black = vips.Image.black(width, height);
    let base = black.newFromImage([0, 0, 0, 0]).cast('float');
    black.delete();

    for (const layer of layers) {
      let img = layer.image.cast('float');

      // Ensure RGBA (add alpha band if missing)
      if (img.bands === 3) {
        // Add fully opaque alpha band
        const opaqueAlpha = img.newFromImage([1.0]);
        const withAlpha = img.bandjoin(opaqueAlpha);
        opaqueAlpha.delete();
        img.delete();
        img = withAlpha;
      }

      // Apply layer opacity to alpha channel
      if (layer.opacity < 1.0) {
        const rgb = img.extractBand(0, { n: 3 });
        const alpha = img.extractBand(3);
        const scaledAlpha = alpha.multiply(layer.opacity);
        alpha.delete();
        const opacified = rgb.bandjoin(scaledAlpha);
        rgb.delete();
        scaledAlpha.delete();
        img.delete();
        img = opacified;
      }

      // Composite using vips blend mode
      const mode = this.mapBlendMode(layer.blendMode);
      const newBase = base.composite(img, mode);
      base.delete();
      img.delete();
      base = newBase;
    }

    return base;
  }

  // ─── ROI Shape Clipping ────────────────────────────────────────────────────

  /**
   * Non-rect ROI clip — uses vips native alpha mask, full precision preserved.
   *
   * Strategy (phase5 §2, applyShapeClip):
   * 1. Rasterize shape → 8-bit grayscale mask via Canvas2D (mask itself is 8-bit — sufficient)
   * 2. Normalize mask to float [0, 1]
   * 3. Multiply composited alpha channel by mask (RGB precision untouched)
   * 4. Reassemble RGBA
   *
   * The source image data stays in float precision throughout.
   * Only the mask is 8-bit — this is acceptable because mask resolution
   * doesn't need more than 256 levels of edge antialiasing.
   */
  private async applyShapeClip(
    composited: VipsImage,
    roi: Shape,
    width: number,
    height: number,
    vips: VipsInstance,
  ): Promise<VipsImage> {
    // 1. Rasterize shape to 8-bit mask (white = visible, black = clipped)
    const maskCanvas = new OffscreenCanvas(width, height);
    const ctx = maskCanvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    const clipPath = shapeToPath2D(roi);
    ctx.fill(clipPath, 'evenodd');

    // 2. Export mask to PNG → read into vips
    const maskBlob = await canvasToBlob(maskCanvas);
    const maskBuffer = new Uint8Array(await maskBlob.arrayBuffer());
    const maskImage = vips.Image.newFromBuffer(maskBuffer);

    // 3. Extract first band → normalize to [0, 1] float
    const band0 = maskImage.extractBand(0);
    const alphaMask = band0.cast('float').divide(255.0);
    band0.delete();
    maskImage.delete();

    // 4. Multiply composited alpha by mask (preserves RGB precision)
    const rgb = composited.extractBand(0, { n: 3 });
    const existingAlpha = composited.extractBand(3);
    const clippedAlpha = existingAlpha.multiply(alphaMask);
    existingAlpha.delete();
    alphaMask.delete();

    // 5. Reassemble RGBA
    const result = rgb.bandjoin(clippedAlpha);
    rgb.delete();
    clippedAlpha.delete();

    return result;
  }

  // ─── Utility ───────────────────────────────────────────────────────────────

  /**
   * Determine if a layer requires Canvas2d fallback.
   *
   * Conditions that require fallback:
   * - Has vector masks (vips has no path-based masking)
   * - Has bitmap masks that are enabled (complex alpha compositing)
   * - Is a text layer (needs DOM-based rasterization first)
   */
  private needsFallback(desc: LayerDescriptor): boolean {
    return !!(
      (desc.vectorMasks && desc.vectorMasks.length > 0) ||
      desc.bitmapMasks?.some(m => m.enabled) ||
      desc.type === 'text'
    );
  }

  /**
   * Map CSS/canvas blend mode string to vips VipsBlendMode enum value.
   * Falls back to OVER (normal) for unmapped modes.
   */
  private mapBlendMode(mode: string): number {
    return BLEND_MODE_MAP[mode] ?? 0; // Default to VIPS_BLEND_MODE_OVER
  }
}
