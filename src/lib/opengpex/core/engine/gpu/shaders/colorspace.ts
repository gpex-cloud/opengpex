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
 * colorspace.ts — sRGB ⇄ linear-light TRC in WGSL.
 *
 * THE FOUNDATION OF THE LINEAR-LIGHT PIPELINE
 * -------------------------------------------
 * Architectural invariant mandates that compositing / grading / filtering all happen in
 * an `rgba16float` LINEAR-LIGHT buffer. Source assets, however, arrive sRGB-TRC
 * ENCODED (8-bit bitmaps always; 16-bit TIFF/PNG usually — see the per-asset
 * `trc` judgement below). So exactly two conversion boundaries exist:
 *
 *   ①  SAMPLE-SIDE DECODE   encoded asset → `srgb_to_linear` → working buffer
 *   ⑥  TERMINAL ENCODE      working buffer → `linear_to_srgb` → swapchain/export
 *
 * Everything between those two points is linear light. This module is the SINGLE
 * definition of both directions, concatenated into every shader module that needs
 * them, so the two boundaries can never drift apart.
 *
 * WHY SHADER-EXPLICIT AND NOT `rgba8unorm-srgb` HARDWARE DECODE
 * ------------------------------------------------------------
 * `uploadSource` has TWO resident-format branches:
 * `bitmap`→`rgba8unorm` and `raw`→`rgba16float`/`rgba32float`. The float formats
 * have NO `-srgb` variant, so a 16-bit source must be converted in the shader
 * regardless. Choosing hardware decode for the 8-bit half would therefore create
 * a SPLIT path ("8-bit hardware / 16-bit shader") — precisely the internal
 * inconsistency. Three further reasons:
 *   • Resident assets carry `RENDER_ATTACHMENT` usage (`WebGpuEngine.uploadSource`).
 *     An `-srgb` view would silently ENCODE on any future render-to-asset path,
 *     planting a double-encode landmine.
 *   • One visible, unit-testable definition beats a per-format hardware
 *     behaviour that no Node test can observe (H1 blind spot).
 *   • Zero pipeline churn: formats are untouched, so no `PipelineCache` key and
 *     no `TexturePool` bucket (whose key embeds the format) changes.
 *
 * NUMERICAL CONTRACT: these are line-for-line transcriptions of
 * `core/engine/color/trc.ts` (the IEC 61966-2-1 reference that codecs
 * already depend on), INCLUDING the behaviour below 0 — a negative input
 * takes the linear branch and stays negative in both implementations, so no
 * clamp is applied here (a clamp would diverge from the reference).
 *
 * ⚠️ ALPHA IS NEVER TRANSFER-ENCODED. Only RGB goes through these functions.
 * Mask textures are consumed via `.a` only, so masks must NOT be converted.
 *
 * @module core/gpu/shaders/colorspace
 */

import type { GamutId } from '@opengpex/editor/core/types/primitives';
import { deriveMatrix64, WORKING_GAMUT } from '@opengpex/editor/core/engine/color/gamut';
import {
  FILMIC_LUMA_WEIGHTS,
  FILMIC_PIVOT,
  FILMIC_WHITE_DOMAIN,
  RAW_STYLE_BOOST,
  RAW_STYLE_K_MAX,
} from '@opengpex/editor/core/engine/color/filmic';

/**
 * Format an f64 matrix element as a fixed 7-decimal WGSL literal, collapsing the
 * `-0.0000000` that `toFixed` can emit for a negative zero into a clean `0`.
 */
function wgslFloat(n: number): string {
  const s = n.toFixed(7);
  return s === '-0.0000000' ? '0.0000000' : s;
}

/**
 * Render a row-major f64 3×3 as a COLUMN-MAJOR WGSL `mat3x3<f32>(...)` literal.
 * WGSL stores `mat3x3<f32>(col0, col1, col2)`, so column j of a row-major matrix
 * is (m[j], m[3+j], m[6+j]).
 *
 * Exported so the present pass (`view.ts`) can emit its WORKING → display
 * projection matrix from the same formatter — one literal style, one derivation.
 */
