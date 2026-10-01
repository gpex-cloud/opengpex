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
 * AVIF encode — @jsquash/avif only (isolated Worker).
 *
 * ── DESIGN DECISION (deliberate, not an oversight) ─────────────────────────
 * AVIF encoding runs EXCLUSIVELY through @jsquash/avif in a dedicated, crash-
 * isolated Worker (`./worker` → `/ext/wasm/avif/avif-worker.js`). This mirrors
 * the WebP handler's shape (encode does NOT touch the shared wasm-vips engine),
 * the only difference being that AVIF has no browser-native encoder so it uses
 * @jsquash instead of `canvas.convertToBlob`.
 *
 * WHY WE DROPPED THE vips-heif ENCODE PATH:
 *   The former dual-engine routing (vips-heif ≤16Mpx for ICC embed, @jsquash
 *   >16Mpx) was removed. wasm-vips has a fixed heap and libaom's encoder
 *   buffers exhaust it on large images; worse, an OOM inside the SHARED vips
 *   singleton corrupts it (Emscripten ABORT) and takes down every other vips
 *   consumer (TIFF/PNG/ICC) until a full page reload — with no restart path.
 *   Self-compiling vips to lift the heap cap was evaluated and judged not worth it.
 *
 * ⚠️ KNOWN DEFECT (accepted, tracked): AVIF export CANNOT embed an ICC profile.
 *   @jsquash/avif has no ICC-embed capability. Pixels are still encoded
 *   correctly (sRGB or P3 as prepared by the colour pipeline below), but the
 *   output carries NO colour-space marker. This is a metadata-only side issue —
 *   it does NOT corrupt the image data. Consequence: a P3 AVIF may be
 *   interpreted as sRGB by naive viewers. Acceptable trade-off for a simple,
 *   crash-safe pipeline. FUTURE FIX (no vips needed): inject an ISOBMFF `colr`
 *   box post-encode, or adopt an encoder library that supports ICC embedding —
 *   then this handler can regain profile embedding without the OOM risk.
 * ───────────────────────────────────────────────────────────────────────────
 */

import type { GamutId } from '@opengpex/editor/core/types';
import type { EncodeOptions } from '../../types';
import { bitmapToCanvas } from '../../index';
import { toCanvasColorSpace } from '@opengpex/editor/core/engine/color';
import { encodeAvifJsquash } from './worker';

/**
 * Encode a canvas/bitmap to AVIF with colour management.
 *
 * ── COLOR CONTRACT ──────────────────────────────────────────────────────────
 * Pixels arrive ALREADY in the target gamut with the target TRC applied (the
 * terminal `unpremultiplyEncodeGamut` in the export command did the single
 * source→target matrix + TRC + quantization step). This encoder performs ZERO
 * internal color conversion — it only tags the canvas to match `config.targetGamut`
 * so the browser round-trip does not reinterpret the pixels. (Wide-gamut Adobe RGB /
 * ProPhoto targets are routed to the PNG/TIFF 16-bit path upstream and never reach
 * this handler.) See the KNOWN DEFECT note: AVIF still cannot embed an ICC profile.
 *
 * `pixels` is retained in the signature for interface parity with the other
 * handlers (ImageFormatHandler), but AVIF encode no longer dispatches any vips
 * job — see the DESIGN DECISION note above.
 */
export async function encodeAvif(
  source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
  options: EncodeOptions,
): Promise<Blob> {
  const quality = Math.round((options.quality ?? 0.80) * 100);
  const config = options.exportConfig;

  const embedIcc = config?.embedIcc ?? false;

  // The gamut the incoming pixels ARE in. AVIF only ever receives
  // srgb / display-p3 here (wide-gamut is routed onto the PNG/TIFF raw lanes).
  const targetGamut: GamutId = (config?.targetGamut as GamutId | undefined) ?? 'srgb';

  // Pixel extraction. Pixels already carry targetGamut + its TRC — tag the canvas
  // to match so the browser round-trip does not reinterpret them. NO color
  // conversion here.
  const canvas: OffscreenCanvas | HTMLCanvasElement = source instanceof ImageBitmap
    ? bitmapToCanvas(source, toCanvasColorSpace(targetGamut))
    : source as OffscreenCanvas;

  const ctx = (canvas as OffscreenCanvas).getContext('2d')!;
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const rgbaData = new Uint8Array(imageData.data.buffer);

  // ⚠️ KNOWN DEFECT (see file header): ICC embedding is unsupported for AVIF.
  if (embedIcc) {
    console.warn(
      '[AvifHandler] AVIF export cannot embed an ICC profile (@jsquash/avif ' +
      'limitation). Pixels are encoded correctly but no colour-space marker is ' +
      'written. Tracked defect — see avif/encode.ts header. Colours preserved, ' +
      'profile omitted.',
    );
  }

  // Single encode path — isolated @jsquash Worker, ALLOW_MEMORY_GROWTH, no size
  // limit, crash-isolated from the shared vips singleton.
  const avifBytes = await encodeAvifJsquash(rgbaData, canvas.width, canvas.height, { quality, speed: 6 });
  return new Blob([avifBytes.buffer as ArrayBuffer], { type: 'image/avif' });
}

