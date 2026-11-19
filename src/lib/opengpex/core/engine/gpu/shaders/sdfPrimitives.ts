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
 * sdfPrimitives.ts — engine-neutral SDF building blocks shared across shaders
 * (GPU vmask primitives).
 *
 * These three pure functions used to live inline inside `sdf.ts`'s SDF_WGSL
 * string, coupled to that shader's `SdfUniforms @group(0) @binding(0)`. The
 * vmask paths (`layer.ts`/`blend.ts` analytic SDF, `vmask.ts` polygon fill) need
 * the SAME geometry maths, but importing `sdf.ts` wholesale would drag in a
 * conflicting binding. So the formulas are extracted here as a binding-free WGSL
 * FRAGMENT (no uniforms, no bindings — just function definitions) that every
 * consumer splices into its own module string. One definition, no drift.
 *
 * Coordinate convention: logical pixel space, `d < 0` inside, `d = 0` on outline.
 *
 * @module core/gpu/shaders/sdfPrimitives
 */

export const SDF_PRIMITIVES_WGSL = /* wgsl */ `
// ── Shared SDF operators (logical pixel space; d < 0 inside, d = 0 on outline) ──

// Rounded rectangle: p centred, half-extents b, corner radius r.
fn sdf_rounded_rect(p: vec2<f32>, b: vec2<f32>, r: f32) -> f32 {
  let q = abs(p) - b + vec2<f32>(r, r);
  return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

// Ellipse: EXACT Euclidean signed distance. p centred, semi-axes r (either
// order; normalized so a = the major semi-axis). The closest point on the
// outline is solved in closed form on the coordinate axes and with an
// unconditionally convergent bisection in the general quadrant; the sign comes
// from the exact ellipse inequality.
//
// Why exact: the stroke band is {d ≤ 0} − {d ≤ −sw}, so the band's inner
// contour is the −sw iso-surface. The previous first-order gradient form had an
// exact zero level but approximate magnitude — its interior iso-surfaces were
// uniformly SCALED ellipses, so a wide ellipse's band fattened over its flat
// ends by sw·(rx/ry − 1) and the inner contour visibly diverged from the
// outline's shape. The exact field makes every iso-surface a true
// constant-width offset of the outline at any stroke width and eccentricity,
// keeps |∇d| = 1 for the analytic AA, and removes the centre degeneration the
// gradient form needed a shape-true interior ramp for.
fn sdf_ellipse(p: vec2<f32>, r: vec2<f32>) -> f32 {
  let a = max(r.x, r.y);
  let b = min(r.x, r.y);
  let q = abs(p);
  // Degenerate: a collapsed semi-axis is a segment (the capsule distance).
  if (b < 1e-6) {
    return sdf_segment(q, vec2<f32>(0.0, 0.0), vec2<f32>(a, 0.0));
  }
  // Centre column (qx == 0): the closest point is the minor vertex.
  if (q.x < 1e-9) {
    return select(-(b - q.y), q.y - b, q.y >= b);
  }
  // Centre row (qy == 0): inside the evolute (|qx| ≤ (a²−b²)/a) the closest
  // point is the perpendicular foot with cos t = a·qx/(a²−b²) — the axis
  // endpoints sit on the field's medial-axis ridge there, and a wrong magnitude
  // on this row poisons the neighbouring texels' fwidth AA width (a
  // translucent stripe along the centre row); outside the evolute the major
  // vertex is the closest point.
  if (q.y < 1e-9) {
    let evolute = (a * a - b * b) / a;
    if (q.x >= evolute) {
      return select(-(a - q.x), q.x - a, q.x >= a);
    }
    let ct = (a * q.x) / (a * a - b * b);
    let footX = a * ct;
    let footY = b * sqrt(1.0 - ct * ct);
    return -length(vec2<f32>(q.x - footX, footY));
  }
  // General quadrant: the Lagrange multiplier λ of the closest-point problem
  // solves  F(λ) = a²·qx²/(a²+λ)² + b²·qy²/(b²+λ)² − 1  — strictly decreasing
  // on (−b², ∞), so the root is unique and bisection is unconditionally
  // convergent (no Newton branch flips). The closest point is
  // (a²·qx/(a²+λ), b²·qy/(b²+λ)); F < 0 inside gives the sign.
  let qx2 = q.x * q.x;
  let qy2 = q.y * q.y;
  var lo = -b * b;
  var hi = 2.0 * a * a + 1.0;
  var v1 = 0.0;
  var v2 = 0.0;
  for (var i = 0; i < 24; i++) {
    let lam = (lo + hi) * 0.5;
    v1 = a * a / (a * a + lam);
    v2 = b * b / (b * b + lam);
    let f = (v1 * v1 * qx2) / (a * a) + (v2 * v2 * qy2) / (b * b) - 1.0;
    if (f > 0.0) {
      lo = lam;
    } else {
      hi = lam;
    }
  }
  let closest = vec2<f32>(v1 * q.x, v2 * q.y);
  let dist = length(q - closest);
  // Exact zero set: |p/r| == 1 is the outline, < 1 inside.
  let inside = (q.x / a) * (q.x / a) + (q.y / b) * (q.y / b) < 1.0;
  return select(dist, -dist, inside);
}

// Unsigned distance from p to segment a→b (capsule building block). A capsule of
// radius w is then sdf_segment(p, a, b) - w.
fn sdf_segment(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
  return length(pa - ba * h);
}
`;