export function wgslMat(m: readonly number[]): string {
  const col = (j: number) =>
    `vec3<f32>(${wgslFloat(m[j])}, ${wgslFloat(m[3 + j])}, ${wgslFloat(m[6 + j])})`;
  return `mat3x3<f32>(\n  ${col(0)},\n  ${col(1)},\n  ${col(2)}\n)`;
}

/**
 * Render a `<gamut> → WORKING_GAMUT` matrix as a COLUMN-MAJOR `mat3x3<f32>(...)`
 * literal, derived from `gamut.ts` (the single source of truth). The CPU path
 * (`core/engine/color/matrices.ts`) formats the SAME derivation into `Float32Array`s — the
 * two can never be independently edited.
 */
function wgslMatToWorking(from: GamutId): string {
  return wgslMat(deriveMatrix64(from, WORKING_GAMUT));
}

/**
 * WGSL: `srgb_to_linear` / `linear_to_srgb` for scalars and vec3.
 *
 * Prepended (not imported — WGSL has no modules) to every shader module that
 * crosses a TRC boundary, the same concatenation pattern `ADJUST_WGSL` uses. Each
 * module gets its own copy; WGSL forbids duplicate top-level definitions within a
 * single module, so this must appear exactly once per module.
 */
export const COLORSPACE_WGSL = /* wgsl */ `
// ────────────────────────────────────────────────────────────
// sRGB transfer characteristics (IEC 61966-2-1) — see core/engine/color/trc.ts
// ────────────────────────────────────────────────────────────

fn srgb_to_linear_channel(c : f32) -> f32 {
  if (c <= 0.04045) {
    return c / 12.92;
  }
  return pow((c + 0.055) / 1.055, 2.4);
}

fn linear_to_srgb_channel(c : f32) -> f32 {
  if (c <= 0.0031308) {
    return c * 12.92;
  }
  return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}

// Decode an sRGB-ENCODED colour into LINEAR LIGHT.
// ⚠️ RGB only — alpha is a coverage ratio and is never transfer-encoded.
fn srgb_to_linear(c : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    srgb_to_linear_channel(c.r),
    srgb_to_linear_channel(c.g),
    srgb_to_linear_channel(c.b),
  );
}

// Encode a LINEAR-LIGHT colour into sRGB.
// ⚠️ Must be applied to STRAIGHT (un-premultiplied) values: the correct
// premultiplied result is encode(rgb/a)*a, NOT encode(rgb).
fn linear_to_srgb(c : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    linear_to_srgb_channel(c.r),
    linear_to_srgb_channel(c.g),
    linear_to_srgb_channel(c.b),
  );
}

// ────────────────────────────────────────────────────────────
// 3×3 Gamut Conversion Matrices to Working Space (ProPhoto RGB, D50)
// Applied in LINEAR light AFTER srgb_to_linear.
//
// AUTO-DERIVED from core/engine/color/gamut.ts (xy primaries + white point) via
// deriveMatrix64(from, WORKING_GAMUT) — NOT hand-transcribed. Each matrix carries
// Bradford adaptation automatically (only the D65→D50 hops need it). The identical
// derivation feeds core/engine/color/matrices.ts on the CPU side; a golden test parses
// these literals back out and asserts they equal the derivation.
// WGSL mat3x3<f32>(col0, col1, col2) — COLUMN-MAJOR storage.
//
// There is deliberately NO ProPhoto→working constant: with W = ProPhoto RGB a
// prophoto-tagged source is ALREADY in the working gamut, so it resolves to
// gamut_id 0 (the passthrough arm) — one less matrix multiply per pixel.
// ────────────────────────────────────────────────────────────

const MAT_SRGB_TO_WORKING = ${wgslMatToWorking('srgb')};

const MAT_ADOBE_RGB_TO_WORKING = ${wgslMatToWorking('adobe-rgb')};

const MAT_DISPLAY_P3_TO_WORKING = ${wgslMatToWorking('display-p3')};

const MAT_REC2020_TO_WORKING = ${wgslMatToWorking('rec2020')};

// Map an input LINEAR colour in its source gamut to the working gamut (ProPhoto RGB).
// gamut_id: 0 = already working (direct; ProPhoto sources land here), 1 = sRGB,
// 2 = Adobe RGB, 3 = Display-P3, 4 = Rec.2020.
fn gamut_to_working(c : vec3<f32>, gamut_id : u32) -> vec3<f32> {
  switch (gamut_id) {
    case 1u: { return MAT_SRGB_TO_WORKING * c; }
    case 2u: { return MAT_ADOBE_RGB_TO_WORKING * c; }
    case 3u: { return MAT_DISPLAY_P3_TO_WORKING * c; }
    case 4u: { return MAT_REC2020_TO_WORKING * c; }
    default: { return c; }
  }
}

// ────────────────────────────────────────────────────────────
// Filmic tone-mapping — Scene-Referred → Display-Referred rendering intent
// (render-intent = 1).
//
// Scene-linear RAW is a raw energy read-out with no baked look, so shown flat it
// reads washed-out and grey. This is the generic display transform that supplies
// the exposure placement + highlight shoulder a camera/Lightroom would otherwise
// bake in — the baseline strategy applied to every featureless RAW without
// parsing a vendor curve.
//
// OPERATOR (see core/engine/color/filmic.ts for the full rationale + probe
// evidence): the pixel's LUMA runs through a LINEAR KNEE — identity below
// FILMIC_PIVOT, constant stretch above it so the anchored scene white lands
// exactly on display white — and the whole RGB triple is scaled by that ONE
// gain. Exposure placement is handled at decode time (median→0.18 anchor baked
// into the f16 line); this operator owns only the knee. The knee's WHITE
// DOMAIN — the anchored input that maps to display white — is PER FILE
// ('white_domain' parameter, threaded from ColorIdentity.rawWhiteDomain
// through every sampling uniform): the median anchor places middle grey but
// not highlights, and a high-contrast capture anchors its highlights far above
// the default domain, where a fixed slope would slam them all to display white
// (probe 2026-10-14: IMG_1795 14.6% of pixels ≥224 vs Apple's 0.1%).
//
// ⚠️ WHY A SCALAR GAIN AND NOT A PER-CHANNEL CURVE: the first device build
// evaluated the knee per channel (in AP1, ACES-style) — with a 4.8× stretch
// the channels cross the pivot at different tones and the hue skews with
// brightness (measured: violet zenith, teal horizon). A uniform gain preserves
// chromaticity exactly; highlights desaturate toward white together instead.
// (This also retires the P3⇄AP1 fold: it existed to rescue per-channel hue,
// which a scalar gain no longer needs.)
//
// ⚠️ CONSTRAINT B: this is NON-LINEAR — it MUST be fed STRAIGHT
// (un-premultiplied) values. Applied to premultiplied RGB (c·α) it distorts
// semi-transparent edges. The caller (normalize_source_components) owns that
// un-premultiply/re-premultiply dance; this operator assumes straight.
// ────────────────────────────────────────────────────────────

const FILMIC_PIVOT = ${wgslFloat(FILMIC_PIVOT)};
const FILMIC_WHITE_DOMAIN_FLOOR = ${wgslFloat(FILMIC_WHITE_DOMAIN)};

const FILMIC_LUMA_WEIGHTS = vec3<f32>(${wgslFloat(FILMIC_LUMA_WEIGHTS[0])}, ${wgslFloat(FILMIC_LUMA_WEIGHTS[1])}, ${wgslFloat(FILMIC_LUMA_WEIGHTS[2])});

// Generic Filmic display transform — LINEAR-light in, LINEAR-light out.
// The tone curve runs on the pixel luma; the scalar gain knee/luma scales the
// whole pixel (chromaticity preserved exactly). The curve is a power S through
// (0,0)/(pivot,pivot)/(white_domain,1): a TOE power below the pivot (shadows
// reach a real black point) and a SHOULDER power above it (anchored scene
// white lands on display white without dragging the upper mids along). Both
// exponents are injected from filmic.ts (probe-calibrated 20261016 against the
// platform reference; the former linear knee rendered shadows +33/255 and
// highlights +35/255 against it). 'white_domain' is the per-file anchored-
// highlight domain (see filmic.ts — decode clamps it to [0.31, 0.95], both >
// the pivot, so the divide is always sane). luma=0 → knee=0 → gain 0 → black
// stays black; channels over 1 after the gain are specular saturation, clamped.
fn tone_map_filmic(c : vec3<f32>, white_domain : f32) -> vec3<f32> {
  let luma = dot(c, FILMIC_LUMA_WEIGHTS);
  // Per-file exponents, adapted on the white domain (filmicCurveExponents
  // mirror): sunny captures (domain at the floor) need the strong toe+shoulder,
  // high-contrast interiors (the GainTableMap already lifted their shadows)
  // need the milder pair — one fixed exponent pair cannot hit both files'
  // black point and highlight percentile.
  let adapt = max(white_domain - FILMIC_PIVOT, 0.0);
  let toe = clamp(2.8 - 1.4 * adapt, 2.2, 3.0);
  let shoulder = clamp(2.3 - 1.4 * adapt, 1.6, 2.3);
  let knee = select(
    FILMIC_PIVOT * pow(luma / FILMIC_PIVOT, toe),
    min(1.0, FILMIC_PIVOT + (1.0 - FILMIC_PIVOT)
      * pow(min(1.0, (luma - FILMIC_PIVOT) / max(white_domain - FILMIC_PIVOT, 1e-4)), shoulder)),
    luma > FILMIC_PIVOT,
  );
  let gain = knee / max(luma, 1e-6);
  return clamp(
    c * gain,
    vec3<f32>(0.0),
    vec3<f32>(1.0),
  );
}

// RAW style preset operator (the colour step of the RAW render intent — the
// "pre-grade"). Scales the pixel's chroma by k = min(1, s + boost) / s where
// s = (max−min)/max, pivoting on the Rec.709 LUMA (hue and luma kept, value
// rides along). Mirrors filmicRawStyle in filmic.ts EXACTLY (same constants,
// same luma pivot, same clamp semantics) — the two can never drift because the
// boost constant is injected from that module. Identity on neutrals (s ≈ 0).
// The whole-pixel-scale variant is REJECTED (probe 2026-10-16): it explodes on
// low-saturation pixels and overexposes the render. MUST run on STRAIGHT
// values and BEFORE tone_map_filmic (the probe validated style-then-knee);
// the caller (normalize_source_components) owns both orderings.
const RAW_STYLE_BOOST_F = ${wgslFloat(RAW_STYLE_BOOST)};
const RAW_STYLE_K_MAX_F = ${wgslFloat(RAW_STYLE_K_MAX)};

// 'white_domain' adapts the dose (filmicStyleDose mirror): Apple's saturation
// offset shrinks as the capture's dynamic compression grows — the sunny file
// calibrates at the full base, the high-contrast interior runs over at it.
fn apply_raw_style(c : vec3<f32>, white_domain : f32) -> vec3<f32> {
  let mx = max(c.r, max(c.g, c.b));
  let mn = min(c.r, min(c.g, c.b));
  let s = (mx - mn) / max(mx, 1e-4);
  let dose = min(RAW_STYLE_BOOST_F, RAW_STYLE_BOOST_F * pow(FILMIC_WHITE_DOMAIN_FLOOR / max(white_domain, FILMIC_WHITE_DOMAIN_FLOOR), 0.5));
  // The k cap keeps near-neutrals from being amplified (sensor colour noise on
  // clouds would otherwise blow up into cyan/magenta patches — 20261016 device
  // finding); mid-saturation calibration points sit below the cap.
  let k = select(1.0, min(min(1.0, s + dose) / s, RAW_STYLE_K_MAX_F), s > 1e-4);
  let luma = dot(c, FILMIC_LUMA_WEIGHTS);
  return clamp(vec3<f32>(luma) + (c - vec3<f32>(luma)) * k, vec3<f32>(0.0), vec3<f32>(1.0));
}
`;
