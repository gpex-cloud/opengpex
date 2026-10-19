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
 * wideGamutF16.ts — wide-gamut degamma → f16-linear naked-pixel kernels.
 *
 * A CPU pixel-op over naked interleaved RGBA (8- or 16-bit) that linearizes a
 * wide-gamut source with the CORRECT source gamma and packs the result to IEEE
 * binary16, producing the raw f16-LINEAR line the GPU raw upload + shader
 * `gamut_to_working` consume. Sibling to `resampleHighDepth.ts` (both are
 * high-depth naked-pixel ops that belong to the colour layer, not any one
 * decoder); it composes `trc.ts` (the source gamma) with `float16.ts` (the
 * packing), the two lower colour primitives it sits on top of.
 *
 * WHY THIS ONE KEEPS ITS `F16` NAME: the sibling was renamed off `resampleF16.ts`
 * when it grew to span `rgba32float` too, but this module's SOURCE is
 * always integer pixels and its OUTPUT is always f16 — the f32 in `linearFloatToFloat16`
 * is a mere arithmetic intermediate between normalize and degamma, never a
 * container. So `F16` is still an accurate contract here, and this module was
 * deliberately left out of the 32-bit passthrough change.
 *
 * WHY IT LIVES IN core/color (not core/files): these are pure colour-science
 * kernels with zero decode/container knowledge — no Canvas, no Blob, no strategy.
 * The files layer's `lib-custom.ts` (`decodeWideGamut8`) and `lib-vips.ts` f16
 * packing both call DOWN into here, alongside float16's `normalizedUint16ToFloat16`
 * / `linearFloatToFloat16`, so all "naked buffer → f16" packers sit together.
 *
 * The three ingest losses of the legacy 8-bit CPU matrix-fold are removed by
 * construction:
 *   ① TRC — linearizes with the CORRECT source gamma ({@link gammaToLinear}), not
 *      the sRGB EOTF;
 *   ② gamut clamp — NO matrix, NO clamp: source-gamut linear values pass straight
 *      through (super-P3 colours survive; the shader matrix later emits negatives);
 *   ③ requantization — packs to f16 bit patterns, no 8-bit round-trip.
 *
 * @module core/engine/color/wideGamutF16
 */

import { gammaToLinear, ADOBE_RGB_GAMMA, PROPHOTO_GAMMA, rec2020ToLinear } from './trc';
import { linearFloatToFloat16 } from './float16';
import { pqToSceneLinear, hlgToSceneLinear } from './hdrTransfer';

/** Shape of the `highDepthSource` a wide-gamut degamma produces (mirrors DecodeResult). */
export interface WideGamutHighDepth {
  data: Uint16Array;
  width: number;
  height: number;
  format: 'rgba16float';
  trc: 'linear';
  gamut: 'adobe-rgb' | 'prophoto-rgb' | 'rec2020';
}

/**
 * Shared degamma kernel: naked interleaved RGBA (8- or 16-bit) → f16-linear.
 *
 * RGB channels are linearized with the CORRECT source gamma; alpha is linear
 * coverage and passes straight through with no TRC. The only per-bit-depth
 * difference is the normalization divisor (`inv` = 1/255 or 1/65535) — the gamma
 * curve itself is bit-depth independent.
 */
function degammaToF16Linear(
  naked: Uint8ClampedArray | Uint16Array,
  inv: number,
  gamma: number,
): Uint16Array {
  const linear = new Float32Array(naked.length);
  for (let i = 0; i < naked.length; i += 4) {
    linear[i] = gammaToLinear(naked[i] * inv, gamma);
    linear[i + 1] = gammaToLinear(naked[i + 1] * inv, gamma);
    linear[i + 2] = gammaToLinear(naked[i + 2] * inv, gamma);
    linear[i + 3] = naked[i + 3] * inv; // alpha: linear coverage, no TRC
  }
  return linearFloatToFloat16(linear);
}

/**
 * Reroute a wide-gamut 8-bit source onto the raw f16-linear line.
 *
 * Takes the SOURCE-ENCODED 8-bit RGBA readback (from `createImageBitmap(none)` +
 * `getImageData`, or vips color-agnostic decode) and produces a `highDepthSource`
 * identical in contract to a 16-bit wide-gamut source, so the existing GPU raw
 * upload line and shader `gamut_to_working(2u/3u)` handle it with ZERO changes.
 *
 * Alpha is linear coverage, never gamma-encoded, so it is mapped `/255` straight
 * through with no TRC.
 *
 * A 16-bit sibling ({@link wideGamut16ToF16}) shares this exact shape, differing
 * only in `/65535` normalization of the naked ushort input.
 *
 * @param readback - interleaved RGBA8 source-encoded pixels (length = w*h*4)
 * @param width    - pixel width
 * @param height   - pixel height
 * @param srcGamut - the source gamut (adobe-rgb / prophoto-rgb)
 */
