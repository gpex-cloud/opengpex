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
 * blend.ts — Types and embedded WGSL source for 16 blend modes.
 *
 * Embedded as a TypeScript constant for zero-config bundler compatibility.
 *
 * @module core/gpu/shaders/blend
 */

import type { LayerBlendMode } from '@opengpex/editor/core/types';
import { ADJUST_WGSL } from './adjust';
import { SOURCENORMALIZE_WGSL } from './sourceNormalize';
import { SDF_PRIMITIVES_WGSL } from './sdfPrimitives';
import { BLEND_MATH_WGSL } from './blendMath';

/**
 * 16 Blend modes index mapping: matches the switch statement in BLEND_WGSL.
 */
export const BLEND_MODE_MAP: Record<LayerBlendMode, number> = {
  'source-over': 0,
  'multiply': 1,
  'screen': 2,
  'overlay': 3,
  'darken': 4,
  'lighten': 5,
  'color-dodge': 6,
  'color-burn': 7,
  'hard-light': 8,
  'soft-light': 9,
  'difference': 10,
  'exclusion': 11,
  'hue': 12,
  'saturation': 13,
  'color': 14,
  'luminosity': 15,
};

/**
 * Single source of truth for the class-A / class-B split.
 *
 * Returns whether a blend mode can be expressed EXACTLY by a fixed-function
 * `GPUBlendState` under premultiplied alpha — i.e. the layer fragment shader
 * only outputs premultiplied `fg` and the hardware blender does the compositing.
 *
 * ⚠️ Contract red line: "hardware-blendable" is NOT the same as W3C
 * "separable". `multiply`/`screen`/`darken`/`lighten` are W3C-separable yet
 * CANNOT be expressed by a single premultiplied-alpha blend state, so they are
 * class B (ping-pong via `apply_blend`), NOT class A.
 *
 * Current `LayerBlendMode` (aligned to Canvas2D `globalCompositeOperation`) has
 * no `add`/`linear-dodge` member, so class A is exactly `{ 'source-over' }`.
 * Extending the enum (e.g. adding Add → `src:'one', dst:'one'`) is a PRODUCT
 * decision and out of scope for the render core — do not add it speculatively.
 *
 * The `isBottomOpaque` first-layer REPLACE optimization is handled separately in
 * `PipelineCache.getLayerPipeline()`, not by this classifier.
 */
