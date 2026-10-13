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
 * filmic.ts — the `filmic` render-intent's scene→display transform (the RAW
 * processing the 05_ingest_decision_spec §9 chain terminates in).
 *
 * WHY NOT ACES RRT+ODT ANYMORE (probe 2026-10-13, gpex-cloud/probes/raw): the
 * Hill fit assumes the ACES scene scale — diffuse white ≈ 0.18 with specular
 * headroom to ~16 — while the libraw channel's linear output is normalized to
 * SENSOR WHITE = 1.0 (outputBps:16 full-scale, zero headroom; ProRAW and
 * traditional DSLR negatives alike). On that domain ACES maps 1.0 → ≈0.62
 * display-linear, so display white is structurally unreachable (whole image
 * tops out ≈205/255) and the shadow floor lifts — the "imported RAW renders
 * washed-out grey" defect. Measured sweeps of white-normalized
 * `hill(c·G)/hill(G)` variants only trade "no white" for "no mids": the ACES
 * shoulder has too little midtone contrast to re-anchor with a gain.
 *
 * THE REPLACEMENT — two stages, both LINEAR-light:
 *
 *   ① Exposure anchor (per file, at decode): K = 0.18 / median(scene luma),
 *      clamped to [1/16, 16] — the dcraw `auto_bright` convention. Anchors the
 *      scene median onto 18% grey in display-linear. On the probe file this
 *      reproduces the platform reference render's placement (Apple ProRAW:
 *      anchored p50 ≈ 143/255 vs Apple's own 119; the un-anchored operator
 *      sat at 179–205). The median→0.18-referenced scale is baked into the
 *      f16 naked-pixel line — it stays LINEAR light in the source gamut (a
 *      positive gain changes no hue, clips nothing in f16, and the `trc:
 *      'linear'` / `dataFormat: 'rgba16float'` identity stays true).
 *
 *   ② Fixed linear knee (display side, constants below): identity below
 *      {@link FILMIC_PIVOT} (shadows untouched — no crush), constant slope
 *      above it so a scene white parked at {@link FILMIC_WHITE_DOMAIN} by the
 *      anchor lands EXACTLY on display white. This is the shoulder every
 *      camera JPEG pipeline draws; ACES's soft asymptote is what made white
 *      unreachable.
 *
 * Stage ② runs identically in the GPU operator (`tone_map_filmic`, constants
 * injected into the WGSL from this module) and the CPU display proxy
 * (`linearRgba16ToDisplayProxy8`) — thumbnails, cold-reload fallback and the
 * pre-upload frame can never drift from the canvas because both consume these
 * exported constants, not copies.
 *
 * @module core/engine/color/filmic
 */

/** Display-linear target the scene median is anchored onto (18% grey). */
export const FILMIC_MEDIAN_TARGET = 0.18;

/** Exposure-gain clamp: K ∈ [1/16, 16] keeps extreme scenes sane. */
export const FILMIC_EXPOSURE_CLAMP = 16;

/**
 * Linear-light pivot where the knee begins: below it the transform is the
 * identity (shadow detail passes through uncrushed).
 */
export const FILMIC_PIVOT = 0.18;

/**
 * Linear-light input the anchored scene white is expected at (pivot × the
 * ~1.7× median→white ratio of typical negatives); an input here maps to
 * display white exactly.
 */
export const FILMIC_WHITE_DOMAIN = 0.31;

/** Slope above the pivot: (1 − pivot) / (whiteDomain − pivot). */
export const FILMIC_KNEE_GAIN = (1 - FILMIC_PIVOT) / (FILMIC_WHITE_DOMAIN - FILMIC_PIVOT);

/**
 * Rec.709 luma weights — the scalar knee runs on the PIXEL'S LUMA, and the
 * whole RGB triple is then scaled by ONE gain so chromaticity is preserved
 * exactly. (A per-channel curve with a 4.8× stretch skews hue wherever
 * channels cross the pivot at different tones — measured on device as a
 * violet zenith + teal horizon on the probe sky.)
 */
export const FILMIC_LUMA_WEIGHTS: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];

/**
 * Stage ① — the per-file exposure anchor from a robust scene-mid estimate.
 * A non-positive / non-finite median (all-black frame, empty sample) falls
 * back to unity: no anchor data, no anchor.
 */
export function filmicExposureGain(medianLuma: number): number {
  const median = Number.isFinite(medianLuma) && medianLuma > 0 ? medianLuma : FILMIC_MEDIAN_TARGET;
  const gain = FILMIC_MEDIAN_TARGET / median;
  return Math.min(FILMIC_EXPOSURE_CLAMP, Math.max(1 / FILMIC_EXPOSURE_CLAMP, gain));
}

/**
 * Stage ② scalar — the linear knee on LUMA. Monotone; ≤ pivot is the identity;
 * the pivot→whiteDomain span is stretched to pivot→1.
 */
export function filmicKnee(x: number): number {
  if (!(x > FILMIC_PIVOT)) return x;
  return Math.min(1, FILMIC_PIVOT + (x - FILMIC_PIVOT) * FILMIC_KNEE_GAIN);
}

/**
 * Stage ② per pixel — scale RGB by ONE gain so the pixel's luma follows the
 * knee. Uniform scaling preserves chromaticity exactly: below the pivot the
 * gain is 1 (identity), above it the whole pixel stretches toward white
 * together (highlights desaturate gracefully instead of hue-skewing).
 * Out-of-range channels after the gain clamp at 1 (specular saturation).
 */
export function filmicToneMap(r: number, g: number, b: number): [number, number, number] {
  const luma = FILMIC_LUMA_WEIGHTS[0] * r + FILMIC_LUMA_WEIGHTS[1] * g + FILMIC_LUMA_WEIGHTS[2] * b;
  const gain = filmicKnee(luma) / Math.max(luma, 1e-6);
  return [
    Math.min(1, Math.max(0, r * gain)),
    Math.min(1, Math.max(0, g * gain)),
    Math.min(1, Math.max(0, b * gain)),
  ];
}
