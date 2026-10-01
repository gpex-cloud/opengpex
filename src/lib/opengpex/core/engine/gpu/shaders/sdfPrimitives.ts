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
 * string, coupled to that shader's `MarkerUniforms @group(0) @binding(0)`. The
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

// Ellipse (approximate analytic SDF, IQ's gradient form): p centred, semi-axes r.
// Exact sign and zero-level (|p/r| == 1 ⇒ 0, < 1 inside, > 1 outside) and EXACT for
// a circle (r.x == r.y); the magnitude is a first-order estimate whose error grows
// with eccentricity — accepted per the plan, verified by golden + visual review.
fn sdf_ellipse(p: vec2<f32>, r: vec2<f32>) -> f32 {
  let k0 = length(p / r);
  let k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 1e-4);
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
