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
 * adjust.ts — Per-layer colour adjustment shader fragment + uniform layout
 * (per-layer colour adjustments and tone curves).
 *
 * ARCHITECTURAL ROLE — WHY A SHARED WGSL FRAGMENT, NOT A FULL-SCREEN PASS
 * ----------------------------------------------------------------------
 * `LayerNode.adjustments` is a PER-LAYER field ("applied in order, before
 * filters"): a colour grade belongs to ONE layer, not the merged composite. A
 * layer reaches the framebuffer through one of two compositing fragment shaders:
 *   • `source-over`  → `layer.wgsl`  fs_main  (CompositePass, separable batch)
 *   • any other mode → `blend.wgsl`  fs_main  (BlendPass, ping-pong)
 * A standalone full-screen "AdjustPass" would (1) grade the MERGED result and
 * (2) break the separable-batch fast path. So attaching adjustments to the end
 * of the layer pipeline is realised as this SHARED `apply_adjustments()` function, concatenated
 * into BOTH compositing shaders and invoked on the layer's STRAIGHT
 * (un-premultiplied) RGB just before re-premultiply. It lives entirely
 * inside the COMPOSITE passes (replayed with the composite cache;
 * `compositeSignature` already serialises `adjustments`) — never in view/present.
 *
 * COLOUR SPACE — LINEAR-LIGHT PIPELINE WITH A TRC WRAP
 * -----------------------------------------------------------
 * v2's working buffer holds LINEAR LIGHT: `layer.wgsl` /
 * `blend.wgsl` decode sRGB→linear on sample, all compositing/blending/filtering
 * is linear, and the single terminal encode lives in `view.wgsl`.
 *
 * Curves / levels / `.cube` are PERCEPTUAL-space operators, and their tables are
 * authored on ENCODED 0..1 (`generateCurveLUT` / `generateLevelsLUT`, the single
 * source of truth also drawn by the curve UI). Feeding linear light into
 * an encoded-domain table would silently re-interpret every stored curve. So this
 * function is TRC-WRAPPED:
 *
 *     linear ──linear_to_srgb──▶ encoded ──[adjust chain]──▶ encoded ──srgb_to_linear──▶ linear
 *
 * Inside the wrap every operator sees encoded values, so the whole chain — LUTs
 * and scalar operators alike — is behaviour-preserving. Proven, not asserted:
 * `adjust-golden.test.ts` gates the wrap against the encoded-domain result
 * (measured worst case 0.063/255, and all 256 8-bit codes re-quantise IDENTICALLY —
 * user's stored curves do not change byte-for-byte).
 *
 * ⚠️ WHY THE WRAP COVERS THE **WHOLE** CHAIN, NOT JUST THE LUTS:
 * The whole-chain wrap is the intentional design choice for operator domains.
 * The per-operator table below explains the technical rationale:
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * OPERATOR DOMAIN RATIONALE — why operators stay in the ENCODED domain
 * ═══════════════════════════════════════════════════════════════════════════
 * While linear light is superior for light transport/blending, the fundamental
 * distinction here is "which of these operators is a PHYSICAL-quantity operator
 * and which is a PERCEPTUAL-quantity operator". An
 * operator whose defining constant is a PERCEPTUAL landmark (mid-grey, an HSL
 * lightness, a tonal-zone threshold) belongs in the encoded domain BY
 * CONSTRUCTION; moving it to linear light does not make it "more correct", it
 * silently redefines what its parameter means.
 *
 * Measured at the DISPLAY END (after view.wgsl's terminal encode) — a linear-end
 * comparison is meaningless here because 0 and 1 are TRC fixed points:
 *
 *  • brightness  `y = x + t·4x(1-x)` — the lift PEAKS AT x=0.5, i.e. the operator
 *    IS "weight the midtones". Linear 0.5 displays as code 188, so in linear light
 *    the peak lands in the highlights. Measured drift if migrated: 34–37/255.
 *
 *  • contrast — tanh S-curve PIVOTED ON 0.5. In linear light the pivot displays as
 *    code 188, so `contrast=70` pulls the whole image toward display 188 instead of
 *    mid-grey (measured: grey ramp 32:61→111, 128:128→149, worst 70/255). That is a
 *    FUNCTIONAL BREAK, not an appearance difference — the single most decisive
 *    datum in the whole evaluation.
 *
 *  • saturation / hueRotate / channelMix — matrix mixing IS more physically
 *    correct in linear light (real light mixing), and that argument is accepted.
 *    It loses anyway on three counts: (a) the de-saturation AXIS `Σ Rec.709·c` is
 *    luma Y′ in the encoded domain but relative luminance Y in linear light, and
 *    v1's LUMA_R/G/B were authored for ENCODED values; (b) migration is an
 *    APPEARANCE-level change, not a precision-level one — 92% of colour samples
 *    exceed the 1/255 tolerance, worst 91/255; (c) saturation CANNOT be
 *    migrated alone — it shares LUMA_* and the fused `color_matrix` with
 *    hueRotate (see `adjustUniform.ts`), whose CSS/SVG coefficients (including the
 *    hard-coded 0.143/0.140/0.283) were jointly derived for encoded values.
 *
 *  • colorBalance — two independent reasons, either sufficient: (a) the zone
 *    thresholds are a PERCEPTUAL concept — the "midtones" weight must peak at
 *    perceptual mid-grey (encoded: display 128 ✓ / linear: display 188 ✗), and the
 *    dominant-zone boundaries move from S|M@52 M|H@204 to S|M@124 M|H@232, i.e.
 *    half the image would be treated as shadow; (b) the weighting variable is
 *    HSL's `L = (max+min)/2`, an HSL construct — NOT any physical luminance
 *    quantity — so "which domain is physical" does not even apply to it.
 *
 *  • preserveLuminosity (`cb_preserve`) — its domain is NOT INDEPENDENTLY
 *    CHOOSABLE, a structural constraint rather than a preference. The three zone
 *    weights sum to a constant, so adding a single scalar `d` cancels the
 *    luminance delta EXACTLY when `d` is computed in the same domain as the
 *    offsets (measured residual ≤3/255, and all of it from clamping). Compute `d`
 *    in the other domain and the residual grows to 9/255 — the feature stops
 *    working. Hence ADJ_LUMA must stay inside this wrap, next to the offsets.
 *
 * ⚠️ ADJ_LUMA vs blend.wgsl's `lum()` — SAME COEFFICIENTS, DIFFERENT DOMAINS, AND
 * THAT IS DELIBERATE. Do NOT "unify" either side. Both are Rec.709, but ADJ_LUMA
 * is applied to ENCODED values (inside this wrap) while `lum()` is applied to
 * LINEAR values. Three reasons this is two correct answers, not one bug:
 *   1. They were NEVER consistent. v1 already mismatched them (adjust used
 *      Rec.709, blend used W3C 0.3/0.59/0.11 — 32/255 apart on saturated hues).
 *      v2 still mismatches (73/255), so "unify" is a NEW consistency goal, not a
 *      regression fix — do not repackage it as one.
 *   2. Each is forced by its own domain. `lum()` MUST be linear: hardware blending
 *      fixes the blend domain. ADJ_LUMA MUST be encoded:
 *      v1 archive semantics fix the operator domain (the table above).
 *   3. They are DIFFERENT FEATURES — `adjust.saturation` is an operator slider,
 *      blend's `saturation`/`color`/`luminosity` are blend modes. No user expects
 *      "the saturation slider equals the saturation blend mode", so unification
 *      has no observable product benefit.
 * `adjust-domain-guard.test.ts` asserts this same-coefficient/different-domain
 * fact mechanically, so a future "cleanup" fails the gate instead of shipping.
 *
 * LUT TABLE-AXIS DOMAIN: tables stay on the ENCODED axis.
 * Re-sampling the SAME mapping onto a linear axis is semantically equivalent
 * (benefit identically zero) yet degrades the deep shadows by up to 158× — worst
 * 7.28/255, past the 1/255 tolerance — because a 256-entry linear-axis table
 * puts display codes 0..13 (5.5% of all 8-bit codes) inside ONE interpolation
 * span, whereas the encoded axis gives every 8-bit code its own entry. Authoring
 * curves natively on a linear axis WOULD be physically cleaner, but it changes the
 * meaning of the curve UI's horizontal axis (and the 256-bin histogram, and the
 * auto-levels percentile, and every stored `LevelsState`), which is an intentional
 * design constraint.
 * Verified by operator domain assessment benchmark.
 *
 * IDENTITY INVARIANT: `flags == 0` returns the input bit-exactly (identity no-op) —

 * the wrap is INSIDE the flags guard, so an un-adjusted layer does not even pay
 * the TRC round-trip. Call sites also gate the un-premultiply/re-premultiply
 * round-trip on `flags != 0`.
 *
 * MATH PROVENANCE (do NOT re-derive — keeps v1 saved effects byte-faithful)
 * ------------------------------------------------------------------------
 * brightness/contrast/saturation/hueRotate/channelMix/colorBalance are
 * line-for-line ports of v1 `shared/filter2d.ts`. The evaluation ORDER mirrors
 * v1 `applyFilterChainRGBA8`: basic point-ops (brightness→contrast) →
 * colorBalance → fused colour matrix (saturation→hueRotate→channelMix).
 *
 * @module core/gpu/shaders/adjust
 */

import { COLORSPACE_WGSL } from './colorspace';

/** WGSL: the `AdjustUniforms` struct + `@group(1) @binding(0)` binding. */
const ADJUST_WGSL_HEAD = /* wgsl */ `
struct AdjustUniforms {
  color_matrix  : mat3x3<f32>,   // fused saturation·hue·channelMix (48 bytes, offset 0)
  cb_shadows    : vec4<f32>,     // colorBalance shadow offsets ×(1/100), xyz (offset 48)
  cb_midtones   : vec4<f32>,     // colorBalance midtone offsets ×(1/100), xyz (offset 64)
  cb_highlights : vec4<f32>,     // colorBalance highlight offsets ×(1/100), xyz (offset 80)
  mat_constant  : vec4<f32>,     // channelMix per-channel constant, xyz (offset 96)
  brightness_t  : f32,           // (brightness-100)/100 ∈ [-1,1] (offset 112)
  contrast_c    : f32,           // (contrast-100)/100 ∈ [-1,1] (offset 116)
  cb_preserve   : f32,           // colorBalance preserveLuminosity (1.0 / 0.0) (offset 120)
  flags         : u32,           // bit0 basic, bit1 matrix, bit2 colorBalance, bit3 levels, bit4 curves, bit5 lut3d (offset 124)
  lut3d_strength : f32,          // 3D LUT blend amount ∈ [0,1] (offset 128)
  _pad0         : f32,           // (offset 132) — struct padded to a 16-B multiple
  _pad1         : f32,           // (offset 136)
  _pad2         : f32,           // (offset 140)
};

@group(1) @binding(0) var<uniform> adj : AdjustUniforms;
@group(1) @binding(1) var lut_samp   : sampler;
@group(1) @binding(2) var levels_lut : texture_1d<f32>;
@group(1) @binding(3) var curve_lut  : texture_1d<f32>;
// 3D colour LUT (.cube film emulation). Sampled with HARDWARE trilinear
// filtering via lut_samp; a 1×1×1 identity texture is bound when the layer has no
// lut3d so the layout stays satisfied and flags=0 remains bit-exact.
@group(1) @binding(4) var lut3d_tex  : texture_3d<f32>;

// Rec.709 luma weights (v1 filter2d LUMA_R/G/B).
//
// Applied to ENCODED values (this whole chain is TRC-wrapped), which is
// why these are LUMA (Y′) weights here and RELATIVE LUMINANCE (Y) weights in
// blend.wgsl's lum(). SAME numbers, DIFFERENT domain — deliberate, see the module
// header. Do NOT move this constant or its call site out of the wrap: colorBalance's
// preserveLuminosity only cancels exactly when the luma delta is computed in the
// same domain as the offsets it is undoing (cross-domain residual 9/255 vs ≤3/255).
const ADJ_LUMA : vec3<f32> = vec3<f32>(0.2126, 0.7152, 0.0722);


// 1D LUT entry count (matches generateCurveLUT/generateLevelsLUT default + v1's
// 256-entry tables). Map a value x∈[0,1] to the texel-CENTRE coordinate for the
// entry that stores curve(x): entry i holds curve(i/(N-1)), texel i centre is
// (i+0.5)/N, so coord = (x·(N-1) + 0.5)/N. Hardware linear filtering then
// interpolates between entries.
const ADJ_LUT_N : f32 = 256.0;
fn adj_lut_coord(x : f32) -> f32 {
  return (clamp(x, 0.0, 1.0) * (ADJ_LUT_N - 1.0) + 0.5) / ADJ_LUT_N;
}

`;


/** WGSL: the adjustment math functions + `apply_adjustments()` entry. */
const ADJUST_WGSL_BODY = /* wgsl */ `
// Brightness — midtone-weighted quadratic curve (v1 generateBrightnessLUT):
//   y = x + t·4·x·(1-x),  endpoints pinned, midtones lift/darken by t.
fn adj_brightness(x : vec3<f32>, t : f32) -> vec3<f32> {
  return clamp(x + t * 4.0 * x * (vec3<f32>(1.0) - x), vec3<f32>(0.0), vec3<f32>(1.0));
}

// Contrast — normalised tanh S-curve (v1 generateContrastLUT). Identity fast
// path |c|<0.001; c>0 steepens around 0.5; c<0 linear compression to midpoint.
fn adj_contrast(x : vec3<f32>, c : f32) -> vec3<f32> {
  if (abs(c) < 0.001) {
    return x;
  }
  if (c > 0.0) {
    let factor = 1.0 + c * 4.0;
    let norm_denom = tanh(factor * 0.5);
    return clamp(vec3<f32>(0.5) + 0.5 * tanh(factor * (x - vec3<f32>(0.5))) / norm_denom,
                 vec3<f32>(0.0), vec3<f32>(1.0));
  }
  let strength = 1.0 + c;
  return clamp(vec3<f32>(0.5) + (x - vec3<f32>(0.5)) * strength, vec3<f32>(0.0), vec3<f32>(1.0));
}

// Colour balance — HSL-lightness-weighted additive offsets (v1
// applyColorBalanceRGBA8). Weights (1-L)² / 4·L·(1-L) / L², each ×CB_SCALE=0.25.
// Offsets arrive pre-scaled by CB_STRENGTH=1/100. Optional additive luminance
// restoration (preserveLuminosity): add back the Rec.709 luma delta uniformly.
fn adj_color_balance(x : vec3<f32>) -> vec3<f32> {
  let l = (max(x.r, max(x.g, x.b)) + min(x.r, min(x.g, x.b))) * 0.5;
  let one_minus_l = 1.0 - l;
  let w_s = one_minus_l * one_minus_l * 0.25;
  let w_m = 4.0 * l * one_minus_l * 0.25;
  let w_h = l * l * 0.25;
  var n = clamp(x + adj.cb_shadows.rgb * w_s + adj.cb_midtones.rgb * w_m + adj.cb_highlights.rgb * w_h,
                vec3<f32>(0.0), vec3<f32>(1.0));
  if (adj.cb_preserve > 0.5) {
    let d = dot(x, ADJ_LUMA) - dot(n, ADJ_LUMA);
    n = clamp(n + vec3<f32>(d), vec3<f32>(0.0), vec3<f32>(1.0));
  }
  return n;
}

// Apply the per-layer adjustment chain. INPUT AND OUTPUT ARE LINEAR LIGHT
// the chain itself runs TRC-WRAPPED in the ENCODED domain so
// every operator — LUTs and scalars alike — sees encoded values (see the
// module header for why the wrap covers the whole chain).
// Order mirrors v1 applyFilterChainRGBA8: basic point-ops → levels → curves →
// colorBalance → fused matrix → 3D LUT.
fn apply_adjustments(rgb_in : vec3<f32>) -> vec3<f32> {
  if (adj.flags == 0u) {
    return rgb_in;
  }
  // TRC wrap, enter: linear → encoded. Inside this boundary the domain is
  // encoded, which keeps stored curves and levels byte-faithful.
  var c = linear_to_srgb(rgb_in);
  if ((adj.flags & 1u) != 0u) {

    c = adj_brightness(c, adj.brightness_t);
    c = adj_contrast(c, adj.contrast_c);
  }
  // levels — one shared table applied to every channel (v1 generateLevelsLUT).
  if ((adj.flags & 8u) != 0u) {
    c = vec3<f32>(
      textureSample(levels_lut, lut_samp, adj_lut_coord(c.r)).r,
      textureSample(levels_lut, lut_samp, adj_lut_coord(c.g)).g,
      textureSample(levels_lut, lut_samp, adj_lut_coord(c.b)).b,
    );
  }
  // curves — per-channel tables baked as perChannel(master(x)) in the RGBA LUT
  // (v1 composition order); sample channel r/g/b from the matching LUT channel.
  if ((adj.flags & 16u) != 0u) {
    c = vec3<f32>(
      textureSample(curve_lut, lut_samp, adj_lut_coord(c.r)).r,
      textureSample(curve_lut, lut_samp, adj_lut_coord(c.g)).g,
      textureSample(curve_lut, lut_samp, adj_lut_coord(c.b)).b,
    );
  }
  if ((adj.flags & 4u) != 0u) {
    c = adj_color_balance(c);
  }
  if ((adj.flags & 2u) != 0u) {
    c = clamp(adj.color_matrix * c + adj.mat_constant.rgb, vec3<f32>(0.0), vec3<f32>(1.0));
  }
  // 3D LUT (.cube) — LAST in the chain (the film-emulation
  // look is applied to the already-graded colour). Hardware trilinear filtering
  // does the interpolation; lut3d_strength allows a partial application
  // (0 = bypass, 1 = full), so a strength of 0 is exactly the input.
  if ((adj.flags & 32u) != 0u) {
    let lut_rgb = textureSample(lut3d_tex, lut_samp, clamp(c, vec3<f32>(0.0), vec3<f32>(1.0))).rgb;
    c = mix(c, lut_rgb, clamp(adj.lut3d_strength, 0.0, 1.0));
  }
  // TRC wrap, exit: encoded → linear. Restores linear working space for the caller,
  // which re-premultiplies and composites in linear light.
  return srgb_to_linear(c);
}
`;

/**
 * Full WGSL fragment: sRGB TRC helpers + `AdjustUniforms` struct +
 * `@group(1) @binding(0)` binding + `apply_adjustments()`. Concatenated into
 * `layer.wgsl` / `blend.wgsl` / `adjustPre.wgsl`; each shader module gets its own
 * copy (WGSL forbids a duplicate top-level binding or function within a single
 * module, so this appears exactly once per module).
 *
 * `COLORSPACE_WGSL` leads so those three modules inherit `srgb_to_linear` /
 * `linear_to_srgb` for their own sample-side decode from the
 * SAME definition this function's TRC wrap uses — the two can never drift.
 */
export const ADJUST_WGSL = COLORSPACE_WGSL + ADJUST_WGSL_HEAD + ADJUST_WGSL_BODY;

/**
 * Size of AdjustUniforms in bytes.
 *
 * Struct size is 144 B with `lut3d_strength` + 12 B of explicit tail padding
 * (WGSL requires a struct size that is a multiple of its largest member alignment,
 * 16 B here for the mat3x3/vec4 members).
 */
export const ADJUST_UNIFORM_BUFFER_SIZE = 144;

/** Number of 4-byte slots in AdjustUniforms (buffer size / 4). */
export const ADJUST_UNIFORM_FLOATS = ADJUST_UNIFORM_BUFFER_SIZE / 4;

/** `flags` bit: apply brightness + contrast scalar curves. */
export const ADJUST_FLAG_BASIC = 1 << 0;
/** `flags` bit: apply the fused saturation·hue·channelMix colour matrix. */
export const ADJUST_FLAG_MATRIX = 1 << 1;
/** `flags` bit: apply the HSL-weighted colour balance offsets. */
export const ADJUST_FLAG_COLOR_BALANCE = 1 << 2;
/** `flags` bit: sample the levels 1D LUT. */
export const ADJUST_FLAG_LEVELS = 1 << 3;
/** `flags` bit: sample the curves 1D LUT. */
export const ADJUST_FLAG_CURVES = 1 << 4;
/** `flags` bit: sample the 3D `.cube` LUT with hardware trilinear. */
export const ADJUST_FLAG_LUT3D = 1 << 5;

/** Float slot of `lut3d_strength` in the packed uniform (byte offset 128 / 4). */
export const ADJUST_SLOT_LUT3D_STRENGTH = 32;
