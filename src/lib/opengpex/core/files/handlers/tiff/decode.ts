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
 * TIFF decode — color pipeline routing + multi-page support.
 *
 * Decodes TIFF via engine Worker (vips) with strategy-based color management.
 * Supports multi-page TIFF (all pages decoded as subImages).
 */

import type { PixelService, WorkingColorSpace } from '@opengpex/editor/core/types';
import type { DecodeOptions, DecodeResult, SubImage } from '../../types';
import type { ImageMetadata } from '../../metadata';
import { iccToBase64, parseIccProfileName } from '../../icc';
import { convertImageDataColorSpace } from '@opengpex/editor/core/color/matrices';
import { resolveColorSpaceForFormat, getImportStrategy, shouldRetainSourceBlob } from '@opengpex/editor/core/color/ColorPipeline';
import { extractTiffMetadata } from './metadata';

/**
 * Decode a TIFF file: extract metadata (V2), decode via vips Worker, apply color pipeline.
 */
export async function decodeTiff(
  file: File,
  pixels: PixelService,
  _options?: DecodeOptions,
): Promise<DecodeResult> {
  // 1. Extract metadata (lightweight, main thread — IFD tag parsing)
  const metadata: ImageMetadata = await extractTiffMetadata(file);

  // ── Strategy-based color pipeline routing ──
  const detectedCS = resolveColorSpaceForFormat('tiff', metadata.colorSpace);
  const strategy = getImportStrategy(detectedCS);

  let displayBlob: Blob;
  let dimensions: { w: number; h: number };

  switch (strategy.conversion) {
    case 'none': {
      // sRGB/P3 — decode preserving original pixels
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { width, height, data } = await pixels.fileIO.decodeTiff(bytes, { preserveColorSpace: true });
      dimensions = { w: width, h: height };

      const canvasCS: PredefinedColorSpace = strategy.frameColorSpace === 'display-p3' ? 'display-p3' : 'srgb';
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d', { colorSpace: canvasCS })!;
      const clamped = new Uint8ClampedArray(width * height * 4);
      clamped.set(new Uint8Array(data.buffer, data.byteOffset, width * height * 4));
      ctx.putImageData(new ImageData(clamped, width, height, { colorSpace: canvasCS }), 0, 0);
      displayBlob = await canvas.convertToBlob({ type: 'image/png' });

      console.debug('[ColorMgmt] TIFF decode: %s conversion=none, detectedCS=%s, frameCS=%s',
        file.name, detectedCS, strategy.frameColorSpace);
      break;
    }

    case 'matrix': {
      // AdobeRGB/ProPhoto — decode preserving original pixels, then matrix convert
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { width, height, data } = await pixels.fileIO.decodeTiff(bytes, { preserveColorSpace: true });
      dimensions = { w: width, h: height };

      const clamped = new Uint8ClampedArray(width * height * 4);
      clamped.set(new Uint8Array(data.buffer, data.byteOffset, width * height * 4));
      convertImageDataColorSpace(clamped, detectedCS as WorkingColorSpace, strategy.frameColorSpace);

      const outCS: PredefinedColorSpace = strategy.frameColorSpace === 'display-p3' ? 'display-p3' : 'srgb';
      const outCanvas = new OffscreenCanvas(width, height);
      const outCtx = outCanvas.getContext('2d', { colorSpace: outCS })!;
      outCtx.putImageData(new ImageData(clamped, width, height, { colorSpace: outCS }), 0, 0);
      displayBlob = await outCanvas.convertToBlob({ type: 'image/png' });

      console.debug('[ColorMgmt] TIFF decode: %s matrix %s→%s',
        file.name, detectedCS, strategy.frameColorSpace);
      break;
    }

    case 'icc-engine': {
      // CMYK/custom ICC — full ICC engine conversion via vips (Little CMS)
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { width, height, data, iccProfileData } = await pixels.fileIO.iccToSrgb(bytes);
      dimensions = { w: width, h: height };

      if (iccProfileData && iccProfileData.length > 0) {
        if (!metadata.raw.icc) {
          metadata.raw.icc = {
            data: iccToBase64(iccProfileData),
            name: parseIccProfileName(iccProfileData) || 'Embedded',
          };
        }
      }

      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d')!;
      const clamped = new Uint8ClampedArray(width * height * 4);
      clamped.set(new Uint8Array(data.buffer, data.byteOffset, width * height * 4));
      ctx.putImageData(new ImageData(clamped, width, height), 0, 0);
      displayBlob = await canvas.convertToBlob({ type: 'image/png' });

      console.debug('[ColorMgmt] TIFF decode: %s icc-engine %s→srgb', file.name, detectedCS);
      break;
    }
  }

  // ── Multi-page detection & subImage/sourceBlob assembly ──
  let subImages: SubImage[];
  let sourceBlob: Blob | undefined;

  try {
    const pageInfo = await getPageCount(file, pixels);
    if (pageInfo.pages > 1) {
      const allPages = await decodeAllPages(file, pixels, pageInfo.pages);
      subImages = allPages.map(p => ({
        displayBlob: p.blob,
        width: p.width,
        height: p.height,
        index: p.index,
      }));
      sourceBlob = file; // Multi-page always preserves source
    } else {
      subImages = [{ displayBlob, width: dimensions.w, height: dimensions.h, index: 0 }];
      sourceBlob = shouldRetainSourceBlob('tiff', metadata, strategy.frameColorSpace) ? file : undefined;
    }
  } catch (err) {
    console.debug('[TiffHandler] Multi-page detection failed (treating as single page):', (err as Error).message);
    subImages = [{ displayBlob, width: dimensions.w, height: dimensions.h, index: 0 }];
    sourceBlob = shouldRetainSourceBlob('tiff', metadata, strategy.frameColorSpace) ? file : undefined;
  }

  return { dimensions, metadata, subImages, sourceBlob };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Multi-page Helpers
// ═══════════════════════════════════════════════════════════════════════════════

async function getPageCount(file: File, pixels: PixelService): Promise<{ pages: number; pageWidth: number; pageHeight: number }> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  return pixels.fileIO.getPageCount(bytes);
}

async function decodeAllPages(file: File, pixels: PixelService, pageCount: number): Promise<Array<{ blob: Blob; width: number; height: number; index: number }>> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const results: Array<{ blob: Blob; width: number; height: number; index: number }> = [];

  for (let i = 0; i < pageCount; i++) {
    const { width, height, data } = await pixels.fileIO.decodePage(bytes, i);
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
