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
 * effectOverlayCompose.ts — Pointwise COLOR OVERLAY compose pass: blend the
 * overlay's solid colour into the content's own RGB by one of the 16 modes
 * (the shared `apply_blend` snippet from blendMath.ts), weighted by
 * `opacity · c.a`, leaving the content ALPHA untouched.
 *
 * EXECUTION POSITION (the iron rule the prepass encodes): the overlay is a
 * SURFACE effect and runs on the mask-baked content BEFORE any stroke. The
 * stroke compose flattens its ring into the content colour, so an overlay
 * that ran afterwards would dye the stroke pixels too — running first means
 * the stroke reads the overlay-coloured content while its ring stays clean.
 * Alpha preservation is what keeps the silhouette (and therefore the stroke
 * ring geometry) bit-identical to a no-overlay layer.
 *
 * GEOMETRY: the output is the EFFECT WINDOW (exactly the rect the caller
 * declares as `contentWindow` — the same window-aligned contract the stroke
 * compose output follows). The overlay itself has NO ROI expansion (it never
 * extends the silhouette), but the prepass's shared window carries the
 * stroke/shadow AA slack, and the declared window and the backing texture
 * MUST agree texel-for-texel or the compositor stretches the quad (the
 * overlay-only "slightly enlarged content" incident: a content-sized
 * overlay transient under a window-sized declaration). The window→content
 * read maps through a bit-exact i32 origin with explicit bounds guards
 * (backend textureLoad OOB clamping must never be relied on).
 *
 * BLEND DOMAIN: both operands are UN-PREMULTIPLIED working-LINEAR RGB — the
 * content is decoded here (srgb_to_linear + gamut_to_working per the flags),
 * and the overlay colour arrives already resolved by the scene translator.
 * The texture's RGB is straight (un-premultiplied) by the working-format
 * contract, so straight-space mixing composes correctly with the later
 * passes that consume the same texture.
 *
 * @module core/gpu/shaders/effectOverlayCompose
 */

import { COLORSPACE_WGSL } from './colorspace';
import { BLEND_MATH_WGSL } from './blendMath';
import type { LayerBlendMode } from '@opengpex/editor/core/types';
import { BLEND_MODE_MAP } from './blend';

/** Workgroup edge for the 2D-tiled dispatch (ceil(dim/8) per axis). */
export const EFFECT_OVERLAY_WORKGROUP = 8;

/** `flags` bit: the CURRENT texture already holds linear light (skip decode). */
export const EFFECT_OVERLAY_FLAG_CURRENT_LINEAR = 1 << 0;

/**
 * `EffectOverlayUniforms` size in bytes: dims vec2 (8) + flags (4) +
 * gamut_id (4) + current_dims vec2 (8) + current_origin vec2 (8, i32 texels) +
 * blend_mode (4) + align pad (8, the overlay_color vec4's 16-byte boundary) +
 * overlay_color vec4 (16) + opacity f32 + pad vec3 (12) = 80.
 */
export const EFFECT_OVERLAY_UNIFORM_BUFFER_SIZE = 80;

/** Number of 4-byte slots in `EffectOverlayUniforms`. */
export const EFFECT_OVERLAY_UNIFORM_FLOATS = EFFECT_OVERLAY_UNIFORM_BUFFER_SIZE / 4;

export function packEffectOverlayComposeUniform(
  width: number,
  height: number,
  opts: {
    /** Is the CURRENT texture already linear light (an earlier overlay or the adjust bake is; raw content may not be). */
    readonly currentIsLinear: boolean;
    /** Gamut id for the current texture (0 when already working gamut). */
    readonly gamutId: number;
    readonly currentWidth: number;
    readonly currentHeight: number;
    /**
     * Current texture's top-left inside the window, in CURRENT texels
     * (bit-exact i32; negative when the window extends past the content —
     * the strokeCompose two's-complement contract).
     */
    readonly currentOriginX: number;
    readonly currentOriginY: number;
    /** Working-LINEAR straight-alpha overlay colour (only .rgb is consumed). */
    readonly overlayColor: readonly [number, number, number, number];
    /** One of the 16 `LayerBlendMode` values (mapped through BLEND_MODE_MAP). */
    readonly blendMode: LayerBlendMode;
    /** Overlay strength 0..1. */
    readonly opacity: number;
  },
): Float32Array {
  const out = new Float32Array(EFFECT_OVERLAY_UNIFORM_FLOATS);
  const uints = new Uint32Array(out.buffer);
  uints[0] = Math.max(1, width) >>> 0;
  uints[1] = Math.max(1, height) >>> 0;
  uints[2] = opts.currentIsLinear ? EFFECT_OVERLAY_FLAG_CURRENT_LINEAR : 0;
  uints[3] = opts.gamutId >>> 0;
  uints[4] = Math.max(1, opts.currentWidth) >>> 0;
  uints[5] = Math.max(1, opts.currentHeight) >>> 0;
  // Current origin packs bit-exactly through the u32->i32 reinterpret (the
  // strokeCompose contract — never a u32->f32 value cast).
  uints[6] = Math.round(opts.currentOriginX) >>> 0;
  uints[7] = Math.round(opts.currentOriginY) >>> 0;
  uints[8] = (BLEND_MODE_MAP[opts.blendMode] ?? 0) >>> 0;
  // [9..11] alignment padding before the 16-byte-aligned overlay colour.
  out.set(
    [opts.overlayColor[0], opts.overlayColor[1], opts.overlayColor[2], opts.overlayColor[3]],
    12,
  );
  const opacity = Number.isFinite(opts.opacity) ? Math.min(1, Math.max(0, opts.opacity)) : 1;
  out[16] = opacity;
  // [17..19] padding.
  return out;
}

