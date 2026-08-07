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
 * AVIF encode — Dual-Engine Architecture with size-aware routing.
 *
 * Encoding engines:
 * 1. @jsquash/avif — isolated Worker, ALLOW_MEMORY_GROWTH (no 2GB cap), no ICC embed
 * 2. vips-heif — engine Worker, ICC embed + 10-bit, shares wasm-vips 2GB heap
 *
 * Routing logic (when USE_VIPS_FOR_ICC_AVIF=true):
 *   - Image ≤ 16 Mpx → vips-heif (ICC embedding, high-quality AV1)
 *   - Image > 16 Mpx  → @jsquash/avif (OOM protection, no ICC embed)
 *
 * The 16 Mpx threshold prevents libaom from exhausting the wasm-vips 2GB heap
 * when allocating encoder lag buffers for large images.
 */

import type { PixelService, WorkingColorSpace } from '@opengpex/editor/core/types';
import type { EncodeOptions } from '../../types';
import { bitmapToCanvas } from '../../index';
import { base64ToIcc } from '../../icc';
import { convertImageDataColorSpace } from '@opengpex/editor/core/color/matrices';
import { getExportStrategy, resolveExportPixelConversion } from '@opengpex/editor/core/color/ColorPipeline';
import { encodeAvifJsquash } from './worker';

/**
 * When true, AVIF exports route through vips-heif for ICC embedding support.
 * When false, ALL encoding uses @jsquash/avif in an isolated Worker.
 *
 * Note: vips-heif shares the wasm-vips 2GB heap. For large images (>16 Mpx),
 * libaom's encoder buffers can exhaust available memory. The routing logic
 * below automatically falls back to @jsquash for images exceeding the threshold.
 */
const USE_VIPS_FOR_ICC_AVIF = true;

/**
 * Maximum pixel count (width × height) for which vips-heif encoding is safe.
 * Above this threshold, encoding falls back to @jsquash/avif to avoid OOM.
 *
 * 16 Mpx ≈ 4096×4000 — libaom needs ~5-8× raw size for encoder buffers,
 * so 16Mpx × 4 bytes × 6 ≈ 384 MB peak, well within the 2GB wasm heap.
 * A 24.5 Mpx image (4284×5712) would need ~600-800MB for lag buffers alone,
 * which combined with other vips allocations risks OOM.
 */
const VIPS_HEIF_MAX_PIXELS = 16_000_000;

/**
 * Encode a canvas/bitmap to AVIF with color management.
 */
export async function encodeAvif(
  source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
  pixels: PixelService,
  options: EncodeOptions,
): Promise<Blob> {
  const quality = Math.round((options.quality ?? 0.80) * 100);
  const meta = options.metadata;
  const config = options.exportConfig;

  const frameCS: WorkingColorSpace = (config?.frameColorSpace as WorkingColorSpace) || 'srgb';
  const exportStrategy = getExportStrategy(frameCS, 'avif');
  const embedIcc = config?.embedIcc ?? false;

  const pixelConv = resolveExportPixelConversion(
    frameCS,
    { colorSpace: meta?.colorSpace, hasIccProfileData: !!meta?.raw?.icc?.data },
    embedIcc,
    'avif',
  );

  // Pixel extraction with color space handling
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
    console.debug('[ColorMgmt] AVIF Export: pixelConversion=p3-to-srgb');
  } else {
    canvas = source instanceof ImageBitmap
      ? bitmapToCanvas(source, exportStrategy.encodeColorSpace)
      : source as OffscreenCanvas;
  }

  const ctx = (canvas as OffscreenCanvas).getContext('2d')!;
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const rgbaData = new Uint8Array(imageData.data.buffer);

  // ICC profile preparation
  let iccProfileBytes: Uint8Array | undefined;

  if (embedIcc && meta?.raw?.icc?.data) {
    iccProfileBytes = base64ToIcc(meta.raw.icc?.data);

    if (pixelConv === 'srgb-to-icc') {
      const { data: convertedData } = await pixels.fileIO.srgbToIcc(
        rgbaData, canvas.width, canvas.height, iccProfileBytes,
      );
      rgbaData.set(convertedData);
      console.debug('[ColorMgmt] AVIF Export: pixelConversion=srgb-to-icc, profile=%s',
        meta.raw.icc?.name || 'custom');
    }
  } else if (embedIcc && !meta?.raw?.icc?.data) {
    console.debug('[ColorMgmt] AVIF Export: embedIcc=true but no source ICC data; sRGB assumed');
  }

  // Engine routing — size-aware dual-engine dispatch
  const totalPixels = canvas.width * canvas.height;
  const useVips = USE_VIPS_FOR_ICC_AVIF && totalPixels <= VIPS_HEIF_MAX_PIXELS;

  if (useVips) {
    console.debug('[ColorMgmt] AVIF Export: vips-heif engine, frameCS=%s, hasSourceIcc=%s, pixels=%d',
      frameCS, !!iccProfileBytes, totalPixels);
    const avifBytes = await pixels.fileIO.encodeAvif(rgbaData, canvas.width, canvas.height, {
      quality, lossless: false, effort: 4,
      iccProfileBytes: embedIcc ? iccProfileBytes : undefined,
      bitDepth: meta?.bitDepth, dpi: config?.dpi || meta?.dpi,
    });
    return new Blob([avifBytes.buffer as ArrayBuffer], { type: 'image/avif' });
  }

  // @jsquash/avif path — isolated Worker, no ICC embedding, no size limit
  if (USE_VIPS_FOR_ICC_AVIF && totalPixels > VIPS_HEIF_MAX_PIXELS) {
    console.warn('[AvifHandler] Image too large for vips-heif (%dx%d = %d Mpx > %d Mpx limit). Falling back to @jsquash/avif.',
      canvas.width, canvas.height, Math.round(totalPixels / 1_000_000), Math.round(VIPS_HEIF_MAX_PIXELS / 1_000_000));
    if (embedIcc) {
      console.warn('[AvifHandler] ICC profile will be omitted for this large image (vips-heif OOM protection).');
    }
  } else if (embedIcc) {
    console.warn('[AvifHandler] ICC embed not supported (USE_VIPS_FOR_ICC_AVIF=false). Colors preserved, profile omitted.');
  }
  console.debug('[ColorMgmt] AVIF Export: @jsquash/avif engine, frameCS=%s, pixels=%d', frameCS, totalPixels);
  const avifBytes = await encodeAvifJsquash(rgbaData, canvas.width, canvas.height, { quality, speed: 6 });
  return new Blob([avifBytes.buffer as ArrayBuffer], { type: 'image/avif' });
}
