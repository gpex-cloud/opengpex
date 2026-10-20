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
 * block (96 bytes, group 0 binding 0) — no sampler, no source/mask texture. The
 * vertex shader stretches the unit quad over the whole render target (the vector
 * source is drawn into its OWN transient, not into document space — the camera/quad
 * transform is a downstream `drawLayer` concern under architecture B), and the
 * fragment shader solves the primitive's signed distance in LOGICAL PIXEL space so
 * anti-aliasing stays isotropic under any aspect ratio.
 *
 * This shader knows ONLY engine-neutral geometry primitives (`prim` ids below); it
 * has no notion of any business model — business payloads are mapped to these
 * primitives by the vector-source translators (vectorSources.ts registry).
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
 * Colours arrive already in WORKING-gamut (ProPhoto RGB, `WORKING_GAMUT`) linear
 * light from the scene
 * source (`SdfShapeParams`) → the prepass entry is flagged
 * `sourceIsLinear/sourceIsWorkingGamut/sourceIntentApplied = true`, so the shader's
 * output is consumed without any further decode/convert/tone-map.
 *
 * Primitives: `shape_type == 0` rounded_rect, `1` ellipse, `5` star, `6` callout
 * (all drawn as an outline stroke over an optional interior fill); `2` arrow, `3`
 * line, `4` darrow — SOLID shapes (capsule shaft, optional triangle heads)
 * painted entirely in the STROKE colour (no interior/fill split; the fragment
 * dispatches the solid family separately from the outline family).
 *
 * @module core/gpu/shaders/sdf
 */

import { SDF_PRIMITIVES_WGSL } from './sdfPrimitives';

