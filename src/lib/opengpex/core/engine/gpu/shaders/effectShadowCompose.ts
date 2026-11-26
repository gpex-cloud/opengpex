/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the GNU General Public License.
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
 * effectShadowCompose.ts — Pointwise DROP-SHADOW compose pass (A8 P5): tint
 * the blurred content silhouette with the shadow colour and composite it
 * BENEATH the accumulated foreground (content, and the stroke ring when a
 * stroke stage ran earlier — render order is shadow beneath stroke beneath
 * content).
 *
 * Two sampled inputs meet per texel:
 *   • `blurred_tex` — the window-sized separable-Gaussian output of the
 *     content silhouette (STRAIGHT alpha, working-LINEAR light, produced by
 *     FilterPass.gaussianBlur with premultiply-on-load / un-premultiply-on-
 *     store). Only its ALPHA is meaningful: the shadow is a flat tint, the
 *     blurred colour is discarded.
 *   • `current_tex` — the accumulated foreground in the SAME window space
 *     (raw content on the first stage, or the stroke pass's composed output).
 *     Sampled at the texel itself (NO offset — the foreground stays put; the
 *     shadow is what moves).
 *
 * The OFFSET is applied to the BLURRED read: window texel `p` samples the
 * blur at `p - offset`, i.e. the silhouette shifted by +offset lands under
 * `p` (positive y = down, canvas convention). Out-of-bounds reads — BOTH the
 * offset-shifted blur sample and the unshifted current sample — are guarded
 * EXPLICITLY to transparent zero; backend textureLoad clamping must never be
 * relied on (the strokeCompose ring-flood incident).
 *
 * @module core/gpu/shaders/effectShadowCompose
 */

import { COLORSPACE_WGSL } from './colorspace';

/** Workgroup edge for the 2D-tiled dispatch (ceil(dim/8) per axis). */
export const EFFECT_SHADOW_WORKGROUP = 8;

/** `flags` bit: the CURRENT texture already holds linear light (skip decode). */
export const EFFECT_SHADOW_FLAG_CURRENT_LINEAR = 1 << 0;

/**
 * `flags` bit: STANDALONE output — emit ONLY the shadow pixels as
 * straight-alpha (rgb, shadow_a) without sampling `current_tex` at all. The
 * backdrop-blend split (Drop Shadow / Outer Glow with a non-Normal blend
 * mode) runs the shadow pass once per external effect into its OWN transient;
 * the composite blends each effect transient against the canvas backdrop with
 * the effect's blend mode, so the pass must not fold the foreground in.
 * `current_tex` stays BOUND (the layout is fixed) but is never read.
 */
export const EFFECT_SHADOW_FLAG_STANDALONE = 1 << 1;

/**
 * `EffectShadowUniforms` size in bytes: dims vec2 (8) + flags (4) +
 * gamut_id (4) + current_dims vec2 (8) + current_origin vec2 (8) +
 * blurred_dims vec2 (8) + shadow_offset vec2 (8, i32 texels) +
 * shadow_color vec4 (16) + shadow_opacity f32 + pad vec3 (12) = 80.
 */
export const EFFECT_SHADOW_UNIFORM_BUFFER_SIZE = 80;

/** Number of 4-byte slots in `EffectShadowUniforms`. */
export const EFFECT_SHADOW_UNIFORM_FLOATS = EFFECT_SHADOW_UNIFORM_BUFFER_SIZE / 4;

export function packEffectShadowComposeUniform(
  width: number,
  height: number,
  opts: {
    /** Is the CURRENT texture already linear light (stroke output is; raw content may not be). */
    readonly currentIsLinear: boolean;
    /** Gamut id for the current texture (0 when already working gamut). */
    readonly gamutId: number;
    readonly currentWidth: number;
    readonly currentHeight: number;
    /** Current texture's top-left inside the window, in CURRENT texels (i32, may be negative). */
    readonly currentOriginX: number;
    readonly currentOriginY: number;
    readonly blurredWidth: number;
    readonly blurredHeight: number;
    /** Shadow offset in WINDOW texels (positive y = down). */
    readonly offsetX: number;
    readonly offsetY: number;
    /** Working-LINEAR straight-alpha shadow colour. */
    readonly shadowColor: readonly [number, number, number, number];
    /** Shadow opacity 0..1 (multiplies the tint alpha). */
    readonly opacity: number;
    /** Emit only the shadow pixels (no current sampling, no over mix). */
    readonly standalone?: boolean;
  },
): Float32Array {
  const out = new Float32Array(EFFECT_SHADOW_UNIFORM_FLOATS);
  const uints = new Uint32Array(out.buffer);
  uints[0] = Math.max(1, width) >>> 0;
  uints[1] = Math.max(1, height) >>> 0;
  uints[2] = (opts.currentIsLinear ? EFFECT_SHADOW_FLAG_CURRENT_LINEAR : 0)
    | (opts.standalone ? EFFECT_SHADOW_FLAG_STANDALONE : 0);
  uints[3] = opts.gamutId >>> 0;
  uints[4] = Math.max(1, opts.currentWidth) >>> 0;
  uints[5] = Math.max(1, opts.currentHeight) >>> 0;
  uints[6] = Math.round(opts.currentOriginX) >>> 0;
  uints[7] = Math.round(opts.currentOriginY) >>> 0;
  uints[8] = Math.max(1, opts.blurredWidth) >>> 0;
  uints[9] = Math.max(1, opts.blurredHeight) >>> 0;
  // Shadow offset packs bit-exactly through the u32→i32 reinterpret (the
  // strokeCompose two's-complement contract — never a u32→f32 value cast).
  uints[10] = Math.round(opts.offsetX) >>> 0;
  uints[11] = Math.round(opts.offsetY) >>> 0;
  out.set(
    [opts.shadowColor[0], opts.shadowColor[1], opts.shadowColor[2], opts.shadowColor[3]],
    12,
  );
  const opacity = Number.isFinite(opts.opacity) ? Math.min(1, Math.max(0, opts.opacity)) : 1;
  out[16] = opacity;
  // [17..19] padding.
  return out;
}

/**
 * WGSL for the shadow compose pass, keyed by the STORAGE format exactly like
 * the stroke compose's.
 *
 * Bindings (group 0):
 *   0 - EffectShadowUniforms
 *   1 - blurred_tex  : texture_2d<f32>  (window-sized blurred silhouette; read .a)
 *   2 - current_tex  : texture_2d<f32>  (accumulated foreground)
 *   3 - dst_tex      : texture_storage_2d<format, write>
 *
 * DISPATCH CONTRACT: a plain 2D grid, ceil(w/8) x ceil(h/8) workgroups.
 */
export function buildEffectShadowComposeWgsl(format: 'rgba16float' | 'rgba32float'): string {
  return COLORSPACE_WGSL + /* wgsl */ `
struct EffectShadowUniforms {
  dims           : vec2<u32>,  // output window size in texels
  flags          : u32,        // bit0: current already linear
  gamut_id       : u32,        // gamut_to_working source id for the current
  current_dims   : vec2<u32>,  // current texture dims in texels
  current_origin : vec2<u32>,  // current top-left inside the window (i32 bits)
  blurred_dims   : vec2<u32>,  // blurred texture dims in texels
  shadow_offset  : vec2<u32>,  // shadow offset in window texels (i32 bits)
  shadow_color   : vec4<f32>,  // working-LINEAR straight-alpha RGBA
  shadow_opacity : f32,        // 0..1
};

@group(0) @binding(0) var<uniform> u : EffectShadowUniforms;
@group(0) @binding(1) var blurred_tex : texture_2d<f32>;
@group(0) @binding(2) var current_tex : texture_2d<f32>;
@group(0) @binding(3) var dst_tex : texture_storage_2d<${format}, write>;

@compute @workgroup_size(${EFFECT_SHADOW_WORKGROUP}, ${EFFECT_SHADOW_WORKGROUP}, 1)
fn cs_effect_shadow_compose(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= u.dims.x || gid.y >= u.dims.y) {
    return;
  }
  let xy = vec2<i32>(gid.xy);

  // The shadow silhouette sampled at (p - offset): the silhouette shifted by
  // +offset is what shows under p. The offset packs bit-exactly; reinterpret
  // u32 bits as i32 FIRST (u32→f32 would turn -2 into 4294967294.0).
  let off = vec2<i32>(u.shadow_offset);
  let s_pos = xy - off;
  var s = vec4<f32>(0.0);
  if (s_pos.x >= 0 && s_pos.y >= 0
    && s_pos.x < i32(u.blurred_dims.x) && s_pos.y < i32(u.blurred_dims.y)) {
    s = textureLoad(blurred_tex, s_pos, 0);
  }
  // Flat tint: only the blurred ALPHA survives; the blurred colour is
  // discarded (a drop shadow is not a blurred copy of the content colour).
  let shadow_a = clamp(s.a, 0.0, 1.0) * u.shadow_color.a * u.shadow_opacity;
  let shadow_rgb = u.shadow_color.rgb;

  // STANDALONE output: skip the foreground entirely and emit the pure effect
  // pixels as straight-alpha. The zero-alpha guard keeps fully transparent
  // texels from leaking the tint colour through unpremultiplied RGB.
  if ((u.flags & ${EFFECT_SHADOW_FLAG_STANDALONE}u) != 0u) {
    let alone_rgb = select(vec3<f32>(0.0), shadow_rgb, shadow_a > 0.0001);
    textureStore(dst_tex, xy, vec4<f32>(alone_rgb, shadow_a));
    return;
  }

  // The accumulated foreground samples UNOFFSET at this texel. Same explicit
  // bounds guard + bit-exact origin as strokeCompose.
  let c_pos = vec2<i32>(floor(
    vec2<f32>(xy) + vec2<f32>(0.5) - vec2<f32>(vec2<i32>(u.current_origin))
  ));
  var c = vec4<f32>(0.0);
  if (c_pos.x >= 0 && c_pos.y >= 0
    && c_pos.x < i32(u.current_dims.x) && c_pos.y < i32(u.current_dims.y)) {
    c = textureLoad(current_tex, c_pos, 0);
  }
  var c_rgb = c.rgb;
  if ((u.flags & ${EFFECT_SHADOW_FLAG_CURRENT_LINEAR}u) == 0u) {
    c_rgb = srgb_to_linear(c_rgb);
  }
  c_rgb = gamut_to_working(c_rgb, u.gamut_id);

  // Foreground OVER shadow (shadow beneath): straight-alpha over.
  let out_a = clamp(c.a + shadow_a * (1.0 - c.a), 0.0, 1.0);
  var out_rgb = (c_rgb * c.a + shadow_rgb * shadow_a * (1.0 - c.a)) / max(out_a, 0.0001);
  if (out_a <= 0.0001) {
    out_rgb = vec3<f32>(0.0);
  }
  textureStore(dst_tex, xy, vec4<f32>(out_rgb, out_a));
}
`;
}

/** Default-format module source (stable string for pure-Node structural guards). */
export const EFFECT_SHADOW_COMPOSE_WGSL = buildEffectShadowComposeWgsl('rgba16float');