/**
 * WGSL for the overlay compose pass, keyed by the STORAGE format exactly like
 * the sibling effect compose shaders.
 *
 * Bindings (group 0):
 *   0 - EffectOverlayUniforms
 *   1 - current_tex : texture_2d<f32>  (mask-baked content, overlay target)
 *   2 - dst_tex     : texture_storage_2d<format, write>
 *
 * DISPATCH CONTRACT: a plain 2D grid, ceil(w/8) x ceil(h/8) workgroups.
 */
export function buildEffectOverlayComposeWgsl(format: 'rgba16float' | 'rgba32float'): string {
  // The blend math declares only pure functions (no bindings, no entry
  // points), so concatenating it ahead of the glue is collision-free.
  return COLORSPACE_WGSL + BLEND_MATH_WGSL + /* wgsl */ `
struct EffectOverlayUniforms {
  dims           : vec2<u32>,  // output window size in texels
  flags          : u32,        // bit0: current already linear
  gamut_id       : u32,        // gamut_to_working source id for the current
  current_dims   : vec2<u32>,  // current texture dims in texels
  current_origin : vec2<u32>,  // current top-left inside the window (i32 bits)
  blend_mode     : u32,        // apply_blend mode index (BLEND_MODE_MAP order)
  overlay_color  : vec4<f32>,  // working-LINEAR straight-alpha RGBA
  opacity        : f32,        // 0..1
};

@group(0) @binding(0) var<uniform> u : EffectOverlayUniforms;
@group(0) @binding(1) var current_tex : texture_2d<f32>;
@group(0) @binding(2) var dst_tex : texture_storage_2d<${format}, write>;

@compute @workgroup_size(${EFFECT_OVERLAY_WORKGROUP}, ${EFFECT_OVERLAY_WORKGROUP}, 1)
fn cs_effect_overlay_compose(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= u.dims.x || gid.y >= u.dims.y) {
    return;
  }
  let xy = vec2<i32>(gid.xy);

  // Map this window texel into the current texture. The origin is packed
  // bit-exactly and may be negative (window extends past the content rect).
  // The u32->i32 step MUST come first: a direct u32->f32 value conversion
  // would turn -2 into 4294967294.0 and push every content read out of
  // bounds (the strokeCompose negative-origin incident).
  let c_pos = xy - vec2<i32>(u.current_origin);

  // Explicit bounds guard: backend textureLoad OOB clamping must never be
  // relied on (the same discipline as every effect compose) — beyond the
  // content rect the truthful value is transparent zero, which the coverage
  // weighting then turns into a pass-through.
  var c = vec4<f32>(0.0);
  if (c_pos.x >= 0 && c_pos.y >= 0
    && c_pos.x < i32(u.current_dims.x) && c_pos.y < i32(u.current_dims.y)) {
    c = textureLoad(current_tex, c_pos, 0);
  }
  var c_rgb = c.rgb;
  if ((u.flags & ${EFFECT_OVERLAY_FLAG_CURRENT_LINEAR}u) == 0u) {
    c_rgb = srgb_to_linear(c_rgb);
  }
  c_rgb = gamut_to_working(c_rgb, u.gamut_id);

  // The blended colour, weighted by opacity times the per-texel content
  // coverage: covered pixels take the blend fully, soft edges scale with the
  // same alpha the mask bake produced, and fully transparent pixels keep
  // their (meaningless) RGB. The ALPHA channel is carried through untouched
  // — the overlay re-colours the surface, it never grows or thins it, which
  // is what keeps the stroke's silhouette bit-identical.
  let blended = apply_blend(c_rgb, u.overlay_color.rgb, u.blend_mode);
  let weight = clamp(u.opacity, 0.0, 1.0) * clamp(c.a, 0.0, 1.0);
  let out_rgb = mix(c_rgb, blended, weight);
  textureStore(dst_tex, xy, vec4<f32>(out_rgb, c.a));
}
`;
}

/** Default-format module source (stable string for pure-Node structural guards). */
export const EFFECT_OVERLAY_COMPOSE_WGSL = buildEffectOverlayComposeWgsl('rgba16float');
