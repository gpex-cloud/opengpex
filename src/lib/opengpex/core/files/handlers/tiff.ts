/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * TIFF Format Handler (wasm-vips powered).
 *
 * Supports: RGB/RGBA 8-bit (uncompressed / LZW / ZIP / JPEG), 16-bit (quantized to 8-bit),
 *           CMYK (basic conversion), BigTIFF, multi-page (first page only).
 *
 * Responsibilities:
 * - Decode: TIFF → PNG via engine Worker (FILE_IO job) + IFD metadata extraction
 * - Encode: ImageData → TIFF via engine Worker (FILE_IO job)
 * - Metadata: Main-thread IFD tag parsing for fast DPI/colorspace/compression info
 *
 * Thread model (Phase 7.2 — vips unification):
 * - All vips operations flow through the unified engine Worker via PixelService.fileIO
 * - vips WASM loads once (shared singleton in Worker with VipsBackend composite)
 * - IFD metadata extraction runs on main thread (lightweight header-only parse, <10ms)
 *
 * Library: wasm-vips (libvips compiled to WebAssembly)
 * - Full TIFF support including JPEG compression, BigTIFF, multi-page
 * - ICC-accurate CMYK → sRGB conversion
 * - LGPL license (dynamically loaded WASM module, not statically linked)
 */

import ExifReader from 'exifreader';
import type { AssetService, PixelService, AdjustmentState } from '@opengpex/editor/core/types';
import type {
  ImageFormatHandler,
  ImageMetadata,
  DecodeOptions,
  DecodeResult,
  EncodeOptions,
} from '../types';
// ICC utilities: base64ToIcc is dynamically imported in encode() for export injection

/** TIFF compression method for encoding */
export type TiffCompression = 'none' | 'lzw' | 'zip' | 'jpeg';

/** Extended encode options for TIFF */
export interface TiffEncodeOptions extends EncodeOptions {
  /** TIFF compression method (default: 'lzw') */
  tiffCompression?: TiffCompression;
  /** JPEG quality (1-100) for TIFF JPEG compression. Only used when tiffCompression='jpeg'. Default: 85. */
  jpegQuality?: number;
  /** Predictor for LZW/ZIP (default: 'none'). */
  tiffPredictor?: 'none' | 'horizontal' | 'float';
  /** Byte order: 'lsb' (Intel) or 'msb' (Motorola). Default: 'lsb'. */
  tiffByteOrder?: 'lsb' | 'msb';
  /** Enable BigTIFF format (>4GB support). Default: false. */
  tiffBigtiff?: boolean;
  /** Enable tile layout (default: false = strip). JPEG forces tile on. */
  tiffTile?: boolean;
  /** Tile width pixels (default: 256). */
  tiffTileWidth?: number;
  /** Tile height pixels (default: 256). */
  tiffTileHeight?: number;
}

export class TiffHandler implements ImageFormatHandler {
  readonly format = 'tiff';
  readonly needsTranscoding = true;
  readonly mimeTypes = ['image/tiff'];
  readonly extensions = ['tiff', 'tif'];

  constructor(
    private assets: AssetService,
    private pixels: PixelService,
  ) {}

  // ─── Decode ──────────────────────────────────────────────────────────────

  async decode(file: File, _options?: DecodeOptions): Promise<DecodeResult> {
    // 1. Extract metadata first (lightweight, main thread — IFD tag parsing)
    const metadata = await this.extractMetadata(file);
    metadata.internalCodec = 'image/png';

    // 2. Decode TIFF → PNG via engine Worker (FILE_IO job, first page)
    const pngBlob = await this.convertTiffToBlob(file);
    const safeFile = new File(
      [pngBlob],
      file.name.replace(/\.(tiff?|tif)$/i, '.png'),
      { type: 'image/png' },
    );

    // 3. Get dimensions from transcoded result
    const img = await createImageBitmap(safeFile);
    const dimensions = { w: img.width, h: img.height };
    img.close();

    // 4. Detect multi-page TIFF and build subImages
    let subImages: import('../types').SubImage[];
    let sourceBlob: Blob | undefined;

    try {
      const pageInfo = await this.getPageCount(file);
      if (pageInfo.pages > 1) {
        // Multi-page: decode all pages → subImages
        const allPages = await this.decodeAllPages(file, pageInfo.pages);
        subImages = allPages.map(p => ({
          displayBlob: p.blob,
          width: p.width,
          height: p.height,
          index: p.index,
        }));
        // Multi-page TIFF always preserves source for per-page extraction
        sourceBlob = file;
      } else {
        subImages = [{ displayBlob: pngBlob, width: dimensions.w, height: dimensions.h, index: 0 }];
        // Preserve source only for 16-bit fidelity
        sourceBlob = metadata.bitDepth > 8 ? file : undefined;
      }
    } catch (err) {
      console.debug('[TiffHandler] Multi-page detection failed (treating as single page):', (err as Error).message);
      subImages = [{ displayBlob: pngBlob, width: dimensions.w, height: dimensions.h, index: 0 }];
      sourceBlob = metadata.bitDepth > 8 ? file : undefined;
    }

    return { dimensions, metadata, subImages, sourceBlob };
  }