export function wideGamut8ToF16(
  readback: Uint8ClampedArray,
  width: number,
  height: number,
  srcGamut: 'adobe-rgb' | 'prophoto-rgb',
): WideGamutHighDepth {
  const gamma = srcGamut === 'adobe-rgb' ? ADOBE_RGB_GAMMA : PROPHOTO_GAMMA;
  return {
    data: degammaToF16Linear(readback, 1 / 255, gamma),
    width,
    height,
    format: 'rgba16float',
    trc: 'linear',
    gamut: srcGamut,
  };
}

/**
 * 16-bit sibling of {@link wideGamut8ToF16}.
 *
 * Takes vips's color-management-agnostic naked ushort readback of a wide-gamut
 * 16-bit source (still SOURCE-gamma-encoded — the `vips` channel only normalizes
 * `/65535`, it does not degamma) and lifts it onto the raw f16-linear line, so
 * the packed pixels finally match the authoritative `colorIdentity.trc:'linear'`
 * the decision matrix assigns to rows 8/12 (PNG / TIFF 16-bit adobe-rgb / prophoto).
 *
 * Isomorphic to the 8-bit version — same gamma curve (bit-depth independent),
 * same unclamped-linear + f16-pack output contract — differing ONLY in the
 * `/65535` normalization of the ushort input.
 *
 * @param naked    - interleaved RGBA16 source-encoded ushort pixels (length = w*h*4)
 * @param width    - pixel width
 * @param height   - pixel height
 * @param srcGamut - the source gamut (adobe-rgb / prophoto-rgb / rec2020-SDR)
 */
export function wideGamut16ToF16(
  naked: Uint16Array,
  width: number,
  height: number,
  srcGamut: 'adobe-rgb' | 'prophoto-rgb' | 'rec2020',
): WideGamutHighDepth {
  if (srcGamut === 'rec2020') {
    // SDR BT.2020 (phase D4, gap #8): the container's transfer IS the ITU
    // BT.709/BT.2020 OETF (α/β piecewise — the same constants both standards
    // publish; `rec2020ToLinear` is its exact inverse). Same f16-linear
    // contract as the gamma siblings: source-gamut linear, no matrix, no clamp.
    const linear = new Float32Array(naked.length);
    for (let i = 0; i < naked.length; i += 4) {
      linear[i] = rec2020ToLinear(naked[i] / 65535);
      linear[i + 1] = rec2020ToLinear(naked[i + 1] / 65535);
      linear[i + 2] = rec2020ToLinear(naked[i + 2] / 65535);
      linear[i + 3] = naked[i + 3] / 65535; // alpha: coverage, no TRC
    }
    return {
      data: linearFloatToFloat16(linear),
      width,
      height,
      format: 'rgba16float',
      trc: 'linear',
      gamut: srcGamut,
    };
  }
  const gamma = srcGamut === 'adobe-rgb' ? ADOBE_RGB_GAMMA : PROPHOTO_GAMMA;
  return {
    data: degammaToF16Linear(naked, 1 / 65535, gamma),
    width,
    height,
    format: 'rgba16float',
    trc: 'linear',
    gamut: srcGamut,
  };
}

/**
 * HDR transfer delinearizer — the PQ/HLG sibling of the wide-gamut degamma.
 *
 * Input: naked interleaved RGBA at the 65535 scale carrying RAW TRANSFER CODE
 * VALUES (what the wasm AVIF decoder delivers bit-exactly — no linearization,
 * no OOTF). Output: f16 SCENE-REFERENCED linear light in the SOURCE gamut
 * (1.0 = 203 cd/m² SDR white anchor; > 1.0 = headroom), the shape the GPU
 * raw upload + `gamut_to_working` consume with `trc: 'linear'` and the
 * source's gamut tag. Alpha is coverage and passes through normalized.
 *
 * NO gamut matrix, NO clamp here — same contract as the wide-gamut kernels:
 * source-gamut scene-linear values pass straight through (the shader matrix
 * later emits negatives for out-of-display colours; HDR headroom survives).
 */
export function hdrTransfer16ToF16(
  naked: Uint16Array,
  transfer: 'pq' | 'hlg',
): Uint16Array {
  const toScene = transfer === 'pq' ? pqToSceneLinear : hlgToSceneLinear;
  const linear = new Float32Array(naked.length);
  for (let i = 0; i < naked.length; i += 4) {
    linear[i] = toScene(naked[i] / 65535);
    linear[i + 1] = toScene(naked[i + 1] / 65535);
    linear[i + 2] = toScene(naked[i + 2] / 65535);
    linear[i + 3] = naked[i + 3] / 65535; // alpha: coverage, no TRC
  }
  return linearFloatToFloat16(linear);
}
