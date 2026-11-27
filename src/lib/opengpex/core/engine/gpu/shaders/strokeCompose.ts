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
 * strokeCompose.ts — Pointwise stroke RING + TINT + CONTENT compose pass (the
 * final dispatch of the stroke effect prepass, G1 dual-field EDT).
 *
 * Three inputs meet per texel:
 *   • `edt_tex`      — `rgba16uint` dual-field 1+JFA seed map (shaders/edtJfa),
 *     `.rg` = nearest foreground seed `(x,y)`, `.ba` = nearest background seed.
 *   • `content_tex`  — the layer's content (resident asset / filtered bake /
 *     vector transient), possibly SMALLER than the window and offset inside it
 *     (`content_origin`), possibly in a non-working domain.
 *   • `stroke_color` — working-gamut LINEAR straight-alpha RGBA, resolved by
 *     the scene translator (`toWorkingLinearRgba`), riding the uniform.
 *
 * Supports all three PS stroke positions (`outside` / `center` / `inside`) as
 * smooth 1px-AA threshold bands over the signed Euclidean distance `sd`.
 *
 * @module core/gpu/shaders/strokeCompose
 */

import { COLORSPACE_WGSL } from './colorspace';
import { EDT_SEED_INVALID } from './edtJfa';
import type { StrokePosition } from '@opengpex/editor/core/types/models';

/** Workgroup edge for the 2D-tiled dispatch (ceil(dim/8) per axis). */
export const STROKE_COMPOSE_WORKGROUP = 8;

/** `flags` bit: the CONTENT texture already holds linear light (skip decode). */
export const STROKE_COMPOSE_FLAG_CONTENT_LINEAR = 1 << 0;

/**
 * `flags` bit: STANDALONE output — emit ONLY the stroke ring as straight
 * alpha `(stroke_color.rgb, ring_a)` without folding the content colour in.
 * The backdrop-blend split (an `outside` / `center` stroke with a non-Normal
 * blend mode) runs the compose once per ring half into its OWN transient; the
 * composite then blends that transient against the canvas backdrop with the
 * stroke's blend mode, so the pass must not mix the content pixels in.
 * The ring alpha still subtracts the content coverage (`max(cov − a_c, 0)`):
 * an opaque content texel must never grow ring pixels, exactly like the flat
 * compose.
 */
export const STROKE_COMPOSE_FLAG_STANDALONE = 1 << 1;

/**
 * `flags` bit: BODY-INNER-ONLY output — suppress the OUTER ring entirely and
 * keep only the inner-band mix folding into the content. The split `center`
 * stroke runs TWO composes off one shared EDT: this body pass writes the
 * inner half-ring into the layer's own foreground (the historical
 * source-over content mix), while the standalone pass above writes the outer
 * half-ring for the backdrop blend. Without this bit the body pass would
 * duplicate the outer ring as a flat source-over band beneath the standalone
 * ring's blend result.
 */
export const STROKE_COMPOSE_FLAG_BODY_INNER_ONLY = 1 << 2;

/** Numeric encoding of `StrokePosition` in `StrokeComposeUniforms.stroke_position`. */
export const STROKE_POSITION_OUTSIDE = 0;
export const STROKE_POSITION_CENTER = 1;
export const STROKE_POSITION_INSIDE = 2;

export function encodeStrokePosition(pos: StrokePosition | undefined): number {
  if (pos === 'center') return STROKE_POSITION_CENTER;
  if (pos === 'inside') return STROKE_POSITION_INSIDE;
  return STROKE_POSITION_OUTSIDE;
}

/**
 * `StrokeComposeUniforms` size in bytes: dims vec2 (8) + flags (4) +
 * gamut_id (4) + content_dims vec2 (8) + content_origin vec2 (8) +
 * stroke_color vec4 (16) + densities 2x f32 (8) + pad (8) +
 * content_visible vec4 (16) = 80.
 */
export const STROKE_COMPOSE_UNIFORM_BUFFER_SIZE = 80;

/** Number of 4-byte slots in `StrokeComposeUniforms`. */
export const STROKE_COMPOSE_UNIFORM_FLOATS = STROKE_COMPOSE_UNIFORM_BUFFER_SIZE / 4;

/**
 * Pack `StrokeComposeUniforms`.
 *
 * Coordinates: `dims` is the output window in texels; `content_origin` is
 * where the content texture's top-left sits INSIDE the window, expressed in
 * CONTENT texels (bit-exact i32; it may be negative when the window extends
 * past the content rect); `content_density` / `window_density` are
 * texels-per-logical-px of the two spaces (1 for asset-space content; the
 * allocation density for a supersampled window). A window texel maps to
 * content space by (texel + 0.5) / windowDensity * contentDensity -
 * contentOrigin, floored (nearest-texel upsample; the window is never
 * DOWNSAMPLED relative to the content - both are allocation choices of this
 * prepass). `contentVisible` confines content reads to the layer's visible
 * sub-rect inside `content_tex` (transparent zero outside, so a cropped
 * logical fragment sharing a larger source asset does not read opaque neighbor
 * alpha in the ring band and eat the stroke). Out-of-window content reads are
 * guarded EXPLICITLY in the shader (transparent zero) - backend textureLoad
 * clamping must not be relied on.
 */