  // ─── Encode ──────────────────────────────────────────────────────────────

  async encode(
    source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
    options: EncodeOptions,
  ): Promise<Blob> {
    const tiffOpts = options as TiffEncodeOptions;
    const compression = tiffOpts.tiffCompression || 'lzw';
    const dpi = options.exportConfig?.dpi || options.metadata?.dpi || 72;

    // Get ImageData from source
    const canvas = source instanceof ImageBitmap
      ? bitmapToOffscreen(source)
      : source;

    const ctx = (canvas as OffscreenCanvas).getContext('2d')!;
    let imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // ICC Profile for embedding
    let iccProfileBytes: Uint8Array | undefined;
    if (options.exportConfig?.embedIcc && options.metadata?.raw?.iccProfileData) {
      const { base64ToIcc: b64ToIcc } = await import('../icc');
      iccProfileBytes = b64ToIcc(options.metadata.raw.iccProfileData);

      // Convert pixel data from sRGB to target ICC color space (only if non-sRGB profile)
      const colorSpace = options.metadata.colorSpace;
      if (colorSpace && colorSpace !== 'srgb') {
        const { data: convertedData } = await this.pixels.fileIO.srgbToIcc(
          new Uint8Array(imageData.data.buffer),
          canvas.width, canvas.height, iccProfileBytes,
        );
        const clamped = new Uint8ClampedArray(convertedData.length);
        clamped.set(convertedData);
        imageData = new ImageData(clamped, canvas.width, canvas.height);
      }
    }

    // Encode via engine Worker (FILE_IO job)
    const tiffBlob = await this.encodeTiffFromImageData(imageData, {
      compression,
      dpi,
      width: canvas.width,
      height: canvas.height,
      iccProfileBytes,
      jpegQuality: tiffOpts.jpegQuality,
      predictor: tiffOpts.tiffPredictor,
      bigtiff: tiffOpts.tiffBigtiff,
      tile: tiffOpts.tiffTile,
      tileWidth: tiffOpts.tiffTileWidth,
      tileHeight: tiffOpts.tiffTileHeight,
    });

    return tiffBlob;
  }

  // ─── Metadata Extraction ─────────────────────────────────────────────────

