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

// Ellipse (approximate analytic SDF, IQ's gradient form): p centred, semi-axes r.
// Exact sign and zero-level (|p/r| == 1 ⇒ 0, < 1 inside, > 1 outside) and EXACT for
// a circle (r.x == r.y); the magnitude is a first-order estimate whose error grows
// with eccentricity — accepted after golden + visual review.
//
// The gradient form is ONLY used outside/near the outline (k0 >= 1). Inside it
// degenerates twice: at p == 0 the product k0*(k0-1) underflows to -0, so the
// centre evaluates as "exactly on the outline" and paints a phantom half-coverage
// stroke dot in the middle of every stroked ellipse; and across the centre band
// the 1e-4 clamp on k1 turns neighbouring texels' distances into a deep-negative
// cliff, whose screen-space derivative (fwidth) explodes the analytic AA width
// and smears spurious stroke coverage over the interior. Inside (k0 < 1) a
// shape-true linear ramp is used instead: it reads -min(r) at the centre, crosses
// 0 exactly at the outline, and stays monotone — the stroke/fill coverage math
// only zero-crosses near k0 == 1, where the approximation is already accurate.
fn sdf_ellipse(p: vec2<f32>, r: vec2<f32>) -> f32 {
  let k0 = length(p / r);
  let approx = k0 * (k0 - 1.0) / max(length(p / (r * r)), 1e-4);
  let interior = (k0 - 1.0) * min(r.x, r.y);
  return select(approx, interior, k0 < 1.0);
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
