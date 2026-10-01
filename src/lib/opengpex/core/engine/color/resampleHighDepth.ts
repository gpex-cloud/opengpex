/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * resampleHighDepth.ts — CPU bilinear resample for HIGH-DEPTH naked RGBA pixels
 * (for resized 16-bit bakes).
 *
 * WHY THIS EXISTS: `compositeResizedLayers` produces a scaled bake. The 8-bit
 * DISPLAY blob is scaled on a Canvas, but the high-depth naked pixels have no
 * Canvas path — an `rgba16float` texture cannot be `drawImage`-scaled without
 * losing precision. This resamples the high-depth buffer DIRECTLY so a resized
 * 16-bit product keeps full precision, rather than degrading to the
 * 8-bit display blob.
 *
 * NAMED FOR THE AXIS, NOT ONE CONTAINER: this was `resampleF16.ts` /
 * `resampleBilinearF16` while f16 WAS the contract. It now spans both high-depth
 * containers (`rgba16float`'s `Uint16Array` and `rgba32float`'s `Float32Array`)
 * and the element type carries the container, so an `F16` suffix would
 * misdescribe it. Its siblings [float16.ts](./float16.ts) and
 * [wideGamutF16.ts](./wideGamutF16.ts) KEEP their `F16` names — those genuinely
 * only ever produce f16, so the suffix is still accurate there.
 *
 * PRECISION: every f16 sample is decoded to f32 (`halfToFloat`), interpolated in
 * f32, and only the final result is re-packed to half (`floatToHalf`). We NEVER
 * interpolate on the raw 16-bit bit patterns (which are non-linear in value). A
 * genuine `Float32Array` source (a 32-bit float file) skips both the decode
 * and the re-pack and stays f32 end to end.
 *
 * ⚠️ STRAIGHT vs PREMULTIPLIED: this interpolates each channel independently,
 * which is correct for STRAIGHT (un-premultiplied) pixels — the shape the bake
 * product's `HighDepthSource` carries (exportEncode un-premultiplies before
 * packing). Do NOT feed premultiplied pixels here without first un-premultiplying.
 *
 * Pure + dependency-free (only float16), so it runs identically in the browser
 * and under Node (vitest).
 *
 * @module core/engine/color/resampleHighDepth
 */

import { halfToFloat, floatToHalf } from './float16';

/**
 * Bilinearly resample an interleaved RGBA high-depth buffer to a new size.
 *
 * The buffer's element type IS its container, and it round-trips: a `Uint16Array`
 * (f16 bit patterns) in yields a `Uint16Array` out; a `Float32Array` (a true
 * 32-bit float source) in yields a `Float32Array` out, so resizing a
 * 32-bit layer does not silently demote it. Interpolation is in f32 either way —
 * only the f16 path pays a decode on entry and a re-pack on exit.
 *
 * @param src   - RGBA-interleaved f16 bit patterns or f32 floats, length `srcW*srcH*4`.
 * @param srcW  - Source width in pixels (≥ 1).
 * @param srcH  - Source height in pixels (≥ 1).
 * @param dstW  - Destination width in pixels (≥ 1).
 * @param dstH  - Destination height in pixels (≥ 1).
 * @returns A buffer of the SAME type as `src`, length `dstW*dstH*4`.
 */
export function resampleBilinear<T extends Uint16Array | Float32Array>(
  src: T,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): T {
  if (srcW < 1 || srcH < 1 || dstW < 1 || dstH < 1) {
    throw new Error(`[resampleHighDepth] invalid dims ${srcW}x${srcH} → ${dstW}x${dstH}`);
  }
  const expected = srcW * srcH * 4;
  if (src.length < expected) {
    throw new Error(`[resampleHighDepth] src too small: got ${src.length}, need ${expected}`);
  }

  // An f32 source is already in the interpolation domain: no decode, no re-pack.
  const isF32 = src instanceof Float32Array;
  const out = (isF32 ? new Float32Array(dstW * dstH * 4) : new Uint16Array(dstW * dstH * 4)) as T;

  // Pre-decode source to f32 once (avoids decoding the same texel 4× across taps).
  let srcF: Float32Array;
  if (isF32) {
    srcF = src;
  } else {
    srcF = new Float32Array(expected);
    for (let i = 0; i < expected; i++) srcF[i] = halfToFloat(src[i]);
  }

  // Map dst pixel CENTER to src space (half-pixel convention — same as GPU linear
  // sampling / most image resamplers): srcX = (dx + 0.5) * srcW/dstW - 0.5.
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;

  for (let dy = 0; dy < dstH; dy++) {
    let sy = (dy + 0.5) * scaleY - 0.5;
    if (sy < 0) sy = 0;
    else if (sy > srcH - 1) sy = srcH - 1;
    const y0 = Math.floor(sy);
    const y1 = y0 + 1 < srcH ? y0 + 1 : y0;
    const wy = sy - y0;

    for (let dx = 0; dx < dstW; dx++) {
      let sx = (dx + 0.5) * scaleX - 0.5;
      if (sx < 0) sx = 0;
      else if (sx > srcW - 1) sx = srcW - 1;
      const x0 = Math.floor(sx);
      const x1 = x0 + 1 < srcW ? x0 + 1 : x0;
      const wx = sx - x0;

      const i00 = (y0 * srcW + x0) * 4;
      const i01 = (y0 * srcW + x1) * 4;
      const i10 = (y1 * srcW + x0) * 4;
      const i11 = (y1 * srcW + x1) * 4;
      const o = (dy * dstW + dx) * 4;

      for (let c = 0; c < 4; c++) {
        const top = srcF[i00 + c] * (1 - wx) + srcF[i01 + c] * wx;
        const bot = srcF[i10 + c] * (1 - wx) + srcF[i11 + c] * wx;
        const v = top * (1 - wy) + bot * wy;
        out[o + c] = isF32 ? v : floatToHalf(v);
      }
    }
  }

  return out;
}
