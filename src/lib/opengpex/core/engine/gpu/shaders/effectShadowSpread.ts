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
 * effectShadowSpread.ts — Pointwise silhouette DILATION pass (the PS
 * "Spread" job for the drop shadow, A8 P5): threshold the signed Euclidean
 * distance field of the content silhouette at `+spread`, producing the
 * enlarged shadow silhouette that the separable Gaussian then softens. PS's
 * Spread has no negative range — the shadow is never eroded below the
 * content.
 *
 * WHY A DISTANCE FIELD THRESHOLD (not a morphological max-filter): the EDT
 * from `shaders/edtJfa` already encodes exact Euclidean distance to the
 * contour — dilation by r is just the band `sd < r`, the SAME closed-form the
 * stroke's `outside` mode uses, so the spread costs one pointwise pass and
 * inherits the EDT's precision (round dilated corners, no chamfer facets).
 * Only the ALPHA is meaningful downstream (the blur's tint discards colour),
 * so the pass copies the content RGB through with the new alpha.
 *
 * Sign contract mirrors `strokeCompose`: `sd` is NEGATIVE inside the content,
 * positive outside; the coverage band is a 1px smoothstep so the dilated edge
 * keeps the same AA width the stroke ring has.
 *
 * @module core/gpu/shaders/effectShadowSpread
 */

// NOTE: no COLORSPACE_WGSL here — the pass passes the content RGB through
// raw (only its ALPHA is meaningful downstream), so no colorspace functions
// are called and pulling the library in would bloat the module.
import { EDT_SEED_INVALID } from './edtJfa';

/** Workgroup edge for the 2D-tiled dispatch (ceil(dim/8) per axis). */
export const EFFECT_SHADOW_SPREAD_WORKGROUP = 8;

/**
 * `EffectShadowSpreadUniforms` size in bytes: dims vec2 (8) +
 * DILATION IS PER-SHAPE, NOT PER-RECT: the EDT seeds from the content's own
 * ALPHA (cs_edt_seed thresholds `a >= 0.5`; the visible rect is only a read
 * guard), so dilation grows every disconnected shape independently. Dense
 * content (a line of CJK glyphs) dilated far enough merges into a single
 * ROUNDED slab whose bounding-box corners stay circular — that is the honest
 * dilated union, not a rectangle fill; effectSpreadPerShape-golden.test.ts
 * pins both regimes.
 *
 * content_dims vec2 (8) + content_origin vec2 (8) + spread f32 (4) +
 * IMPLICIT 4-byte align pad (28..31; vec4 aligns to 16) +
 * content_visible vec4 (32..47) = 48.
 *
 * ⚠️ The packer MUST write content_visible at FLOAT SLOTS 8..11 (bytes
 * 32..47) and leave slot 7 (bytes 28..31) zero — slot 7 is struct padding,
 * not the rect's x. Writing the rect at slots 7..10 shifts every component
 * through the padding and the WGSL reads (vy0, vw, vh, 0): a visible height
 * of 0 clips the whole content read to transparent.
 */
export const EFFECT_SHADOW_SPREAD_UNIFORM_BUFFER_SIZE = 48;

/** Number of 4-byte slots in `EffectShadowSpreadUniforms`. */
export const EFFECT_SHADOW_SPREAD_UNIFORM_FLOATS = EFFECT_SHADOW_SPREAD_UNIFORM_BUFFER_SIZE / 4;

export function packEffectShadowSpreadUniform(
  width: number,
  height: number,
  opts: {
    readonly contentWidth: number;
    readonly contentHeight: number;
    /** Content top-left inside the window, in CONTENT texels (i32 bits, may be negative). */
    readonly contentOriginX: number;
    readonly contentOriginY: number;
    /** Spread in WINDOW texels (non-negative dilation). */
    readonly spreadTexels: number;
    /** Visible sub-rect in content texels (transparent zero outside). */
    readonly contentVisible?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  },
): Float32Array {
  const out = new Float32Array(EFFECT_SHADOW_SPREAD_UNIFORM_FLOATS);
  const uints = new Uint32Array(out.buffer);
  const contentW = Math.max(1, opts.contentWidth);
  const contentH = Math.max(1, opts.contentHeight);
  const vis = opts.contentVisible;
  const vx0 = vis ? Math.floor(vis.x) : 0;
  const vy0 = vis ? Math.floor(vis.y) : 0;
  const vw = vis ? Math.max(0, Math.ceil(vis.x + vis.w) - vx0) : contentW;
  const vh = vis ? Math.max(0, Math.ceil(vis.y + vis.h) - vy0) : contentH;
  uints[0] = Math.max(1, width) >>> 0;
  uints[1] = Math.max(1, height) >>> 0;
  uints[2] = contentW >>> 0;
  uints[3] = contentH >>> 0;
  uints[4] = Math.round(opts.contentOriginX) >>> 0;
  uints[5] = Math.round(opts.contentOriginY) >>> 0;
  const spread = Number.isFinite(opts.spreadTexels) ? opts.spreadTexels : 0;
  out[6] = spread > 0 ? spread : 0;
  // Slot 7 (bytes 28..31) is the vec4's implicit ALIGN PADDING — skip it.
  // content_visible lives at slots 8..11 (bytes 32..47), 16-aligned.
  uints[7] = 0;
  uints[8] = vx0 >>> 0;
  uints[9] = vy0 >>> 0;
  uints[10] = vw >>> 0;
  uints[11] = vh >>> 0;
  return out;
}

/**
 * WGSL for the spread pass, keyed by the STORAGE format exactly like the
 * other effect passes.
 *
 * Bindings (group 0):
 *   0 - EffectShadowSpreadUniforms
 *   1 - edt_tex      : texture_2d<u32>  (dual-field 1+JFA seed map)
 *   2 - content_tex  : texture_2d<f32>  (the silhouette source; RGB passes through)
 *   3 - dst_tex      : texture_storage_2d<format, write>
 *
 * DISPATCH CONTRACT: a plain 2D grid, ceil(w/8) x ceil(h/8) workgroups.
 */
export function buildEffectShadowSpreadWgsl(format: 'rgba16float' | 'rgba32float'): string {
  return /* wgsl */ `
struct EffectShadowSpreadUniforms {
  dims            : vec2<u32>,  // output window size in texels
  content_dims    : vec2<u32>,  // content texture dims in texels
  content_origin  : vec2<u32>,  // content top-left inside the window (i32 bits)
  spread          : f32,        // dilation in window texels (non-negative)
  content_visible : vec4<u32>,  // visible sub-rect (x, y, w, h) in content texels
};

@group(0) @binding(0) var<uniform> u : EffectShadowSpreadUniforms;
@group(0) @binding(1) var edt_tex : texture_2d<u32>;
@group(0) @binding(2) var content_tex : texture_2d<f32>;
@group(0) @binding(3) var dst_tex : texture_storage_2d<${format}, write>;

fn seed_dist(p : vec2<f32>, s : vec2<u32>) -> f32 {
  if (s.x == ${EDT_SEED_INVALID}u) {
    return 1000000.0;
  }
  return length(p - vec2<f32>(s));
}

@compute @workgroup_size(${EFFECT_SHADOW_SPREAD_WORKGROUP}, ${EFFECT_SHADOW_SPREAD_WORKGROUP}, 1)
fn cs_effect_shadow_spread(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= u.dims.x || gid.y >= u.dims.y) {
    return;
  }
  let xy = vec2<i32>(gid.xy);
  let seeds = textureLoad(edt_tex, xy, 0);

  // Content read FIRST (same explicit bounds + visible-rect guard as
  // strokeCompose; the u32→i32 origin reinterpret comes FIRST) so the
  // signed-distance side selection uses the CONTENT alpha, exactly like the
  // stroke compose — never a seed-map sentinel heuristic.
  let c_pos = vec2<i32>(floor(
    vec2<f32>(xy) + vec2<f32>(0.5) - vec2<f32>(vec2<i32>(u.content_origin))
  ));
  let vx0 = i32(u.content_visible.x);
  let vy0 = i32(u.content_visible.y);
  let vx1 = vx0 + i32(u.content_visible.z);
  let vy1 = vy0 + i32(u.content_visible.w);
  var c = vec4<f32>(0.0);
  if (c_pos.x >= 0 && c_pos.y >= 0
    && c_pos.x < i32(u.content_dims.x) && c_pos.y < i32(u.content_dims.y)
    && c_pos.x >= vx0 && c_pos.y >= vy0 && c_pos.x < vx1 && c_pos.y < vy1) {
    c = textureLoad(content_tex, c_pos, 0);
  }

  let p = vec2<f32>(gid.xy);
  let d_out = seed_dist(p, seeds.xy);
  let d_in = seed_dist(p, seeds.zw);
  // Same signed-distance contract as strokeCompose: negative inside.
  let sd = select(d_out - 0.5, -(d_in - 0.5), c.a >= 0.5);

  // Threshold band: the stroke OUTSIDE closed form with the spread as the
  // band radius (dilation only — spread is non-negative by contract).
  let cov = 1.0 - smoothstep(u.spread - 0.5, u.spread + 0.5, sd);

  // RGB passes through (the downstream blur's tint only consumes alpha; the
  // premultiply pipeline needs a finite colour to carry, and the content's
  // own colour is the truthful carrier in the kept region).
  textureStore(dst_tex, xy, vec4<f32>(c.rgb, clamp(cov, 0.0, 1.0)));
}
`;
}

/** Default-format module source (stable string for pure-Node structural guards). */
export const EFFECT_SHADOW_SPREAD_WGSL = buildEffectShadowSpreadWgsl('rgba16float');
