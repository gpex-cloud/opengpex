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
 * sdf.ts — Embedded WGSL for the analytic SDF vector render strategy
 * (vector spine, Layer B — the `SdfRenderer` strategy).
 *
 * A ZERO-TEXTURE procedural primitive: the pipeline binds only the SDF uniform
 * block (80 bytes, group 0 binding 0) — no sampler, no source/mask texture. The
 * vertex shader stretches the unit quad over the whole render target (the vector
 * source is drawn into its OWN transient, not into document space — the camera/quad
 * transform is a downstream `drawLayer` concern under architecture B), and the
 * fragment shader solves the primitive's signed distance in LOGICAL PIXEL space so
 * anti-aliasing stays isotropic under any aspect ratio.
 *
 * This shader knows ONLY engine-neutral geometry primitives (`prim` ids below); it
 * has no notion of any business model (marker/brush) — those are mapped to these
 * primitives in the scene-assembly layer (`markerToVectorSource`).
 *
 * ── ALPHA CONVENTION (load-bearing) ──
 * The whole composite chain samples STRAIGHT (un-premultiplied) alpha: `layer.wgsl`
 * premultiplies on OUTPUT and never sets `LAYER_FLAG_PREMULTIPLIED_SOURCE`, and
 * `AdjustPrePass` / `FilterPass` both store straight. So this shader also emits
 * STRAIGHT alpha (`rgb` = un-premultiplied composited colour, `a` = coverage), and
 * `SdfRenderer` draws it with REPLACE blend over a cleared transient. The downstream
 * `drawLayer` then applies `layer.opacity` / blend / mask / adjust exactly as it
 * does for any raster — which is why NO `layer_opacity` term appears here.
 *
 * Colours arrive already in WORKING-gamut (Display-P3) linear light from the scene
 * source (`SdfShapeParams`) → the prepass entry is flagged
 * `sourceIsLinear/sourceIsWorkingGamut/sourceIntentApplied = true`, so the shader's
 * output is consumed without any further decode/convert/tone-map.
 *
 * Primitives: `shape_type == 0` rounded_rect, `1` ellipse (both drawn as an outline
 * stroke over an optional interior fill), `2` arrow — a SOLID capsule-shaft +
 * triangle-head union painted entirely in the STROKE colour (the arrow is filled
 * with the stroke colour, so it has no interior/fill split; the fragment dispatches
 * this case separately from rounded_rect/ellipse).
 *
 * NOTE: the WGSL struct is still named `MarkerUniforms` and the uniform var `marker`
 * for a byte-for-byte behaviour-preserving refactor — these are shader-internal
 * identifiers, not part of the business coupling the vector spine removes.
 *
 * @module core/gpu/shaders/sdf
 */

import { SDF_PRIMITIVES_WGSL } from './sdfPrimitives';

