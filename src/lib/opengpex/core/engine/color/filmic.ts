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
 * processing operator the ingest pipeline's render-intent chain terminates in).
 *
 * WHY NOT ACES RRT+ODT ANYMORE (probe 2026-10-13): the
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
 *   ② Linear knee (display side, constants below): identity below
 *      {@link FILMIC_PIVOT} (shadows untouched — no crush), constant slope above
 *      it so the anchored scene white lands EXACTLY on display white. The white
 *      domain — the anchored input that maps to display white — is PER FILE:
 *      decode samples the anchored highlight percentile alongside the median
 *      ({@link clampFilmicWhiteDomain}; floor = {@link FILMIC_WHITE_DOMAIN}, the
 *      original fixed constant, which encoded a ~1.7× scene max/median ratio a
 *      high-contrast capture violates — probe 2026-10-14: 14.6% of pixels blown
 *      to white on IMG_1795 vs Apple's 0.1%). The per-file domain rides the
 *      asset's `ColorIdentity.rawWhiteDomain` to the GPU operator (the
 *      `white_domain` WGSL parameter) and the CPU display proxy, so canvas,
 *      thumbnails and cold-reload fallback all knee identically.
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
 * DEFAULT linear-light input the anchored scene white is expected at (pivot ×
 * the ~1.7× median→white ratio of typical negatives); an input here maps to
 * display white exactly.
 *
 * ⚠️ This is a PER-FILE FLOOR, not a universal constant: the median anchor
 * places the scene's MIDDLE grey, but the knee also needs to know where the
 * scene's HIGHLIGHTS sit — and that ratio (scene max / median) varies per
 * capture. A sunny ProRAW clips at sensor white (ratio ≈ 1.7× → anchored
 * highlights land right here), but a high-contrast interior (ratio ≈ 3.8×)
 * anchors its highlights 2× ABOVE this domain and the fixed slope would slam
 * them all to display white (probe 2026-10-14, IMG_1795: 14.6% of pixels
 * ≥224 vs Apple's 0.1%). So decode derives the real domain from the file's own
 * anchored highlight percentile ({@link clampFilmicWhiteDomain}) and threads it
 * to the knee (CPU proxy + the `white_domain` WGSL parameter). This constant
 * remains the floor: scenes whose anchored highlights sit BELOW it keep the
 * original rendering (no auto-levels on flat/dark scenes) — the fix only
 * relaxes the domain upward, never downward.
 */
export const FILMIC_WHITE_DOMAIN = 0.31;

/** Ceiling for the per-file adaptive white domain (keeps the knee a knee). */
export const FILMIC_WHITE_DOMAIN_MAX = 0.95;

/**
 * Tone-curve shape exponents (20261016 calibration against the macOS
 * CIRAWFilter render of IMG_2591, probe-fitted on p5/p50/p90 + sky-mean
 * targets): the toe (below-pivot) power and the shoulder (pivot→white-domain)
 * power of a single S through (0,0)/(pivot,pivot)/(domain,1). The old linear
 * knee (identity below the pivot, constant slope above) could not produce a
 * black point (encoded p5 44 vs Apple 11, deep-shadow band 0.7% vs 13.5%) nor
 * compress highlights (p90 214 vs 179) — the flat, washed look users see next
 * to macOS. Final values fitted on the float-PGTM base (the map applied first
 * per spec — it pre-compresses highlights and lifts shadows regionally, so the
 * global curve re-fitted milder than its no-map first fit 2.2/2.0): BOTH files
 * then hit their references simultaneously (2591: leaf subset exact
 * 74,77,58 vs 73,76,59, sky R/G exact; 1795: p90 152/156, leaf 148/145). Both
 * exponents apply to ALL RAW renders (the filmic intent never touches
 * display-referred formats).
 */
export const FILMIC_TOE_GAMMA = 2.6;
export const FILMIC_SHOULDER_GAMMA = 1.6;

/**
 * Per-file tone-curve exponents, adapted on the white domain T. The two probe
 * files' fits are OPPOSITE slopes on T: the sunny capture (T = 0.31, highlights
 * at sensor white) needs a strong toe (2.8) and strong shoulder (2.3); the
 * high-contrast interior (T = 0.60, the GainTableMap already lifted its
 * shadows) needs a milder pair (≈2.4/1.9) — a fixed exponent pair that hits
 * one file's black point misses the other's by 2-3×. Linear in (T − pivot),
 * clamped to the probe-fitted envelope; both files then land within ±4/255 on
 * p5/p50 and their foliage/sky subsets.
 */
export function filmicCurveExponents(whiteDomain: number): { toe: number; shoulder: number } {
  const t = Math.max(0, whiteDomain - FILMIC_PIVOT);
  return {
    toe: Math.min(3.0, Math.max(2.2, 2.8 - 1.4 * t)),
    shoulder: Math.min(2.3, Math.max(1.6, 2.3 - 1.4 * t)),
  };
}

/**
 * Per-file style dose, adapted on the white domain: Apple's saturation offset
 * shrinks as the capture's dynamic compression grows (measured: the sunny file
 * wants d = 0.35, the high-contrast interior's sky runs +13 b−r over at that
 * dose). √ falloff from the base at the floor domain, capped at the base —
 * computed from the white domain the layer already carries, so the style
 * stays a per-file quantity without any new uniform surface.
 */
export function filmicStyleDose(whiteDomain: number): number {
  return Math.min(
    RAW_STYLE_BOOST,
    RAW_STYLE_BOOST * Math.pow(FILMIC_WHITE_DOMAIN / Math.max(whiteDomain, FILMIC_WHITE_DOMAIN), 0.5),
  );
}

/**
 * Clamp a file-derived anchored-highlight estimate into the knee's working
 * domain: never below {@link FILMIC_WHITE_DOMAIN} (flat/dark scenes keep the
 * original placement — the adaptive domain only relaxes UPWARD for
 * high-contrast scenes), never above {@link FILMIC_WHITE_DOMAIN_MAX} (a
 * near-unity domain would flatten the knee to a no-op; 0.95 keeps the pivot→
 * white stretch meaningful). Non-finite input falls back to the default.
 */
export function clampFilmicWhiteDomain(whiteDomain: number): number {
  if (!Number.isFinite(whiteDomain)) return FILMIC_WHITE_DOMAIN;
  return Math.min(FILMIC_WHITE_DOMAIN_MAX, Math.max(FILMIC_WHITE_DOMAIN, whiteDomain));
}

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
 * Stage ② scalar — the tone curve on LUMA: a power S through
 * (0,0)/(pivot,pivot)/(whiteDomain,1). Below the pivot a toe power
 * ({@link FILMIC_TOE_GAMMA} > 1) pulls shadows to a real black point; above it
 * a shoulder power ({@link FILMIC_SHOULDER_GAMMA} > 1) compresses the upper
 * tones so anchored scene white lands on display white WITHOUT dragging the
 * whole upper mid along (the former constant-slope linear stretch rendered
 * p90 +35/255 against the platform reference). Monotone; `whiteDomain` is the
 * per-file anchored-highlight domain ({@link clampFilmicWhiteDomain}); omitted
 * ⇒ the default {@link FILMIC_WHITE_DOMAIN}.
 */
export function filmicKnee(x: number, whiteDomain: number = FILMIC_WHITE_DOMAIN): number {
  if (x <= 0) return 0;
  const { toe, shoulder } = filmicCurveExponents(whiteDomain);
  if (x <= FILMIC_PIVOT) {
    return FILMIC_PIVOT * Math.pow(x / FILMIC_PIVOT, toe);
  }
  const u = Math.min(1, (x - FILMIC_PIVOT) / Math.max(whiteDomain - FILMIC_PIVOT, 1e-4));
  return Math.min(1, FILMIC_PIVOT + (1 - FILMIC_PIVOT) * Math.pow(u, shoulder));
}

/**
 * Stage ② per pixel — scale RGB by ONE gain so the pixel's luma follows the
 * knee. Uniform scaling preserves chromaticity exactly: below the pivot the
 * gain is 1 (identity), above it the whole pixel stretches toward white
 * together (highlights desaturate gracefully instead of hue-skewing).
 * Out-of-range channels after the gain clamp at 1 (specular saturation).
 * `whiteDomain` — the per-file knee domain, same contract as {@link filmicKnee}.
 */
export function filmicToneMap(
  r: number,
  g: number,
  b: number,
  whiteDomain: number = FILMIC_WHITE_DOMAIN,
): [number, number, number] {
  const luma = FILMIC_LUMA_WEIGHTS[0] * r + FILMIC_LUMA_WEIGHTS[1] * g + FILMIC_LUMA_WEIGHTS[2] * b;
  const gain = filmicKnee(luma, whiteDomain) / Math.max(luma, 1e-6);
  return [
    Math.min(1, Math.max(0, r * gain)),
    Math.min(1, Math.max(0, g * gain)),
    Math.min(1, Math.max(0, b * gain)),
  ];
}

// ─── RAW style preset (the "pre-grade" colour step) ──────────────────────────

/**
 * The RAW style preset's saturation addition, in W-linear anchored-domain
 * saturation units (s = (max−min)/max). Calibration: probe 2026-10-16 (third
 * round, against the user-supplied macOS conversion pairs, in the REAL device
 * order — style + power-S tone curve in W, THEN the W→display-p3 projection):
 * d=0.35 lands IMG_2591's sky subset at RGB 111,136,166 (ref 112,137,175),
 * b−r 56 (ref 62) with the foliage subset essentially exact (73,75,59 vs
 * 73,76,59). This is a STYLE preset parameter, not a per-file truth — Apple's
 * own saturation offset varies per capture (its 1795 interior wants LESS than
 * this while its sky runs over; a white-domain-adaptive dose is the designed
 * refinement, deferred with the brightness step) and the file carries no data
 * for it (the DNG GainTableMap holds tone only, zero chroma content).
 */
export const RAW_STYLE_BOOST = 0.35;

/**
 * Cap on the style's chroma scale factor. Without it F1 is an unbounded
 * amplifier near neutral: k = (s+d)/s → ∞ as s → 0, so a near-white cloud's
 * 1–3% sensor colour noise gets amplified ~15× into visible cyan/magenta
 * patches (20261016 device finding). 2.5 sits above every calibration point
 * (the probe sky s≈0.24 needs k≈2.2) and reduces a neutral's chroma boost to
 * imperceptible levels.
 */
export const RAW_STYLE_K_MAX = 2.5;

/**
 * RAW style preset operator — the colour step of the RAW render intent. Scales
 * the pixel's chroma by `k = min(1, s + boost) / s` (hue and Rec.709 luma kept,
 * value rides along): a "saturation + boost" reading in the same units the
 * probe calibrated. The luma-preserving choice is deliberate — the exact-
 * saturation alternative (scaling the whole pixel) blows up on low-saturation
 * pixels (k = (s+d)/s → ∞ as s → 0) and visually overexposes the image
 * (probe 2026-10-16: encoded p50 122 → 170).
 *
 * Identity guarantees: a perfectly neutral pixel (s ≈ 0) passes through
 * untouched; `boost = 0` is the exact identity; the result never leaves [0, 1]
 * when the input is in [0, 1] (the min(1, s+d) cap plus the clamp below).
 *
 * Runs BEFORE the knee (stage ②) in both the GPU operator
 * (`apply_raw_style`, injected into `COLORSPACE_WGSL` from this module) and the
 * CPU display proxy — the knee's scalar gain preserves the boosted chroma
 * exactly where it does not clamp, matching the probe's validated order.
 */
export function filmicRawStyle(
  r: number,
  g: number,
  b: number,
  boost: number = RAW_STYLE_BOOST,
): [number, number, number] {
  if (boost <= 0) return [r, g, b];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const s = (max - min) / Math.max(max, 1e-4);
  if (s < 1e-4) return [r, g, b];
  const k = Math.min(Math.min(1, s + boost) / s, RAW_STYLE_K_MAX);
  const luma = FILMIC_LUMA_WEIGHTS[0] * r + FILMIC_LUMA_WEIGHTS[1] * g + FILMIC_LUMA_WEIGHTS[2] * b;
  const ch = (v: number): number => Math.min(1, Math.max(0, luma + (v - luma) * k));
  return [ch(r), ch(g), ch(b)];
}
