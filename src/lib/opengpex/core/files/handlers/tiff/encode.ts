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
 * TIFF encode — color pipeline + engine Worker encoding.
 *
 * Uses the centralized ColorPipeline strategy for export pixel conversion.
 * Encodes via engine Worker (vips) with full TIFF options support.
 */

import type { PixelService, WorkingColorSpace } from '@opengpex/editor/core/types';
import type { EncodeOptions } from '../../types';
import { bitmapToCanvas } from '../../index';
import { base64ToIcc, getStockIccProfile } from '../../icc';
import { convertImageDataColorSpace } from '@opengpex/editor/core/color/matrices';
import { getExportStrategy, resolveExportPixelConversion } from '@opengpex/editor/core/color/ColorPipeline';
import { injectTiffIfd0Tags, TIFF_TAGS } from './ifd0-inject';
import type { Ifd0StringTag } from './ifd0-inject';

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

/**
 * Encode a canvas/bitmap to TIFF with color management.
 */
export async function encodeTiff(
  source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
  pixels: PixelService,
  options: EncodeOptions,
): Promise<Blob> {
  const config = options.exportConfig;
  const compression: TiffCompression = (config?.tiffCompression as TiffCompression) || 'lzw';
  const dpi = config?.dpi || options.metadata?.dpi || 72;

  // ── Strategy-based export color pipeline ──
  const meta = options.metadata;
  const frameCS: WorkingColorSpace = (config?.frameColorSpace as WorkingColorSpace) || 'srgb';
  const exportStrategy = getExportStrategy(frameCS, 'tiff');
  const embedIcc = config?.embedIcc ?? false;

  const pixelConv = resolveExportPixelConversion(
    frameCS,
    { colorSpace: meta?.colorSpace, hasIccProfileData: !!meta?.raw?.icc?.data },
    embedIcc,
    'tiff',
  );

  let canvas: OffscreenCanvas | HTMLCanvasElement;

  if (pixelConv === 'p3-to-srgb') {
    const srcCanvas = source instanceof ImageBitmap ? bitmapToCanvas(source, 'display-p3') : source as OffscreenCanvas;
    const w = srcCanvas.width;
    const h = srcCanvas.height;
    const tmpCanvas = new OffscreenCanvas(w, h);
    const tmpCtx = tmpCanvas.getContext('2d', { colorSpace: 'display-p3' })!;
    tmpCtx.drawImage(srcCanvas, 0, 0);
    const imgData = tmpCtx.getImageData(0, 0, w, h);
    convertImageDataColorSpace(imgData.data, 'display-p3', 'srgb');
    const outCanvas = new OffscreenCanvas(w, h);
    const outCtx = outCanvas.getContext('2d')!;
    outCtx.putImageData(new ImageData(imgData.data, w, h), 0, 0);
    canvas = outCanvas;
    console.debug('[ColorMgmt] TIFF Export: pixelConversion=p3-to-srgb');
  } else {
    canvas = source instanceof ImageBitmap
      ? bitmapToCanvas(source, exportStrategy.encodeColorSpace)
      : source;
  }

  const ctx = (canvas as OffscreenCanvas).getContext('2d')!;
  let imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

  // ICC Profile for embedding
  let iccProfileBytes: Uint8Array | undefined;
  if (embedIcc && meta?.raw?.icc?.data) {
    const { base64ToIcc: b64ToIcc } = await import('../../icc');
    iccProfileBytes = b64ToIcc(meta.raw.icc?.data);

    if (pixelConv === 'srgb-to-icc') {
      const { data: convertedData } = await pixels.fileIO.srgbToIcc(
        new Uint8Array(imageData.data.buffer),
        canvas.width, canvas.height, iccProfileBytes,
      );
      const clamped = new Uint8ClampedArray(convertedData.length);
      clamped.set(convertedData);
      imageData = new ImageData(clamped, canvas.width, canvas.height);
      console.debug('[ColorMgmt] TIFF Export: pixelConversion=srgb-to-icc, targetProfile=%s',
        meta.raw.icc?.name || 'custom');
    } else {
      console.debug('[ColorMgmt] TIFF Export: frameCS=%s, embedIcc=true, no pixel conversion needed', frameCS);
    }
  } else if (embedIcc && !meta?.raw?.icc?.data) {
    // Source has no ICC data but user requested embedding → use stock profile for frame CS
    const stockProfile = getStockIccProfile(frameCS);
    if (stockProfile) {
      iccProfileBytes = stockProfile.bytes;
      console.debug('[ColorMgmt] TIFF Export: embedIcc=true, using stock profile: %s', stockProfile.name);
    } else {
      console.debug('[ColorMgmt] TIFF Export: embedIcc=true but no stock profile for frameCS=%s', frameCS);
    }
  }

  // Encode via engine Worker (FILE_IO job)
  try {
    const rgbaData = new Uint8Array(imageData.data.buffer);
    // Prepare EXIF bytes for injection (decoded from base64)
    const exifBytes = config?.preserveExif && meta?.raw?.exif
      ? base64ToIcc(meta.raw.exif) : undefined;

    let tiffBytes = await pixels.fileIO.encodeTiff(
      rgbaData,
      canvas.width,
      canvas.height,
      {
        compression,
        dpi,
        iccProfileBytes,
        exifBytes,
        jpegQuality: config?.jpegQuality,
        predictor: config?.tiffPredictor,
        bigtiff: config?.tiffBigtiff,
        tile: config?.tiffTile,
        tileWidth: config?.tiffTileWidth,
        tileHeight: config?.tiffTileHeight,
      },
    );

    // ── Inject IFD0 metadata tags (Software, Author, Copyright, Camera) ──
    const ifd0Tags: Ifd0StringTag[] = [];

    // Always write Software tag
    if (config?.writeSoftwareTag !== false) {
      ifd0Tags.push({ tag: TIFF_TAGS.SOFTWARE, value: 'OpenGPEX' });
    }

    // Author / Copyright from config or source metadata
    const authorName = config?.author?.name || meta?.author?.name;
    const copyright = config?.author?.copyright || meta?.author?.copyright;
    if (authorName) ifd0Tags.push({ tag: TIFF_TAGS.ARTIST, value: authorName });
    if (copyright) ifd0Tags.push({ tag: TIFF_TAGS.COPYRIGHT, value: copyright });

    // Camera Make/Model from source metadata (when preserving EXIF)
    if (config?.preserveExif && meta?.camera) {
      if (meta.camera.make) ifd0Tags.push({ tag: TIFF_TAGS.MAKE, value: meta.camera.make });
      if (meta.camera.model) ifd0Tags.push({ tag: TIFF_TAGS.MODEL, value: meta.camera.model });
    }

    if (ifd0Tags.length > 0) {
      tiffBytes = injectTiffIfd0Tags(tiffBytes, ifd0Tags);
    }

    const blob = new Blob([tiffBytes.buffer as ArrayBuffer], { type: 'image/tiff' });
    console.log(`[TiffHandler] Encode complete: ${canvas.width}×${canvas.height}, compression=${compression}, dpi=${dpi}`);
    return blob;
  } catch (error) {
    console.error('[TiffHandler] Encode failed:', error);
    throw error;
  }
}