export const SDF_WGSL = /* wgsl */ `
struct MarkerUniforms {
  // offset 0 (16 bytes)
  layer_size   : vec2<f32>,   // logical width, height
  shape_type   : u32,         // 0: rounded_rect, 1: ellipse, 2: arrow
  has_fill     : u32,         // 0: no fill, 1: fill

  // offset 16 (16 bytes)
  stroke_width : f32,         // logical px
  head_scale   : f32,         // arrow head length factor (arrow only)
  hard_edge    : u32,         // 0: smoothstep AA (default), 1: binary hard edge
  _pad1        : f32,

  // offset 32 (16 bytes) — stroke colour, working-gamut linear, straight alpha
  stroke_color : vec4<f32>,

  // offset 48 (16 bytes) — fill colour, working-gamut linear, alpha already × fill.opacity
  fill_color   : vec4<f32>,

  // offset 64 (16 bytes) — shape geometry:
  //   rounded_rect: [cornerRadius, 0, 0, 0]
  //   ellipse:      [0, 0, 0, 0]  (geometry implied by layer_size)
  //   arrow:        [tail.x, tail.y, head.x, head.y]
  shape_params : vec4<f32>,
};

@group(0) @binding(0) var<uniform> marker : MarkerUniforms;

struct VSInput {
  @location(0) pos : vec2<f32>,
  @location(1) uv  : vec2<f32>,
};

struct VSOut {
  @builtin(position) clip_pos : vec4<f32>,
  @location(0) local          : vec2<f32>,   // logical-pixel coordinate, origin top-left
};

@vertex
fn vs_main(in : VSInput) -> VSOut {
  var out : VSOut;
  // Unit quad (0..1) -> full-target NDC. uv.v = 0 is the TOP row (matches the quad
  // buffer), and local pixels grow downward like the layer's own coordinate frame.
  out.clip_pos = vec4<f32>(in.pos.x * 2.0 - 1.0, 1.0 - in.pos.y * 2.0, 0.0, 1.0);
  out.local = in.uv * marker.layer_size;
  return out;
}

// ── SDF operators (logical pixel space; d < 0 inside, d = 0 on the outline) ──
// sdf_rounded_rect / sdf_ellipse / sdf_segment are spliced in from the shared
// SDF_PRIMITIVES_WGSL fragment so the vmask paths reuse ONE definition.
${SDF_PRIMITIVES_WGSL}

// IQ's 2D isoceles-triangle SDF: apex at the origin, base at local.y = q.y, half
// width q.x. Negative inside, positive outside.
fn sdf_isoceles_triangle(p: vec2<f32>, q: vec2<f32>) -> f32 {
  let p2 = vec2<f32>(abs(p.x), p.y);
  let a = p2 - q * clamp(dot(p2, q) / dot(q, q), 0.0, 1.0);
  let b = p2 - q * vec2<f32>(clamp(p2.x / q.x, 0.0, 1.0), 1.0);
  let s = -sign(q.y);
  let d = min(
    vec2<f32>(dot(a, a), s * (p2.x * q.y - p2.y * q.x)),
    vec2<f32>(dot(b, b), s * (p2.y - q.y)),
  );
  return -sqrt(d.x) * sign(d.y);
}

// Arrow = solid capsule shaft (tail → shaft_end) ∪ triangle head (apex at head).
// tail/head are arbitrary layer-local endpoints (any direction, not axis-aligned);
// headLen = stroke_w * head_scale keeps ONE formula shared with the CPU raster path
// (paintMarker.ts::paintArrow). Returns the SOLID shape's signed distance.
fn sdf_arrow(p: vec2<f32>, tail: vec2<f32>, head: vec2<f32>, stroke_w: f32, head_scale: f32) -> f32 {
  let full_dir = head - tail;
  let full_len = max(length(full_dir), 1e-4);
  let dir = full_dir / full_len;                 // unit tail → head
  let normal = vec2<f32>(-dir.y, dir.x);

  let head_len = stroke_w * head_scale;
  let head_half_w = head_len * 0.5;
  let shaft_end = head - dir * head_len;         // triangle base centre = capsule end

  // Shaft capsule stops at the triangle base (does not run under the head) so the
  // union has no coverage discontinuity where the two solids meet.
  let d_shaft = sdf_segment(p, tail, shaft_end) - (stroke_w * 0.5);

  // Rotate p into the head's local frame: apex (local.y = 0) at head, base at head_len.
  let rel = p - head;
  let local = vec2<f32>(dot(rel, normal), -dot(rel, dir));
  let d_head = sdf_isoceles_triangle(local, vec2<f32>(head_half_w, head_len));

  return min(d_shaft, d_head);
}

// Signed distance to the shape OUTLINE for the active shape_type (rect/ellipse:
// d = 0 is the outer boundary, stroke grows inward). Arrow (2) returns the SOLID
// shape's distance and is composited separately in fs_main.
fn shape_distance(p: vec2<f32>) -> f32 {
  if (marker.shape_type == 0u) {
    let b = marker.layer_size * 0.5;
    let r = clamp(marker.shape_params.x, 0.0, min(b.x, b.y));
    return sdf_rounded_rect(p - b, b, r);
  }
  if (marker.shape_type == 1u) {
    let c = marker.layer_size * 0.5;
    return sdf_ellipse(p - c, c);
  }
  // arrow (2)
  return sdf_arrow(
    p,
    marker.shape_params.xy,
    marker.shape_params.zw,
    marker.stroke_width,
    marker.head_scale,
  );
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  let d = shape_distance(in.local);

  // Analytic AA width from the screen-space gradient. The gradient is the
  // same for d and d+stroke_width (pure translation), so one aa serves both.
  let aa = max(fwidth(d), 1e-6) * 0.5;

  // Arrow is a SOLID capsule+triangle, painted entirely in the stroke colour (the
  // CPU path fills the whole arrow with the stroke colour — no interior/fill split).
  if (marker.shape_type == 2u) {
    // Soft edge: analytic smoothstep AA. Hard edge: binary coverage at the
    // signed-distance zero crossing (single-pixel step, no fwidth smoothing).
    let cov = select(1.0 - smoothstep(-aa, aa, d),
                     select(0.0, 1.0, d <= 0.0),
                     marker.hard_edge == 1u);
    // STRAIGHT alpha: colour is the stroke RGB directly, alpha = coverage × stroke α.
    return vec4<f32>(marker.stroke_color.rgb, marker.stroke_color.a * cov);
  }

  // Rect / ellipse: a stroke RING (shape − interior) over an optional fill, where
  // the interior is the shape inset by stroke_width (d + stroke_width ≤ 0).
  var shape_cov = 1.0 - smoothstep(-aa, aa, d);
  var interior_cov = 1.0 - smoothstep(-aa, aa, d + marker.stroke_width);
  if (marker.hard_edge == 1u) {
    // Hard edge: both coverages collapse to binary tests at their zero crossings.
    shape_cov = select(0.0, 1.0, d <= 0.0);
    interior_cov = select(0.0, 1.0, d + marker.stroke_width <= 0.0);
  }
  let stroke_cov = clamp(shape_cov - interior_cov, 0.0, 1.0);
  let fill_cov = select(0.0, interior_cov, marker.has_fill == 1u);

  // Straight-alpha 'over': stroke above fill, in working-gamut linear light.
  let sa = marker.stroke_color.a * stroke_cov;
  let fa = marker.fill_color.a * fill_cov;
  let out_a = sa + fa * (1.0 - sa);

  var out_rgb = vec3<f32>(0.0);
  if (out_a > 1e-6) {
    out_rgb = (marker.stroke_color.rgb * sa
             + marker.fill_color.rgb * fa * (1.0 - sa)) / out_a;
  }

  // STRAIGHT alpha — downstream drawLayer premultiplies and applies layer.opacity.
  return vec4<f32>(out_rgb, out_a);
}
`;

/** Size of the SDF uniform block in bytes (80 bytes = 20 float/u32 slots). */
export const SDF_UNIFORM_BUFFER_SIZE = 80;
