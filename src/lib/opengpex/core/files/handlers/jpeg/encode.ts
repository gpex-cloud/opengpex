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
import type { GamutId } from '@opengpex/editor/core/types';
import { toGamutId } from '@opengpex/editor/core/types';
import type { EncodeOptions } from '../../types';
import { bitmapToCanvas } from '../../index';
import { base64ToIcc, getStockIccProfile } from '../../shared/icc';
import { toCanvasColorSpace } from '@opengpex/editor/core/engine/color';
import { injectJpegExif, injectJpegIcc } from './jfif';
import { blobToBase64, base64ToBlob } from '../../utils';

/**
 * Encode a canvas/bitmap to JPEG with metadata injection.
 *
 * ── COLOR CONTRACT ──────────────────────────────────────────────────────────
 * Pixels arrive ALREADY in the target gamut with the target TRC applied — the
 * terminal `unpremultiplyEncodeGamut` in the export command performed the single
 * source→target gamut matrix + TRC + quantization step. This encoder therefore
 * performs ZERO internal color conversion: it only writes the JPEG container and
 * the EXIF/ICC metadata matching what the pixels now carry (the source ICC
 * verbatim on a same-gamut round-trip; a stock profile for `targetGamut`
 * otherwise). The canvas is tagged `toCanvasColorSpace(targetGamut)` purely to
 * prevent the browser encoder from reinterpreting the already-correct pixels.
 */
export async function encodeJpeg(
  source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
  options: EncodeOptions,
): Promise<Blob> {
  const quality = options.quality ?? 0.92;
  const meta = options.metadata;
  const config = options.exportConfig;

  // The gamut the incoming pixels ARE in = the egest decision's `targetGamut`.
  // The terminal encode already converted into it upstream, so it drives ONLY the
  // canvas tag + ICC selection here.
  const targetGamut: GamutId = (config?.targetGamut as GamutId | undefined) ?? 'srgb';
  // Embed the SOURCE profile verbatim ONLY when the output gamut still equals the
  // source file's gamut (exact round-trip) — the pixels are then in the source's
  // numeric space, so a stock `targetGamut` profile would mislabel them.
  const sourceIccMatchesTarget = !!meta?.raw?.icc?.data && toGamutId(meta?.colorSpace) === targetGamut;
  const embedSourceIccVerbatim = sourceIccMatchesTarget;

  // Pixels already carry targetGamut + its TRC — tag the canvas to match so the
  // browser encoder does not reinterpret them. NO color conversion here.
  const canvas: OffscreenCanvas = source instanceof ImageBitmap
    ? bitmapToCanvas(source, toCanvasColorSpace(targetGamut))
    : source as OffscreenCanvas;

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
    if (config?.embedIcc && embedSourceIccVerbatim) {
      // Round-trip OR post-pre-encode-conversion → embed the source's own profile.
      const iccBytes = base64ToIcc(meta!.raw!.icc!.data);
      const jpegBytes = new Uint8Array(await resultBlob.arrayBuffer());
      const withIcc = injectJpegIcc(jpegBytes, iccBytes);
      resultBlob = new Blob([withIcc.buffer as ArrayBuffer], { type: 'image/jpeg' });
    } else if (config?.embedIcc) {
      // No matching source ICC (none present, or gamut changed) → embed the stock
      // profile for the OUTPUT gamut, which is what the pixels now carry.
      const stockProfile = getStockIccProfile(targetGamut);
      if (stockProfile) {
        const jpegBytes = new Uint8Array(await resultBlob.arrayBuffer());
        const withIcc = injectJpegIcc(jpegBytes, stockProfile.bytes);
        resultBlob = new Blob([withIcc.buffer as ArrayBuffer], { type: 'image/jpeg' });
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
