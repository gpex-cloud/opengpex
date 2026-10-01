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

import type { GamutId } from '@opengpex/editor/core/types';
import { toGamutId } from '@opengpex/editor/core/types';
import type { EncodeOptions } from '../../types';
import { bitmapToCanvas } from '../../index';
import { base64ToIcc, getStockIccProfile } from '../../shared/icc';
import { toCanvasColorSpace } from '@opengpex/editor/core/engine/color';
import { injectWebpIcc, stripWebpIcc, injectWebpExif } from './riff';
import { resetExifOrientation } from '../../metadata/tiff-ifd-reader';

/**
 * Encode a canvas/bitmap to WebP with ICC injection.
 *
 * ── COLOR CONTRACT ──────────────────────────────────────────────────────────
 * Pixels arrive ALREADY in the target gamut with the target TRC applied — the
 * terminal `unpremultiplyEncodeGamut` in the export command did the single
 * source→target matrix + TRC + quantization step, and there is NO reverse
 * pre-encode conversion anymore (the `srgb-to-icc` step was removed mechanism-
 * level: choosing sRGB now yields true sRGB, so `FileService.encode()` hands the
 * pixels straight to this handler untouched).
 * This encoder performs ZERO internal color conversion — it writes the WebP
 * RIFF container and the ICC profile matching what the pixels now carry.
 * (WebP has no browser PredefinedColorSpace beyond srgb/display-p3, so
 * wide-gamut Adobe RGB / ProPhoto targets are routed to the PNG/TIFF raw lanes
 * upstream and never reach this handler.)
 */
export async function encodeWebp(
  source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
  options: EncodeOptions,
): Promise<Blob> {
  const quality = options.quality ?? 0.80;
  const meta = options.metadata;
  const config = options.exportConfig;

  const embedIcc = config?.embedIcc ?? false;

  // The gamut the incoming pixels ARE in = the egest decision's `targetGamut`;
  // the pixels were already converted into it upstream.
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

  const baseBlob = await canvas.convertToBlob({
    type: 'image/webp',
    quality,
  });

  // Embed ICC Profile into WebP RIFF container (when embedIcc=true).
  if (embedIcc && embedSourceIccVerbatim) {
    // Round-trip (output gamut == source gamut) → embed the source's own profile.
    const iccBytes = base64ToIcc(meta!.raw!.icc!.data);
    const webpBytes = new Uint8Array(await baseBlob.arrayBuffer());
    const finalBytes = injectWebpIcc(webpBytes, iccBytes);
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
    // No matching source ICC (none present, or gamut changed) → stock OUTPUT-gamut profile
    const stockProfile = getStockIccProfile(targetGamut);
    if (stockProfile) {
      const webpBytes = new Uint8Array(await baseBlob.arrayBuffer());
      const finalBytes = injectWebpIcc(webpBytes, stockProfile.bytes);
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
