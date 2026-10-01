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
 * exportEncode.ts — the terminal TRC encode for the Readback export path.
 *
 * WHY THIS EXISTS
 * ---------------
 * `WebGpuEngine.export()` reads the composite buffer back verbatim: the
 * pixels are **premultiplied AND in LINEAR light** (the exact invariant the
 * on-screen `view.wgsl` fragment shader documents — "already premultiplied AND
 * in LINEAR LIGHT"). `#decodeReadback` neither un-premultiplies nor
 * TRC-encodes; it hands back raw linear values. This module performs the ONE
 * terminal step the codec layer needs:
 *
 *     un-premultiply → `linearToSrgb` (per RGB channel) → 8-bit quantize
 *
 * which is a line-for-line CPU mirror of `view.wgsl`'s `default` branch
 * (`straight = color.rgb / color.a; encode(straight); alpha unchanged`).
 *
 * SINGLE ENCODE POINT (hard invariant)
 * ------------------------------------
 * The sRGB/target-TRC encode must reuse the SAME transfer curve as `view.wgsl`,
 * so we import `linearToSrgb` from `core/engine/color/trc.ts` — the shared reference
 * implementation that `tests/.../colorspace-golden.test.ts` proves is bit-equal
 * to the WGSL `linear_to_srgb`. We MUST NOT re-derive an sRGB formula here;
 * doing so would create a second, drift-prone encode point (forbidden).
 *
 * DEFERRED (see command layer): 16/32-bit encoded output goes through a
 * separate naked-pixel worker path (`fileIO.encodeTiff`), not this 8-bit helper.
 *
 * Pure + dependency-free (only `trc.ts`), so it runs identically in the browser
 * and under Node (vitest).
 *
 * @module core/engine/utils/export-utils
 */

import { linearToSrgb, linearToGamma } from '@opengpex/editor/core/engine/color/trc';
import { floatToHalf } from '@opengpex/editor/core/engine/color/float16';
import { getConversionMatrix } from '@opengpex/editor/core/engine/color/matrices';
import type { WorkingColorSpace, GamutId } from '@opengpex/editor/core/types';

/**
 * Convert one row-major `rgba32float` buffer of PREMULTIPLIED LINEAR-light RGBA
 * (the shape `WebGpuEngine.export({ bitDepth: 32 })` returns) into straight,
 * sRGB-TRC-encoded 8-bit RGBA suitable for a Canvas `ImageData` / codec input.
 *
 * Per texel (mirrors `view.wgsl` `fs_main` default branch exactly):
 *   • `a <= 0`            → fully transparent, emit (0,0,0,0).
 *   • otherwise           → `straight = clamp(rgb / a, 0, 1)`, then
 *                            `linearToSrgb(straight)` per channel, ×255 rounded.
 *   • alpha               → coverage, NOT light: `clamp(a,0,1)·255`, NO TRC.
 *
 * The un-premultiply-before-encode ordering is mandatory: encoding the
 * premultiplied value directly would shift the colour of every semi-transparent
 * pixel (this is the same subtle rule `view.wgsl` calls out).
 *
 * @param linearPremul - Float32Array of length `width*height*4`, premultiplied
 *                       linear-light RGBA in [0,1] (values may slightly exceed 1
 *                       for wide-gamut/over-range; clamped on encode).
 * @param width  - pixel width  (used only to validate buffer length)
 * @param height - pixel height
 * @returns Uint8ClampedArray of straight sRGB-encoded RGBA, same pixel count.
 */
export function unpremultiplyEncodeSrgb8(
  linearPremul: Float32Array,
  width: number,
  height: number,
): Uint8ClampedArray {
  const expected = width * height * 4;
  if (linearPremul.length < expected) {
    throw new Error(
      `[exportEncode] buffer too small: got ${linearPremul.length}, need ${expected} (${width}×${height} RGBA)`,
    );
  }

  const out = new Uint8ClampedArray(expected);
  for (let i = 0; i < expected; i += 4) {
    const a = linearPremul[i + 3];

    if (a <= 0) {
      // Fully transparent — emit zeroed pixel (matches view.wgsl a<=0 branch).
      out[i] = 0;
      out[i + 1] = 0;
      out[i + 2] = 0;
      out[i + 3] = 0;
      continue;
    }

    // Un-premultiply to the straight colour BEFORE the TRC encode.
    const sr = clamp01(linearPremul[i] / a);
    const sg = clamp01(linearPremul[i + 1] / a);
    const sb = clamp01(linearPremul[i + 2] / a);

    // Single encode point: reuse trc.ts linearToSrgb (== view.wgsl).
    // Uint8ClampedArray rounds-to-nearest + clamps on assignment.
    out[i] = linearToSrgb(sr) * 255;
    out[i + 1] = linearToSrgb(sg) * 255;
    out[i + 2] = linearToSrgb(sb) * 255;
    // Alpha is coverage, not light — no TRC, just quantize.
    out[i + 3] = clamp01(a) * 255;
  }
  return out;
}

/**
 * Convert one row-major `rgba32float` buffer of PREMULTIPLIED LINEAR-light RGBA
 * (the shape `WebGpuEngine.export({ bitDepth: 32 })` returns) into STRAIGHT
 * (un-premultiplied) LINEAR-light half-float RGBA — the naked-pixel shape a
 * `HighDepthSource` carries (`dataFormat:'rgba16float'`, `trc:'linear'`).
 *
 * This is the 16-bit sibling of `unpremultiplyEncodeSrgb8` and the SAME single
 * encode point: both un-premultiply identically; they differ only in
 * the terminal quantization. Here we DO NOT apply the sRGB TRC — the product is
 * kept in linear light so the GPU can re-composite it losslessly (the
 * `HighDepthSource.trc:'linear'` tag tells `SceneAssembler` to skip the
 * sRGB→linear decode on sample). Over-range values (wide gamut / HDR) survive
 * because half-float is unclamped above 1.0; we only guard the ×divide.
 *
 * Bake-precision settlement: a 16-bit layer merge/peel keeps full
 * precision instead of truncating to 8-bit sRGB.
 *
 * GAMUT: the readback is in the WORKING gamut (always Linear Display-P3 —
 * `GpuDevice.configureSurface`). When the bake target gamut differs (an sRGB
 * document with a P3 layer in it), pass `gamut` so the naked pixels land in the
 * SAME gamut as the 8-bit sibling blob and the asset's `ColorIdentity.gamut`.
 * Omitting it would register P3 numbers under an sRGB tag, and `SceneAssembler`
 * would then have the shader apply a spurious sRGB→P3 lift on re-composite.
 *
 * Unlike {@link unpremultiplyEncodeGamut}, the matrix output is NOT clamped to
 * [0,1]: half-float is the container precisely so out-of-gamut / over-range values
 * survive a round trip. Only alpha is clamped (it is coverage, not light).
 *
 * @param linearPremul - Float32Array of length `width*height*4`, premultiplied
 *                       linear-light RGBA (values may exceed 1 for over-range).
 * @param gamut - optional linear-light gamut conversion; omit (or pass equal
 *                source/target) for the historical no-convert behaviour.
 * @returns Uint16Array of IEEE binary16 bit patterns, straight linear RGBA.
 */
export function unpremultiplyEncodeLinearF16(
  linearPremul: Float32Array,
  width: number,
  height: number,
  gamut?: { readonly sourceGamut: WorkingColorSpace; readonly targetGamut: WorkingColorSpace },
): Uint16Array {
  const expected = width * height * 4;
  if (linearPremul.length < expected) {
    throw new Error(
      `[exportEncode] buffer too small: got ${linearPremul.length}, need ${expected} (${width}×${height} RGBA)`,
    );
  }

  // Resolve the linear-light gamut matrix once. `getConversionMatrix` returns
  // IDENTITY for source === target, so we skip it entirely in that (dominant) case
  // and keep the historical code path bit-identical.
  let m: Float32Array | null = null;
  if (gamut && gamut.sourceGamut !== gamut.targetGamut) {
    m = getConversionMatrix(gamut.sourceGamut, gamut.targetGamut);
    if (!m) {
      throw new Error(
        `[exportEncode] no conversion matrix for ${gamut.sourceGamut}→${gamut.targetGamut}`,
      );
    }
  }

  const out = new Uint16Array(expected);
  for (let i = 0; i < expected; i += 4) {
    const a = linearPremul[i + 3];

    if (a <= 0) {
      // Fully transparent — emit zeroed pixel (matches the sRGB8 a<=0 branch).
      out[i] = 0;
      out[i + 1] = 0;
      out[i + 2] = 0;
      out[i + 3] = 0;
      continue;
    }

    // Un-premultiply to the straight colour. NO TRC encode — stay linear.
    // No upper clamp: half-float retains over-range wide-gamut values.
    const inv = 1 / a;
    let r = linearPremul[i] * inv;
    let g = linearPremul[i + 1] * inv;
    let b = linearPremul[i + 2] * inv;

    if (m) {
      // Linear-light matrix, UNCLAMPED (see the gamut note above).
      const lr = r, lg = g, lb = b;
      r = m[0] * lr + m[1] * lg + m[2] * lb;
      g = m[3] * lr + m[4] * lg + m[5] * lb;
      b = m[6] * lr + m[7] * lg + m[8] * lb;
    }

    out[i] = floatToHalf(r);
    out[i + 1] = floatToHalf(g);
    out[i + 2] = floatToHalf(b);
    // Alpha is coverage, not light — clamp to [0,1] then store as half-float.
    out[i + 3] = floatToHalf(clamp01(a));
  }
  return out;
}

/**
 * Convert one row-major `rgba32float` buffer of PREMULTIPLIED LINEAR-light RGBA
 * (the shape `WebGpuEngine.export({ bitDepth: 32 })` returns) into straight,
 * sRGB-TRC-encoded 16-bit integer RGBA suitable for lossless 16-bit TIFF/PNG export.
 *
 * Per texel (mirrors `unpremultiplyEncodeSrgb8` exactly, quantized to 16-bit 0..65535):
 *   • `a <= 0`   → fully transparent, emit (0,0,0,0).
 *   • otherwise  → `straight = clamp(rgb / a, 0, 1)`, then
 *                   `linearToSrgb(straight)` per channel, ×65535 rounded.
 *   • alpha      → coverage, NOT light: `clamp(a,0,1) * 65535`, NO TRC.
 *
 * @param linearPremul - Float32Array of length `width*height*4`
 * @param width - pixel width
 * @param height - pixel height
 * @returns Uint16Array of straight sRGB-encoded RGBA in [0, 65535], same pixel count.
 */
export function unpremultiplyEncodeSrgb16(
  linearPremul: Float32Array,
  width: number,
  height: number,
): Uint16Array {
  const expected = width * height * 4;
  if (linearPremul.length < expected) {
    throw new Error(
      `[exportEncode] buffer too small: got ${linearPremul.length}, need ${expected} (${width}×${height} RGBA)`,
    );
  }

  const out = new Uint16Array(expected);
  for (let i = 0; i < expected; i += 4) {
    const a = linearPremul[i + 3];

    if (a <= 0) {
      out[i] = 0;
      out[i + 1] = 0;
      out[i + 2] = 0;
      out[i + 3] = 0;
      continue;
    }

    const invA = 1 / a;
    const sr = clamp01(linearPremul[i] * invA);
    const sg = clamp01(linearPremul[i + 1] * invA);
    const sb = clamp01(linearPremul[i + 2] * invA);

    // Single encode point: reuse trc.ts linearToSrgb (== view.wgsl).
    out[i] = Math.round(linearToSrgb(sr) * 65535);
    out[i + 1] = Math.round(linearToSrgb(sg) * 65535);
    out[i + 2] = Math.round(linearToSrgb(sb) * 65535);
    out[i + 3] = Math.round(clamp01(a) * 65535);
  }
  return out;
}

/** Clamp a scalar to [0, 1] (NaN → 0). */
function clamp01(x: number): number {
  if (!(x > 0)) return 0; // also catches NaN
  return x > 1 ? 1 : x;
}

/**
 * Options for {@link unpremultiplyEncodeGamutF32} — the un-quantized f32 sibling
 * of {@link GamutEncodeOptions} (there is no `bitDepth`; the output is always
 * float, never quantized).
 */
export interface GamutEncodeF32Options {
  /** See {@link GamutEncodeOptions.sourceGamut} — always `WORKING_GAMUT`. */
  readonly sourceGamut: WorkingColorSpace;
  /** Desired output gamut (the encoded float channels agree on this). */
  readonly targetGamut: GamutId;
}

/**
 * Convert a premultiplied LINEAR-light working-gamut `rgba32float` readback into
 * STRAIGHT, target-gamut, target-TRC-**encoded** RGBA held as an un-quantized
 * `Float32Array` — the precision-truth track for the WebGPU colour sampler
 * (`SampledBlock.float`).
 *
 * This is a LINE-FOR-LINE mirror of {@link unpremultiplyEncodeGamut}'s float
 * domain (same single encode point): un-premultiply → linear-light gamut
 * matrix (clamped [0,1]) → per-target TRC. The ONLY difference is the terminal
 * step — here we write the encoded value verbatim into `Float32Array` instead of
 * scaling by 255/65535 and rounding. Because the curve is identical, the contract
 * `Math.round(floatPixels[i] * 255) === unpremultiplyEncodeGamut(..., {bitDepth:8})[i]`
 * holds, so `float.r * 255 ≈ rgb8.r` and a CSS `color()` string built from these
 * channels is correct with zero extra colour logic in the UI.
 *
 * WHY TRC-ENCODED, NOT LINEAR (contrast {@link unpremultiplyEncodeLinearF16}):
 * the sampler reads these back as JS numbers to show hex / CSS `color(gamut …)`,
 * whose components are gamma-encoded values — reporting linear light would not
 * match hex. f32 (not f16) because these are transient, read per-pixel as JS
 * numbers (zero decode), and the readback is already f32.
 *
 * Per texel (float domain, in strict order):
 *   • `a <= 0`  → fully transparent, emit (0,0,0,0).
 *   • otherwise → `straight = rgb / a` (NO clamp — preserve out-of-gamut into the
 *                 matrix), gamut matrix (clamps [0,1]), target TRC. Channels are
 *                 the encoded [0,1] value, NOT scaled.
 *   • alpha     → coverage, NOT light: `clamp01(a)`, NO TRC, NO matrix, NO scale.
 *
 * @param linearPremul - Float32Array of length `width*height*4`, premultiplied
 *                       linear-light RGBA in the working (`sourceGamut`) space.
 * @param width  - pixel width  (used to validate buffer length)
 * @param height - pixel height
 * @returns Float32Array of straight `targetGamut`-encoded RGBA, same pixel count.
 */
export function unpremultiplyEncodeGamutF32(
  linearPremul: Float32Array,
  width: number,
  height: number,
  opts: GamutEncodeF32Options,
): Float32Array {
  const expected = width * height * 4;
  if (linearPremul.length < expected) {
    throw new Error(
      `[exportEncode] buffer too small: got ${linearPremul.length}, need ${expected} (${width}×${height} RGBA)`,
    );
  }

  const { sourceGamut, targetGamut } = opts;

  // rec2020 has no conversion matrix and is not a WorkingColorSpace — guard so
  // getConversionMatrix stays well-typed and a mis-route fails loudly (mirrors
  // unpremultiplyEncodeGamut).
  if (targetGamut === 'rec2020') {
    throw new Error('[exportEncode] rec2020 target gamut has no conversion matrix');
  }
  const target: WorkingColorSpace = targetGamut;

  // IDENTITY when source === target (the regression-safe default path).
  const matrix = getConversionMatrix(sourceGamut, target);
  if (!matrix) {
    throw new Error(`[exportEncode] no conversion matrix for ${sourceGamut}→${target}`);
  }
  const m0 = matrix[0], m1 = matrix[1], m2 = matrix[2];
  const m3 = matrix[3], m4 = matrix[4], m5 = matrix[5];
  const m6 = matrix[6], m7 = matrix[7], m8 = matrix[8];

  // Per-target encode TRC — identical selection to unpremultiplyEncodeGamut.
  const encode: (c: number) => number =
    target === 'adobe-rgb'
      ? (c) => linearToGamma(c, 1 / 2.2)
      : target === 'prophoto-rgb'
        ? (c) => linearToGamma(c, 1 / 1.8)
        : linearToSrgb; // srgb & display-p3

  const out = new Float32Array(expected);
  for (let i = 0; i < expected; i += 4) {
    const a = linearPremul[i + 3];

    if (a <= 0) {
      // Fully transparent — emit zeroed pixel (matches the sibling a<=0 branch).
      out[i] = 0;
      out[i + 1] = 0;
      out[i + 2] = 0;
      out[i + 3] = 0;
      continue;
    }

    // 1. Un-premultiply to straight linear (NO clamp — preserve out-of-gamut).
    const invA = 1 / a;
    const lr = linearPremul[i] * invA;
    const lg = linearPremul[i + 1] * invA;
    const lb = linearPremul[i + 2] * invA;

    // 2. Gamut matrix in linear light (inlined applyMatrix3x3; clamps to [0,1]).
    const outR = Math.max(0, Math.min(1, m0 * lr + m1 * lg + m2 * lb));
    const outG = Math.max(0, Math.min(1, m3 * lr + m4 * lg + m5 * lb));
    const outB = Math.max(0, Math.min(1, m6 * lr + m7 * lg + m8 * lb));

    // 3. Target TRC — written verbatim (NO quantization). This is the sole
    //    departure from unpremultiplyEncodeGamut's terminal ×scale + round.
    out[i] = encode(outR);
    out[i + 1] = encode(outG);
    out[i + 2] = encode(outB);
    // Alpha is coverage, not light — clamp only, no TRC.
    out[i + 3] = clamp01(a);
  }
  return out;
}

/**
 * Options for {@link unpremultiplyEncodeGamut}.
 */
export interface GamutEncodeOptions {
  /**
   * Gamut of the readback buffer — in practice always
   * `core/engine/color/gamut.ts::WORKING_GAMUT` ('display-p3'), an engine invariant
   * rather than a document property. This is the gamut the un-premultiplied
   * LINEAR pixels are currently in; the matrix converts FROM here. Pass the
   * constant `WORKING_GAMUT`; never re-derive it and never plumb it through a
   * request object as if it were configurable.
   */
  readonly sourceGamut: WorkingColorSpace;
  /** Desired output gamut (the encoded pixels + embedded ICC agree on this). */
  readonly targetGamut: GamutId;
  /** Output quantization: 8 → Uint8ClampedArray, 16 → Uint16Array. */
  readonly bitDepth: 8 | 16;
}

/**
 * Gamut-aware terminal encode for the Readback export path — the single float-domain
 * step that turns the premultiplied LINEAR
 * working-gamut readback into straight, target-gamut, target-TRC, quantized RGBA.
 *
 * This CLOSES the wide-gamut export loop. Where the sibling `unpremultiplyEncode*`
 * helpers are hard-wired to the sRGB TRC, this one carries the gamut MATRIX + a
 * per-target TRC so a document can ship as sRGB / Display-P3 / Adobe RGB /
 * ProPhoto. The five raster encoders downstream do ZERO color math — they only
 * write the container + the ICC matching `targetGamut`.
 *
 * The BAKE path (`CompositeDispatcher`) also calls this, with `targetGamut`
 * restricted to the two canvas-representable gamuts (`core/strategy/bake.ts`) and
 * `sourceGamut` fixed to the working gamut. It converts for the same reason egest
 * does: the readback is always Linear Display-P3, so an sRGB document needs the
 * real P3→sRGB matrix — tagging the pixels `'srgb'` without it is what shipped P3
 * numbers under an sRGB profile.
 *
 * Per texel (float domain, in strict order, BEFORE any quantization):
 *   1. un-premultiply — `straight = rgb / a` (`a <= 0` → zeroed pixel, identical
 *      guard to the sibling fns). NO clamp here, so over-range/out-of-gamut values
 *      survive into the matrix (clipping before the matrix would wrongly discard
 *      colors that map back in-gamut).
 *   2. gamut matrix in linear light — `applyMatrix3x3(getConversionMatrix(source,
 *      target))`. `getConversionMatrix` returns IDENTITY when source === target,
 *      and `applyMatrix3x3` clamps its output to [0, 1].
 *   3. target TRC — srgb & display-p3 → `linearToSrgb`; adobe-rgb → `linearToGamma
 *      (·, 1/2.2)`; prophoto-rgb → `linearToGamma(·, 1/1.8)`.
 *   4. quantize — bitDepth 8 → `×255` into Uint8ClampedArray (round+clamp on
 *      assignment); bitDepth 16 → `Math.round(×65535)` into Uint16Array.
 *   • alpha — coverage, NOT light: `clamp01(a)` quantized, NO TRC, NO matrix.
 *
 * REGRESSION GUARANTEE: `{ sourceGamut:'srgb', targetGamut:'srgb', bitDepth:8 }`
 * is byte-identical to `unpremultiplyEncodeSrgb8` (identity matrix's [0,1] clamp
 * equals `clamp01` for finite values, and both funnel NaN → 0), and the default
 * P3-doc→P3 case is identity + `linearToSrgb` — unchanged from today.
 *
 * @param linearPremul - Float32Array of length `width*height*4`, premultiplied
 *                       linear-light RGBA in the working (`sourceGamut`) space.
 * @param width  - pixel width  (used to validate buffer length)
 * @param height - pixel height
 * @returns Uint8ClampedArray (bitDepth 8) or Uint16Array (bitDepth 16), straight
 *          `targetGamut`-encoded RGBA, same pixel count.
 */
export function unpremultiplyEncodeGamut(
  linearPremul: Float32Array,
  width: number,
  height: number,
  opts: GamutEncodeOptions,
): Uint8ClampedArray | Uint16Array {
  const expected = width * height * 4;
  if (linearPremul.length < expected) {
    throw new Error(
      `[exportEncode] buffer too small: got ${linearPremul.length}, need ${expected} (${width}×${height} RGBA)`,
    );
  }

  const { sourceGamut, targetGamut, bitDepth } = opts;

  // rec2020 has no conversion matrix and is not a WorkingColorSpace — commands.ts
  // routing never produces it as a target. Guard so getConversionMatrix stays
  // well-typed and any future mis-route fails loudly instead of silently wrong.
  if (targetGamut === 'rec2020') {
    throw new Error('[exportEncode] rec2020 target gamut has no conversion matrix');
  }
  const target: WorkingColorSpace = targetGamut;

  // IDENTITY when source === target (the regression-safe default path).
  const matrix = getConversionMatrix(sourceGamut, target);
  if (!matrix) {
    // Defensive: every {srgb,display-p3}→{4 working spaces} pair exists in the
    // registry, so this is unreachable in practice — treat as passthrough.
    throw new Error(`[exportEncode] no conversion matrix for ${sourceGamut}→${target}`);
  }
  const m0 = matrix[0], m1 = matrix[1], m2 = matrix[2];
  const m3 = matrix[3], m4 = matrix[4], m5 = matrix[5];
  const m6 = matrix[6], m7 = matrix[7], m8 = matrix[8];

  // Per-target encode TRC (agrees with the stock ICC `curv` gamma).
  const encode: (c: number) => number =
    target === 'adobe-rgb'
      ? (c) => linearToGamma(c, 1 / 2.2)
      : target === 'prophoto-rgb'
        ? (c) => linearToGamma(c, 1 / 1.8)
        : linearToSrgb; // srgb & display-p3

  const bits8 = bitDepth === 8;
  const out: Uint8ClampedArray | Uint16Array = bits8
    ? new Uint8ClampedArray(expected)
    : new Uint16Array(expected);
  const scale = bits8 ? 255 : 65535;

  for (let i = 0; i < expected; i += 4) {
    const a = linearPremul[i + 3];

    if (a <= 0) {
      // Fully transparent — emit zeroed pixel (matches the sibling a<=0 branch).
      out[i] = 0;
      out[i + 1] = 0;
      out[i + 2] = 0;
      out[i + 3] = 0;
      continue;
    }

    // 1. Un-premultiply to straight linear (NO clamp — preserve out-of-gamut).
    const invA = 1 / a;
    const lr = linearPremul[i] * invA;
    const lg = linearPremul[i + 1] * invA;
    const lb = linearPremul[i + 2] * invA;

    // 2. Gamut matrix in linear light (inlined applyMatrix3x3; clamps to [0,1]).
    const outR = Math.max(0, Math.min(1, m0 * lr + m1 * lg + m2 * lb));
    const outG = Math.max(0, Math.min(1, m3 * lr + m4 * lg + m5 * lb));
    const outB = Math.max(0, Math.min(1, m6 * lr + m7 * lg + m8 * lb));

    // 3. Target TRC + 4. quantize. Uint8ClampedArray rounds+clamps on assign;
    // Uint16Array needs explicit Math.round.
    if (bits8) {
      out[i] = encode(outR) * scale;
      out[i + 1] = encode(outG) * scale;
      out[i + 2] = encode(outB) * scale;
      out[i + 3] = clamp01(a) * scale;
    } else {
      out[i] = Math.round(encode(outR) * scale);
      out[i + 1] = Math.round(encode(outG) * scale);
      out[i + 2] = Math.round(encode(outB) * scale);
      out[i + 3] = Math.round(clamp01(a) * scale);
    }
  }
  return out;
}
