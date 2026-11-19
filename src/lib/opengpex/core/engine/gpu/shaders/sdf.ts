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
 * primitives by the vector-source translators (translators/vector registry).
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
 * Primitives: `shape_type == 0` rounded_rect, `1` ellipse, `3` star, `4` callout
 * (all drawn as an outline stroke over an optional interior fill); `2` line-segment —
 * SOLID shape (capsule shaft, optional triangle heads at either end) painted
 * entirely in the STROKE colour (no interior/fill split; the fragment dispatches
 * the solid family separately from the outline family).
 *
 * @module core/gpu/shaders/sdf
 */

import { SDF_PRIMITIVES_WGSL } from './sdfPrimitives';

export const SDF_WGSL = /* wgsl */ `
struct SdfUniforms {
  // offset 0 (16 bytes)
  layer_size   : vec2<f32>,   // logical width, height
  shape_type   : u32,         // 0 rounded_rect, 1 ellipse, 2 line-segment, 3 star, 4 callout
  has_fill     : u32,         // 0: no fill, 1: fill

  // offset 16 (16 bytes)
  stroke_width : f32,         // logical px
  head_scale   : f32,         // line-segment head length factor (head length = stroke_width * head_scale)
  hard_edge    : u32,         // 0: smoothstep AA (default), 1: binary hard edge
  density      : f32,         // render-target texels per logical px (1 interactive; exportScale on supersampled export)

  // offset 32 (16 bytes) — stroke colour, working-gamut linear, straight alpha
  stroke_color : vec4<f32>,

  // offset 48 (16 bytes) — fill colour, working-gamut linear, alpha already × fill.opacity
  fill_color   : vec4<f32>,

  // offset 64 (32 bytes) — shape geometry, up to 8 scalars packed as two vec4
  // ([0] = scalars 0..3, [1] = scalars 4..7; unused tail is zero):
  //   rounded_rect: [cornerRadius]
  //   ellipse:      []  (geometry implied by layer_size)
  //   line-segment: [a.x, a.y, b.x, b.y, headA, headB] — head flags > 0.5 = head
  //                 at that end (length = stroke_width * head_scale)
  //   star:         [points, sharpness, rxScale, ryScale, cxDelta, cyDelta]
  //                 (scalars 2..5 = content-filling-ellipse multipliers /
  //                  fractional centre offsets; zero-packed legacy = the plain
  //                  inscribed ellipse — a real multiplier is always positive)
  //   callout:      [body.x, body.y, body.w, body.h, tip.x, tip.y, cornerRadius, tailHalfBase]
  shape_params : array<vec4<f32>, 2>,

  // offset 96 (16 bytes) — L2 analytic polygon solver control (sdfPolygonSolver).
  solver        : u32,   // 0: legacy SDF/smoothstep, 1: analytic polygon coverage
  outer_count   : u32,   // outer ring vertex count (≤ 32; 0 = no solver outline)
  inner_count   : u32,   // stroke-inset ring vertex count (0 = solid shape)
  poly_pad      : f32,

  // offset 112 (512 bytes) — solver rings: 32 outer slots then 32 inner slots,
  // packed TWO vertices per vec4 (uniform address space requires 16-byte array
  // strides), each vertex in layer-local logical px (zero-padded tail).
  poly_verts : array<vec4<f32>, 32>,
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

// Line segment = shaft between two arbitrary layer-local endpoints (any
// direction, not axis-aligned) ∪ an optional triangle head at EITHER end.
// head_a / head_b select the ends. The head length clamps to full_len / heads
// so the shaft — clipped back by head_len at EACH headed end — never inverts
// (an unclamped head length longer than the shaft crosses the clipped
// endpoints and the capsule resolves into a fat bowtie). The SAME clamp lives
// in the marker plugin's geometry (effectiveHeadLen) and the polygon solver,
// keeping preview / box / solver / render on one formula.
//
// At a LIVE headed end the shaft is cut FLUSH at the head's base plane and the
// triangle base half-width is floored at the shaft radius. Uncut, the
// capsule's own end cap bulges a round butt out of the triangle's back and,
// whenever the base is narrower than the shaft, pokes sideways past the base
// corners as a pair of round ears. The cut is the exact intersection of the
// capsule with the tip-side half-plane of the base plane (both convex, so max
// of the two fields), which turns the shaft end into the flat edge the solver
// outline and painted bounds already assume. The SAME floor and cut live in
// the marker plugin's vertex helper and the polygon solver's outline walk.
// A degenerate head length (head_scale 0, zero-width stroke) must not reach
// the triangle SDF — its collapsed q poisons the field — and is treated
// headless. Returns the SOLID shape's signed distance.
fn sdf_line_segment(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>, stroke_w: f32, head_scale: f32, head_a: bool, head_b: bool) -> f32 {
  let full_dir = b - a;
  let full_len = max(length(full_dir), 1e-4);
  let dir = full_dir / full_len;                 // unit a → b
  let normal = vec2<f32>(-dir.y, dir.x);

  let heads = select(0.0, 1.0, head_a) + select(0.0, 1.0, head_b);
  let head_len = min(stroke_w * head_scale, full_len / max(heads, 1.0));
  let live_a = head_a && head_len > 1e-3;
  let live_b = head_b && head_len > 1e-3;
  let head_half = max(head_len * 0.5, stroke_w * 0.5);
  let ha = select(vec2<f32>(0.0), dir * head_len, head_a);
  let hb = select(vec2<f32>(0.0), dir * head_len, head_b);
  let shaft_a = a + ha;
  let shaft_b = b - hb;

  // Shaft capsule between the (possibly clipped) ends; with heads the caps
  // hide inside the head triangles, with no heads it is the full round-cap
  // line.
  var d = sdf_segment(p, shaft_a, shaft_b) - (stroke_w * 0.5);

  // Flush base: keep only the shaft side of each live head's base plane
  // (dot(p − base, dir) ≤ 0 toward b for the b head; ≥ 0 toward a for the a
  // head), turning that end flat.
  if (live_b) {
    d = max(d, dot(p - shaft_b, dir));
  }
  if (live_a) {
    d = max(d, dot(shaft_a - p, dir));
  }

  // Head at b: apex (local.y = 0) at b, base head_len back along the shaft.
  if (live_b) {
    let rel = p - b;
    let local = vec2<f32>(dot(rel, normal), -dot(rel, dir));
    d = min(d, sdf_isoceles_triangle(local, vec2<f32>(head_half, head_len)));
  }
  // Head at a points the other way: mirror the frame along dir.
  if (live_a) {
    let rel = p - a;
    let local = vec2<f32>(dot(rel, normal), dot(rel, dir));
    d = min(d, sdf_isoceles_triangle(local, vec2<f32>(head_half, head_len)));
  }
  return d;
}

// IQ's regular radial-polygon SDF: n points, outer radius r, "sharpness" m in
// [2, n] (2 = regular n-gon, n = spikes thinning all the way to the centre; the
// inner vertex radius is r * (cos(pi/n) - sin(pi/n) / tan(pi/m))). p is centred
// on the shape; the first point is on +y. GLSL mod() is floor-mod, WGSL % is
// trunc-mod, hence the explicit floor form for the sector fold.
fn sdf_polygon(p_in: vec2<f32>, r: f32, n: f32, m: f32) -> f32 {
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

// ── L1 Analytic coverage solver: axis-aligned rectangle ∩ texel cell ──
//
// Computes the exact fractional area of [rx0, rx1] × [ry0, ry1] that overlaps
// the render target's texel cell centred on the fragment. The cell spans ONE
// TARGET TEXEL: at interactive density (1) that is the 1×1 logical-pixel cell
// [p−0.5, p+0.5]; on a supersampled export transient (density = exportScale)
// one texel covers 1/density logical px per side, so the cell half-extent is
// 0.5/density — the coverage stays a true area integral at EVERY density,
// which is the whole point of this solver.
//
// The intersection of two 1D intervals [a, b] and [c, d] has length
// max(0, min(b,d) - max(a,c)), so the 2D area is the product of the two 1D
// overlaps. All operands are exact f32 (no transcendental functions), so for
// integer-aligned geometry on integer pixel grids the result is an exact 0, 1,
// or a representable rational — no fwidth, no smoothstep, no knife-edge noise.
//
// 'p' is the logical-pixel coordinate of the texel centre (== in.local: the
// vertex shader maps the full-target quad through u.layer_size, so the
// rasteriser's texel centres land at logical ((i+0.5)/density, (j+0.5)/density)).
fn rect_cell_overlap(rx0: f32, ry0: f32, rx1: f32, ry1: f32, p: vec2<f32>) -> f32 {
  let cell = 0.5 / max(u.density, 1e-4);
  let ox = max(0.0, min(rx1, p.x + cell) - max(rx0, p.x - cell));
  let oy = max(0.0, min(ry1, p.y + cell) - max(ry0, p.y - cell));
  return ox * oy;
}

// Analytic stroke-ring coverage for an axis-aligned rectangle stroke ring.
// The ring = outer rect [0, w] × [0, h]  minus  inner rect inset by stroke_w.
// Returns coverage in [0, 1]; caller falls back to smoothstep when cornerRadius > 0.
fn rect_ring_coverage(p: vec2<f32>, w: f32, h: f32, stroke_w: f32) -> f32 {
  let outer = rect_cell_overlap(0.0, 0.0, w, h, p);
  let inner_x0 = stroke_w;
  let inner_y0 = stroke_w;
  let inner_x1 = w - stroke_w;
  let inner_y1 = h - stroke_w;
  // If stroke is so wide that the inner rect has non-positive area, the whole
  // outer rect is covered (solid fill through the ring).
  var inner = 0.0;
  if (inner_x1 > inner_x0 && inner_y1 > inner_y0) {
    inner = rect_cell_overlap(inner_x0, inner_y0, inner_x1, inner_y1, p);
  }
  return clamp(outer - inner, 0.0, 1.0);
}

// Analytic fill coverage for an axis-aligned rectangle: the WHOLE rect (the
// fill paints UNDER the stroke band — the SVG fill-then-stroke model; filling
// only the eroded interior would over-composite two complementary coverages
// along their shared edge and open a translucent seam with AA on).
  fn rect_fill_coverage(p: vec2<f32>, w: f32, h: f32, stroke_w: f32) -> f32 {
    return rect_cell_overlap(0.0, 0.0, w, h, p);
  }

// ── L2 Analytic polygon coverage solver (sdfPolygonSolver) ──────────────────
//
// The rings arrive as simple polygons in layer-local logical px (outer =
// rendered outline, inner = stroke-inset ring). Coverage = the exact area of
// (outer ∩ cell) − (inner ∩ cell): the subject polygon is clipped against the
// four texel-cell half-planes with Sutherland–Hodgman, and the clipped area is
// the shoelace sum of the result. SH on a CONCAVE subject with a convex window
// can emit degenerate "bridge" edges along the window border when the subject
// exits and re-enters — those bridges run collinearly in opposite directions
// and cancel pairwise in the signed shoelace sum, so the total stays the true
// intersection area (verified against a sub-sample oracle for U-shaped and
// star-shaped subjects). Like L1 this is a pure area integral: no fwidth, no
// smoothstep, no knife-edge noise, identical at every render density.

// Max vertices after one SH pass = ring verts + 1 per clip plane (worst case).
var<private> clip_a : array<vec2<f32>, 40>;
var<private> clip_b : array<vec2<f32>, 40>;

// The inner ring occupies the second half of the uniform vertex slots.
const POLY_INNER_START : u32 = 32u;

// Read one vertex from the two-per-vec4 packed uniform ring array.
fn poly_vert(i : u32) -> vec2<f32> {
  let packed = u.poly_verts[min(i / 2u, 31u)];
  return select(vec2<f32>(packed.zw), vec2<f32>(packed.xy), i % 2u == 0u);
}

// Load a ring from the uniform block into the scratch (bounds-clamped: OOB
// uniform reads must never be relied upon).
fn poly_load(start: u32, count: u32) -> u32 {
  let n = min(count, 32u);
  for (var i = 0u; i < n; i = i + 1u) {
    clip_a[i] = poly_vert(start + i);
  }
  return n;
}

// Clip polygon in clip_a (n vertices) against { p : dot(nrm, p) ≤ c }.
// Returns the new vertex count (result back in clip_a).
fn poly_clip(n_in : u32, nrm : vec2<f32>, c : f32) -> u32 {
  var m = 0u;
  for (var i = 0u; i < n_in; i = i + 1u) {
    let j = select(0u, i + 1u, i + 1u < n_in);
    let cur = clip_a[i];
    let nxt = clip_a[j];
    let dc = dot(nrm, cur) - c;
    let dn = dot(nrm, nxt) - c;
    if (dc <= 0.0) {
      clip_b[m] = cur;
      m = m + 1u;
    }
    if ((dc > 0.0 && dn < 0.0) || (dc < 0.0 && dn > 0.0)) {
      let t = dc / (dc - dn);
      clip_b[m] = vec2<f32>(cur.x + (nxt.x - cur.x) * t, cur.y + (nxt.y - cur.y) * t);
      m = m + 1u;
    }
  }
  for (var i = 0u; i < m; i = i + 1u) {
    clip_a[i] = clip_b[i];
  }
  return m;
}

// Shoelace area of the clipped polygon (orientation-independent via abs).
fn poly_area(n : u32) -> f32 {
  var s = 0.0;
  for (var i = 0u; i < n; i = i + 1u) {
    let j = select(0u, i + 1u, i + 1u < n);
    s += clip_a[i].x * clip_a[j].y - clip_a[j].x * clip_a[i].y;
  }
  return abs(s) * 0.5;
}

// Exact area of ring [start, count) ∩ texel cell centred at logical point p.
fn poly_cell_area(start : u32, count : u32, p : vec2<f32>) -> f32 {
  if (count == 0u) { return 0.0; }
  let h = 0.5 / max(u.density, 1e-4);
  var n = poly_load(start, count);
  n = poly_clip(n, vec2<f32>(1.0, 0.0), p.x + h);
  n = poly_clip(n, vec2<f32>(-1.0, 0.0), h - p.x);
  n = poly_clip(n, vec2<f32>(0.0, 1.0), p.y + h);
  n = poly_clip(n, vec2<f32>(0.0, -1.0), h - p.y);
  if (n < 3u) { return 0.0; }
  return poly_area(n);
}

// L2 analytic coverage for the solver rings (straight-alpha compose downstream).
fn solver_coverage(p : vec2<f32>, stroke_cov : ptr<function, f32>, fill_cov : ptr<function, f32>) {
  let outer_area = poly_cell_area(0u, u.outer_count, p);
  let inner_area = poly_cell_area(POLY_INNER_START, u.inner_count, p);
  // Fill paints the WHOLE shape interior UNDER the stroke band (the SVG
  // fill-then-stroke model). Compositing two COMPLEMENTARY coverages over
  // each other (band = outer − inner, fill = inner) loses cov·(1−cov) alpha
  // along their shared boundary — with AA on, a background-tinted seam opens
  // between the fill and the stroke. Filling the full shape and letting the
  // band paint over it is seam-free. The SOLID family (line-segment) has no
  // fill split: its fill region stays the (empty) inner ring.
  let fill_region = select(inner_area, outer_area, u.shape_type != 2u);
  if (u.hard_edge == 1u) {
    // Hard edge: binary output, but the IN/OUT decision is the texel's TRUE
    // analytic coverage thresholded at 0.5 — NOT a centre-sample crossing
    // test. A centre sample drops most texels of a ~1px band (diagonal edges
    // render as dotted lines, horizontal ones solid); the coverage threshold
    // keeps such bands continuous while still emitting pure 0/1 alpha (no
    // gray anti-aliasing). For axis-aligned edges the 0.5 threshold agrees
    // with the centre test, so crisp pixel-art edges keep their contract.
    let cov = clamp(outer_area - inner_area, 0.0, 1.0);
    *stroke_cov = select(0.0, 1.0, cov >= 0.5);
    *fill_cov = select(0.0, 1.0, u.has_fill == 1u && outer_area >= 0.5);
  } else {
    *stroke_cov = clamp(outer_area - inner_area, 0.0, 1.0);
    *fill_cov = select(0.0, fill_region, u.has_fill == 1u);
  }
}

// Signed distance to the shape OUTLINE for the outline family (rounded_rect /
// ellipse / star / callout: d = 0 is the outer boundary, stroke grows inward), or
// to the SOLID shape for the solid family (line-segment), which fs_main composites
// separately.
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
  if (u.shape_type == 2u) {
    // line-segment: head flags ride shape_params[1].xy (> 0.5 = head at that end).
    return sdf_line_segment(
      p,
      u.shape_params[0].xy,
      u.shape_params[0].zw,
      u.stroke_width,
      u.head_scale,
      u.shape_params[1].x > 0.5,
      u.shape_params[1].y > 0.5,
    );
  }
  if (u.shape_type == 3u) {
    // Inscribed in an ellipse expressed as multipliers / fractional centre
    // offsets on layer_size (shape_params scalars 2..5; zero-packed legacy
    // data = the plain inscribed ellipse 1, 1, 0, 0). The content-filling
    // ellipse scales the semi-axes and shifts the centre so the painted
    // shape's AABB equals the bounding box. Map the box onto a circle of
    // radius r_min = min(semi), solve there, and let the anisotropic mapping
    // stretch it back. Under a non-square aspect the stroke is thinner along
    // the stretched axis — the same approximation an anisotropically scaled
    // SVG makes.
    // Declared as var (not let) so the legacy zero guard below can normalize
    // them in place; a real multiplier is always positive, so 0 means the
    // zero-packed legacy form and must map back to the inscribed ellipse.
    var rx_scale = u.shape_params[0].z;
    var ry_scale = u.shape_params[0].w;
    if (rx_scale <= 0.0) { rx_scale = 1.0; }
    if (ry_scale <= 0.0) { ry_scale = 1.0; }
    let semi = vec2<f32>(u.layer_size.x * 0.5 * rx_scale, u.layer_size.y * 0.5 * ry_scale);
    let c = vec2<f32>(
      u.layer_size.x * (0.5 + u.shape_params[1].x),
      u.layer_size.y * (0.5 + u.shape_params[1].y),
    );
    let r_min = min(semi.x, semi.y);
    // Flip y so the first point faces UP on screen (local y grows downward).
    let q = vec2<f32>(
      (p.x - c.x) * r_min / semi.x,
      -(p.y - c.y) * r_min / semi.y,
    );
    let n = max(3.0, round(u.shape_params[0].x));
    let m = clamp(u.shape_params[0].y, 2.0, n);
    return sdf_polygon(q, r_min, n, m);
  }
  if (u.shape_type == 4u) {
    return sdf_callout(p, u.shape_params[0], u.shape_params[1].xy, u.shape_params[1].z, u.shape_params[1].w);
  }
  return 1e6;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  var stroke_cov: f32;
  var fill_cov: f32;

  // L2 analytic polygon solver: exact area-integral coverage from the
  // screen-front expanded rings (star / polygon / callout / line-segment — see
  // sdfPolygonSolver). Solid shapes carry no inner ring, so the shared compose
  // below degenerates to the stroke-only solid output.
  if (u.solver == 1u && u.outer_count >= 3u) {
    solver_coverage(in.local, &stroke_cov, &fill_cov);
    let sa = u.stroke_color.a * stroke_cov;
    let fa = u.fill_color.a * fill_cov;
    let out_a = sa + fa * (1.0 - sa);
    var out_rgb = vec3<f32>(0.0);
    if (out_a > 1e-6) {
      out_rgb = (u.stroke_color.rgb * sa
               + u.fill_color.rgb * fa * (1.0 - sa)) / out_a;
    }
    return vec4<f32>(out_rgb, out_a);
  }

  let d = shape_distance(in.local);

  // Analytic AA width from the screen-space gradient. The gradient is the
  // same for d and d+stroke_width (pure translation), so one aa serves both.
  let aa = max(fwidth(d), 1e-6) * 0.5;

  // Solid family (line-segment): capsule (+ optional heads) painted entirely in the
  // stroke colour — no interior/fill split.
  if (u.shape_type == 2u) {
    // Soft edge: analytic smoothstep AA. Hard edge: binary coverage at the
    // signed-distance zero crossing (single-pixel step, no fwidth smoothing).
    let cov = select(1.0 - smoothstep(-aa, aa, d),
                     select(0.0, 1.0, d <= 0.0),
                     u.hard_edge == 1u);
    // STRAIGHT alpha: colour is the stroke RGB directly, alpha = coverage × stroke α.
    return vec4<f32>(u.stroke_color.rgb, u.stroke_color.a * cov);
  }

  // Outline family (rounded_rect / ellipse / star / callout): a stroke RING
  // (shape − interior, the interior being the shape inset by stroke_width)
  // composited OVER an optional fill that paints the WHOLE shape (the SVG
  // fill-then-stroke model — see the fill_cov note below).
  //
  // L1 fast path: axis-aligned rect with zero corner radius uses the analytic
  // area-integral solver (rect_ring_coverage / rect_fill_coverage) instead of
  // smoothstep + fwidth. This eliminates the knife-edge noise that appears when
  // an edge falls exactly on a pixel grid boundary — the analytic solver returns
  // exact 0, 1, or a true fractional overlap, so there is no floating-point
  // phase dependence and the same geometry produces identical coverage at every
  // render density (viewport DPR vs. 1:1 export).
  //
  // Corner-radius > 0 falls through to the smoothstep path (the analytic solver
  // only handles straight edges; the rounded corners are handled by the SDF).
  // The threshold is 0.5px: sub-half-pixel radii are visually indistinct from
  // sharp corners and would still exhibit knife-edge noise on the straight sides,
  // so they are also routed to the analytic path.
  let corner_radius = u.shape_params[0].x;
  if (u.shape_type == 0u && corner_radius < 0.5) {
    if (u.hard_edge == 1u) {
      // Hard edge keeps its binary contract on the analytic path too: a texel
      // is fully in or fully out by its CENTRE (the same centre test the
      // smoothstep path makes via d <= 0 / d + stroke_width <= 0). No
      // fractional coverage leaks through — the AA-off toggle stays honest.
      let sw = u.stroke_width;
      let in_outer = in.local.x >= 0.0 && in.local.x <= u.layer_size.x
                  && in.local.y >= 0.0 && in.local.y <= u.layer_size.y;
      let in_inner = in.local.x >= sw && in.local.x <= u.layer_size.x - sw
                  && in.local.y >= sw && in.local.y <= u.layer_size.y - sw;
      stroke_cov = select(0.0, 1.0, in_outer && !in_inner);
      // Fill UNDER the band: the whole rect (the fill-then-stroke model —
      // filling only the inset interior over-composites two complementary
      // coverages along their shared edge and opens a translucent seam).
      fill_cov   = select(0.0, 1.0, u.has_fill == 1u && in_outer);
    } else {
      // Analytic rect ring coverage — no fwidth, no smoothstep, no knife-edge.
      stroke_cov = rect_ring_coverage(in.local, u.layer_size.x, u.layer_size.y, u.stroke_width);
      fill_cov   = select(0.0, rect_fill_coverage(in.local, u.layer_size.x, u.layer_size.y, u.stroke_width), u.has_fill == 1u);
    }
  } else {
    var shape_cov    = 1.0 - smoothstep(-aa, aa, d);
    var interior_cov = 1.0 - smoothstep(-aa, aa, d + u.stroke_width);
    if (u.hard_edge == 1u) {
      // Hard edge: both coverages collapse to binary tests at their zero crossings.
      shape_cov    = select(0.0, 1.0, d <= 0.0);
      interior_cov = select(0.0, 1.0, d + u.stroke_width <= 0.0);
    }
    stroke_cov = clamp(shape_cov - interior_cov, 0.0, 1.0);
    // Fill UNDER the band (the SVG fill-then-stroke model): the fill paints
    // the WHOLE shape and the band composites over it. Filling only the
    // eroded interior would over-composite two complementary coverages along
    // their shared boundary — with AA on, cov·(1−cov) alpha is lost there and
    // a background-tinted seam opens between the fill and the stroke.
    fill_cov   = select(0.0, shape_cov, u.has_fill == 1u);
  }

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

/** Size of the SDF uniform block in bytes (624 = 96 base + 16 solver control + 512 poly rings). */
export const SDF_UNIFORM_BUFFER_SIZE = 624;

/** Uniform vertex slots per solver ring (must match `SDF_POLY_MAX_VERTS`). */
export const SDF_POLY_UNIFORM_VERTS = 32;
/** Uniform slot index where the inner (stroke-inset) ring starts. */
export const SDF_POLY_INNER_START = 32;