export function packStrokeComposeUniform(
  width: number,
  height: number,
  opts: {
    readonly contentIsLinear: boolean;
    readonly gamutId: number;
    readonly contentWidth: number;
    readonly contentHeight: number;
    readonly contentOriginX: number;
    readonly contentOriginY: number;
    /** Working-LINEAR straight-alpha stroke colour. */
    readonly strokeColor: readonly [number, number, number, number];
    readonly contentDensity: number;
    readonly windowDensity: number;
    /** Stroke width in window texels. */
    readonly strokeWidthTexels: number;
    /** Stroke placement relative to the alpha contour. */
    readonly strokePosition: StrokePosition;
    /** Visible sub-rect in content texels (defaults to full content texture). */
    readonly contentVisible?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
    /** Emit ONLY the outer ring as straight alpha (no content colour mix). */
    readonly standalone?: boolean;
    /** Suppress the outer ring (the split `center` stroke's body pass). */
    readonly bodyInnerOnly?: boolean;
  },
): Float32Array {
  const out = new Float32Array(STROKE_COMPOSE_UNIFORM_FLOATS);
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
  uints[2] = (opts.contentIsLinear ? STROKE_COMPOSE_FLAG_CONTENT_LINEAR : 0)
    | (opts.standalone ? STROKE_COMPOSE_FLAG_STANDALONE : 0)
    | (opts.bodyInnerOnly ? STROKE_COMPOSE_FLAG_BODY_INNER_ONLY : 0);
  uints[3] = opts.gamutId >>> 0;
  uints[4] = contentW >>> 0;
  uints[5] = contentH >>> 0;
  uints[6] = Math.round(opts.contentOriginX) >>> 0;
  uints[7] = Math.round(opts.contentOriginY) >>> 0;
  out.set(
    [opts.strokeColor[0], opts.strokeColor[1], opts.strokeColor[2], opts.strokeColor[3]],
    8,
  );
  out[12] = opts.contentDensity > 0 ? opts.contentDensity : 1;
  out[13] = opts.windowDensity > 0 ? opts.windowDensity : 1;
  out[14] = Number.isFinite(opts.strokeWidthTexels) && opts.strokeWidthTexels > 0 ? opts.strokeWidthTexels : 0;
  uints[15] = encodeStrokePosition(opts.strokePosition) >>> 0;
  // [16..19] content_visible (x, y, w, h).
  uints[16] = vx0 >>> 0;
  uints[17] = vy0 >>> 0;
  uints[18] = vw >>> 0;
  uints[19] = vh >>> 0;
  return out;
}

/**
 * WGSL for the stroke compose pass. Keyed by the STORAGE format (the working
 * format) exactly like the Gaussian's, because the storage declaration bakes
 * it.
 *
 * Bindings (group 0):
 *   0 - StrokeComposeUniforms
 *   1 - dilated_tex  : texture_2d<f32>  (rgba8unorm intermediate; read .a)
 *   2 - content_tex  : texture_2d<f32>  (content; read .a and normalized .rgb)
 *   3 - dst_tex      : texture_storage_2d<format, write>
 *
 * DISPATCH CONTRACT: a plain 2D grid, ceil(w/8) x ceil(h/8) workgroups.
 */
