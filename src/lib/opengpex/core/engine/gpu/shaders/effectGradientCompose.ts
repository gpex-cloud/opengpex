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
 * effectGradientCompose.ts — Pointwise GRADIENT OVERLAY compose pass: sample
 * a two-stop ramp (linear or radial) at each content texel and blend the
 * ramp colour into the content RGB by one of the 16 modes (the shared
 * `apply_blend` snippet from blendMath.ts), weighted by
 * `opacity · rampAlpha · c.a`, leaving the content ALPHA untouched.
 *
 * EXECUTION POSITION (the iron rule the prepass encodes): the gradient is a
 * SURFACE effect in the same band as the color overlay and runs on the
 * mask-baked content BEFORE any stroke — and AFTER the color overlays, so
 * the intra-band order is color overlay beneath gradient overlay (the
 * reference product's Layer Style dialog order; each surface pass reads the
 * previous pass's result). The stroke then rings the fully surface-painted
 * content. Alpha preservation keeps the stroke silhouette bit-identical.
 *
 * GEOMETRY: the output is the EFFECT WINDOW (the batch-1 contract — the
 * declared contentWindow and the backing texture must agree texel-for-texel
 * or the composite quad stretches). The overlay itself adds NO ROI
 * expansion. The window→content read maps through a bit-exact i32 origin
 * with explicit transparent-zero bounds guards (backend textureLoad OOB
 * clamping must never be relied on).
 *
 * ⚠️ UV BASIS: the ramp's normalized coordinates are derived from the
 * VISIBLE CONTENT RECT (`content_visible`, the contentRectInTexture
 * contract), NEVER from the full texture dims — a shared-source crop
 * fragment or a layer with transparent padding would otherwise shift the
 * gradient's center and extent away from the visible pixels. The linear
 * ramp's extent is the visible rect's support projected onto the rotated
 * axis (the exact |hx·ax| + |hy·ay| bound), so the ramp spans corner to
 * corner of the VISIBLE rect at scale 100 regardless of orientation; the
 * radial ramp's radius is the visible rect's longer half-extent.
 *
 * RAMP CONVENTION: the LINEAR ramp is centred on the visible rect (t = 0.5
 * at the rect centre; start colour at the −axis extreme, end colour at the
 * +axis extreme), and the RADIAL ramp runs centre (t = 0) → the longer
 * half-extent (t = 1).
 *
 * ANGLE CONVENTION: `angle` arrives in RADIANS, measured in DISPLAY
 * orientation (y up) from +x counterclockwise; the shader negates the sine
 * because the texture space is y-down. Angle 0 = left→right, 90° =
 * bottom→top — the reference product's gradient dialog convention.
 *
 * BLEND DOMAIN: both operands are UN-PREMULTIPLIED working-LINEAR RGB; the
 * ramp colour is mixed in that domain like the content (the translator
 * resolved the stop colours and the compose multiplies the ramp's own
 * straight alpha into the weight, so partially transparent stops feather
 * the surface naturally).
 *
 * @module core/gpu/shaders/effectGradientCompose
 */

import { COLORSPACE_WGSL } from './colorspace';
import { BLEND_MATH_WGSL } from './blendMath';
import type { LayerBlendMode, GradientOverlayStyle } from '@opengpex/editor/core/types';
import { BLEND_MODE_MAP } from './blend';

/** Workgroup edge for the 2D-tiled dispatch (ceil(dim/8) per axis). */
export const EFFECT_GRADIENT_WORKGROUP = 8;

/** `flags` bit: the CURRENT texture already holds linear light (skip decode). */
export const EFFECT_GRADIENT_FLAG_CURRENT_LINEAR = 1 << 0;

/** Numeric encoding of `GradientOverlayStyle` in the uniform. */
export const GRADIENT_STYLE_LINEAR = 0;
export const GRADIENT_STYLE_RADIAL = 1;

export function encodeGradientStyle(style: GradientOverlayStyle | undefined): number {
  return style === 'radial' ? GRADIENT_STYLE_RADIAL : GRADIENT_STYLE_LINEAR;
}

/**
 * `EffectGradientUniforms` size in bytes: dims vec2 (8) + flags (4) +
 * gamut_id (4) + current_dims vec2 (8) + current_origin vec2 (8) +
 * content_visible vec4 (16) + blend_mode/style/angle/scale/opacity
 * 5x u32-or-f32 (20) + pad to the vec4 boundary (12) + start_color vec4
 * (16) + end_color vec4 (16) + tail pad (16) = 128.
 */
export const EFFECT_GRADIENT_UNIFORM_BUFFER_SIZE = 128;

/** Number of 4-byte slots in `EffectGradientUniforms`. */
export const EFFECT_GRADIENT_UNIFORM_FLOATS = EFFECT_GRADIENT_UNIFORM_BUFFER_SIZE / 4;

export function packEffectGradientComposeUniform(
  width: number,
  height: number,
  opts: {
    /** Is the CURRENT texture already linear light (an earlier surface pass or the adjust bake is). */
    readonly currentIsLinear: boolean;
    /** Gamut id for the current texture (0 when already working gamut). */
    readonly gamutId: number;
    readonly currentWidth: number;
    readonly currentHeight: number;
    /** Current texture's top-left inside the window, in CURRENT texels (bit-exact i32; may be negative). */
    readonly currentOriginX: number;
    readonly currentOriginY: number;
    /** Visible content rect in CURRENT-texture texels — the ramp's UV basis. */
    readonly contentVisible: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
    /** One of the 16 `LayerBlendMode` values (mapped through BLEND_MODE_MAP). */
    readonly blendMode: LayerBlendMode;
    readonly style: GradientOverlayStyle;
    /** Ramp axis angle in RADIANS, display orientation (y up). */
    readonly angleRad: number;
    /** Ramp extent percent of the visible rect (100 = exact fit). */
    readonly scale: number;
    /** Overlay strength 0..1. */
    readonly opacity: number;
    /** Working-LINEAR straight-alpha ramp START colour. */
    readonly startColor: readonly [number, number, number, number];
    /** Working-LINEAR straight-alpha ramp END colour. */
    readonly endColor: readonly [number, number, number, number];
  },
): Float32Array {
  const out = new Float32Array(EFFECT_GRADIENT_UNIFORM_FLOATS);
  const uints = new Uint32Array(out.buffer);
  uints[0] = Math.max(1, width) >>> 0;
  uints[1] = Math.max(1, height) >>> 0;
  uints[2] = opts.currentIsLinear ? EFFECT_GRADIENT_FLAG_CURRENT_LINEAR : 0;
  uints[3] = opts.gamutId >>> 0;
  uints[4] = Math.max(1, opts.currentWidth) >>> 0;
  uints[5] = Math.max(1, opts.currentHeight) >>> 0;
  // Current origin packs bit-exactly through the u32->i32 reinterpret (the
  // strokeCompose contract — never a u32->f32 value cast).
  uints[6] = Math.round(opts.currentOriginX) >>> 0;
  uints[7] = Math.round(opts.currentOriginY) >>> 0;
  // content_visible occupies slots 8..11 (bytes 32..47, the vec4's natural
  // 16-byte boundary).
  uints[8] = Math.max(0, Math.floor(opts.contentVisible.x)) >>> 0;
  uints[9] = Math.max(0, Math.floor(opts.contentVisible.y)) >>> 0;
  uints[10] = Math.max(0, Math.ceil(opts.contentVisible.w)) >>> 0;
  uints[11] = Math.max(0, Math.ceil(opts.contentVisible.h)) >>> 0;
  uints[12] = (BLEND_MODE_MAP[opts.blendMode] ?? 0) >>> 0;
  uints[13] = encodeGradientStyle(opts.style) >>> 0;
  const angle = Number.isFinite(opts.angleRad) ? opts.angleRad : 0;
  const scale = Number.isFinite(opts.scale) && opts.scale > 0 ? opts.scale : 100;
  out[14] = angle;
  out[15] = scale;
  out[16] = Number.isFinite(opts.opacity) ? Math.min(1, Math.max(0, opts.opacity)) : 1;
  // [17..19] alignment padding before the 16-byte-aligned stop colours.
  out.set([opts.startColor[0], opts.startColor[1], opts.startColor[2], opts.startColor[3]], 20);
  out.set([opts.endColor[0], opts.endColor[1], opts.endColor[2], opts.endColor[3]], 24);
  // [28..31] tail padding.
  return out;
}

/**
 * WGSL for the gradient compose pass, keyed by the STORAGE format exactly
 * like the sibling effect compose shaders.
 *
 * Bindings (group 0):
 *   0 - EffectGradientUniforms
 *   1 - current_tex : texture_2d<f32>  (mask-baked content, overlay target)
 *   2 - dst_tex     : texture_storage_2d<format, write>
 *
 * DISPATCH CONTRACT: a plain 2D grid, ceil(w/8) x ceil(h/8) workgroups.
 */
export function buildEffectGradientComposeWgsl(format: 'rgba16float' | 'rgba32float'): string {
  // The blend math declares only pure functions (no bindings, no entry
  // points), so concatenating it ahead of the glue is collision-free.
  return COLORSPACE_WGSL + BLEND_MATH_WGSL + /* wgsl */ `
struct EffectGradientUniforms {
  dims           : vec2<u32>,  // output window size in texels
  flags          : u32,        // bit0: current already linear
  gamut_id       : u32,        // gamut_to_working source id for the current
  current_dims   : vec2<u32>,  // current texture dims in texels
  current_origin : vec2<u32>,  // current top-left inside the window (i32 bits)
  content_visible: vec4<u32>,  // visible content rect (x, y, w, h) in current texels
  blend_mode     : u32,        // apply_blend mode index (BLEND_MODE_MAP order)
  style          : u32,        // 0 = linear, 1 = radial
  angle          : f32,        // ramp axis angle in radians (display orientation)
  scale          : f32,        // ramp extent percent (100 = visible rect fit)
  opacity        : f32,        // 0..1
  start_color    : vec4<f32>,  // working-LINEAR straight-alpha RGBA (t = 0)
  end_color      : vec4<f32>,  // working-LINEAR straight-alpha RGBA (t = 1)
};

@group(0) @binding(0) var<uniform> u : EffectGradientUniforms;
@group(0) @binding(1) var current_tex : texture_2d<f32>;
@group(0) @binding(2) var dst_tex : texture_storage_2d<${format}, write>;

@compute @workgroup_size(${EFFECT_GRADIENT_WORKGROUP}, ${EFFECT_GRADIENT_WORKGROUP}, 1)
fn cs_effect_gradient_compose(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= u.dims.x || gid.y >= u.dims.y) {
    return;
  }
  let xy = vec2<i32>(gid.xy);

  // Window -> content mapping. The origin is packed bit-exactly and may be
  // negative (window extends past the content rect); the u32->i32 step MUST
  // come first — a direct u32->f32 value conversion would turn -2 into
  // 4294967294.0 (the strokeCompose negative-origin incident).
  let c_pos = xy - vec2<i32>(u.current_origin);

  // Explicit bounds guard: backend textureLoad OOB clamping must never be
  // relied on — beyond the content rect the truthful value is transparent
  // zero, which the coverage weighting turns into a pass-through.
  var c = vec4<f32>(0.0);
  if (c_pos.x >= 0 && c_pos.y >= 0
    && c_pos.x < i32(u.current_dims.x) && c_pos.y < i32(u.current_dims.y)) {
    c = textureLoad(current_tex, c_pos, 0);
  }
  var c_rgb = c.rgb;
  if ((u.flags & ${EFFECT_GRADIENT_FLAG_CURRENT_LINEAR}u) == 0u) {
    c_rgb = srgb_to_linear(c_rgb);
  }
  c_rgb = gamut_to_working(c_rgb, u.gamut_id);

  // ── Ramp coordinate (UV basis = the VISIBLE content rect, never the full
  // texture dims — a shared-source crop fragment or transparent padding
  // would otherwise shift the gradient center/extent off the visible
  // pixels). Content pixels outside the visible rect still compose (they
  // hold the ramp's clamped end colour weighted by their own coverage), but
  // the RAMP GEOMETRY anchors on the visible rect.
  let half_w = f32(u.content_visible.z) * 0.5;
  let half_h = f32(u.content_visible.w) * 0.5;
  let center = vec2<f32>(
    f32(u.content_visible.x) + half_w,
    f32(u.content_visible.y) + half_h,
  );
  // Texel CENTER: c_pos is an integer texel coordinate, so +0.5 aligns the
  // sample point with the fractional rect centre (x + w*0.5) — without it
  // every ramp is offset by half a texel.
  let p = vec2<f32>(c_pos) + vec2<f32>(0.5) - center;
  // Display orientation (y up) into y-down texture space: negate the sine.
  let axis = vec2<f32>(cos(u.angle), -sin(u.angle));
  let scaleFactor = max(u.scale, 1.0) / 100.0;
  var t = 0.0;
  var ramp_a = 1.0;
  if (u.style == ${GRADIENT_STYLE_LINEAR}u) {
    // The visible rect's support projected onto the axis: |hx*ax| + |hy*ay|
    // is the exact half-extent of the rotated rect. The ramp is CENTRED on
    // the visible rect (the reference convention): t = 0.5 at the centre,
    // 0 at the −axis extreme, 1 at the +axis extreme — at scale 100 the
    // ramp spans corner to corner of the VISIBLE rect at any angle.
    let support = abs(half_w * axis.x) + abs(half_h * axis.y);
    t = 0.5 + dot(p, axis) / (2.0 * max(support * scaleFactor, 0.0001));
  } else {
    // Radial: distance from the visible-rect centre, normalized by the
    // longer half-extent (a circle scaled to the visible rect).
    let radius = max(half_w, half_h) * scaleFactor;
    t = length(p) / max(radius, 0.0001);
  }
  t = clamp(t, 0.0, 1.0);
  let ramp = mix(u.start_color.rgb, u.end_color.rgb, t);
  ramp_a = mix(u.start_color.a, u.end_color.a, t);

  // The blended colour, weighted by opacity · ramp alpha · content coverage
  // (the same surface contract as the color overlay). The ALPHA channel is
  // carried through untouched — the gradient re-colours the surface, it
  // never grows or thins it, which is what keeps the stroke's silhouette
  // bit-identical.
  let blended = apply_blend(c_rgb, ramp, u.blend_mode);
  let weight = clamp(u.opacity, 0.0, 1.0) * clamp(ramp_a, 0.0, 1.0) * clamp(c.a, 0.0, 1.0);
  let out_rgb = mix(c_rgb, blended, weight);
  textureStore(dst_tex, xy, vec4<f32>(out_rgb, c.a));
}
`;
}

/** Default-format module source (stable string for pure-Node structural guards). */
export const EFFECT_GRADIENT_COMPOSE_WGSL = buildEffectGradientComposeWgsl('rgba16float');
