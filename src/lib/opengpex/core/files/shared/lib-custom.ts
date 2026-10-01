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
 * Files-layer CUSTOM (hand-rolled, CPU-side) decode/render infrastructure — the
 * counterpart to `lib-vips.ts`: where that proxies the external vips engine, this
 * is our own pixel code for the paths vips does not own. The SINGLE home for both
 * CPU-side proxy producers, shared by every raster decoder.
 *
 * Two entry points, one per decode channel:
 *
 * {@link renderDisplayProxy} — renders ONLY the display proxy from a
 * source-encoded 8-bit readback (colour management OFF, so `data` holds
 * SOURCE-encoded pixels, whatever produced them). Fed by the `vips` channel
 * (≥8-bit, and all TIFF) directly, AND by `decodeWideGamut8`'s wide branch (a
 * browser `getImageData` readback) — hence it is source-agnostic, not vips-only.
 * It decides colour by the source gamut:
 *   - non-wide (srgb / display-p3): FOLLOW the source — pass pixels through
 *     untouched and tag the canvas with the matching native space, so the browser
 *     shows them in their own gamut with zero conversion;
 *   - wide (adobe-rgb / prophoto-rgb): the canvas has no native tag for these, so
 *     CPU-fold source → working P3 and tag a display-p3 canvas.
 * The full-precision line is NOT this function's concern — on the `vips` channel
 * it travels on the vips f16 `highDepthSource`, colour-management-agnostic at the
 * source gamut; on the `wide-gamut-8` channel `decodeWideGamut8` lifts it (below).
 *
 * {@link decodeWideGamut8} — the `wide-gamut-8` channel (8-bit wide gamut read via
 * the browser with colour management off). Produces BOTH outputs a wide-gamut
 * import needs: the display proxy (delegated to `renderDisplayProxy`'s wide
 * branch, so the fold+canvas logic lives once) AND a CPU f16 lift of the source's
 * unclamped linear pixels (via the colour-layer kernel `core/engine/color/wideGamutF16`).
 * Unlike the `vips` channel, here the f16 high-depth line is produced on the CPU,
 * right beside the display proxy — hence both live in this one call.
 *
 * @module core/files/shared/lib-custom
 */

import type { WorkingColorSpace, GamutId } from '@opengpex/editor/core/types';
import {
  convertImageDataColorSpace,
  wideGamut8ToF16,
  type WideGamutHighDepth,
} from '@opengpex/editor/core/engine/color';
import { readSourceEncodedRgba } from '../utils';

/**
 * Render the gamut-aware 8-bit display proxy Blob from a source-encoded readback
 * (from a preserve-mode vips decode, or a browser colour-managed-off getImageData).
 * See the module header for the follow-vs-fold policy.
 */
export async function renderDisplayProxy(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  gamut: GamutId,
): Promise<Blob> {
  // Fresh Uint8ClampedArray over a plain ArrayBuffer — required by ImageData /
  // convertImageDataColorSpace, and it isolates the destructive fold below.
  const clamped = new Uint8ClampedArray(width * height * 4);
  clamped.set(data);

  let canvasCS: PredefinedColorSpace;
  if (gamut === 'srgb' || gamut === 'display-p3') {
    // Follow the source: no pixel conversion, tag the native canvas space.
    canvasCS = gamut === 'display-p3' ? 'display-p3' : 'srgb';
  } else {
    // Wide gamut (adobe-rgb / prophoto-rgb): fold source → working P3. The
    // `as WorkingColorSpace` aligns the GamutId with the callee's input axis.
    convertImageDataColorSpace(clamped, gamut as WorkingColorSpace, 'display-p3');
    canvasCS = 'display-p3';
  }

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { colorSpace: canvasCS })!;
  ctx.putImageData(new ImageData(clamped, width, height, { colorSpace: canvasCS }), 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

/** Outputs of the `wide-gamut-8` decode channel — the display proxy + its f16-linear high-depth line. */
export interface WideGamut8Decoded {
  readonly displayBlob: Blob;
  /**
   * Unclamped f16-linear naked pixels of the SOURCE gamut. Inline shape is
   * compatible with `DecodeResult.highDepthSource`, so it mounts directly.
   */
  readonly highDepthSource: WideGamutHighDepth;
  readonly width: number;
  readonly height: number;
}

/**
 * Decode the `wide-gamut-8` channel: a source file (JPEG, WebP, PNG, AVIF, HEIC) →
 * BOTH outputs a wide-gamut import needs, in one call.
 *
 *   1. Reads source-encoded pixels with browser colour management OFF via {@link readSourceEncodedRgba};
 *   2. Lifts UNCLAMPED f16-linear naked pixels straight from source readback via {@link wideGamut8ToF16};
 *   3. Renders the 8-bit display proxy Blob folded to Display P3 via {@link renderDisplayProxy}.
 *
 * @param source   - encoded image file or Blob (JPEG, WebP, PNG, AVIF, HEIC)
 * @param srcGamut - the source gamut (adobe-rgb / prophoto-rgb)
 */
export async function decodeWideGamut8(
  source: Blob,
  srcGamut: 'adobe-rgb' | 'prophoto-rgb',
): Promise<WideGamut8Decoded> {
  const { data, w, h } = await readSourceEncodedRgba(source);
  const highDepthSource = wideGamut8ToF16(data, w, h, srcGamut);
  const displayBlob = await renderDisplayProxy(data, w, h, srcGamut);
  return { displayBlob, highDepthSource, width: w, height: h };
}
