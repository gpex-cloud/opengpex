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
 * WebP encode — color pipeline + ICC injection/stripping.
 *
 * Uses the centralized ColorPipeline strategy for export pixel conversion.
 * Handles ICC Profile injection/stripping via RIFF container manipulation.
 *
 * Note: WebP does not support EXIF write-back in this handler (no piexifjs equivalent).
 * Chrome 111+ can produce P3 WebP when given a display-p3 canvas.
 */

import type { PixelService, WorkingColorSpace } from '@opengpex/editor/core/types';
import type { EncodeOptions } from '../../types';
import { bitmapToCanvas } from '../../index';
import { base64ToIcc, getStockIccProfile } from '../../icc';
import { convertImageDataColorSpace } from '@opengpex/editor/core/color/matrices';
import { getExportStrategy, resolveExportPixelConversion } from '@opengpex/editor/core/color/ColorPipeline';
import { injectWebpIcc, stripWebpIcc, injectWebpExif } from './riff';
import { resetExifOrientation } from '../../tiff-ifd-reader';

/**
 * Encode a canvas/bitmap to WebP with ICC injection.
 */
export async function encodeWebp(
  source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
  pixels: PixelService,
  options: EncodeOptions,
): Promise<Blob> {
  const quality = options.quality ?? 0.80;
  const meta = options.metadata;
  const config = options.exportConfig;

  // ── Strategy-based export color pipeline ──
  const frameCS: WorkingColorSpace = (config?.frameColorSpace as WorkingColorSpace) || 'srgb';
  const exportStrategy = getExportStrategy(frameCS, 'webp');
  const embedIcc = config?.embedIcc ?? false;

  // Centralized pixel conversion decision via resolveExportPixelConversion()
  const pixelConv = resolveExportPixelConversion(
    frameCS,
    { colorSpace: meta?.colorSpace, hasIccProfileData: !!meta?.raw?.icc?.data },
    embedIcc,
    'webp',
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
    console.debug('[ColorMgmt] WebP Export: pixelConversion=p3-to-srgb');
  } else if (pixelConv === 'srgb-to-icc') {
    // Pixels are sRGB, need to convert to target ICC space before embedding.
    // Atomic operation: srgbToIcc pixel conversion + RIFF ICC injection.
    const srcCanvas = source instanceof ImageBitmap ? bitmapToCanvas(source) : source as OffscreenCanvas;
    const w = srcCanvas.width;
    const h = srcCanvas.height;
    const tmpCanvas = new OffscreenCanvas(w, h);
    const tmpCtx = tmpCanvas.getContext('2d')!;
    tmpCtx.drawImage(srcCanvas, 0, 0);
    const imageData = tmpCtx.getImageData(0, 0, w, h);

    // Step 1: Convert pixels from sRGB to target ICC space
    const iccBytes = base64ToIcc(meta!.raw!.icc!.data);
    const { data: convertedData } = await pixels.fileIO.srgbToIcc(
      new Uint8Array(imageData.data.buffer),
      w, h, iccBytes,
    );

    // Step 2: Put converted pixels onto canvas and encode to WebP
    const clamped = new Uint8ClampedArray(convertedData.length);
    clamped.set(convertedData);
    const outCanvas = new OffscreenCanvas(w, h);
    const outCtx = outCanvas.getContext('2d')!;
    outCtx.putImageData(new ImageData(clamped, w, h), 0, 0);
    const webpBlob = await outCanvas.convertToBlob({ type: 'image/webp', quality });

    // Step 3: Inject ICC Profile into the WebP RIFF container
    const webpBytes = new Uint8Array(await webpBlob.arrayBuffer());
    const finalBytes = injectWebpIcc(webpBytes, iccBytes);

    console.debug('[ColorMgmt] WebP Export: pixelConversion=srgb-to-icc, targetProfile=%s',
      meta!.raw!.icc?.name || 'custom');
    let resultBlob = new Blob([finalBytes.buffer as ArrayBuffer], { type: 'image/webp' });
    // EXIF injection (post-ICC) — reset Orientation since pixels are already corrected
    if (config?.preserveExif && meta?.raw?.exif) {
      const exifRaw = resetExifOrientation(base64ToIcc(meta.raw.exif));
      const webpBuf = new Uint8Array(await resultBlob.arrayBuffer());
      const withExif = injectWebpExif(webpBuf, exifRaw);
      resultBlob = new Blob([withExif.buffer as ArrayBuffer], { type: 'image/webp' });
    }
    return resultBlob;
  } else {
    canvas = source instanceof ImageBitmap
      ? bitmapToCanvas(source, exportStrategy.encodeColorSpace)
      : source as OffscreenCanvas;
    console.debug('[ColorMgmt] WebP Export: frameCS=%s, encodeColorSpace=%s',
      frameCS, exportStrategy.encodeColorSpace);
  }

  const baseBlob = await canvas.convertToBlob({
    type: 'image/webp',
    quality,
  });

  // Embed ICC Profile into WebP RIFF container (when embedIcc=true).
  // Handles case where no pixel conversion needed but user wants ICC Profile embedded.
  if (embedIcc && meta?.raw?.icc?.data) {
    // Source has ICC Profile data → embed original (round-trip)
    const iccBytes = base64ToIcc(meta.raw.icc?.data);
    const webpBytes = new Uint8Array(await baseBlob.arrayBuffer());
    const finalBytes = injectWebpIcc(webpBytes, iccBytes);
    console.debug('[ColorMgmt] WebP Export: injecting ICC profile (no pixel conversion), profile=%s',
      meta.raw.icc?.name || 'embedded');
    let iccResultBlob = new Blob([finalBytes.buffer as ArrayBuffer], { type: 'image/webp' });
    // EXIF injection (post-ICC embed path) — reset Orientation since pixels are already corrected
    if (config?.preserveExif && meta?.raw?.exif) {
      const exifRaw = resetExifOrientation(base64ToIcc(meta.raw.exif));
      const webpBuf = new Uint8Array(await iccResultBlob.arrayBuffer());
      const withExif = injectWebpExif(webpBuf, exifRaw);
      iccResultBlob = new Blob([withExif.buffer as ArrayBuffer], { type: 'image/webp' });
    }
    return iccResultBlob;
  } else if (embedIcc) {
    // Source has no ICC data but user requested embedding → use stock profile for frame CS
    const stockProfile = getStockIccProfile(frameCS);
    if (stockProfile) {
      const webpBytes = new Uint8Array(await baseBlob.arrayBuffer());
      const finalBytes = injectWebpIcc(webpBytes, stockProfile.bytes);
      console.debug('[ColorMgmt] WebP Export: embedded stock ICC profile for %s', frameCS);
      let iccResultBlob = new Blob([finalBytes.buffer as ArrayBuffer], { type: 'image/webp' });
      if (config?.preserveExif && meta?.raw?.exif) {
        const exifRaw = resetExifOrientation(base64ToIcc(meta.raw.exif));
        const webpBuf = new Uint8Array(await iccResultBlob.arrayBuffer());
        const withExif = injectWebpExif(webpBuf, exifRaw);
        iccResultBlob = new Blob([withExif.buffer as ArrayBuffer], { type: 'image/webp' });
      }
      return iccResultBlob;
    }
  }

  // Strip browser-injected ICC when user explicitly disables embedding.
  // Chrome may auto-inject sRGB/P3 ICC profiles via canvas.convertToBlob().
  let resultBlob: Blob;
  if (!embedIcc) {
    const webpBytes = new Uint8Array(await baseBlob.arrayBuffer());
    const strippedBytes = stripWebpIcc(webpBytes);
    if (strippedBytes !== webpBytes) {
      console.debug('[ColorMgmt] WebP Export: stripped browser-injected ICC (embedIcc=false)');
      resultBlob = new Blob([strippedBytes.buffer as ArrayBuffer], { type: 'image/webp' });
    } else {
      resultBlob = baseBlob;
    }
  } else {
    resultBlob = baseBlob;
  }

  // EXIF injection (after ICC handling, before return) — reset Orientation since pixels are already corrected
  if (config?.preserveExif && meta?.raw?.exif) {
    const exifRaw = resetExifOrientation(base64ToIcc(meta.raw.exif));
    const webpBuf = new Uint8Array(await resultBlob.arrayBuffer());
    const withExif = injectWebpExif(webpBuf, exifRaw);
    resultBlob = new Blob([withExif.buffer as ArrayBuffer], { type: 'image/webp' });
  }

  return resultBlob;
}