  async extractMetadata(file: File): Promise<ImageMetadata> {
    const base: ImageMetadata = {
      version: 1,
      sourceFormat: 'tiff',
      sourceFileName: file.name,
      sourceFileSize: file.size,
      dpi: 72,
      dpiSource: 'default',
      colorSpace: 'srgb',
      bitDepth: 8,
      hasAlpha: false,
      hasIccProfile: false,
    };

    try {
      const fileBuffer = await file.arrayBuffer();
      const tags = ExifReader.load(fileBuffer, { expanded: true });

      // DPI
      const xRes = tags.exif?.XResolution?.value;
      if (xRes) {
        const resUnit = tags.exif?.ResolutionUnit?.value;
        let dpi = Array.isArray(xRes) ? xRes[0] / (xRes[1] || 1) : Number(xRes);
        if (resUnit === 3) dpi = dpi * 2.54;
        if (dpi > 1 && dpi < 10000) {
          base.dpi = Math.round(dpi);
          base.dpiSource = 'exif';
        }
      }

      // Bit depth
      const bpsTag = tags.exif?.BitsPerSample?.value;
      if (bpsTag) {
        const bps = Array.isArray(bpsTag) ? Number(bpsTag[0]) : Number(bpsTag);
        if (bps > 0) base.bitDepth = bps;
      }

      // Color space / photometric interpretation
      const photoInterp = tags.exif?.PhotometricInterpretation?.value;
      if (photoInterp != null) {
        switch (Number(photoInterp)) {
          case 5: base.colorSpace = 'cmyk'; break;
          case 1: case 0: base.colorSpace = 'grayscale'; break;
          default: base.colorSpace = 'srgb';
        }
      }

      // Alpha (use bracket access for non-standard ExifReader tags)
      if ((tags.exif as Record<string, unknown>)?.['ExtraSamples'] != null) base.hasAlpha = true;
      const spp = tags.exif?.SamplesPerPixel?.value;
      if (Number(spp) === 4 && base.colorSpace === 'srgb') base.hasAlpha = true;

      // ICC Profile
      const iccDesc = tags.icc?.['ICC Description']?.description
        || tags.icc?.ProfileDescription?.description;
      if (iccDesc) {
        base.hasIccProfile = true;
        base.raw = base.raw || {};
        base.raw.iccProfileName = String(iccDesc);

        const profileName = base.raw.iccProfileName.toLowerCase();
        if (profileName.includes('adobe') && profileName.includes('rgb')) {
          base.colorSpace = 'adobe-rgb';
        } else if (profileName.includes('display p3') || profileName.includes('p3')) {
          base.colorSpace = 'display-p3';
        } else if (profileName.includes('prophoto')) {
          base.colorSpace = 'prophoto-rgb';
        }
      }

      // Camera info
      const make = tags.exif?.Make?.description;
      const model = tags.exif?.Model?.description;
      if (make || model) {
        base.camera = {
          make, model,
          lensMake: tags.exif?.LensMake?.description,
          lensModel: tags.exif?.LensModel?.description,
          software: tags.exif?.Software?.description,
        };
      }

      // Capture parameters
      const fNum = tags.exif?.FNumber?.value;
      const expTime = tags.exif?.ExposureTime?.value;
      const iso = tags.exif?.ISOSpeedRatings?.value;
      if (fNum || expTime || iso) {
        base.capture = {
          fNumber: fNum ? (Array.isArray(fNum) ? fNum[0] / (fNum[1] || 1) : Number(fNum)) : undefined,
          exposureTime: expTime ? (Array.isArray(expTime) ? expTime[0] / (expTime[1] || 1) : Number(expTime)) : undefined,
          iso: iso ? (Array.isArray(iso) ? Number(iso[0]) : Number(iso)) : undefined,
          focalLength: tags.exif?.FocalLength?.value
            ? (Array.isArray(tags.exif.FocalLength.value)
                ? tags.exif.FocalLength.value[0] / (tags.exif.FocalLength.value[1] || 1)
                : Number(tags.exif.FocalLength.value))
            : undefined,
        };
      }

      // Dates
      const dateStr = tags.exif?.DateTimeOriginal?.description;
      if (dateStr) {
        try {
          const normalized = dateStr.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
          base.dates = { created: new Date(normalized).toISOString() };
        } catch { /* non-critical */ }
      }

      // Author
      const artist = tags.exif?.Artist?.description;
      const copyright = tags.exif?.Copyright?.description;
      if (artist || copyright) {
        base.author = { name: artist, copyright };
      }
    } catch (err) {
      console.debug('[TiffHandler] IFD metadata extraction failed:', (err as Error).message);
    }

    return base;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private: TIFF → PNG Conversion (via engine Worker FILE_IO)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Converts a TIFF file to a PNG Blob via engine Worker.
   *
   * Supports all TIFF variants that libvips handles:
   * - RGB/RGBA 8-bit/16-bit (any compression)
   * - CMYK → sRGB conversion (ICC-accurate when profile is embedded)
   * - BigTIFF, multi-page (first page only)
   */
  private async convertTiffToBlob(file: File): Promise<Blob> {
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      // Decode TIFF → RGBA via engine Worker
      const { width, height, data } = await this.pixels.fileIO.decodeTiff(bytes);

      if (!data || width <= 0 || height <= 0) {
        throw new Error('Failed to decode TIFF image: no image data returned');
      }

      // Convert RGBA pixels to PNG via OffscreenCanvas
      const rgbaData = new Uint8ClampedArray(width * height * 4);
      rgbaData.set(new Uint8Array(data.buffer, data.byteOffset, width * height * 4));
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d')!;
      const imgData = new ImageData(rgbaData, width, height);
      ctx.putImageData(imgData, 0, 0);

      const blob = await canvas.convertToBlob({ type: 'image/png' });
      return blob;
    } catch (error) {
      console.error('[TiffHandler] Decode failed:', error);
      throw error;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private: Encode ImageData → TIFF (via engine Worker FILE_IO)
  // ═══════════════════════════════════════════════════════════════════════════

  private async encodeTiffFromImageData(
    imageData: ImageData,
    options: {
      compression: TiffCompression;
      dpi: number;
      width: number;
      height: number;
      iccProfileBytes?: Uint8Array;
      jpegQuality?: number;
      predictor?: string;
      bigtiff?: boolean;
      tile?: boolean;
      tileWidth?: number;
      tileHeight?: number;
    },
  ): Promise<Blob> {
    try {
      const rgbaData = new Uint8Array(imageData.data.buffer);

      const tiffBytes = await this.pixels.fileIO.encodeTiff(
        rgbaData,
        options.width,
        options.height,
        {
          compression: options.compression,
          dpi: options.dpi,
          iccProfileBytes: options.iccProfileBytes,
          jpegQuality: options.jpegQuality,
          predictor: options.predictor,
          bigtiff: options.bigtiff,
          tile: options.tile,
          tileWidth: options.tileWidth,
          tileHeight: options.tileHeight,
        },
      );

      const blob = new Blob([tiffBytes.buffer as ArrayBuffer], { type: 'image/tiff' });
      console.log(`[TiffHandler] Encode complete: ${options.width}×${options.height}, compression=${options.compression}, dpi=${options.dpi}`);
      return blob;
    } catch (error) {
      console.error('[TiffHandler] Encode failed:', error);
      throw error;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private: Multi-page TIFF helpers
  // ═══════════════════════════════════════════════════════════════════════════

  private async getPageCount(file: File): Promise<{ pages: number; pageWidth: number; pageHeight: number }> {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    return this.pixels.fileIO.getPageCount(bytes);
  }

  private async decodeAllPages(file: File, pageCount: number): Promise<Array<{ blob: Blob; width: number; height: number; index: number }>> {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const results: Array<{ blob: Blob; width: number; height: number; index: number }> = [];

    for (let i = 0; i < pageCount; i++) {
      const { width, height, data } = await this.pixels.fileIO.decodePage(bytes, i);
      // Convert RGBA to PNG blob via OffscreenCanvas
      const rgbaData = new Uint8ClampedArray(width * height * 4);
      rgbaData.set(new Uint8Array(data.buffer, data.byteOffset, width * height * 4));
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d')!;
      ctx.putImageData(new ImageData(rgbaData, width, height), 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      results.push({ blob, width, height, index: i });
    }

    return results;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Public API for 16-bit High-Resolution Export
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Options for 16-bit high-resolution export.
 */
export interface HighResExportOptions {
  /** Output format: 'tiff' or 'png' */
  format: 'tiff' | 'png';
  /** TIFF compression: 'none'|'lzw'|'zip' (default: 'lzw') */
  compression?: TiffCompression;
  /** PNG compression level: 0=none/fastest, 6=default, 9=max/slowest (default: 6) */
  pngCompression?: number;
  /** Output DPI (default: 72) */
  dpi?: number;
  /** Optional crop rect (in pixel coordinates of the original image) */
  crop?: { x: number; y: number; w: number; h: number };
  /** Optional resize dimensions */
  resize?: { w: number; h: number };
  /** ICC Profile bytes to embed in output */
  iccProfileBytes?: Uint8Array;
  /**
   * Optional adjustments to apply in 16-bit domain before encoding.
   * Uses AdjustmentState from models.ts — same type as Layer.adjustments.
   * Applied by vips natively — full 16-bit precision, no quantization.
   */
  adjustments?: AdjustmentState;
}

/**
 * Exports a 16-bit high-resolution image from raw source bytes.
 * The entire pipeline runs in 16-bit domain (no quantization to 8-bit).
 *
 * This function is the public API used by the export command to produce
 * lossless 16-bit TIFF/PNG output from preserved raw sources.
 *
 * @param pixels - PixelService instance (provides fileIO namespace)
 * @param rawBlob - The original high-resolution source blob (TIFF/PNG/RAW)
 * @param options - Export options (format, compression, dpi, crop, resize)
 * @returns Blob containing the encoded 16-bit output
 */
export async function exportHighRes(pixels: PixelService, rawBlob: Blob, options: HighResExportOptions): Promise<Blob> {
  const buffer = await rawBlob.arrayBuffer();
  const rawBytes = new Uint8Array(buffer);

  const outputBytes = await pixels.fileIO.exportHighRes(rawBytes, {
    format: options.format,
    compression: options.compression,
    pngCompression: options.pngCompression,
    dpi: options.dpi,
    crop: options.crop,
    resize: options.resize,
    iccProfileBytes: options.iccProfileBytes,
    adjustments: options.adjustments,
  });

  const mimeType = options.format === 'png' ? 'image/png' : 'image/tiff';
  return new Blob([outputBytes.buffer as ArrayBuffer], { type: mimeType });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Public API for Multi-layer 16-bit Composite Export
// ═══════════════════════════════════════════════════════════════════════════════

/** Layer descriptor for multi-layer composite export */
export interface CompositeLayerDescriptor {
  /** File bytes (raw 16-bit source or 8-bit display PNG) */
  bytes: Uint8Array;
  /** Layer X position on canvas */
  x: number;
  /** Layer Y position on canvas */
  y: number;
  /** Vips blend mode string (from blendModeMap.ts) */
  blendMode: string;
  /** Layer opacity (0-1) */
  opacity: number;
  /** Whether this is an 8-bit source (will be upsampled to 16-bit) */
  is8bit: boolean;
  /**
   * Optional adjustments to apply in 16-bit domain before compositing.
   * Uses AdjustmentState from models.ts — same type as Layer.adjustments.
   * Applied by vips natively — full 16-bit precision, no quantization.
   */
  adjustments?: AdjustmentState;
}

/** Options for multi-layer 16-bit composite export */
export interface CompositeExportOptions {
  /** Output format */
  format: 'tiff' | 'png';
  /** TIFF compression */
  compression?: string;
  /** Output DPI */
  dpi?: number;
  /** JPEG quality (only for TIFF JPEG compression) */
  jpegQuality?: number;
  /** BigTIFF support */
  bigtiff?: boolean;
  /** Tile layout */
  tile?: boolean;
  /** Tile dimensions */
  tileWidth?: number;
  tileHeight?: number;
}

/**
 * Composites multiple layers into a 16-bit TIFF/PNG output using vips.
 *
 * This is the public API for multi-layer 16-bit export. Each layer is provided
 * as raw file bytes with position, blend mode, and opacity information.
 * Layers without 16-bit raw source are upsampled from 8-bit (value * 257).
 *
 * @param pixels - PixelService instance (provides fileIO namespace)
 * @param layers - Array of layer descriptors (bottom to top order)
 * @param canvasWidth - Output canvas width
 * @param canvasHeight - Output canvas height
 * @param options - Export options (format, compression, dpi, etc.)
 * @returns Blob containing the composited output
 */
export async function compositeMultiLayer16bit(
  pixels: PixelService,
  layers: CompositeLayerDescriptor[],
  canvasWidth: number,
  canvasHeight: number,
  options: CompositeExportOptions,
): Promise<Blob> {
  const outputBytes = await pixels.fileIO.composite16bit({
    layers: layers.map(l => ({
      bytes: l.bytes,
      x: l.x,
      y: l.y,
      blendMode: l.blendMode,
      opacity: l.opacity,
      is8bit: l.is8bit,
      adjustments: l.adjustments as Record<string, unknown> | undefined,
    })),
    canvasWidth,
    canvasHeight,
    options: {
      format: options.format,
      compression: options.compression,
      dpi: options.dpi,
      jpegQuality: options.jpegQuality,
      bigtiff: options.bigtiff,
      tile: options.tile,
      tileWidth: options.tileWidth,
      tileHeight: options.tileHeight,
    },
  });

  const mimeType = options.format === 'png' ? 'image/png' : 'image/tiff';
  return new Blob([outputBytes.buffer as ArrayBuffer], { type: mimeType });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Utility: ImageBitmap → OffscreenCanvas
// ═══════════════════════════════════════════════════════════════════════════════

function bitmapToOffscreen(bitmap: ImageBitmap): OffscreenCanvas {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  return canvas;
}
