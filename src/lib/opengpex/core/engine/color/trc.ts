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
 * trc.ts — sRGB ⇄ linear-light transfer-characteristic scalars.
 *
 * IEC 61966-2-1 reference formulas for color management and matrix conversions.
 *
 * @module core/engine/color/trc
 */

/**
 * Convert a single sRGB-encoded channel value [0, 1] to linear-light.
 *
 * Formula (IEC 61966-2-1):
 *   C_linear = (C <= 0.04045) ? C / 12.92 : ((C + 0.055) / 1.055)^2.4
 */
export function srgbToLinear(c: number): number {
  return c <= 0.04045
    ? c / 12.92
    : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Convert a single linear-light channel value [0, 1] to sRGB encoding.
 *
 * Formula (IEC 61966-2-1):
 *   C_srgb = (C <= 0.0031308) ? C * 12.92 : 1.055 * C^(1/2.4) - 0.055
 */
export function linearToSrgb(c: number): number {
  return c <= 0.0031308
    ? c * 12.92
    : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/**
 * Encode a single linear-light channel value [0, 1] to a pure power-law gamma
 * transfer characteristic (wide-gamut export TRC).
 *
 * Unlike sRGB's piecewise curve, Adobe RGB (1998) and ProPhoto RGB (ROMM) use a
 * simple power function on export:
 *   • Adobe RGB (1998) → invGamma = 1/2.2   (gamma 2.19921875, the 563/256 ICC value)
 *   • ProPhoto RGB     → invGamma = 1/1.8   (gamma 1.80078125, the 461/256 ICC value)
 *
 * These match the `curv` gamma tag baked into the stock ICC profiles emitted by
 * `getStockIccProfile` (`core/files/shared/icc.ts`), so encoded pixels + embedded ICC
 * agree. ProPhoto's true spec has a tiny linear toe near 0; we use the pure power
 * law to stay bit-consistent with the profile's single-gamma `curv`.
 *
 * @param c        - linear-light channel value (guarded to [0, 1])
 * @param invGamma - reciprocal display gamma (e.g. 1/2.2, 1/1.8)
 */
export function linearToGamma(c: number, invGamma: number): number {
  if (!(c > 0)) return 0; // also catches NaN
  return Math.pow(c > 1 ? 1 : c, invGamma);
}

/**
 * Display gamma of Adobe RGB (1998): 563/256 = 2.19921875, the exact value ICC
 * `curv` tags encode (and what `getStockIccProfile('adobe-rgb')` bakes). Import
 * uses this with {@link gammaToLinear}; export uses its reciprocal via
 * {@link linearToGamma}. Same constant both directions ⇒ round-trip consistency.
 */
export const ADOBE_RGB_GAMMA = 2.19921875;

/**
 * Display gamma of ProPhoto RGB (ROMM): 461/256 = 1.80078125, the exact ICC
 * `curv` value baked by `getStockIccProfile('prophoto-rgb')`. The true ROMM spec
 * has a small linear toe near 0; we use the pure power law both directions to
 * stay bit-consistent with the single-gamma `curv` (see {@link linearToGamma}).
 */
export const PROPHOTO_GAMMA = 1.80078125;

/**
 * Decode a single gamma-encoded channel value [0, 1] to linear-light via a pure
 * power law — the IMPORT-direction inverse of {@link linearToGamma}.
 *
 * Adobe RGB (1998) and ProPhoto RGB (ROMM) encode with a plain power function
 * (no piecewise toe, unlike sRGB), so linearization is a single `pow`:
 *   C_linear = C_encoded ^ gamma
 *
 * Using the CORRECT source gamma here (2.19921875 / 1.80078125) — rather than the
 * sRGB EOTF — is exactly what removes the TRC-mismatch ingest loss for wide-gamut
 * 8-bit sources. Pass {@link ADOBE_RGB_GAMMA} or
 * {@link PROPHOTO_GAMMA}.
 *
 * @param c     - gamma-encoded channel value (guarded to [0, 1])
 * @param gamma - source display gamma (e.g. 2.19921875, 1.80078125)
 */
export function gammaToLinear(c: number, gamma: number): number {
  if (!(c > 0)) return 0; // also catches NaN
  return Math.pow(c > 1 ? 1 : c, gamma);
}

/** Rec.2020 transfer function constants (ITU-R BT.2020-2). */
export const REC2020_ALPHA = 1.09929682680944;
export const REC2020_BETA = 0.018053968510807;

/**
 * Encode a linear-light channel value [0, 1] into Rec.2020 transfer characteristic (ITU-R BT.2020-2).
 */
export function linearToRec2020(L: number): number {
  if (L <= 0) return 0;
  return L < REC2020_BETA
    ? 4.5 * L
    : REC2020_ALPHA * Math.pow(Math.min(1, L), 0.45) - (REC2020_ALPHA - 1);
}

/**
 * Decode a Rec.2020 transfer-encoded channel value [0, 1] into linear-light (ITU-R BT.2020-2).
 */
export function rec2020ToLinear(E: number): number {
  if (E <= 0) return 0;
  return E < 4.5 * REC2020_BETA
    ? E / 4.5
    : Math.pow((Math.min(1, E) + (REC2020_ALPHA - 1)) / REC2020_ALPHA, 1 / 0.45);
}
