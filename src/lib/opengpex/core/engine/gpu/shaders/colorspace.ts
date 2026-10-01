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
import {
  deriveMatrix64,
  deriveMatrixBetween,
  GAMUT_PRIMARIES,
  type GamutPrimaries,
} from '@opengpex/editor/core/engine/color/gamut';

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
 */
function wgslMat(m: readonly number[]): string {
  const col = (j: number) =>
    `vec3<f32>(${wgslFloat(m[j])}, ${wgslFloat(m[3 + j])}, ${wgslFloat(m[6 + j])})`;
  return `mat3x3<f32>(\n  ${col(0)},\n  ${col(1)},\n  ${col(2)}\n)`;
}

/**
 * Render a `<gamut> → Display-P3` matrix as a COLUMN-MAJOR `mat3x3<f32>(...)`
 * literal, derived from `primaries.ts` (the single source of truth). The CPU path
 * (`core/engine/color/matrices.ts`) formats the SAME derivation into `Float32Array`s — the
 * two can never be independently edited.
 */
function wgslMatToP3(from: GamutId): string {
  return wgslMat(deriveMatrix64(from, 'display-p3'));
}

/**
 * ACEScg (AP1) primaries — SMPTE ST 2065-4 / ACES, white ≈ D60. This is NOT a
 * source {@link GamutId} (never an ingest gamut), so it deliberately lives here and
 * NOT in the global `GAMUT_PRIMARIES` registry: it exists only as the wide internal
 * working space the Filmic RRT+ODT curve runs in (see `tone_map_filmic`).
 */
const ACESCG_AP1: GamutPrimaries = {
  R: [0.713, 0.293],
  G: [0.165, 0.830],
  B: [0.128, 0.044],
  white: [0.32168, 0.33767],
};

/** Display-P3 (D65) ⇄ ACEScg (AP1, D60) — derived with Bradford adaptation. */
const MAT_P3_TO_AP1_64 = deriveMatrixBetween(GAMUT_PRIMARIES['display-p3'], ACESCG_AP1);
const MAT_AP1_TO_P3_64 = deriveMatrixBetween(ACESCG_AP1, GAMUT_PRIMARIES['display-p3']);

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
// 3×3 Gamut Conversion Matrices to Working Space (Display-P3, D65)
// Applied in LINEAR light AFTER srgb_to_linear.
//
// AUTO-DERIVED from core/engine/color/gamut.ts (xy primaries + white point) via
// deriveMatrix64() — NOT hand-transcribed. Each matrix carries Bradford
// adaptation automatically (only ProPhoto, D50, needs it → D65). The identical
// derivation feeds core/engine/color/matrices.ts on the CPU side; a golden test parses
// these literals back out and asserts they equal the derivation.
// WGSL mat3x3<f32>(col0, col1, col2) — COLUMN-MAJOR storage.
// ────────────────────────────────────────────────────────────

const MAT_SRGB_TO_P3 = ${wgslMatToP3('srgb')};

const MAT_ADOBE_RGB_TO_P3 = ${wgslMatToP3('adobe-rgb')};

const MAT_PROPHOTO_TO_P3 = ${wgslMatToP3('prophoto-rgb')};

const MAT_REC2020_TO_P3 = ${wgslMatToP3('rec2020')};

// Map an input LINEAR colour in its source gamut to the working gamut (Display-P3).
// gamut_id: 0 = already working (direct), 1 = sRGB, 2 = Adobe RGB, 3 = ProPhoto, 4 = Rec.2020.
fn gamut_to_working(c : vec3<f32>, gamut_id : u32) -> vec3<f32> {
  switch (gamut_id) {
    case 1u: { return MAT_SRGB_TO_P3 * c; }
    case 2u: { return MAT_ADOBE_RGB_TO_P3 * c; }
    case 3u: { return MAT_PROPHOTO_TO_P3 * c; }
    case 4u: { return MAT_REC2020_TO_P3 * c; }
    default: { return c; }
  }
}

