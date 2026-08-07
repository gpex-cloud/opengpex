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
 * JPEG encode — color pipeline + EXIF write + ICC injection.
 *
 * Uses the centralized ColorPipeline strategy for export pixel conversion,
 * then injects EXIF metadata (piexifjs write path) and ICC Profile.
 *
 * V2 changes:
 * - No longer reads from `raw.piexifObj`
 * - Uses `raw.exif` (base64 TIFF IFD) for EXIF passthrough
 * - piexifjs only used in the WRITE path (dump/insert)
 */

// @ts-expect-error - piexifjs lacks official TypeScript declarations
import * as piexif from 'piexifjs';
import type { PixelService, WorkingColorSpace } from '@opengpex/editor/core/types';
import type { EncodeOptions } from '../../types';
import { bitmapToCanvas } from '../../index';
import { base64ToIcc, getStockIccProfile } from '../../icc';
import { convertImageDataColorSpace } from '@opengpex/editor/core/color/matrices';
import { getExportStrategy, resolveExportPixelConversion } from '@opengpex/editor/core/color/ColorPipeline';
import { injectJpegExif, injectJpegIcc } from './jfif';
import { blobToBase64, base64ToBlob } from './utils';

/**
 * Encode a canvas/bitmap to JPEG with metadata injection.
 */
