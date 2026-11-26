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
 * effectInnerCompose.ts — The INNER-EDGE effect family (Inner Glow / Inner
 * Shadow): ONE shared machinery, parameterized per effect. Both effects:
 * invert the mask-baked content alpha (`1 − c.a`), optionally dilate the
 * inverted region (Spread, via the EDT band — the existing effectShadowSpread
 * pipeline run on the inverted texture, fg seeds = inverted alpha ≥ ½), blur
 * it, and composite the band ON the content clipped by the silhouette — only
 * the compose differs (glow overlays its colour on the whole band; shadow
 * shifts the band sample by the offset so the ring lands on the offset's
 * side).
 *
 * ⚠️ THE OOB HAZARD THIS MODULE EXISTS TO NAIL: inner effects' OUTPUT window
 * has pad = 0. Writing `1 − c.a` into a temp and blurring it with zero-OOB
 * semantics reads 0.0 beyond the content where the TRUE inverted silhouette
 * is 1.0 — for a full-bleed solid rect (content == texture, no transparent
 * border) the four borders lose the effect entirely (a void ring at the
 * edges). THE FIX, implemented in `cs_effect_inner_invert`:
 *   • the inverted-silhouette temp is padded OUTWARD by
 *     `blurReach + spread + AA slack` on every side, and
 *   • the padding is filled with the TRUTHFUL value 1.0 (beyond the content
 *     the inverted silhouette IS 1.0 — not zero), so
 *   • the blur's edge taps read truth and the band survives at full bleed.
 * The compose then clips back to the original silhouette alpha. NO new
 * gaussian OOB flag is needed: with truthful borders the blur's edge taps
 * are fed by the padding itself, and the compose only consumes the window
 * rect well inside the padding.
 *
 * EXECUTION POSITION: the inner chain runs on the FINAL foreground (after
 * the stroke and shadow chains) and composites ON it — composing last keeps
 * the silhouette-derived effects unpolluted. The OUTPUT stays window-aligned
 * at the same window extent (pad contribution 0 — see effectWindowPadsPx).
 *
 * BAND SHAPING: the blurred inverted field is a step-edge blur capped at 0.5
 * at the content border (the field's full half lies outside the content).
 * The compose RESCALES the band by 2 (clamped) so the inner ring reaches
 * full strength at the wall and the inward falloff spans the same width as
 * the outer shadow's at the same blurRadius — the sigma mapping itself is
 * IDENTICAL to the outer path (one shared FilterPass blur, sigma =
 * blurRadius; deliberately not tuned separately).
 *
 * BLEND DOMAIN: the band blends against the layer's OWN content — a
 * layer-local operation — through the shared `apply_blend` seat (16 modes,
 * no enum growth). Both operands are un-premultiplied working-LINEAR RGB.
 *
 * MODULE NOTE: the two kernels are TWO separate WGSL modules (WGSL forbids
 * re-declaring a (group, binding) pair in one module, and the invert and
 * compose need different resource sets). Both include the shared blend math.
 *
 * @module core/gpu/shaders/effectInnerCompose
 */

import { COLORSPACE_WGSL } from './colorspace';
import { BLEND_MATH_WGSL } from './blendMath';
import type { LayerBlendMode } from '@opengpex/editor/core/types';
import { BLEND_MODE_MAP } from './blend';

/** Workgroup edge for the 2D-tiled dispatches (ceil(dim/8) per axis). */
export const EFFECT_INNER_WORKGROUP = 8;

/** `flags` bit: the CURRENT texture already holds linear light (skip decode). */
export const EFFECT_INNER_FLAG_CURRENT_LINEAR = 1 << 0;

/**
 * `EffectInnerInvertUniforms` size in bytes: padded dims vec2 (8) +
 * pad vec2 (8, the invert temp's outward headroom in texels) +
 * sil_dims vec2 (8) + sil_origin vec2 (8, i32 bits) +
 * inner_rect vec4 (16, the visible window rect the band guards to) = 48.
 */
export const EFFECT_INNER_INVERT_UNIFORM_BUFFER_SIZE = 48;

/** Number of 4-byte slots in `EffectInnerInvertUniforms`. */
export const EFFECT_INNER_INVERT_UNIFORM_FLOATS = EFFECT_INNER_INVERT_UNIFORM_BUFFER_SIZE / 4;

export function packEffectInnerInvertUniform(
  paddedWidth: number,
  paddedHeight: number,
  opts: {
    /** The invert temp's outward headroom in texels (blurReach + spread + slack). */
    readonly padTexels: number;
    readonly silWidth: number;
    readonly silHeight: number;
    /** Silhouette texture's top-left inside the window, in SIL texels (bit-exact i32; may be negative). */
    readonly silOriginX: number;
    readonly silOriginY: number;
    /** The visible window rect (x, y, w, h) — the band is built inside it; padding is 1.0. */
    readonly innerRect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  },
): Float32Array {
  const out = new Float32Array(EFFECT_INNER_INVERT_UNIFORM_FLOATS);
  const uints = new Uint32Array(out.buffer);
  uints[0] = Math.max(1, paddedWidth) >>> 0;
  uints[1] = Math.max(1, paddedHeight) >>> 0;
  out[2] = opts.padTexels;
  out[3] = opts.padTexels;
  uints[4] = Math.max(1, opts.silWidth) >>> 0;
  uints[5] = Math.max(1, opts.silHeight) >>> 0;
  uints[6] = Math.round(opts.silOriginX) >>> 0;
  uints[7] = Math.round(opts.silOriginY) >>> 0;
  uints[8] = Math.max(0, Math.floor(opts.innerRect.x)) >>> 0;
  uints[9] = Math.max(0, Math.floor(opts.innerRect.y)) >>> 0;
  uints[10] = Math.max(0, Math.ceil(opts.innerRect.w)) >>> 0;
  uints[11] = Math.max(0, Math.ceil(opts.innerRect.h)) >>> 0;
  return out;
}

/**
 * `EffectInnerUniforms` (the compose pass) size in bytes: dims vec2 (8) +
 * flags (4) + gamut_id (4) + cur_dims vec2 (8) + cur_origin vec2 (8) +
 * sil_dims vec2 (8) + sil_origin vec2 (8) + band_dims vec2 (8) +
 * band_offset vec2 (8, i32 bits) + band_pad vec2 (8) + blend_mode (4) +
 * opacity (4) + align pad (8) + effect_color vec4 (16) = 112.
 */
export const EFFECT_INNER_UNIFORM_BUFFER_SIZE = 112;

/** Number of 4-byte slots in `EffectInnerUniforms`. */
export const EFFECT_INNER_UNIFORM_FLOATS = EFFECT_INNER_UNIFORM_BUFFER_SIZE / 4;

export function packEffectInnerComposeUniform(
  width: number,
  height: number,
  opts: {
    readonly currentIsLinear: boolean;
    readonly gamutId: number;
    readonly currentWidth: number;
    readonly currentHeight: number;
    /** Current texture's top-left inside the window, in CURRENT texels (bit-exact i32). */
    readonly currentOriginX: number;
    readonly currentOriginY: number;
    readonly silWidth: number;
    readonly silHeight: number;
    /** Silhouette origin (same convention as the invert pass). */
    readonly silOriginX: number;
    readonly silOriginY: number;
    readonly bandWidth: number;
    readonly bandHeight: number;
    /** Inner-shadow band shift, in window texels (bit-exact i32; the ring lands on the offset's side). */
    readonly offsetX: number;
    readonly offsetY: number;
    /** The band temp's outward headroom (band coords = window coords + pad). */
    readonly padTexels: number;
    /** One of the 16 `LayerBlendMode` values. */
    readonly blendMode: LayerBlendMode;
    /** Effect strength 0..1. */
    readonly opacity: number;
    /** Working-LINEAR straight-alpha effect colour. */
    readonly effectColor: readonly [number, number, number, number];
  },
): Float32Array {
  const out = new Float32Array(EFFECT_INNER_UNIFORM_FLOATS);
  const uints = new Uint32Array(out.buffer);
  uints[0] = Math.max(1, width) >>> 0;
  uints[1] = Math.max(1, height) >>> 0;
  uints[2] = opts.currentIsLinear ? EFFECT_INNER_FLAG_CURRENT_LINEAR : 0;
  uints[3] = opts.gamutId >>> 0;
  uints[4] = Math.max(1, opts.currentWidth) >>> 0;
  uints[5] = Math.max(1, opts.currentHeight) >>> 0;
  uints[6] = Math.round(opts.currentOriginX) >>> 0;
  uints[7] = Math.round(opts.currentOriginY) >>> 0;
  uints[8] = Math.max(1, opts.silWidth) >>> 0;
  uints[9] = Math.max(1, opts.silHeight) >>> 0;
  uints[10] = Math.round(opts.silOriginX) >>> 0;
  uints[11] = Math.round(opts.silOriginY) >>> 0;
  uints[12] = Math.max(1, opts.bandWidth) >>> 0;
  uints[13] = Math.max(1, opts.bandHeight) >>> 0;
  uints[14] = Math.round(opts.offsetX) >>> 0;
  uints[15] = Math.round(opts.offsetY) >>> 0;
  out[16] = opts.padTexels;
  out[17] = opts.padTexels;
  uints[18] = (BLEND_MODE_MAP[opts.blendMode] ?? 0) >>> 0;
  out[19] = Number.isFinite(opts.opacity) ? Math.min(1, Math.max(0, opts.opacity)) : 1;
  // [20..21] alignment padding before the 16-byte-aligned effect colour.
  out.set([opts.effectColor[0], opts.effectColor[1], opts.effectColor[2], opts.effectColor[3]], 22);
  // [26..27] tail padding.
  return out;
}

/**
 * WGSL for the INVERT kernel: build the padded inverted silhouette with the
 * truthful 1.0 border (see the module header — the OOB fix).
 *
 * Bindings (group 0):
 *   0 - EffectInnerInvertUniforms
 *   1 - sil_tex : texture_2d<f32>  (mask-baked content silhouette)
 *   2 - dst_tex : texture_storage_2d<format, write>  (padded temp)
 */
export function buildEffectInnerInvertWgsl(format: 'rgba16float' | 'rgba32float'): string {
  return COLORSPACE_WGSL + /* wgsl */ `
struct EffectInnerInvertUniforms {
  dims       : vec2<u32>,  // padded temp dims in texels
  pad        : vec2<f32>,  // outward headroom in texels (blurReach + spread + slack)
  sil_dims   : vec2<u32>,  // silhouette texture dims in texels
  sil_origin : vec2<u32>,  // silhouette top-left inside the window (i32 bits)
  inner_rect : vec4<u32>,  // visible window rect (x, y, w, h) the band guards to
};

@group(0) @binding(0) var<uniform> u : EffectInnerInvertUniforms;
@group(0) @binding(1) var sil_tex : texture_2d<f32>;
@group(0) @binding(2) var dst_tex : texture_storage_2d<${format}, write>;

@compute @workgroup_size(${EFFECT_INNER_WORKGROUP}, ${EFFECT_INNER_WORKGROUP}, 1)
fn cs_effect_inner_invert(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= u.dims.x || gid.y >= u.dims.y) {
    return;
  }
  let xy = vec2<i32>(gid.xy);
  // Padded texel q -> window coord w = q - pad.
  let w = xy - vec2<i32>(u.pad);
  // Window coord -> silhouette texel. The origin packs bit-exactly and may
  // be negative; the u32->i32 reinterpret MUST come first (a direct u32->f32
  // value cast would turn -2 into 4294967294.0 — the strokeCompose incident).
  let s_pos = w - vec2<i32>(u.sil_origin);
  let vx0 = i32(u.inner_rect.x);
  let vy0 = i32(u.inner_rect.y);
  let vx1 = vx0 + i32(u.inner_rect.z);
  let vy1 = vy0 + i32(u.inner_rect.w);
  var a = 0.0;
  var guarded = false;
  if (s_pos.x >= 0 && s_pos.y >= 0
    && s_pos.x < i32(u.sil_dims.x) && s_pos.y < i32(u.sil_dims.y)
    && w.x >= vx0 && w.y >= vy0 && w.x < vx1 && w.y < vy1) {
    a = textureLoad(sil_tex, s_pos, 0).a;
    guarded = true;
  }
  // ⚠️ THE OOB FIX: beyond the visible content the inverted silhouette's
  // truthful value is 1.0, never 0 — a zero fill would starve the blur's
  // border taps and erase the band on full-bleed layers (the incident).
  let inv = select(1.0, 1.0 - clamp(a, 0.0, 1.0), guarded);
  textureStore(dst_tex, xy, vec4<f32>(0.0, 0.0, 0.0, inv));
}
`;
}

/**
 * WGSL for the COMPOSE kernel: blend the (optionally shifted) band onto the
 * foreground, clipped by the silhouette.
 *
 * Bindings (group 0):
 *   0 - EffectInnerUniforms
 *   1 - current_tex : texture_2d<f32>  (final foreground)
 *   2 - sil_tex     : texture_2d<f32>  (mask-baked silhouette — the clip)
 *   3 - band_tex    : texture_2d<f32>  (padded blurred inverted silhouette)
 *   4 - dst_tex     : texture_storage_2d<format, write>
 */
export function buildEffectInnerComposeWgsl(format: 'rgba16float' | 'rgba32float'): string {
  // The blend math declares only pure functions (no bindings, no entry
  // points), so concatenating it ahead of the glue is collision-free.
  return COLORSPACE_WGSL + BLEND_MATH_WGSL + /* wgsl */ `
struct EffectInnerUniforms {
  dims        : vec2<u32>,  // output window size in texels
  flags       : u32,        // bit0: current already linear
  gamut_id    : u32,        // gamut_to_working source id for the current
  cur_dims    : vec2<u32>,  // current texture dims in texels
  cur_origin  : vec2<u32>,  // current top-left inside the window (i32 bits)
  sil_dims    : vec2<u32>,  // silhouette dims in texels
  sil_origin  : vec2<u32>,  // silhouette top-left inside the window (i32 bits)
  band_dims   : vec2<u32>,  // blurred band temp dims (padded) in texels
  band_offset : vec2<u32>,  // inner-shadow band shift (i32 bits; 0 for the glow)
  band_pad    : vec2<f32>,  // band temp's outward headroom
  blend_mode  : u32,        // apply_blend mode index (BLEND_MODE_MAP order)
  opacity     : f32,        // effect strength 0..1
  effect_color: vec4<f32>,  // working-LINEAR straight-alpha RGBA
};

@group(0) @binding(0) var<uniform> u : EffectInnerUniforms;
@group(0) @binding(1) var current_tex : texture_2d<f32>;
@group(0) @binding(2) var sil_tex : texture_2d<f32>;
@group(0) @binding(3) var band_tex : texture_2d<f32>;
@group(0) @binding(4) var dst_tex : texture_storage_2d<${format}, write>;

@compute @workgroup_size(${EFFECT_INNER_WORKGROUP}, ${EFFECT_INNER_WORKGROUP}, 1)
fn cs_effect_inner_compose(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= u.dims.x || gid.y >= u.dims.y) {
    return;
  }
  let xy = vec2<i32>(gid.xy);

  // Foreground: window -> current texels (bit-exact origin, explicit guard;
  // backend textureLoad OOB clamping must never be relied on).
  let c_pos = xy - vec2<i32>(u.cur_origin);
  var c = vec4<f32>(0.0);
  if (c_pos.x >= 0 && c_pos.y >= 0
    && c_pos.x < i32(u.cur_dims.x) && c_pos.y < i32(u.cur_dims.y)) {
    c = textureLoad(current_tex, c_pos, 0);
  }
  var c_rgb = c.rgb;
  if ((u.flags & ${EFFECT_INNER_FLAG_CURRENT_LINEAR}u) == 0u) {
    c_rgb = srgb_to_linear(c_rgb);
  }
  c_rgb = gamut_to_working(c_rgb, u.gamut_id);

  // Silhouette coverage: the clip that keeps the effect INSIDE the content
  // (and off the stroke ring — the silhouette is the ORIGINAL mask-baked
  // content alpha, never the stroked foreground).
  let s_pos = xy - vec2<i32>(u.sil_origin);
  var sil_a = 0.0;
  if (s_pos.x >= 0 && s_pos.y >= 0
    && s_pos.x < i32(u.sil_dims.x) && s_pos.y < i32(u.sil_dims.y)) {
    sil_a = textureLoad(sil_tex, s_pos, 0).a;
  }

  // Band sample. The band temp is the padded grid: band coords = window
  // coords + pad. The inner shadow shifts the band sample by the offset so
  // the ring lands ON the offset's side (offset up -> the top edge
  // darkens); the glow shifts by zero. The pad covers blur reach + spread
  // but NOT the offset (which reaches 250 px), so a large offset samples
  // OUTSIDE the grid — and beyond the grid the inverted silhouette's
  // truthful value is 1.0, never 0. The OOB default MUST be 1.0: a 0.0
  // default cuts a hard rectangular no-shadow void into the layer once the
  // offset exceeds the pad (measured incident).
  let b_pos = xy + vec2<i32>(u.band_offset) + vec2<i32>(u.band_pad);
  var band_a = 1.0;
  if (b_pos.x >= 0 && b_pos.y >= 0
    && b_pos.x < i32(u.band_dims.x) && b_pos.y < i32(u.band_dims.y)) {
    band_a = textureLoad(band_tex, b_pos, 0).a;
  }
  // NOTE: the band is the RAW blurred inverted silhouette — NO x2/renorm
  // rescale. A rescale is exact only at offset = 0; with a non-zero offset
  // the wall already samples above 0.5 and clamping would flatten the whole
  // offset side into a hard plateau with a C0 kink (measured incident). The
  // reference-soft falloff comes from the SIGMA mapping instead: the inner
  // path blurs at sigma = 2 x blurRadius (EffectInnerEdgePass), i.e. the
  // numeric Size reads as twice-outer softness.
  // Compose: effect colour ON the content, clipped by the silhouette, moved
  // toward the blend result by strength · band · coverage. ALPHA untouched.
  let blended = apply_blend(c_rgb, u.effect_color.rgb, u.blend_mode);
  let weight = clamp(u.opacity, 0.0, 1.0) * clamp(band_a, 0.0, 1.0) * clamp(sil_a, 0.0, 1.0);
  let out_rgb = mix(c_rgb, blended, weight);
  textureStore(dst_tex, xy, vec4<f32>(out_rgb, c.a));
}
`;
}

/** Default-format invert source (stable string for structural guards). */
export const EFFECT_INNER_INVERT_WGSL = buildEffectInnerInvertWgsl('rgba16float');

/** Default-format compose source (stable string for structural guards). */
export const EFFECT_INNER_COMPOSE_WGSL = buildEffectInnerComposeWgsl('rgba16float');
