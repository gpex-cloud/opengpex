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
 * adjustPre.ts — 1:1 full-quad shader that BAKES `apply_adjustments` into an
 * offscreen texture before applying neighbourhood filters.
 *
 * WHY THIS EXISTS — THE ORDER CONTRACT
 * ------------------------------------
 * `Scene.LayerNode` declares `adjustments` are "applied in order, BEFORE
 * `filters`" (and v1's normalizer always put blur last). Adjustments normally run
 * INLINE inside the compositing fragment shader (`layer.wgsl` / `blend.wgsl`),
 * which is free — but a filter is a NEIGHBOURHOOD operator that must run as its
 * own compute pass BEFORE compositing. Leaving the adjustment inline would
 * therefore execute `filter → adjust`, inverting the contract.
 *
 * So for the (rare) layers that carry BOTH, the composite path becomes:
 *   ① AdjustPrePass  — bake adjustments into a transient texture   ← this module
 *   ② FilterPass     — convolve that texture (compute)
 *   ③ Composite/Blend — with the group-1 IDENTITY adjust bind group,
 *                       so the adjustment is NOT applied a second time
 * Layers with NO filters skip ①/② entirely and keep the inline path bit-for-bit.
 *
 * ALPHA CONTRACT: input resident textures hold STRAIGHT alpha (CompositePass never
 * sets `LAYER_FLAG_PREMULTIPLIED_SOURCE`), adjustments are defined on straight RGB
 * and the output is written back STRAIGHT — so the texture this produces is
 * a drop-in replacement for the resident asset from every consumer's point of view.
 * No premultiply round-trip happens here; `FilterPass` owns that (it is the operator
 * that actually needs premultiplied accumulation).
 *
 * ⚠️ COLOUR SPACE: this pass DECODES sRGB→linear on sample (unless the
 * source is already linear) and writes LINEAR light into its rgba16float bake —
 * `apply_adjustments` takes and returns linear light, TRC-wrapping its own chain.
 * Consequently the bake is ALWAYS linear regardless of the input's encoding, which
 * is why `RenderGraph` tells the subsequent `FilterPass` `sourceIsLinear: true` and
 * the composite pass sets `LAYER_FLAG_SOURCE_LINEAR` for the filtered result.
 *
 * ⚠️ IDENTITY PATH SUBTLETY: when `adj.flags == 0` this pass is a pure COPY used by
 * filter-only layers. It must therefore still perform the decode (the bake's domain
 * contract is "always linear"), but it must NOT run the TRC round-trip that
 * `apply_adjustments` would otherwise apply — hence the two separate branches below.
 *
 * @module core/gpu/shaders/adjustPre
 */

import { ADJUST_WGSL } from './adjust';
import { SOURCENORMALIZE_WGSL } from './sourceNormalize';

/**
 * `AdjustPreUniforms` size in bytes: `uv_rect` vec4 (16) + `pad` vec4 (16) = 32.
 * A vec4 of padding keeps the struct a clean 2×16 B and leaves room for future
 * per-pass parameters without re-aligning.
 */
export const ADJUST_PRE_UNIFORM_BUFFER_SIZE = 32;

/** Number of 4-byte slots in `AdjustPreUniforms`. */
export const ADJUST_PRE_UNIFORM_FLOATS = ADJUST_PRE_UNIFORM_BUFFER_SIZE / 4;

/**
 * WGSL: a unit-quad vertex stage covering the whole render target plus a fragment
 * stage that samples the source at `uv_rect` and applies `apply_adjustments`.
 *
 * `ADJUST_WGSL` is prepended (not imported) because WGSL has no modules — the same
 * concatenation pattern `layer.wgsl` / `blend.wgsl` use, so all three share ONE
 * definition of `apply_adjustments` and can never drift. `SOURCENORMALIZE_WGSL`
 * follows it so this pass calls the SAME `normalize_source_components` the other two
 * consume (it needs `srgb_to_linear` / `gamut_to_working` / `tone_map_filmic` from
 * `COLORSPACE_WGSL`, which leads `ADJUST_WGSL`).
 */
