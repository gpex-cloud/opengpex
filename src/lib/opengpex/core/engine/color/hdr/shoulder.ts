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
 * shoulder.ts — the SDR "direct-pass shoulder" — the down-render operator for
 * the EXPORT side of the HDR pipeline.
 *
 * WHY IT EXISTS (probe-verified): every full-look tone
 * transform (ACES / AgX / Khronos PBR Neutral) is an appearance-level rewrite
 * that fails SDR identity outright (SDR white drops to 0.62 / 0.59 / 0.89
 * display-linear; hue shifts up to 25° at +1 stop). An EDITOR must not change
 * the look of existing content on open, so the down-render used by the gain
 * map (UltraHDR) and any SDR target is this minimal extension of the house
 * filmic philosophy: a scalar-gain knee that is the EXACT IDENTITY on [0,1]
 * and compresses only above white.
 *
 *     knee(x) = x                          for x ≤ 1
 *     knee(x) = 1 + (x−1) / (1 + k(x−1))   for x > 1
 *
 * C¹-continuous at 1 (slope 1 both sides), strictly increasing, asymptote
 * 1 + 1/k. Applied as a SINGLE SCALAR GAIN (knee(luma)/luma) so chromaticity
 * is preserved exactly — the same luma-referenced-scalar discipline as
 * `filmic.ts`'s knee (a per-channel curve hue-skews with tone; measured violet
 * zenith / teal horizon, see colorspace.ts's filmic block).
 *
 * APPLICATION DOMAIN: DISPLAY-REFERENCED LINEAR light — post-projection into
 * the target display gamut (Rec.709 primaries ≈ native for sRGB/P3), where the
 * Rec.709 luma weights below are near-native. The ProPhoto working space's
 * TRUE luma is ≈ [0.288, 0.712, 0.000] — the Rec.709 weights must never be
 * carried into the W domain (review finding; the weights sum to 1 so
 * greys are exact, only saturated knees shift).
 *
 * DEFAULT k (0.5): asymptote 3.0 (≈ 3× SDR white). Provisional until a
 * real-device batch calibrates it against actual EDR headroom.
 */

/** Display-domain (Rec.709) luma weights — see the module header. */
export const SHOULDER_LUMA_WEIGHTS: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];

/**
 * Default shoulder steepness: asymptote = 1 + 1/k = 3.0× SDR white. D10
 * (real-device headroom quantification) owns the final value.
 */
export const SHOULDER_K_DEFAULT = 0.5;

/**
 * The direct-pass shoulder on a single (linear-light) channel value: identity
 * on [0, 1], C¹ rational knee above. Total over all x ≥ 0.
 */
export function shoulderKnee(x: number, k: number = SHOULDER_K_DEFAULT): number {
  if (x <= 1) return x;
  return 1 + (x - 1) / (1 + k * (x - 1));
}

/**
 * Down-render one LINEAR display-domain pixel to SDR: a single scalar gain
 * knee(luma)/luma — chromaticity-preserving by construction (luma 0 → gain 0
 * keeps black at black; the knee caps luma at the asymptote).
 */
export function renderSdrDown(
  r: number,
  g: number,
  b: number,
  k: number = SHOULDER_K_DEFAULT,
): [number, number, number] {
  const luma = SHOULDER_LUMA_WEIGHTS[0] * r + SHOULDER_LUMA_WEIGHTS[1] * g + SHOULDER_LUMA_WEIGHTS[2] * b;
  if (luma <= 0) return [0, 0, 0];
  const gain = shoulderKnee(luma, k) / luma;
  return [r * gain, g * gain, b * gain];
}

/**
 * The UltraHDR gain map VALUE for one pixel: log2 of the HDR/SDR ratio.
 *
 * The standard gain map stores log2(hdr/sdr) so a renderer with a known
 * headroom H reconstructs hdr = sdr · 2^(ratio · log2(H)/gainMax). For pixels
 * at or below white the ratio is 0 (the SDR rendition IS the HDR rendition);
 * above white it grows with the shoulder's compression. The reference SDR
 * rendition must be non-degenerate — a zero SDR channel pair yields ratio 0.
 */
export function gainMapRatio(
  hdrLinear: number,
  sdrLinear: number,
): number {
  if (hdrLinear <= 0 || sdrLinear <= 0) return 0;
  return Math.log2(hdrLinear / sdrLinear);
}
