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
 * PNG encode — color pipeline + chunk reassembly.
 *
 * Uses the centralized ColorPipeline strategy for export pixel conversion,
 * then reassembles chunks with metadata injection (pHYs, iCCP/sRGB, tEXt, tIME).
 */

import type { PixelService, WorkingColorSpace } from '@opengpex/editor/core/types';
import type { EncodeOptions } from '../../types';
import { bitmapToCanvas } from '../../index';
import { base64ToIcc, getStockIccProfile } from '../../icc';
import { resetExifOrientation } from '../../tiff-ifd-reader';
import { convertImageDataColorSpace } from '@opengpex/editor/core/color/matrices';
import { getExportStrategy, resolveExportPixelConversion } from '@opengpex/editor/core/color/ColorPipeline';
import { verifySignature, iterateChunks, concat } from './chunks';
import { buildPhysChunk, buildSrgbChunk, buildIccpChunk, buildTextChunk, buildTimeChunk, buildExifChunk } from './writers';

/**
 * Encode a canvas/bitmap to PNG with metadata injection.
 */
export async function encodePng(
  source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
  pixels: PixelService,
  options: EncodeOptions,
): Promise<Blob> {
  const meta = options.metadata;
  const config = options.exportConfig;
  console.log(`[PngHandler.encode] encode start: colorSpace=${meta?.colorSpace}, embedIcc=${config?.embedIcc}, hasIccData=${!!meta?.raw?.icc?.data}`);

  // ── Strategy-based export color pipeline ──
  const frameCS: WorkingColorSpace = (config?.frameColorSpace as WorkingColorSpace) || 'srgb';
  const exportStrategy = getExportStrategy(frameCS, 'png');
  const embedIcc = config?.embedIcc ?? false;

  // Centralized pixel conversion decision
  const pixelConv = resolveExportPixelConversion(
    frameCS,
    { colorSpace: meta?.colorSpace, hasIccProfileData: !!meta?.raw?.icc?.data },
    embedIcc,
    'png',
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
    // console.debug('[ColorMgmt] PNG Export: pixelConversion=p3-to-srgb');
  } else if (pixelConv === 'srgb-to-icc') {
    // Pixels are sRGB, need to convert to target ICC space before embedding
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
    // console.debug('[ColorMgmt] PNG Export: pixelConversion=srgb-to-icc, targetProfile=%s', meta!.raw!.icc?.name || 'custom');
  } else {
    // Strategy-driven: use encodeColorSpace to prevent implicit browser conversion
    canvas = source instanceof ImageBitmap
      ? bitmapToCanvas(source, exportStrategy.encodeColorSpace)
      : source as OffscreenCanvas;
    // console.debug('[ColorMgmt] PNG Export: frameCS=%s, encodeColorSpace=%s, embedIcc=%s', frameCS, exportStrategy.encodeColorSpace, embedIcc);
  }

  // 1. Get base PNG blob from browser encoder
  const baseBlob = await canvas.convertToBlob({ type: 'image/png' });

  // If no metadata to inject, return as-is
  const dpi = config?.dpi || meta?.dpi;
  const hasAuthor = !!(config?.author?.name || meta?.author?.name);
  const hasCopyright = !!(config?.author?.copyright || meta?.author?.copyright);
  const writeSoftware = config?.writeSoftwareTag !== false;

  if (!dpi && !hasAuthor && !hasCopyright && !writeSoftware && !config?.embedIcc) {
    return baseBlob;
  }

  // 2. Reassemble PNG chunks with metadata injection
  try {
    const buffer = await baseBlob.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    if (!verifySignature(bytes)) return baseBlob;

    const chunks: Uint8Array[] = [];

    // PNG Signature (8 bytes)
    chunks.push(bytes.slice(0, 8));

    // IHDR chunk (first chunk after signature: 4 length + 4 type + 13 data + 4 CRC = 25 bytes)
    chunks.push(bytes.slice(8, 33));

    // Insert pHYs chunk (DPI)
    if (dpi && dpi > 0) {
      chunks.push(buildPhysChunk(dpi));
    }

    // Insert color profile declaration (iCCP or sRGB chunk, mutually exclusive per PNG spec)
    if (config?.embedIcc && meta?.raw?.icc?.data) {
      // Source has ICC Profile data → embed as iCCP chunk (round-trip original profile)
      const iccBytes = base64ToIcc(meta.raw.icc?.data);
      chunks.push(await buildIccpChunk(iccBytes, meta.raw.icc?.name));
    } else if (config?.embedIcc) {
      // Source has no ICC data but user requested embedding → use stock profile for frame CS
      const stockProfile = getStockIccProfile(frameCS);
      if (stockProfile) {
        chunks.push(await buildIccpChunk(stockProfile.bytes, stockProfile.name));
        // console.debug('[ColorMgmt] PNG Export: embedded stock ICC profile for %s', frameCS);
      } else {
        chunks.push(buildSrgbChunk());
      }
    } else if (frameCS === 'srgb') {
      // No embedding requested → insert sRGB chunk as lightweight color declaration
      chunks.push(buildSrgbChunk());
    }

    // Insert tEXt chunks (Author, Copyright, Software)
    if (hasAuthor) {
      const name = config?.author?.name || meta?.author?.name || '';
      chunks.push(buildTextChunk('Author', name));
    }
    if (hasCopyright) {
      const cr = config?.author?.copyright || meta?.author?.copyright || '';
      chunks.push(buildTextChunk('Copyright', cr));
    }
    if (writeSoftware) {
      chunks.push(buildTextChunk('Software', 'OpenGPEX'));
    }

    // Insert eXIf chunk (raw EXIF passthrough with Orientation reset)
    if (config?.preserveExif && meta?.raw?.exif) {
      const exifBytes = base64ToIcc(meta.raw.exif);
      // Reset Orientation to 1 (Normal) since exported pixels are already correctly
      // oriented. Source formats like HEIC may store non-trivial orientation in EXIF,
      // but the composite/transcode pipeline normalizes pixel orientation.
      resetExifOrientation(exifBytes);
      chunks.push(buildExifChunk(exifBytes));
    }

    // Insert tIME chunk (current export timestamp)
    chunks.push(buildTimeChunk());

    // Remaining original chunks (skip any we're replacing to avoid duplicates)
    // Use iterateChunks but skip signature + IHDR (already added)
    let firstChunkSeen = false;
    for (const chunk of iterateChunks(bytes)) {
      // Skip IHDR (already added above)
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        continue;
      }
      // Skip chunks we're replacing
      if (chunk.type === 'pHYs' || chunk.type === 'sRGB' || chunk.type === 'tEXt'
          || chunk.type === 'iCCP' || chunk.type === 'tIME' || chunk.type === 'iTXt'
          || chunk.type === 'eXIf') {
        continue;
      }
      // Keep everything else (IDAT, IEND, etc.)
      chunks.push(bytes.slice(chunk.offset, chunk.offset + chunk.totalSize));
    }

    const result = concat(chunks);
    return new Blob([result.buffer as ArrayBuffer], { type: 'image/png' });
  } catch (e) {
    console.warn('[PngHandler.encode] Chunk injection failed, returning raw blob:', e);
    return baseBlob;
  }
}
