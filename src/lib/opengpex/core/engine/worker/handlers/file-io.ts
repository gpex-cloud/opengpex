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
 * FileIoHandler — Worker-side handler for FILE_IO jobs.
 *
 * Provides TIFF decode/encode, multi-page support, 16-bit composite export,
 * and high-res export — all powered by the shared wasm-vips singleton
 * (`worker/vips/loader.ts`).
 *
 * Architecture (phase7_2_vips_unification.md §2):
 * - Shares vips instance with VipsBackend (composite 16/32-bit)
 * - Replaces the standalone `/ext/wasm/vips/vips-worker.js` usage from tiff.ts
 * - Called via FILE_IO Job routed by router.ts
 */

import { getVips } from '../vips/loader';
import type { VipsInstance, VipsImage } from '../vips/types';
import type { FileIoJob } from '../../protocol/jobs';
import type { RouterResult } from '../router';

export class FileIoHandler {
  async handle(job: FileIoJob): Promise<RouterResult> {
    const vips = await getVips();

    switch (job.fn) {
      case 'decodeTiff':
        return this.decodeTiff(vips, job.bytes!);

      case 'encodeTiff':
        return this.encodeTiff(vips, job.rgbaData!, job.width!, job.height!, job.options || {});

      case 'getPageCount':
        return this.getPageCount(vips, job.bytes!);

      case 'decodePage':
        return this.decodePage(vips, job.bytes!, job.page ?? 0);

      case 'decodePages':
        return this.decodePage(vips, job.bytes!, job.page ?? 0);

      case 'composite16bit':
        return this.composite16bit(vips, job);

      case 'exportHighRes':
        return this.exportHighRes(vips, job.bytes!, job.options || {});

      default:
        throw new Error(`[FileIoHandler] Unknown fn: ${(job as { fn: string }).fn}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // decodeTiff — Decode TIFF bytes → RGBA pixel data (8-bit output)
  // ═══════════════════════════════════════════════════════════════════════════

  private decodeTiff(
    vips: VipsInstance,
    bytes: Uint8Array,
  ): { result: { width: number; height: number; data: Uint8Array }; transfer: Transferable[] } {
    const image = vips.Image.newFromBuffer(bytes, '', { page: 0, access: 'sequential' });

    // Convert to sRGB if needed (handles CMYK, Lab, etc.)
    let rgb: VipsImage = image;
    if (image.interpretation !== 'srgb' && image.interpretation !== 'b-w') {
      rgb = image.colourspace('srgb');
    }

    // Ensure 8-bit
    let img8: VipsImage = rgb;
    if (rgb.format !== 'uchar') {
      if (rgb.format === 'ushort') {
        img8 = rgb.linear(1.0 / 257.0, 0).cast('uchar');
      } else {
        img8 = rgb.cast('uchar');
      }
    }

    // Ensure RGBA
    let rgba: VipsImage = img8;
    if (!img8.hasAlpha()) {
      rgba = img8.bandjoin(255);
    } else if (img8.bands > 4) {
      rgba = img8.extractBand(0, { n: 4 });
    }

    const width = rgba.width;
    const height = rgba.height;
    const rawBuffer = rgba.writeToBuffer('.raw');
    const data = new Uint8Array(rawBuffer);

    // Cleanup
    image.delete();
    if (rgb !== image) rgb.delete();
    if (img8 !== rgb) img8.delete();
    if (rgba !== img8) rgba.delete();

    return { result: { width, height, data }, transfer: [data.buffer] };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // encodeTiff — Encode RGBA pixel data → TIFF bytes
  // ═══════════════════════════════════════════════════════════════════════════

  private encodeTiff(
    vips: VipsInstance,
    rgbaData: Uint8Array,
    width: number,
    height: number,
    options: Record<string, unknown>,
  ): { result: Uint8Array; transfer: Transferable[] } {
    const {
      compression = 'lzw',
      dpi = 72,
      iccProfileBytes,
      jpegQuality = 85,
      predictor = 'none',
      bigtiff = false,
      tile = false,
      tileWidth = 256,
      tileHeight = 256,
    } = options as {
      compression?: string;
      dpi?: number;
      iccProfileBytes?: Uint8Array;
      jpegQuality?: number;
      predictor?: string;
      bigtiff?: boolean;
      tile?: boolean;
      tileWidth?: number;
      tileHeight?: number;
    };

    const image = vips.Image.newFromMemory(rgbaData, width, height, 4, 'uchar');

    // Attach ICC Profile if provided
    if (iccProfileBytes && iccProfileBytes.length > 0) {
      try {
        image.set('icc-profile-data', iccProfileBytes);
      } catch (e) {
        // Non-critical: ICC attachment failure
        console.warn('[FileIoHandler] ICC attachment failed:', (e as Error).message);
      }
    }

    const compressionMap: Record<string, string> = { none: 'none', lzw: 'lzw', zip: 'deflate', jpeg: 'jpeg' };
    const vipsCompression = compressionMap[compression as string] || 'lzw';

    // Build tiff save options
    const saveOpts: Record<string, unknown> = {
      compression: vipsCompression,
      xres: (dpi as number) / 25.4,
      yres: (dpi as number) / 25.4,
      resunit: 'inch',
      bigtiff,
    };

    // JPEG compression requires tiling and quality parameter
    if (compression === 'jpeg') {
      saveOpts.Q = jpegQuality;
      saveOpts.tile = true;
      saveOpts.tile_width = tileWidth;
      saveOpts.tile_height = tileHeight;
    } else if (tile) {
      saveOpts.tile = true;
      saveOpts.tile_width = tileWidth;
      saveOpts.tile_height = tileHeight;
    }

    // Predictor (only effective for LZW/ZIP)
    if ((compression === 'lzw' || compression === 'zip') && predictor !== 'none') {
      const predictorMap: Record<string, string> = { horizontal: 'horizontal', float: 'float' };
      saveOpts.predictor = predictorMap[predictor as string] || 'none';
    }

    const tiffBuffer = image.writeToBuffer('.tiff', saveOpts);
    image.delete();

    const result = new Uint8Array(tiffBuffer);
    return { result, transfer: [result.buffer] };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // getPageCount — Get page count and per-page dimensions of multi-page TIFF
  // ═══════════════════════════════════════════════════════════════════════════

  private getPageCount(
    vips: VipsInstance,
    bytes: Uint8Array,
  ): { result: { pages: number; pageWidth: number; pageHeight: number } } {
    // First, try metadata-based detection (fast path)
    let metadataPages = 0;
    try {
      const testImg = vips.Image.newFromBuffer(bytes, '', { access: 'sequential' });
      try { metadataPages = testImg.get('n-pages') as number; } catch { /* ignore */ }
      testImg.delete();
    } catch { /* ignore */ }

    if (metadataPages > 1) {
      const firstPage = vips.Image.newFromBuffer(bytes, '', { page: 0, access: 'sequential' });
      const pageWidth = firstPage.width;
      const pageHeight = firstPage.height;
      firstPage.delete();
      return { result: { pages: metadataPages, pageWidth, pageHeight } };
    }

    // Fallback: probe pages by trying to load them sequentially
    const page0 = vips.Image.newFromBuffer(bytes, '', { page: 0, access: 'sequential' });
    const pageWidth = page0.width;
    const pageHeight = page0.height;
    page0.delete();

    let pages = 1;
    const MAX_PAGES = 1000;
    for (let i = 1; i < MAX_PAGES; i++) {
      try {
        const testPage = vips.Image.newFromBuffer(bytes, '', { page: i, access: 'sequential' });
        testPage.delete();
        pages++;
      } catch {
        break;
      }
    }

    return { result: { pages, pageWidth, pageHeight } };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // decodePage — Decode a specific page of a multi-page TIFF to RGBA
  // ═══════════════════════════════════════════════════════════════════════════

  private decodePage(
    vips: VipsInstance,
    bytes: Uint8Array,
    page: number,
  ): { result: { width: number; height: number; data: Uint8Array }; transfer: Transferable[] } {
    const image = vips.Image.newFromBuffer(bytes, '', { page, access: 'sequential' });

    // Convert to sRGB if needed
    let rgb: VipsImage = image;
    if (image.interpretation !== 'srgb' && image.interpretation !== 'b-w') {
      rgb = image.colourspace('srgb');
    }

    // Ensure 8-bit
    let img8: VipsImage = rgb;
    if (rgb.format !== 'uchar') {
      if (rgb.format === 'ushort') {
        img8 = rgb.linear(1.0 / 257.0, 0).cast('uchar');
      } else {
        img8 = rgb.cast('uchar');
      }
    }

    // Ensure RGBA
    let rgba: VipsImage = img8;
    if (!img8.hasAlpha()) {
      rgba = img8.bandjoin(255);
    } else if (img8.bands > 4) {
      rgba = img8.extractBand(0, { n: 4 });
    }

    const width = rgba.width;
    const height = rgba.height;
    const rawBuffer = rgba.writeToBuffer('.raw');
    const data = new Uint8Array(rawBuffer);

    // Cleanup
    image.delete();
    if (rgb !== image) rgb.delete();
    if (img8 !== rgb) img8.delete();
    if (rgba !== img8) rgba.delete();

    return { result: { width, height, data }, transfer: [data.buffer] };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // composite16bit — Multi-layer 16-bit composite export
  // ═══════════════════════════════════════════════════════════════════════════

  private composite16bit(
    vips: VipsInstance,
    job: FileIoJob,
  ): { result: Uint8Array; transfer: Transferable[] } {
    const layers = job.layers || [];
    const canvasWidth = job.canvasWidth!;
    const canvasHeight = job.canvasHeight!;
    const outputOptions = (job.options || {}) as {
      format?: string;
      compression?: string;
      dpi?: number;
      jpegQuality?: number;
      bigtiff?: boolean;
      tile?: boolean;
      tileWidth?: number;
      tileHeight?: number;
    };

    const {
      format = 'tiff',
      compression = 'lzw',
      dpi = 72,
      jpegQuality = 85,
      bigtiff = false,
      tile = false,
      tileWidth = 256,
      tileHeight = 256,
    } = outputOptions;

    // Create transparent 16-bit RGBA base canvas
    let base = vips.Image.black(canvasWidth, canvasHeight, { bands: 4 }).cast('ushort');

    const overlayImages: VipsImage[] = [];
    const blendModes: number[] = [];
    const xPositions: number[] = [];
    const yPositions: number[] = [];

    for (const layer of layers) {
      try {
        let img = vips.Image.newFromBuffer(layer.bytes, '', { access: 'sequential' });

        // Convert to sRGB if needed
        if (img.interpretation !== 'srgb' && img.interpretation !== 'b-w' && img.interpretation !== 'rgb16') {
          img = img.colourspace('srgb');
        }

        // If 8-bit source, upscale to 16-bit (value * 257)
        if (layer.is8bit || img.format === 'uchar') {
          img = img.linear(257.0, 0).cast('ushort');
        } else if (img.format === 'float' || img.format === 'double') {
          img = img.linear(65535.0, 0).cast('ushort');
        }

        // Ensure RGBA (4 bands)
        if (!img.hasAlpha()) {
          const alpha = vips.Image.black(img.width, img.height).add(65535).cast('ushort');
          img = img.bandjoin(alpha);
        }
        if (img.bands > 4) {
          img = img.extractBand(0, { n: 4 });
        }

        // Apply opacity by scaling the alpha channel
        if (layer.opacity < 1.0) {
          const rgb = img.extractBand(0, { n: 3 });
          const alpha = img.extractBand(3).linear(layer.opacity, 0);
          img = rgb.bandjoin(alpha);
        }

        // Apply per-layer adjustments in full 16-bit precision
        img = this.applyAdjustments16bit(vips, img, layer.adjustments);

        overlayImages.push(img);
        blendModes.push((vips.BlendMode as Record<string, number>)[layer.blendMode] ?? (vips.BlendMode as Record<string, number>).over);
        xPositions.push(Math.round(layer.x));
        yPositions.push(Math.round(layer.y));
      } catch (err) {
        console.warn('[FileIoHandler] Failed to process layer:', (err as Error).message);
      }
    }

    // Composite all layers onto base
    if (overlayImages.length > 0) {
      base = base.composite(overlayImages, blendModes, {
        x: xPositions,
        y: yPositions,
      });
    }

    // Ensure output is 16-bit ushort RGBA
    if (base.format !== 'ushort') {
      base = base.cast('ushort');
    }

    // Write output
    let outputBytes: Uint8Array;
    if (format === 'png') {
      outputBytes = base.writeToBuffer('.png', { bitdepth: 16 });
    } else {
      const compressionMap: Record<string, string> = { none: 'none', lzw: 'lzw', zip: 'deflate', jpeg: 'jpeg' };
      const vipsCompression = compressionMap[compression] || 'lzw';
      const saveOpts: Record<string, unknown> = {
        bitdepth: 16,
        compression: vipsCompression,
        xres: dpi / 25.4,
        yres: dpi / 25.4,
        resunit: 'inch',
        bigtiff,
      };
      if (compression === 'jpeg') {
        saveOpts.Q = jpegQuality;
        saveOpts.tile = true;
        saveOpts.tile_width = tileWidth;
        saveOpts.tile_height = tileHeight;
        // JPEG TIFF doesn't support 16-bit, downcast to 8-bit
        base = base.linear(1.0 / 257.0, 0).cast('uchar');
        delete saveOpts.bitdepth;
      } else if (tile) {
        saveOpts.tile = true;
        saveOpts.tile_width = tileWidth;
        saveOpts.tile_height = tileHeight;
      }
      outputBytes = base.writeToBuffer('.tiff', saveOpts);
    }

    // Cleanup
    base.delete();
    for (const img of overlayImages) img.delete();

    return { result: outputBytes, transfer: [outputBytes.buffer] };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // exportHighRes — 16-bit high-resolution export from raw source bytes
  // ═══════════════════════════════════════════════════════════════════════════

  private exportHighRes(
    vips: VipsInstance,
    rawBytes: Uint8Array,
    options: Record<string, unknown>,
  ): { result: Uint8Array; transfer: Transferable[] } {
    const {
      format = 'tiff',
      compression = 'lzw',
      pngCompression = 6,
      dpi = 72,
      crop,
      resize,
      iccProfileBytes,
      adjustments,
    } = options as {
      format?: string;
      compression?: string;
      pngCompression?: number;
      dpi?: number;
      crop?: { x: number; y: number; w: number; h: number };
      resize?: { w: number; h: number };
      iccProfileBytes?: Uint8Array;
      adjustments?: Record<string, unknown>;
    };

    // 1. Load image from raw bytes at full precision
    let image = vips.Image.newFromBuffer(rawBytes, '', { page: 0, access: 'sequential' });

    // 2. Convert to sRGB color space if needed (preserving bit depth)
    if (image.interpretation !== 'srgb' && image.interpretation !== 'b-w'
        && image.interpretation !== 'rgb16') {
      image = image.colourspace('srgb');
    }

    // 3. Apply crop if specified
    if (crop && crop.x >= 0 && crop.y >= 0 && crop.w > 0 && crop.h > 0) {
      image = image.extractArea(crop.x, crop.y, crop.w, crop.h);
    }

    // 4. Apply resize if specified
    if (resize && resize.w > 0 && resize.h > 0) {
      const hscale = resize.w / image.width;
      const vscale = resize.h / image.height;
      image = image.resize(hscale, { vscale });
    }

    // 4.5. Apply adjustments in 16-bit domain
    if (adjustments) {
      if (image.format !== 'ushort') {
        if (image.format === 'uchar') {
          image = image.linear(257.0, 0).cast('ushort');
        } else {
          image = image.cast('ushort');
        }
      }
      image = this.applyAdjustments16bit(vips, image, adjustments);
    }

    // 5. Ensure 16-bit precision for output
    if (image.format === 'uchar') {
      image = image.linear(257.0, 0).cast('ushort');
    } else if (image.format === 'float' || image.format === 'double') {
      image = image.linear(65535.0, 0).cast('ushort');
    }

    // 6. Attach ICC Profile if provided
    if (iccProfileBytes && iccProfileBytes.length > 0) {
      try {
        image.set('icc-profile-data', iccProfileBytes);
      } catch {
        // Non-critical: ICC attachment failure
      }
    }

    // 7. Write output in requested format
    let outputBytes: Uint8Array;
    if (format === 'png') {
      outputBytes = image.writeToBuffer('.png', {
        bitdepth: 16,
        compression: pngCompression,
      });
    } else {
      const compressionMap: Record<string, string> = { none: 'none', lzw: 'lzw', zip: 'deflate' };
      const vipsCompression = compressionMap[compression as string] || 'lzw';
      outputBytes = image.writeToBuffer('.tiff', {
        bitdepth: 16,
        compression: vipsCompression,
        xres: (dpi as number) / 25.4,
        yres: (dpi as number) / 25.4,
        resunit: 'inch',
      });
    }

    image.delete();

    return { result: outputBytes, transfer: [outputBytes.buffer] };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // applyAdjustments16bit — Apply layer adjustments in full 16-bit precision
  // ═══════════════════════════════════════════════════════════════════════════

  private applyAdjustments16bit(
    vips: VipsInstance,
    img: VipsImage,
    adj: Record<string, unknown> | undefined,
  ): VipsImage {
    if (!adj) return img;

    const hasAlpha = img.hasAlpha();
    const nRgbBands = hasAlpha ? img.bands - 1 : img.bands;

    // 1. Brightness: linear scale on RGB bands only
    if (adj.brightness !== undefined && adj.brightness !== 100) {
      const scale = (adj.brightness as number) / 100.0;
      const rgb = img.extractBand(0, { n: nRgbBands });
      const scaledRgb = rgb.linear(scale, 0).cast('ushort');
      if (hasAlpha) {
        const alpha = img.extractBand(nRgbBands);
        img = scaledRgb.bandjoin(alpha);
      } else {
        img = scaledRgb;
      }
    }

    // 2. Contrast: linear scale around 16-bit midpoint (32768)
    if (adj.contrast !== undefined && adj.contrast !== 100) {
      const scale = (adj.contrast as number) / 100.0;
      const offset = 32768 * (1 - scale);
      const rgb = img.extractBand(0, { n: nRgbBands });
      const scaledRgb = rgb.linear(scale, offset).cast('ushort');
      if (hasAlpha) {
        const alpha = img.extractBand(nRgbBands);
        img = scaledRgb.bandjoin(alpha);
      } else {
        img = scaledRgb;
      }
    }

    // 3. Saturation + hueRotate: convert to LCh, adjust C and H, convert back
    if ((adj.saturation !== undefined && adj.saturation !== 100) ||
        (adj.hueRotate !== undefined && adj.hueRotate !== 0)) {
      let workImg = img;
      if (workImg.interpretation !== 'srgb') {
        workImg = workImg.colourspace('srgb');
      }
      const lch = workImg.colourspace('lch');
      const L = lch.extractBand(0);
      let C: VipsImage = lch.extractBand(1);
      let H: VipsImage = lch.extractBand(2);

      if (adj.saturation !== undefined && adj.saturation !== 100) {
        C = C.linear((adj.saturation as number) / 100.0, 0);
      }
      if (adj.hueRotate !== undefined && adj.hueRotate !== 0) {
        H = H.linear(1, adj.hueRotate as number).remainder(360);
      }

      const adjustedLch = L.bandjoin([C, H]);
      const adjustedRgb = adjustedLch.colourspace('srgb');

      if (hasAlpha) {
        const alpha = img.extractBand(nRgbBands);
        img = adjustedRgb.bandjoin(alpha).cast('ushort');
      } else {
        img = adjustedRgb.cast('ushort');
      }
    }

    // 4. Blur: Gaussian blur on RGB bands
    if (adj.blur !== undefined && (adj.blur as number) > 0) {
      const sigma = (adj.blur as number) * 0.1;
      const rgb = img.extractBand(0, { n: nRgbBands });
      const blurredRgb = rgb.gaussblur(sigma).cast('ushort');
      if (hasAlpha) {
        const alpha = img.extractBand(nRgbBands);
        img = blurredRgb.bandjoin(alpha);
      } else {
        img = blurredRgb;
      }
    }

    return img;
  }
}