export function buildStrokeComposeWgsl(format: 'rgba16float' | 'rgba32float'): string {
  return COLORSPACE_WGSL + /* wgsl */ `
struct StrokeComposeUniforms {
  dims            : vec2<u32>,  // output window size in texels
  flags           : u32,        // bit0: content already linear
  gamut_id        : u32,        // gamut_to_working source id for the content
  content_dims    : vec2<u32>,  // content texture dims in texels
  content_origin  : vec2<u32>,  // content top-left inside the window (i32 bits)
  stroke_color    : vec4<f32>,  // working-LINEAR straight-alpha RGBA
  content_density : f32,        // content texels per logical px
  window_density  : f32,        // window texels per logical px
  stroke_width    : f32,        // stroke width in window texels
  stroke_position : u32,        // 0 = outside, 1 = center, 2 = inside
  content_visible : vec4<u32>,  // visible sub-rect (x, y, w, h) in content texels
};

@group(0) @binding(0) var<uniform> u : StrokeComposeUniforms;
@group(0) @binding(1) var edt_tex : texture_2d<u32>;
@group(0) @binding(2) var content_tex : texture_2d<f32>;
@group(0) @binding(3) var dst_tex : texture_storage_2d<${format}, write>;

fn seed_dist(p : vec2<f32>, s : vec2<u32>) -> f32 {
  if (s.x == ${EDT_SEED_INVALID}u) {
    return 1000000.0;
  }
  return length(p - vec2<f32>(s));
}

@compute @workgroup_size(${STROKE_COMPOSE_WORKGROUP}, ${STROKE_COMPOSE_WORKGROUP}, 1)
fn cs_stroke_compose(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= u.dims.x || gid.y >= u.dims.y) {
    return;
  }
  let xy = vec2<i32>(gid.xy);
  let seeds = textureLoad(edt_tex, xy, 0);

  // Map this window texel into the content texture. The origin is packed
  // bit-exactly and may be negative (window extends past the content rect).
  // ⚠️ The u32→i32 step MUST come first: same-width integer conversion
  // reinterprets the bits (two's complement), while a direct u32→f32 value
  // conversion would turn -2 into 4294967294.0 and push every content read
  // out of bounds (the ring would then flood the whole content rect — the
  // cropped-fragment bug).
  // ⚠️ EXPLICIT bounds guard - do NOT rely on out-of-bounds textureLoad
  // semantics: backends may CLAMP the coordinate to the edge instead of
  // returning transparent zero, which would repeat the content's edge texel
  // across the whole ring (opaque content would then flood the window). The
  // truthful value beyond the content rect is transparency.
  let c_pos = vec2<i32>(floor(
    (vec2<f32>(xy) + vec2<f32>(0.5)) / u.window_density * u.content_density
    - vec2<f32>(vec2<i32>(u.content_origin))
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
  var c_rgb = c.rgb;
  if ((u.flags & ${STROKE_COMPOSE_FLAG_CONTENT_LINEAR}u) == 0u) {
    c_rgb = srgb_to_linear(c_rgb);
  }
  c_rgb = gamut_to_working(c_rgb, u.gamut_id);

  let p = vec2<f32>(gid.xy);
  let d_out = seed_dist(p, seeds.xy);
  let d_in = seed_dist(p, seeds.zw);
  let sd = select(d_out - 0.5, -(d_in - 0.5), c.a >= 0.5);

  let w = max(u.stroke_width, 0.0);
  var outer_cov = 0.0;
  var inner_cov = 0.0;
  if (w > 0.0) {
    if (u.stroke_position == ${STROKE_POSITION_OUTSIDE}u) {
      outer_cov = 1.0 - smoothstep(w - 0.5, w + 0.5, sd);
    } else if (u.stroke_position == ${STROKE_POSITION_CENTER}u) {
      let hw = w * 0.5;
      outer_cov = 1.0 - smoothstep(hw - 0.5, hw + 0.5, sd);
      inner_cov = smoothstep(-hw - 0.5, -hw + 0.5, sd);
    } else {
      inner_cov = smoothstep(-w - 0.5, -w + 0.5, sd);
    }
  }

  // BODY-INNER-ONLY (the split center stroke's body pass): drop the outer
  // half-ring so the inner band folds into the content alone — the outer
  // half comes from the STANDALONE companion pass, which shares this same
  // EDT result (zero duplicate JFA work).
  if ((u.flags & ${STROKE_COMPOSE_FLAG_BODY_INNER_ONLY}u) != 0u) {
    outer_cov = 0.0;
  }

  let inside_mix = clamp(inner_cov, 0.0, 1.0) * u.stroke_color.a;
  let fg_rgb = mix(c_rgb, u.stroke_color.rgb, inside_mix);
  let fg_a = c.a;
  let outer_ring_a = max(outer_cov - fg_a, 0.0) * u.stroke_color.a;

  // STANDALONE output (backdrop-blend split): emit ONLY the outer ring as
  // straight alpha, skipping the content colour entirely. The zero-alpha
  // guard keeps fully transparent ring texels from leaking the tint colour
  // through unpremultiplied RGB. The composite downstream blends this
  // transient against the canvas backdrop with the stroke's blend mode.
  if ((u.flags & ${STROKE_COMPOSE_FLAG_STANDALONE}u) != 0u) {
    let alone_a = outer_ring_a;
    let alone_rgb = select(vec3<f32>(0.0), u.stroke_color.rgb, alone_a > 0.0001);
    textureStore(dst_tex, xy, vec4<f32>(alone_rgb, alone_a));
    return;
  }

  let out_a = fg_a + outer_ring_a * (1.0 - fg_a);
  var out_rgb = (fg_rgb * fg_a + u.stroke_color.rgb * outer_ring_a * (1.0 - fg_a)) / max(out_a, 0.0001);
  if (out_a <= 0.0001) {
    out_rgb = vec3<f32>(0.0);
  }
  textureStore(dst_tex, xy, vec4<f32>(out_rgb, out_a));
}
`;
}

/**
 * Default-format module source (stable string for the pure-Node structural
 * guards, mirroring FEATHER_COMBINE_WGSL).
 */
export const STROKE_COMPOSE_WGSL = buildStrokeComposeWgsl('rgba16float');