export function isHardwareBlendable(mode: LayerBlendMode): boolean {
  return mode === 'source-over';
}
export const BLEND_WGSL = ADJUST_WGSL + SOURCENORMALIZE_WGSL + SDF_PRIMITIVES_WGSL + BLEND_MATH_WGSL + /* wgsl */ `
struct BlendUniforms {
  // Frame-unit quad (0..1) -> FOREGROUND-LOCAL unit coords (0..1 inside the layer
  // rect, outside otherwise). This is the inverse of the layer placement folded
  // with the frame extent; vs_main applies it so the full-frame blend quad can
  // recover per-pixel foreground coverage + UV without a background copy. Occupies
  // the same 48 bytes the old "Local Quad -> NDC" transform did. (48 bytes)
  fg_frame_to_local : mat3x3<f32>,
  uv_rect      : vec4<f32>,   // (u0, v0, du, dv) (16 bytes, offset 48..63)
  opacity      : f32,         // Offset 64
  blend_mode   : u32,         // Offset 68 (0..15)
  flags        : u32,         // Offset 72 (bits 0..2: has_mask/clip/premult, bit 3: source_solid, bit 4: source_is_linear, bits 5..7: gamut_id, bits 8..9: render_intent; bits 10..17 RETIRED — bmask hard/invert/stack now bake into the combined mask texture)
  vmask_flags  : u32,         // Offset 76 (was _pad; mirrors LayerUniforms.vmask_flags)
  vmask_rect   : vec4<f32>,   // Offset 80 (16B) — (cx, cy, halfW, halfH) in layer-local pixel space (analytic only)
  vmask_feather: vec4<f32>,   // Offset 96 (16B) — (featherPx, maskPxW, maskPxH, _reserved)
  tail         : vec4<f32>,   // Offset 112 (16B) — mirrors LayerUniforms.tail: .x is the per-file filmic knee domain (consumed only when render_intent ≠ 0); the WHOLE vec4 is the declarative solid colour (working-LINEAR straight alpha) when flags bit 3 (SOURCE_SOLID) is set
  clip_row0    : vec4<f32>,   // Offset 128 (16B) — CLIP-gate affine row 0 (ia, ib, itx, 0): frame px → base-local unit (mirrors LayerUniforms.clip_row0). Unread when flags bit 1 (CLIP) is clear.
  clip_row1    : vec4<f32>,   // Offset 144 (16B) — CLIP-gate affine row 1 (ic, id, ity, 0).
  clip_uv      : vec4<f32>,   // Offset 160 (16B) — the base's physical UV rect (u0, v0, du, dv).
};

@group(0) @binding(0) var<uniform> blend_u : BlendUniforms;
@group(0) @binding(1) var samp            : sampler;
@group(0) @binding(2) var fg_tex          : texture_2d<f32>;
@group(0) @binding(3) var bg_tex          : texture_2d<f32>;
@group(0) @binding(4) var mask_tex        : texture_2d<f32>;
@group(0) @binding(5) var vmask_tex       : texture_2d<f32>;
// The clip base's coverage texture (binding 6): bound ONLY for a clipped
// layer's draw; the 1×1 default white view otherwise (unread unless flags
// bit 1 — CLIP — is set). Symmetric to the layer shader's binding 5.
@group(0) @binding(6) var clip_tex        : texture_2d<f32>;
// The grade chain (uniform, LUT atlas, coverage array, 3D LUT) is group 1 —
// see adjust.ts. The bmask stack slots (retired bindings 6..8) are gone: the bmask combine
// pass bakes ALL enabled records (each record's hard bit + erase/restore
// family) into the ONE texture bound at mask_tex, so a single sample covers
// the whole mask set.

struct VSInput {
  @location(0) pos : vec2<f32>,
  @location(1) uv  : vec2<f32>,
};

struct VSOut {
  @builtin(position) clip_pos : vec4<f32>,
  @location(0) uv             : vec2<f32>,
  @location(1) mask_uv        : vec2<f32>,
};

@vertex
fn vs_main(in : VSInput) -> VSOut {
  var out : VSOut;
  // Non-separable coverage fix: the blend quad now covers the WHOLE frame
  // (unit quad 0..1 -> full-frame NDC, Y flipped so uv.y=0 is top), NOT just the
  // foreground layer rect. This guarantees a fragment runs for every accumulator
  // pixel, so the loadOp:'clear' scratch gets the full background composited in —
  // previously only the layer-sized quad ran fragments and everything outside it
  // stayed cleared-transparent, erasing the background (only the fragment showed).
  out.clip_pos = vec4<f32>(in.pos.x * 2.0 - 1.0, 1.0 - in.pos.y * 2.0, 0.0, 1.0);
  // uv/mask_uv are recomputed per-fragment from clip_pos (foreground-local space),
  // so these interpolants are unused; pass the frame-unit coord through harmlessly.
  out.uv = in.uv;
  out.mask_uv = in.uv;
  return out;
}

// ────────────────────────────────────────────────────────────
// Fragment Shader
// ────────────────────────────────────────────────────────────

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  // in.clip_pos IS the framebuffer coordinate (frame-pixel space, centers at .5),
  // set up by setViewport(0,0,frameW,frameH). Map it back into FOREGROUND-LOCAL
  // unit coords (0..1 inside the layer rect) with the precomputed inverse of the
  // layer placement. This lets the full-frame blend quad recover per-pixel fg
  // coverage + UV without any background copy: pixels outside the layer
  // rect get alpha_s=0 and the W3C formula below collapses to the untouched
  // background, so the accumulator is preserved everywhere the fg doesn't cover.
  let frame_px = in.clip_pos.xy;
  let local = (blend_u.fg_frame_to_local * vec3<f32>(frame_px, 1.0)).xy;
  let inside = local.x >= 0.0 && local.x <= 1.0 && local.y >= 0.0 && local.y <= 1.0;
  let coverage = select(0.0, 1.0, inside);

  // 1. Sample foreground layer at its own UV sub-rect (crop-aware). textureSample
  // stays in uniform control flow (called unconditionally); coverage zeroes alpha
  // outside the rect instead of branching around the sample.
  let fg_uv = blend_u.uv_rect.xy + local * blend_u.uv_rect.zw;
  var fg_sample = textureSample(fg_tex, samp, fg_uv);
  // ── Bitmap-extent gate ──
  // uv_rect is derived from visibleShape.rect and can legitimately extend past
  // the texture: a feathered-cut fragment pads its bounding outward so the soft
  // edge fades against real pixels, and its crop origin goes negative. The
  // sampler is clamp-to-edge, so those texels would smear the bitmap's edge
  // colour outward; there is no content beyond the bitmap — transparency, not
  // the edge texel, is what lives there. (Sample stays in uniform control flow;
  // the gate zeroes AFTER it.)
  if (fg_uv.x < 0.0 || fg_uv.y < 0.0 || fg_uv.x > 1.0 || fg_uv.y > 1.0) {
    fg_sample = vec4<f32>(0.0);
  }

  // ── Declarative solid fill ──
  // flags bit 3 (SOURCE_SOLID): the foreground colour is the uniform tail vec4
  // (working-LINEAR straight alpha), NOT a texture sample — the shared 1×1 white
  // texture bound at fg_tex is a binding-formality stretched constant and its
  // texel is discarded here (same discipline as layer.ts's fs_main). The blend
  // pass packs SOURCE_LINEAR + GAMUT_ID 0 + RENDER_INTENT 0 alongside, so the
  // normalize below passes the declaration through untouched.
  if ((blend_u.flags & 8u) != 0u) {
    fg_sample = blend_u.tail;
  }
  fg_sample.a *= coverage;

  // ── NORMALISE THE FOREGROUND ──
  // TRC decode → source-gamut → Display-P3 → render-intent tone-map, the SAME
  // shared pipeline layer.ts / adjustPre.ts use (sourceNormalize.wgsl). Must
  // precede the un-premultiply / mask / opacity arithmetic below — gamma-domain
  // alpha maths is v1's dark-edge root cause. Skips each step per the flags bits
  // (SOURCE_LINEAR / gamut_id / render_intent).
  //
  // ⚠️ ASYMMETRY IS INTENTIONAL: the BACKGROUND (bg_tex, read further down) is the
  // rgba16float accumulator — it is ALREADY working-space linear light and must
  // NOT be re-normalised. Converting both sides would double-decode / double-fold /
  // double-tone-map the backdrop and darken every ping-pong blend.
  fg_sample = normalize_layer_source(fg_sample, blend_u.flags, blend_u.tail.x);

  // Optional mask on foreground (bmask, sampled in the same foreground-local space).
  // The bound texture is the COMBINED coverage the bmask combine pass baked:
  // every enabled record's hard bit and erase/restore family are already folded
  // into it, so the sampling side is a plain multiply (symmetric to the
  // layer.ts bmask block; the retired per-record flag bits and stack slots are
  // gone). Coverage lives in the RED channel — record textures upload as
  // r8unorm and the combined output mirrors .r, so both shapes of the bound
  // texture (identity fast path vs combined) sample identically.
  if ((blend_u.flags & 1u) != 0u) {
    fg_sample.a *= textureSample(mask_tex, samp, local).r;
  }

  // Optional vmask (analytic SDF or baked polygon texture). Symmetric to
  // layer.ts fs_main; the mask coordinate is the foreground-local unit coord.
  if ((blend_u.vmask_flags & 1u) != 0u) {              // HAS_VMASK_ANALYTIC
    let vpx = local * blend_u.vmask_feather.yz;
    let center = blend_u.vmask_rect.xy;
    let half = blend_u.vmask_rect.zw;
    let shape = (blend_u.vmask_flags >> 4u) & 3u;
    var d: f32;
    if (shape == 0u) {
      d = sdf_rounded_rect(vpx - center, half, 0.0);
    } else {
      d = sdf_ellipse(vpx - center, half);
    }
    let aa = max(fwidth(d), 1e-6) * 0.5;
    let feather = max(blend_u.vmask_feather.x, aa);
    var vmask_alpha = 1.0 - smoothstep(-feather, feather, d);
    if ((blend_u.vmask_flags & 4u) != 0u) { vmask_alpha = 1.0 - vmask_alpha; }
    if ((blend_u.vmask_flags & 8u) != 0u) { vmask_alpha = step(0.5, vmask_alpha); }
    fg_sample.a *= vmask_alpha;
  } else if ((blend_u.vmask_flags & 2u) != 0u) {       // HAS_VMASK_TEX
    // WINDOWED bake: re-map normalized content uv into the coverage window
    // (same contract as the layer.ts composite branch).
    var vmask_uv = local;
    if ((blend_u.vmask_flags & 64u) != 0u) {           // VMASK_HAS_WINDOW
      let px = local * blend_u.vmask_feather.yz;
      vmask_uv = (px - blend_u.vmask_rect.xy) / blend_u.vmask_rect.zw;
    }
    var vmask_alpha = textureSample(vmask_tex, samp, vmask_uv).a;
    if ((blend_u.vmask_flags & 4u) != 0u) { vmask_alpha = 1.0 - vmask_alpha; }
    if ((blend_u.vmask_flags & 8u) != 0u) { vmask_alpha = step(0.5, vmask_alpha); }
    fg_sample.a *= vmask_alpha;
  }
  // ── Clip-to-base gate (Photoshop-style clipping mask) ──
  // flags bit 1 (CLIP): the foreground clips to the nearest unclipped layer
  // below — the same gate layer.wgsl applies on the class-A path, so a
  // member and its split effect steps share ONE base silhouette. The CPU
  // packs the inverse of the BASE's placement (frame px → base-local unit
  // quad, already folded with the export-viewport scale exactly like the
  // fg_frame_to_local rows above); coverage = inside-gate × base texture
  // alpha (a declarative-solid base binds the 1×1 white formality, so the
  // gate alone forms the rect coverage).
  if ((blend_u.flags & 2u) != 0u) {
    let cl = vec2<f32>(
      blend_u.clip_row0.x * frame_px.x + blend_u.clip_row1.x * frame_px.y + blend_u.clip_row0.z,
      blend_u.clip_row0.y * frame_px.x + blend_u.clip_row1.y * frame_px.y + blend_u.clip_row1.z,
    );
    var cov = select(0.0, 1.0, cl.x >= 0.0 && cl.x <= 1.0 && cl.y >= 0.0 && cl.y <= 1.0);
    let cuv = blend_u.clip_uv.xy + cl * blend_u.clip_uv.zw;
    // Bitmap-extent gate (symmetric to the fg sample): outside the base's
    // content rect the clamp-to-edge sampler would smear edge texels —
    // transparency is the truth there.
    if (cuv.x < 0.0 || cuv.y < 0.0 || cuv.x > 1.0 || cuv.y > 1.0) {
      cov = 0.0;
    }
    cov *= textureSample(clip_tex, samp, cuv).a;
    fg_sample.a *= cov;
  }
  fg_sample.a *= blend_u.opacity;

  // Un-premultiply foreground RGB if source was premultiplied. UNBOUNDED
  // (scene-referred contract): the f16 foreground legitimately carries > 1.0
  // HDR light, and a clamp here would flatten every highlight before the blend
  // math ever sees it. For [0,1] SDR content this is bit-identical to the old
  // clamp — clamping an in-range value is a no-op.
  var cs = fg_sample.rgb;
  if ((blend_u.flags & 4u) != 0u && fg_sample.a > 0.0001) {
    cs = fg_sample.rgb / fg_sample.a;
  }

  // Per-layer grade CHAIN on the STRAIGHT foreground rgb, before the blend
  // math. Gated on adj.stage_count != 0 so an un-adjusted layer is
  // bit-identical to un-adjusted input (identity no-op). Each stage blends
  // original vs graded by its own coverage (frozen selection snapshot,
  // sampled in the same foreground-local unit coord as vmask_tex): coverage
  // 1 = fully graded, 0 = untouched original — the layer's ALPHA is never
  // clipped by it.
  if (adj.stage_count != 0u) {
    cs = apply_adjust_chain(cs, local);
  }

  let alpha_s = fg_sample.a;

  // 2. Fetch background pixel at exact window coordinate.
  // ⚠️ NO TRC CONVERSION HERE: bg_tex is the rgba16float ping-pong accumulator
  // written by a previous composite/blend pass, so it already holds LINEAR LIGHT
  // in linear light. Decoding it would double-apply gamma. This asymmetry with
  // the foreground sample above is the correct behaviour, not an oversight.
  let bg_pixel_coord = vec2<i32>(floor(frame_px));
  let bg_sample = textureLoad(bg_tex, bg_pixel_coord, 0);

  let alpha_b = bg_sample.a;
  var cb = bg_sample.rgb;
  // UNBOUNDED accumulator un-premultiply (scene-referred contract): the
  // ping-pong accumulator is the previous composite and legitimately holds
  // HDR light. This was the heaviest clamp in the pipeline — ANY layer with a
  // non-source-over mode passes through here, so the old clamp flattened the
  // whole already-composited highlight range on the very next ping-pong. For
  // [0,1] SDR content it is a no-op (bit-identical).
  if (alpha_b > 0.0001) {
    cb = bg_sample.rgb / alpha_b;
  }

  // 3. Compute blended color in un-premultiplied space.
  // Perf note: blended is only consumed by the alpha_s*alpha_b*blended
  // term below, which is identically 0 when alpha_s == 0. Since the full-frame quad
  // runs a fragment for EVERY frame pixel but the foreground only covers a sub-rect
  // (coverage=0 outside so alpha_s=0) or is transparent, gating the expensive 16-mode
  // + HSL apply_blend behind (alpha_s > 0) skips that math for all uncovered /
  // transparent pixels with ZERO change to the output. apply_blend does no texture
  // sampling, so it is legal in non-uniform control flow.
  var blended = cb;
  if (alpha_s > 0.0) {
    blended = apply_blend(cb, cs, blend_u.blend_mode);
  }

  // 4. W3C general alpha compositing formula:
  let alpha_o = alpha_s + alpha_b * (1.0 - alpha_s);
  let out_rgb_premult = (1.0 - alpha_b) * alpha_s * cs
                      + (1.0 - alpha_s) * alpha_b * cb
                      + alpha_s * alpha_b * blended;

  // Premultiplied LINEAR light back into the rgba16float accumulator. Channel
  // isolation is NOT applied here: compositing/blending is channel-agnostic so
  // the composited texture stays cacheable (compose-once/view-many); the
  // display channel swizzle lives in the view pass (view.ts), where the single
  // terminal encode also lives.
  return vec4<f32>(out_rgb_premult, alpha_o);
}
`;

/** Size of BlendUniforms in bytes (176 bytes = 44 float/u32 slots, including vmask fields, filmic_white and the clip-base affine rows + UV rect). */
export const BLEND_UNIFORM_BUFFER_SIZE = 176;
