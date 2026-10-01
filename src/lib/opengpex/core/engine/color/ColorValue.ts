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
 * ColorValue.ts — the structured foreground-colour datum.
 *
 * `ColorValue` is the ONE currency for palette / foreground / layer-fill / sampler,
 * replacing the bare `hex: string` that flattened every wide-gamut colour at the
 * door. It supersedes the (now-deleted) zero-consumer `SampledColorResult`
 * (decision A).
 *
 * This module provides structured color types and pure helpers.
 * Every constructor here emits `space: 'srgb'`; wide-gamut `ColorValue`s
 * arrive once the sampler forwards f32 + gamut.
 *
 * @module core/engine/color/ColorValue
 */

import type { GamutId } from '@opengpex/editor/core/types/primitives';
import type { WorkingColorSpace } from '@opengpex/editor/core/types/models';
import { gamutToCssSpace, deriveMatrix64 } from '@opengpex/editor/core/engine/color/gamut';
import { hexToRgb, hsvToRgbF, rgbToHex } from '@opengpex/editor/core/engine/color/srgbHsv';
import {
  srgbToLinear,
  linearToSrgb,
  gammaToLinear,
  linearToGamma,
  ADOBE_RGB_GAMMA,
  PROPHOTO_GAMMA,
  rec2020ToLinear,
  linearToRec2020,
} from '@opengpex/editor/core/engine/color/trc';

/**
 * Structured colour value: the unified currency for palette / foreground / layer
 * fill / sampler.
 */
export interface ColorValue {
  /**
   * The gamut `coords` live in. Simple UI mode is always `'srgb'`; Pro mode may
   * switch to Display-P3 etc.
   */
  space: GamutId;
  /**
   * TRC-encoded, normalized channels in `space` (0..1, and >1 is representable for
   * wide-gamut values expressed relative to sRGB). NOT linear-light.
   */
  coords: { r: number; g: number; b: number };
  /** Opacity, 0..1. */
  alpha: number;
  /**
   * 8-bit sRGB compatibility view `"#rrggbb"` (always present). For display swatch
   * fallbacks / non-wide-gamut consumers / serialization summaries.
   *
   * NEVER reconstruct `coords` from `hex` — it is lossy and, for a
   * wide-gamut `space`, only a clamped best-effort (see {@link toHex}).
   */
  hex: string;
}

/** Clamp to [0,1]. */
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** 8-bit quantize a normalized channel (clamped). */
function toByte(x: number): number {
  return Math.round(clamp01(x) * 255);
}

/**
 * The 8-bit sRGB compatibility hex for a {@link ColorValue}.
 *
 * `space === 'srgb'`: exact — `round(clamp01(coord) * 255)` per channel. This is
 * the tie that pins the cross-track contract `round(coords.r*255) === rgb8.r`.
 *
 * Wide-gamut `space`: PHASE-0 BEST-EFFORT — channels are clamped to [0,1] and
 * quantized WITHOUT a colorimetric sRGB conversion. A precise perceptual gamut-map
 * is deferred to future out-of-gamut work; until then the
 * precise wide-gamut view is {@link toCssColor4}, and `hex` stays a lossy swatch
 * fallback (never a `coords` source).
 */
export function toHex(value: ColorValue): string {
  const { r, g, b } = value.coords;
  return rgbToHex(toByte(r), toByte(g), toByte(b));
}

/**
 * The 8-bit RGB triple backing {@link ColorValue.hex} — the `rgb8` cross-track view.
 * By construction `round(coords.r*255) === toRgb8(v).r`.
 */
export function toRgb8(value: ColorValue): { r: number; g: number; b: number } {
  const { r, g, b } = value.coords;
  return { r: toByte(r), g: toByte(g), b: toByte(b) };
}

/**
 * CSS Color 4 `color()` string preserving float precision.
 * Mirrors the sampler read-out format exactly:
 *   `color(<cssSpace> r.rrrr g.gggg b.bbbb[ / a.aaa])`
 * `cssSpace` via {@link gamutToCssSpace}. Alpha is only emitted when < 1.
 */
