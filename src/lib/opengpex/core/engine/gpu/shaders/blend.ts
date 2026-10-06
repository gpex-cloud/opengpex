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
export const BLEND_WGSL = ADJUST_WGSL + SOURCENORMALIZE_WGSL + SDF_PRIMITIVES_WGSL + /* wgsl */ `
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
  flags        : u32,         // Offset 72 (bits 0..2: has_mask/clip/premult, bit 4: source_is_linear, bits 5..7: gamut_id, bits 8..9: render_intent; bits 3/10..17 RETIRED — bmask hard/invert/stack now bake into the combined mask texture)
  vmask_flags  : u32,         // Offset 76 (was _pad; mirrors LayerUniforms.vmask_flags)
  vmask_rect   : vec4<f32>,   // Offset 80 (16B) — (cx, cy, halfW, halfH) in layer-local pixel space (analytic only)
  vmask_feather: vec4<f32>,   // Offset 96 (16B) — (featherPx, maskPxW, maskPxH, _reserved)
};

@group(0) @binding(0) var<uniform> blend_u : BlendUniforms;
@group(0) @binding(1) var samp            : sampler;
@group(0) @binding(2) var fg_tex          : texture_2d<f32>;
@group(0) @binding(3) var bg_tex          : texture_2d<f32>;
@group(0) @binding(4) var mask_tex        : texture_2d<f32>;
@group(0) @binding(5) var vmask_tex       : texture_2d<f32>;
// The bmask stack slots (retired bindings 6..8) are gone: the bmask combine
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
// Non-separable HSL Blend Math Functions
// ────────────────────────────────────────────────────────────

// Luminosity coefficients — Rec.709.
//
// ⚠️ DELIBERATELY NOT the W3C 0.3/0.59/0.11. Those coefficients are defined for
// ENCODED (gamma) values; v2 blends in LINEAR LIGHT, where the
// physically-correct luminance weights are Rec.709 (0.2126/0.7152/0.0722) — the
// same weights adjust.wgsl's ADJ_LUMA already uses. This is a domain-consistent
// pairing, not a free choice: using gamma-domain coefficients on linear values
// would mis-weight every hue/saturation/color/luminosity blend.
fn lum(c : vec3<f32>) -> f32 {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

fn clip_color(c_in : vec3<f32>) -> vec3<f32> {
  var c = c_in;
  let l = lum(c);
  let n = min(min(c.r, c.g), c.b);
  let x = max(max(c.r, c.g), c.b);

  if (n < 0.0) {
    let denom = select(1.0, l - n, (l - n) != 0.0);
    c = l + (((c - l) * l) / denom);
  }
  if (x > 1.0) {
    let denom = select(1.0, x - l, (x - l) != 0.0);
    c = l + (((c - l) * (1.0 - l)) / denom);
  }
  return clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn set_lum(c : vec3<f32>, l : f32) -> vec3<f32> {
  let d = l - lum(c);
  return clip_color(c + vec3<f32>(d));
}

fn sat(c : vec3<f32>) -> f32 {
  return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
}

fn set_sat(c : vec3<f32>, s : f32) -> vec3<f32> {
  let curr_sat = sat(c);
  if (curr_sat <= 0.00001) {
    return vec3<f32>(0.0);
  }

  let r = c.r;
  let g = c.g;
  let b = c.b;

  var res = vec3<f32>(0.0);
  if (r <= g && g <= b) {
    res.r = 0.0;
    res.g = ((g - r) * s) / curr_sat;
    res.b = s;
  } else if (r <= b && b <= g) {
    res.r = 0.0;
    res.b = ((b - r) * s) / curr_sat;
    res.g = s;
  } else if (g <= r && r <= b) {
    res.g = 0.0;
    res.r = ((r - g) * s) / curr_sat;
    res.b = s;
  } else if (g <= b && b <= r) {
    res.g = 0.0;
    res.b = ((b - g) * s) / curr_sat;
    res.r = s;
  } else if (b <= r && r <= g) {
    res.b = 0.0;
    res.r = ((r - b) * s) / curr_sat;
    res.g = s;
  } else {
    res.b = 0.0;
    res.g = ((g - b) * s) / curr_sat;
    res.r = s;
  }
  return res;
}

fn blend_hue(bg : vec3<f32>, fg : vec3<f32>) -> vec3<f32> {
  return set_lum(set_sat(fg, sat(bg)), lum(bg));
}

fn blend_saturation(bg : vec3<f32>, fg : vec3<f32>) -> vec3<f32> {
  return set_lum(set_sat(bg, sat(fg)), lum(bg));
}

fn blend_color(bg : vec3<f32>, fg : vec3<f32>) -> vec3<f32> {
  return set_lum(fg, lum(bg));
}

fn blend_luminosity(bg : vec3<f32>, fg : vec3<f32>) -> vec3<f32> {
  return set_lum(bg, lum(fg));
}

// ────────────────────────────────────────────────────────────
// Per-channel Component Helpers
// ────────────────────────────────────────────────────────────

fn overlay_ch(b : f32, f : f32) -> f32 {
  if (b < 0.5) {
    return 2.0 * b * f;
  }
  return 1.0 - 2.0 * (1.0 - b) * (1.0 - f);
}

fn soft_light_ch(b : f32, f : f32) -> f32 {
  if (f <= 0.5) {
    return b - (1.0 - 2.0 * f) * b * (1.0 - b);
  }
  let d = select(sqrt(b), ((16.0 * b - 12.0) * b + 4.0) * b, b <= 0.25);
  return b + (2.0 * f - 1.0) * (d - b);
}

fn color_dodge_ch(b : f32, f : f32) -> f32 {
  if (b <= 0.0) { return 0.0; }
  if (f >= 1.0) { return 1.0; }
  return min(1.0, b / (1.0 - f));
}

fn color_burn_ch(b : f32, f : f32) -> f32 {
  if (b >= 1.0) { return 1.0; }
  if (f <= 0.0) { return 0.0; }
  return 1.0 - min(1.0, (1.0 - b) / f);
}

// ────────────────────────────────────────────────────────────
// Pure Color Blend Function (16 Modes)
// ────────────────────────────────────────────────────────────

fn apply_blend(bg : vec3<f32>, fg : vec3<f32>, mode : u32) -> vec3<f32> {
  switch (mode) {
    case 0u: { // Normal / source-over
      return fg;
    }
    case 1u: { // Multiply
      return bg * fg;
    }
    case 2u: { // Screen
      return 1.0 - (1.0 - bg) * (1.0 - fg);
    }
    case 3u: { // Overlay
      return vec3<f32>(
        overlay_ch(bg.r, fg.r),
        overlay_ch(bg.g, fg.g),
        overlay_ch(bg.b, fg.b)
      );
    }
    case 4u: { // Darken
      return min(bg, fg);
    }
    case 5u: { // Lighten
      return max(bg, fg);
    }
    case 6u: { // Color Dodge
      return vec3<f32>(
        color_dodge_ch(bg.r, fg.r),
        color_dodge_ch(bg.g, fg.g),
        color_dodge_ch(bg.b, fg.b)
      );
    }
    case 7u: { // Color Burn
      return vec3<f32>(
        color_burn_ch(bg.r, fg.r),
        color_burn_ch(bg.g, fg.g),
        color_burn_ch(bg.b, fg.b)
      );
    }
    case 8u: { // Hard Light
      return vec3<f32>(
        overlay_ch(fg.r, bg.r),
        overlay_ch(fg.g, bg.g),
        overlay_ch(fg.b, bg.b)
      );
    }
    case 9u: { // Soft Light
      return vec3<f32>(
        soft_light_ch(bg.r, fg.r),
        soft_light_ch(bg.g, fg.g),
        soft_light_ch(bg.b, fg.b)
      );
    }
    case 10u: { // Difference
      return abs(bg - fg);
    }
    case 11u: { // Exclusion
      return bg + fg - 2.0 * bg * fg;
    }
    case 12u: { // Hue
      return blend_hue(bg, fg);
    }
    case 13u: { // Saturation
      return blend_saturation(bg, fg);
    }
    case 14u: { // Color
      return blend_color(bg, fg);
    }
    case 15u: { // Luminosity
      return blend_luminosity(bg, fg);
    }
    default: {
      return fg;
    }
  }
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
  fg_sample = normalize_layer_source(fg_sample, blend_u.flags);

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
    var vmask_alpha = textureSample(vmask_tex, samp, local).a;
    if ((blend_u.vmask_flags & 4u) != 0u) { vmask_alpha = 1.0 - vmask_alpha; }
    if ((blend_u.vmask_flags & 8u) != 0u) { vmask_alpha = step(0.5, vmask_alpha); }
    fg_sample.a *= vmask_alpha;
  }
  fg_sample.a *= blend_u.opacity;

  // Un-premultiply foreground RGB if source was premultiplied
  var cs = fg_sample.rgb;
  if ((blend_u.flags & 4u) != 0u && fg_sample.a > 0.0001) {
    cs = clamp(fg_sample.rgb / fg_sample.a, vec3<f32>(0.0), vec3<f32>(1.0));
  }

  // Per-layer colour adjustments on the STRAIGHT foreground rgb, before
  // the blend math. Gated on adj.flags != 0 so an un-adjusted layer is
  // bit-identical to un-adjusted input (identity no-op).
  if (adj.flags != 0u) {
    cs = apply_adjustments(cs);
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
  if (alpha_b > 0.0001) {
    cb = clamp(bg_sample.rgb / alpha_b, vec3<f32>(0.0), vec3<f32>(1.0));
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

/** Size of BlendUniforms in bytes (112 bytes = 28 float/u32 slots, including vmask fields). */
export const BLEND_UNIFORM_BUFFER_SIZE = 112;