export const ADJUST_PRE_WGSL = ADJUST_WGSL + SOURCENORMALIZE_WGSL + /* wgsl */ `
struct AdjustPreUniforms {
  // Source sub-rect to sample: (u0, v0, du, dv). Carries the bucket's maxU/maxV so
  // a pooled (power-of-two) source texture only contributes its VALID region.
  uv_rect : vec4<f32>,
  // x: 0 = source is sRGB-encoded (decode it), 1 = source is already linear light.
  // y: GAMUT_ID (0..7) — the source physical gamut to align to the working space
  //    (Display-P3) after the TRC decode; 0 = already working / direct (no-op).
  // z: RENDER_INTENT (0..3) — the out-of-box rendering intent tone-map (RAW Route B
  //    0 = SDR passthrough, 1 = Filmic, 2 = DNG LUT→Filmic. This
  //    bake is the FIRST sample of the raw asset, so it OWNS the tone-map; the
  //    downstream composite is then told the intent is already applied (constraint A).
  // Kept in the padding slot the struct already reserved, so the 32-byte layout and
  // every existing offset are unchanged.
  flags   : vec4<f32>,
};

@group(0) @binding(0) var<uniform> pre : AdjustPreUniforms;
@group(0) @binding(1) var pre_samp : sampler;
@group(0) @binding(2) var pre_tex  : texture_2d<f32>;

struct PreVSOut {
  @builtin(position) clip_pos : vec4<f32>,
  @location(0) uv             : vec2<f32>,
};

struct PreVSIn {
  @location(0) pos : vec2<f32>,
  @location(1) uv  : vec2<f32>,
};

@vertex
fn vs_adjust_pre(in : PreVSIn) -> PreVSOut {
  var out : PreVSOut;
  // Unit quad (0..1) -> full-target NDC. Y flips so v=0 is the top row, matching
  // the texture orientation every other pass assumes.
  out.clip_pos = vec4<f32>(in.pos.x * 2.0 - 1.0, 1.0 - in.pos.y * 2.0, 0.0, 1.0);
  out.uv = pre.uv_rect.xy + in.uv * pre.uv_rect.zw;
  return out;
}

@fragment
fn fs_adjust_pre(in : PreVSOut) -> @location(0) vec4<f32> {
  let src = textureSample(pre_tex, pre_samp, in.uv);

  // Normalise the raw sample into WORKING-space
  // (Display-P3) linear light with its rendering intent applied — the SAME pipeline
  // layer.ts / blend.ts run, via the scalar-parameter entry point (this 32-byte
  // uniform cannot carry a packed u32 flags word; constraint C). Input alpha is
  // STRAIGHT (CompositePass never premultiplies the bake source), so is_premult is
  // false and the intent's un-premultiply dance is a no-op. flags carry the fields as
  // exact integers in the f32 mantissa (0..7 / 0..3 exact; round discretises).
  let normalized = normalize_source_components(
    src,
    pre.flags.x >= 0.5,          // is_linear (skip decode)
    false,                       // is_premult — bake source is always straight
    u32(round(pre.flags.y)),     // gamut_id
    u32(round(pre.flags.z)),     // render_intent
  );
  let linear_rgb = normalized.rgb;

  // Identity fast path: flags == 0 makes this a pure (linear) copy for a
  // filter-only layer. Returning early SKIPS apply_adjustments' TRC round-trip,
  // preserving identity no-op through the bake.
  if (adj.flags == 0u) {
    return vec4<f32>(linear_rgb, src.a);
  }
  // Source is STRAIGHT alpha and apply_adjustments is defined on straight linear
  // RGB, so no un-premultiply is needed; alpha passes through untouched.
  return vec4<f32>(apply_adjustments(linear_rgb), src.a);
}
`;

/**
 * Pack `AdjustPreUniforms`: the source UV sub-rect `(u0, v0, du, dv)` plus the
 * `sourceIsLinear` flag.
 *
 * For a pooled source the valid region is `[0, maxU] × [0, maxV]`, NOT the whole
 * allocated texture — passing the full 0..1 rect would sample never-written
 * bucket padding (which would show up as a squashed image sampling uninitialised VRAM).
 *
 * `sourceIsLinear` must be true only when the sampled texture genuinely holds
 * linear light (a linear source asset). It is passed explicitly rather than derived
 * from the texture format, because format does not imply colour domain.
 *
 * `gamutId` (0..4) is the source physical gamut to align to the working space
 * (Display-P3) after the TRC decode; 0 = already working / direct (no-op). It is
 * written to `flags.y` and read back as an exact integer in the shader.
 *
 * `intent` (0..2) is the out-of-box rendering intent tone-map: 0 = SDR passthrough,
 * 1 = Filmic, 2 = DNG LUT (→Filmic). Written to `flags.z`. The bake OWNS the
 * tone-map (it is the raw asset's first sample), so the downstream composite is
 * later told the intent is already applied (RAW Route B constraint A).
 */
export function packAdjustPreUniform(
  maxU: number,
  maxV: number,
  sourceIsLinear = false,
  gamutId = 0,
  intent = 0,
): Float32Array {
  const out = new Float32Array(ADJUST_PRE_UNIFORM_FLOATS);
  out[0] = 0;
  out[1] = 0;
  out[2] = maxU;
  out[3] = maxV;
  out[4] = sourceIsLinear ? 1 : 0;
  out[5] = gamutId;
  out[6] = intent;
  return out;
}