export function toCssColor4(value: ColorValue): string {
  const { r, g, b } = value.coords;
  const a = value.alpha;
  const space = gamutToCssSpace(value.space);
  const alphaPart = a < 1 ? ` / ${a.toFixed(3)}` : '';
  return `color(${space} ${r.toFixed(4)} ${g.toFixed(4)} ${b.toFixed(4)}${alphaPart})`;
}

/**
 * Build an sRGB {@link ColorValue} from a `"#rgb"` / `"#rrggbb"` string.
 *
 * @param hex   - 3- or 6-digit hex triple (leading `#` optional)
 * @param alpha - opacity 0..1 (default 1)
 * @throws when `hex` is not a valid 3/6-digit hex triple
 */
export function fromHex(hex: string, alpha = 1): ColorValue {
  const rgb = hexToRgb(hex);
  if (!rgb) {
    throw new Error(`[ColorValue] invalid hex: ${JSON.stringify(hex)}`);
  }
  return {
    space: 'srgb',
    coords: { r: rgb.r / 255, g: rgb.g / 255, b: rgb.b / 255 },
    alpha: clamp01(alpha),
    hex: rgbToHex(rgb.r, rgb.g, rgb.b),
  };
}

/**
 * Build a {@link ColorValue} in an ARBITRARY gamut from HSV geometry — the shared
 * constructor behind both simple-mode ({@link srgbFromHsv}) and Pro wide-gamut
 * SV/Hue.
 *
 * HSV→RGB is pure scalar geometry; the gamut is carried entirely by the `space`
 * tag, NOT by the numbers. So `colorFromHsv(0, 1, 1, 'display-p3')` yields
 * `coords {1,0,0}` tagged `display-p3` — a redder red than sRGB's, exactly the
 * wide-gamut precision design requires. There is no second colour-math path: the palette Pro
 * mode reuses this one.
 *
 * `coords` are UNQUANTIZED floats (via {@link hsvToRgbF}) so f32 SV/Hue never
 * collapses to 256 levels; `hex` is their 8-bit swatch view (for a
 * wide-gamut `space` it is the phase-0 lossy clamp of {@link toHex}, so the precise
 * view stays {@link toCssColor4}). For `space === 'srgb'` the
 * `round(coords.r*255) === rgb8.r` contract holds by construction.
 *
 * @param h - hue, normalized [0,1)
 * @param s - saturation [0,1]
 * @param v - value/brightness [0,1]
 * @param space - the gamut `coords` are expressed in (default `'srgb'`)
 * @param alpha - opacity 0..1 (default 1)
 */
export function colorFromHsv(
  h: number,
  s: number,
  v: number,
  space: GamutId = 'srgb',
  alpha = 1,
): ColorValue {
  const f = hsvToRgbF(h, s, v);
  return {
    space,
    coords: { r: f.r, g: f.g, b: f.b },
    alpha: clamp01(alpha),
    hex: rgbToHex(toByte(f.r), toByte(f.g), toByte(f.b)),
  };
}

/**
 * Build an sRGB {@link ColorValue} from HSV (simple-mode palette geometry) — a
 * fixed-`space` shorthand for {@link colorFromHsv}. Preserved as the named
 * simple-mode entry point (and its existing golden contract).
 *
 * @param h - hue, normalized [0,1)
 * @param s - saturation [0,1]
 * @param v - value/brightness [0,1]
 * @param alpha - opacity 0..1 (default 1)
 */
export function srgbFromHsv(h: number, s: number, v: number, alpha = 1): ColorValue {
  return colorFromHsv(h, s, v, 'srgb', alpha);
}