// ────────────────────────────────────────────────────────────
// Filmic tone-mapping — Scene-Referred → Display-Referred rendering intent
// (render-intent = 1).
//
// Scene-linear RAW is a raw energy read-out with no baked look, so shown flat it
// reads washed-out and grey. This is the generic S-curve that supplies the
// midtone contrast + highlight roll-off a camera/Lightroom would otherwise bake
// in — the baseline strategy applied to every featureless RAW without
// parsing a vendor curve.
//
// OPERATOR: Stephen Hill's "ACES Fitted" RRT+ODT rational (BakingLab), run PER
// CHANNEL in ACEScg (AP1). Chosen over the earlier Narkowicz 2015 fit for ONE
// decisive reason:
//
//   ⚠️ OUTPUT DOMAIN — Narkowicz's fit approximates ACES RRT+ODT(sRGB) and so
//   emits DISPLAY-ENCODED (sRGB-gamma) values. Our working buffer is LINEAR light
//   and the terminal stage (view.ts / exportEncode.ts) unconditionally applies
//   linear_to_srgb. Writing Narkowicz's gamma-encoded output into that linear
//   buffer therefore DOUBLE-encodes (≈ x^(1/4.84)): midtones balloon (0.18 → ~0.55
//   displayed instead of ~0.27) and colour desaturates — the "washed-out & bright"
//   bug. Hill's RRTAndODTFit instead outputs LINEAR display-referred values, so the
//   single terminal OETF is exactly right and the double-gamma is gone.
//
// WHY AP1, NOT the working Display-P3 directly: the curve is per-channel, and ACES'
// signature highlight desaturation ("hue-preserving" roll-off) comes from evaluating
// it in a WIDE gamut. AP1 is wider than P3, so bright saturated RAW highlights roll
// toward white gracefully instead of clipping a channel and skewing hue. We fold
// P3 → AP1 (Bradford D65→D60) before the curve and AP1 → P3 after; both matrices are
// DERIVED from primaries via the same colorimetry as every other gamut matrix here.
// NOTE: the small ACES RRT_SAT/ODT_SAT global saturation tweaks are intentionally
// omitted (the wide-gamut per-channel curve already supplies the primary look).
//
// ⚠️ CONSTRAINT B: this is HIGHLY NON-LINEAR — it MUST be fed STRAIGHT
// (un-premultiplied) values. Applied to premultiplied RGB (c·α) it crushes
// semi-transparent edges to black. The caller (normalize_source_components)
// owns that un-premultiply/re-premultiply dance; this operator assumes straight.
// ────────────────────────────────────────────────────────────

const MAT_P3_TO_AP1 = ${wgslMat(MAT_P3_TO_AP1_64)};

const MAT_AP1_TO_P3 = ${wgslMat(MAT_AP1_TO_P3_64)};

// Stephen Hill's RRT+ODT rational fit, evaluated per channel in ACEScg (AP1).
// Outputs LINEAR display-referred light. Coefficients are the canonical BakingLab
// values (a golden test parses them back out and re-derives the curve).
fn rrt_odt_fit(v : vec3<f32>) -> vec3<f32> {
  let a = v * (v + 0.0245786) - 0.000090537;
  let b = v * (0.983729 * v + 0.432951) + 0.238081;
  return a / b;
}

// Generic Filmic S-curve — ACES "Fitted" (Hill), LINEAR-light in, LINEAR-light out.
// Fold working Display-P3 → AP1, apply the per-channel RRT+ODT fit, fold back to
// Display-P3. Negatives are floored before the fold; the final clamp guards the
// tiny overshoot the rational form and the AP1→P3 fold can produce at the extremes.
fn tone_map_filmic(c : vec3<f32>) -> vec3<f32> {
  let ap1 = MAT_P3_TO_AP1 * max(c, vec3<f32>(0.0));
  let mapped = rrt_odt_fit(ap1);
  return clamp(
    MAT_AP1_TO_P3 * mapped,
    vec3<f32>(0.0),
    vec3<f32>(1.0),
  );
}
`;