export const SDF_WGSL = /* wgsl */ `
struct SdfUniforms {
  // offset 0 (16 bytes)
  layer_size   : vec2<f32>,   // logical width, height
  shape_type   : u32,         // 0 rounded_rect, 1 ellipse, 2 arrow, 3 line, 4 darrow, 5 star, 6 callout
  has_fill     : u32,         // 0: no fill, 1: fill

  // offset 16 (16 bytes)
  stroke_width : f32,         // logical px
  head_scale   : f32,         // arrow head length factor (arrow / darrow only)
  hard_edge    : u32,         // 0: smoothstep AA (default), 1: binary hard edge
  _pad1        : f32,

  // offset 32 (16 bytes) — stroke colour, working-gamut linear, straight alpha
  stroke_color : vec4<f32>,

  // offset 48 (16 bytes) — fill colour, working-gamut linear, alpha already × fill.opacity
  fill_color   : vec4<f32>,

  // offset 64 (32 bytes) — shape geometry, up to 8 scalars packed as two vec4
  // ([0] = scalars 0..3, [1] = scalars 4..7; unused tail is zero):
  //   rounded_rect: [cornerRadius]
  //   ellipse:      []  (geometry implied by layer_size)
  //   arrow:        [tail.x, tail.y, head.x, head.y]
  //   line:         [a.x, a.y, b.x, b.y]
  //   darrow: [a.x, a.y, b.x, b.y]
  //   star:         [points, sharpness]
  //   callout:      [body.x, body.y, body.w, body.h, tip.x, tip.y, cornerRadius, tailHalfBase]
  shape_params : array<vec4<f32>, 2>,
};

@group(0) @binding(0) var<uniform> u : SdfUniforms;

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
  out.local = in.uv * u.layer_size;
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
// headLen = stroke_w * head_scale keeps ONE formula shared with the marker
// plugin's SVG drag preview (MarkerOverlay/marker/svg.ts). Returns the SOLID
// shape's signed distance.
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

// Line = solid capsule between two arbitrary layer-local endpoints (no heads).
fn sdf_line(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>, stroke_w: f32) -> f32 {
  return sdf_segment(p, a, b) - (stroke_w * 0.5);
}

// Double arrow = capsule shaft ∪ a triangle head at EACH end. Both heads use the
// same head_len = stroke_w * head_scale as the single arrow; the shaft is clipped
// back by head_len on both sides so neither union seam shows a coverage step.
fn sdf_darrow(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>, stroke_w: f32, head_scale: f32) -> f32 {
  let full_dir = b - a;
  let full_len = max(length(full_dir), 1e-4);
  let dir = full_dir / full_len;
  let normal = vec2<f32>(-dir.y, dir.x);

  let head_len = stroke_w * head_scale;
  let head_half_w = head_len * 0.5;
  let shaft_a = a + dir * head_len;
  let shaft_b = b - dir * head_len;
  let d_shaft = sdf_segment(p, shaft_a, shaft_b) - (stroke_w * 0.5);

  let rel_b = p - b;
  let local_b = vec2<f32>(dot(rel_b, normal), -dot(rel_b, dir));
  let d_head_b = sdf_isoceles_triangle(local_b, vec2<f32>(head_half_w, head_len));

  // Head at point a points the other way: mirror the frame along dir.
  let rel_a = p - a;
  let local_a = vec2<f32>(dot(rel_a, normal), dot(rel_a, dir));
  let d_head_a = sdf_isoceles_triangle(local_a, vec2<f32>(head_half_w, head_len));

  return min(d_shaft, min(d_head_a, d_head_b));
}

// IQ's regular star SDF: n points, outer radius r, "sharpness" m in [2, n] (2 =
// regular n-gon, n = spikes thinning all the way to the centre; the inner vertex
// radius is r * (cos(pi/n) - sin(pi/n) / tan(pi/m))). p is centred on the star; the first point
// is on +y. GLSL mod() is floor-mod, WGSL % is trunc-mod, hence the explicit
// floor form for the sector fold.
fn sdf_star(p_in: vec2<f32>, r: f32, n: f32, m: f32) -> f32 {
  let an = 3.141592653589793 / n;
  let en = 3.141592653589793 / m;
  let acs = vec2<f32>(cos(an), sin(an));
  let ecs = vec2<f32>(cos(en), sin(en));

  let ang = atan2(p_in.x, p_in.y);
  let period = 2.0 * an;
  let bn = (ang - period * floor(ang / period)) - an;
  var p = length(p_in) * vec2<f32>(cos(bn), abs(sin(bn)));
  p = p - r * acs;
  p = p + ecs * clamp(-dot(p, ecs), 0.0, r * acs.y / ecs.y);
  return length(p) * sign(p.x);
}

// IQ's exact 2D triangle SDF for an arbitrary triangle (p0, p1, p2), any winding.
fn sdf_triangle(p: vec2<f32>, p0: vec2<f32>, p1: vec2<f32>, p2: vec2<f32>) -> f32 {
  let e0 = p1 - p0;
  let e1 = p2 - p1;
  let e2 = p0 - p2;
  let v0 = p - p0;
  let v1 = p - p1;
  let v2 = p - p2;
  let pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  let pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  let pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  let s = sign(e0.x * e2.y - e0.y * e2.x);
  let d = min(
    min(
      vec2<f32>(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
      vec2<f32>(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x)),
    ),
    vec2<f32>(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)),
  );
  return -sqrt(d.x) * sign(d.y);
}

// Callout = rounded-rect body ∪ tail triangle. The tail's base lies ACROSS the
// body centre (centre ± perpendicular * half_base), so the part of the triangle
// inside the body is swallowed by the union and only the protruding wedge toward
// the tip shows — with the tip inside the body the whole triangle is hidden and
// the callout degrades gracefully to a plain rounded rect.
fn sdf_callout(p: vec2<f32>, body: vec4<f32>, tip: vec2<f32>, radius: f32, half_base: f32) -> f32 {
  let b = body.zw * 0.5;
  let c = body.xy + b;
  let r = clamp(radius, 0.0, min(b.x, b.y));
  let d_body = sdf_rounded_rect(p - c, b, r);

  let to_tip = tip - c;
  let len = max(length(to_tip), 1e-4);
  let dir = to_tip / len;
  let perp = vec2<f32>(-dir.y, dir.x) * half_base;
  let d_tail = sdf_triangle(p, tip, c + perp, c - perp);

  return min(d_body, d_tail);
}

// Signed distance to the shape OUTLINE for the outline family (rounded_rect /
// ellipse / star / callout: d = 0 is the outer boundary, stroke grows inward), or
// to the SOLID shape for the solid family (arrow / line / darrow), which
// fs_main composites separately.
fn shape_distance(p: vec2<f32>) -> f32 {
  if (u.shape_type == 0u) {
    let b = u.layer_size * 0.5;
    let r = clamp(u.shape_params[0].x, 0.0, min(b.x, b.y));
    return sdf_rounded_rect(p - b, b, r);
  }
  if (u.shape_type == 1u) {
    let c = u.layer_size * 0.5;
    return sdf_ellipse(p - c, c);
  }
  if (u.shape_type == 3u) {
    return sdf_line(p, u.shape_params[0].xy, u.shape_params[0].zw, u.stroke_width);
  }
  if (u.shape_type == 4u) {
    return sdf_darrow(p, u.shape_params[0].xy, u.shape_params[0].zw, u.stroke_width, u.head_scale);
  }
  if (u.shape_type == 5u) {
    // Inscribed in layer_size: map the (possibly non-square) box onto a circle of
    // radius r_min, solve the star there, and scale the distance back by the
    // smaller axis. Under a non-square aspect the stroke is thinner along the
    // stretched axis — the same approximation an anisotropically scaled SVG makes.
    let b = u.layer_size * 0.5;
    let r_min = min(b.x, b.y);
    // Flip y so the first point faces UP on screen (local y grows downward).
    let q = (p - b) * (r_min / b) * vec2<f32>(1.0, -1.0);
    let n = max(3.0, round(u.shape_params[0].x));
    let m = clamp(u.shape_params[0].y, 2.0, n);
    return sdf_star(q, r_min, n, m);
  }
  if (u.shape_type == 6u) {
    return sdf_callout(p, u.shape_params[0], u.shape_params[1].xy, u.shape_params[1].z, u.shape_params[1].w);
  }
  // arrow (2)
  return sdf_arrow(
    p,
    u.shape_params[0].xy,
    u.shape_params[0].zw,
    u.stroke_width,
    u.head_scale,
  );
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  let d = shape_distance(in.local);

  // Analytic AA width from the screen-space gradient. The gradient is the
  // same for d and d+stroke_width (pure translation), so one aa serves both.
  let aa = max(fwidth(d), 1e-6) * 0.5;

  // Solid family (arrow / line / darrow): capsule (+ heads) painted entirely
  // in the stroke colour — no interior/fill split.
  if (u.shape_type == 2u || u.shape_type == 3u || u.shape_type == 4u) {
    // Soft edge: analytic smoothstep AA. Hard edge: binary coverage at the
    // signed-distance zero crossing (single-pixel step, no fwidth smoothing).
    let cov = select(1.0 - smoothstep(-aa, aa, d),
                     select(0.0, 1.0, d <= 0.0),
                     u.hard_edge == 1u);
    // STRAIGHT alpha: colour is the stroke RGB directly, alpha = coverage × stroke α.
    return vec4<f32>(u.stroke_color.rgb, u.stroke_color.a * cov);
  }

  // Outline family (rounded_rect / ellipse / star / callout): a stroke RING
  // (shape − interior) over an optional fill, where the interior is the shape
  // inset by stroke_width (d + stroke_width ≤ 0).
  var shape_cov = 1.0 - smoothstep(-aa, aa, d);
  var interior_cov = 1.0 - smoothstep(-aa, aa, d + u.stroke_width);
  if (u.hard_edge == 1u) {
    // Hard edge: both coverages collapse to binary tests at their zero crossings.
    shape_cov = select(0.0, 1.0, d <= 0.0);
    interior_cov = select(0.0, 1.0, d + u.stroke_width <= 0.0);
  }
  let stroke_cov = clamp(shape_cov - interior_cov, 0.0, 1.0);
  let fill_cov = select(0.0, interior_cov, u.has_fill == 1u);

  // Straight-alpha 'over': stroke above fill, in working-gamut linear light.
  let sa = u.stroke_color.a * stroke_cov;
  let fa = u.fill_color.a * fill_cov;
  let out_a = sa + fa * (1.0 - sa);

  var out_rgb = vec3<f32>(0.0);
  if (out_a > 1e-6) {
    out_rgb = (u.stroke_color.rgb * sa
             + u.fill_color.rgb * fa * (1.0 - sa)) / out_a;
  }

  // STRAIGHT alpha — downstream drawLayer premultiplies and applies layer.opacity.
  return vec4<f32>(out_rgb, out_a);
}
`;

/** Size of the SDF uniform block in bytes (96 bytes = 24 float/u32 slots). */
export const SDF_UNIFORM_BUFFER_SIZE = 96;