export async function encodeJpeg(
  source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
  pixels: PixelService,
  options: EncodeOptions,
): Promise<Blob> {
  const quality = options.quality ?? 0.92;
  const meta = options.metadata;
  const config = options.exportConfig;

  // ── Strategy-based export color pipeline ──
  const frameCS: WorkingColorSpace = (config?.frameColorSpace as WorkingColorSpace) || 'srgb';
  const exportStrategy = getExportStrategy(frameCS, 'jpeg');
  const embedIcc = config?.embedIcc ?? false;

  // Centralized pixel conversion decision via resolveExportPixelConversion()
  const pixelConv = resolveExportPixelConversion(
    frameCS,
    { colorSpace: meta?.colorSpace, hasIccProfileData: !!meta?.raw?.icc?.data },
    embedIcc,
    'jpeg',
  );

  let canvas: OffscreenCanvas;

  if (pixelConv === 'p3-to-srgb') {
    // Format fallback: P3 frame → sRGB (format doesn't support P3)
    const srcCanvas = source instanceof ImageBitmap ? bitmapToCanvas(source, 'display-p3') : source as OffscreenCanvas;
    const w = srcCanvas.width;
    const h = srcCanvas.height;
    const tmpCanvas = new OffscreenCanvas(w, h);
    const tmpCtx = tmpCanvas.getContext('2d', { colorSpace: 'display-p3' })!;
    tmpCtx.drawImage(srcCanvas, 0, 0);
    const imageData = tmpCtx.getImageData(0, 0, w, h);
    convertImageDataColorSpace(imageData.data, 'display-p3', 'srgb');
    const outCanvas = new OffscreenCanvas(w, h);
    const outCtx = outCanvas.getContext('2d')!;
    outCtx.putImageData(new ImageData(imageData.data, w, h), 0, 0);
    canvas = outCanvas;
    console.debug('[ColorMgmt] JPEG Export: pixelConversion=p3-to-srgb');
  } else if (pixelConv === 'srgb-to-icc') {
    // Pixels are sRGB, need to convert to target ICC space
    const srcCanvas = source instanceof ImageBitmap ? bitmapToCanvas(source) : source as OffscreenCanvas;
    const w = srcCanvas.width;
    const h = srcCanvas.height;
    const tmpCanvas = new OffscreenCanvas(w, h);
    const tmpCtx = tmpCanvas.getContext('2d')!;
    tmpCtx.drawImage(srcCanvas, 0, 0);
    const imageData = tmpCtx.getImageData(0, 0, w, h);

    const iccBytes = base64ToIcc(meta!.raw!.icc!.data);
    const { data } = await pixels.fileIO.srgbToIcc(
      new Uint8Array(imageData.data.buffer),
      w, h, iccBytes,
    );

    const clamped = new Uint8ClampedArray(data.length);
    clamped.set(data);
    tmpCtx.putImageData(new ImageData(clamped, w, h), 0, 0);
    canvas = tmpCanvas;
    console.debug('[ColorMgmt] JPEG Export: pixelConversion=srgb-to-icc, targetProfile=%s',
      meta!.raw!.icc?.name || 'custom');
  } else {
    // Strategy-driven: use encodeColorSpace to prevent implicit browser conversion
    canvas = source instanceof ImageBitmap
      ? bitmapToCanvas(source, exportStrategy.encodeColorSpace)
      : source as OffscreenCanvas;
    console.debug('[ColorMgmt] JPEG Export: frameCS=%s, encodeColorSpace=%s, embedIcc=%s',
      frameCS, exportStrategy.encodeColorSpace, embedIcc);
  }

  // 1. Get base JPEG blob from browser encoder
  const baseBlob = await canvas.convertToBlob({
    type: 'image/jpeg',
    quality,
  });

  // 2. Inject EXIF metadata (DPI, camera info, software tag)
  if (!meta && !config) return baseBlob;

  try {
    const base64 = await blobToBase64(baseBlob);

    // Build exifObj: start from raw EXIF passthrough or create fresh
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let exifObj: Record<string, any>;

    if (config?.preserveExif && meta?.raw?.exif) {
      // V2 path: inject raw EXIF bytes into base JPEG, then load via piexif for modification
      const rawExifBytes = base64ToExifBytes(meta.raw.exif);
      const baseJpegBytes = new Uint8Array(await baseBlob.arrayBuffer());
      const jpegWithExif = injectJpegExif(baseJpegBytes, rawExifBytes);
      const withExifBase64 = bytesToDataUrl(jpegWithExif, 'image/jpeg');
      exifObj = piexif.load(withExifBase64);

      // Always reset Orientation to Normal (1) since exported pixels are already
      // in correct orientation. Source formats like HEIC/JPEG may store non-trivial
      // orientation in EXIF, but the composite/transcode pipeline normalizes pixels.
      if (exifObj['0th']) {
        exifObj['0th'][piexif.ImageIFD.Orientation] = 1;
      }
    } else {
      exifObj = { '0th': {}, Exif: {}, GPS: {} };
    }

    // Ensure IFD objects exist
    if (!exifObj['0th']) exifObj['0th'] = {};
    if (!exifObj['Exif']) exifObj['Exif'] = {};

    // Inject DPI
    const dpi = config?.dpi || meta?.dpi;
    if (dpi && dpi > 0) {
      exifObj['0th'][piexif.ImageIFD.XResolution] = [dpi, 1];
      exifObj['0th'][piexif.ImageIFD.YResolution] = [dpi, 1];
      exifObj['0th'][piexif.ImageIFD.ResolutionUnit] = 2; // inches
    }

    // Inject software tag
    if (config?.writeSoftwareTag !== false) {
      exifObj['0th'][piexif.ImageIFD.Software] = 'OpenGPEX';
    }

    // Inject author/copyright
    const authorName = config?.author?.name || meta?.author?.name;
    const copyright = config?.author?.copyright || meta?.author?.copyright;
    if (authorName) {
      exifObj['0th'][piexif.ImageIFD.Artist] = authorName;
    }
    if (copyright) {
      exifObj['0th'][piexif.ImageIFD.Copyright] = copyright;
    }

    const exifStr = piexif.dump(exifObj);
    const newBase64 = piexif.insert(exifStr, base64);
    let resultBlob = base64ToBlob(newBase64, 'image/jpeg');

    // 3. Inject ICC Profile if embedding is requested
    if (config?.embedIcc && meta?.raw?.icc?.data) {
      const iccBytes = base64ToIcc(meta.raw.icc?.data);
      const jpegBytes = new Uint8Array(await resultBlob.arrayBuffer());
      const withIcc = injectJpegIcc(jpegBytes, iccBytes);
      resultBlob = new Blob([withIcc.buffer as ArrayBuffer], { type: 'image/jpeg' });
    } else if (config?.embedIcc && !meta?.raw?.icc?.data) {
      // embedIcc requested but no source ICC data → embed stock profile for frame CS
      const stockProfile = getStockIccProfile(frameCS);
      if (stockProfile) {
        const jpegBytes = new Uint8Array(await resultBlob.arrayBuffer());
        const withIcc = injectJpegIcc(jpegBytes, stockProfile.bytes);
        resultBlob = new Blob([withIcc.buffer as ArrayBuffer], { type: 'image/jpeg' });
        console.debug('[ColorMgmt] JPEG Export: embedded stock ICC profile for %s', frameCS);
      }
    }

    return resultBlob;
  } catch (e) {
    console.warn('[JpegHandler.encode] EXIF injection failed, returning raw blob:', e);
    return baseBlob;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Internal Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Decode base64-encoded EXIF bytes (TIFF IFD) back to Uint8Array.
 */
function base64ToExifBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Convert Uint8Array JPEG bytes to a data-URL string for piexif consumption.
 */
function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}