function channelToLinear(c: number, space: GamutId): number {
  if (space === 'srgb' || space === 'display-p3') return srgbToLinear(c);
  if (space === 'adobe-rgb') return gammaToLinear(c, ADOBE_RGB_GAMMA);
  if (space === 'prophoto-rgb') return gammaToLinear(c, PROPHOTO_GAMMA);
  if (space === 'rec2020') return rec2020ToLinear(c);
  return srgbToLinear(c);
}

function linearToChannel(L: number, space: GamutId): number {
  if (space === 'srgb' || space === 'display-p3') return linearToSrgb(L);
  if (space === 'adobe-rgb') return linearToGamma(L, 1 / ADOBE_RGB_GAMMA);
  if (space === 'prophoto-rgb') return linearToGamma(L, 1 / PROPHOTO_GAMMA);
  if (space === 'rec2020') return linearToRec2020(L);
  return linearToSrgb(L);
}

/**
 * Convert a {@link ColorValue} from its current gamut to a target gamut.
 * Linearizes the coordinates through the source TRC, transforms through the
 * 3x3 linear matrix (with Bradford adaptation for white point shifts), and
 * encodes into the target TRC.
 */
export function convertColorGamut(value: ColorValue, targetSpace: GamutId): ColorValue {
  if (value.space === targetSpace) return value;

  const { r, g, b } = value.coords;
  const linR = channelToLinear(r, value.space);
  const linG = channelToLinear(g, value.space);
  const linB = channelToLinear(b, value.space);

  const m = deriveMatrix64(value.space, targetSpace);
  const outLinR = m[0] * linR + m[1] * linG + m[2] * linB;
  const outLinG = m[3] * linR + m[4] * linG + m[5] * linB;
  const outLinB = m[6] * linR + m[7] * linG + m[8] * linB;

  const targetR = linearToChannel(outLinR, targetSpace);
  const targetG = linearToChannel(outLinG, targetSpace);
  const targetB = linearToChannel(outLinB, targetSpace);

  // Compute 8-bit hex representation
  let hex: string;
  if (targetSpace === 'srgb') {
    hex = rgbToHex(toByte(targetR), toByte(targetG), toByte(targetB));
  } else {
    const srgbM = deriveMatrix64(targetSpace, 'srgb');
    const srgbLinR = srgbM[0] * outLinR + srgbM[1] * outLinG + srgbM[2] * outLinB;
    const srgbLinG = srgbM[3] * outLinR + srgbM[4] * outLinG + srgbM[5] * outLinB;
    const srgbLinB = srgbM[6] * outLinR + srgbM[7] * outLinG + srgbM[8] * outLinB;
    hex = rgbToHex(
      toByte(linearToSrgb(srgbLinR)),
      toByte(linearToSrgb(srgbLinG)),
      toByte(linearToSrgb(srgbLinB)),
    );
  }

  return {
    space: targetSpace,
    coords: {
      r: clamp01(targetR),
      g: clamp01(targetG),
      b: clamp01(targetB),
    },
    alpha: value.alpha,
    hex,
  };
}

/**
 * Convert a {@link ColorValue} to the document WORKING colour space
 * ({@link WorkingColorSpace}) as LINEAR-light RGBA (0..1), the currency the GPU
 * compositor expects (premultiplied downstream).
 *
 * Two steps: {@link convertColorGamut} moves the coords into `workingSpace`
 * (gamut matrix + Bradford), then the working-space TRC linearises each channel
 * via the shared {@link channelToLinear} (NOT a re-implementation — same private
 * oracle `convertColorGamut` uses internally). Alpha is never transfer-encoded.
 *
 * `WorkingColorSpace ⊂ GamutId`, so it is a valid `convertColorGamut` target.
 */
export function toWorkingLinearRgba(
  value: ColorValue,
  workingSpace: WorkingColorSpace,
): readonly [number, number, number, number] {
  const inWorking = convertColorGamut(value, workingSpace);
  const { r, g, b } = inWorking.coords;
  return [
    channelToLinear(r, workingSpace),
    channelToLinear(g, workingSpace),
    channelToLinear(b, workingSpace),
    inWorking.alpha,
  ];
}
