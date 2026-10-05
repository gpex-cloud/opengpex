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
 * vmask.ts — GPU compute fill-pass for polygon vector masks.
 *
 * The analytic vmask sub-path (single rect/ellipse) is solved per-fragment in
 * `layer.ts`/`blend.ts`; THIS shader handles the OTHER sub-path — arbitrary
 * polygons (lasso / magic-wand / ≥2 stacked masks), which have no closed-form
 * SDF. Rather than open an empty render pass to rasterise geometry, we bake
 * coverage with a compute shader that writes straight into a resident/pooled
 * `rgba8unorm` texture (no primitives to draw, only a
 * per-pixel test"). The baked texture is then sampled by the HAS_VMASK_TEX
 * branch of `layer.ts`/`blend.ts` (`color.a *= vmask.a`).
 *
 * ── MULTI-MASK INTERSECTION (multiply coverage across combinedMasks) ──
 * ≥2 stacked vmasks are INTERSECTED (v1 `ctx.clip()` semantics — intersection, upstream
 * confirmed). Each mask keeps its OWN `feather` + `inverted`, so they cannot be
 * flattened into one ring set (a per-mask invert must bake before the product).
 * The shader therefore takes a SUBMASK TABLE: each entry is a `[edge_start,
 * edge_count)` slice into the shared edge buffer plus that mask's feather/flags
 * (bit0 = inverted, bit1 = antiAliased).
 * `coverage = Π_m cov_m` — one even-odd + nearest-edge solve per sub-mask, the
 * per-mask invert baked, then multiplied. A single sub-mask degrades to the
 * plain one-polygon case (product of one term).
 *
 * ── PER-PIXEL ALGORITHM per sub-mask ──
 *   a. Even-odd winding: cast a horizontal ray from the OFFSET sample point
 *      p_test = pixel-center + (1/64, 1/128) (CPU/GPU shared tie-break, see
 *      the rule document in polygon.ts) and count edge crossings within THIS
 *      sub-mask's slice (odd ⇒ inside). Independent oracle: the classic
 *      pnpoly test, so self-intersecting rings get true even-odd semantics.
 *   b. Nearest-edge distance: min `sdf_segment(p,a,b)` over that slice at the
 *      TRUE pixel center, signed by the winding result — a continuous SDF
 *      field for feathering/AA.
 *   Coverage mapping (in priority order):
 *   `feather > 0` ⇒ `1 - smoothstep(-feather, feather, d)` (soft band wins);
 *   `feather == 0` + AA flag ⇒ `clamp(0.5 - d, 0, 1)` — a 1-document-pixel
 *   sub-pixel coverage ramp (formula B), the standard Photoshop AA ON edge;
 *   `feather == 0` + AA clear ⇒ binary `inside ? 1 : 0` — the explicit hard,
 *   aliased edge (Photoshop AA OFF).
 *
 * ── FLAGS BAKED IN-PASS ──
 * Each sub-mask's `inverted` (flags bit0) is resolved HERE (`1 - cov_m`) BEFORE
 * the product, so the baked texel IS the final mask value; the sampling side
 * only does a linear multiply. (Analytic keeps invert/hard in `fs_main` because
 * it has no intermediate texture to bake into.) The AA flag (bit1) is likewise
 * per-sub-mask: a polygon mask mixed from an AA-off and an AA-on shape bakes
 * each half with its own edge quality before the coverage product.
 *
 * ── COORDINATE CONTRACT ──
 * Edges arrive flattened (every ring closed, last→first appended) in the SAME
 * space that `p_ring = (vec2<f32>(gid.xy) + 0.5) * px_scale` produces — the
 * orchestrator (`prepareVmaskSources.ts`) computes `px_scale` so the mask
 * texture's texel grid maps onto the ring coordinate space. The shader itself
 * is space-agnostic: it only consumes `px_scale` + flattened edges + the table.
 *
 * Output: `rgba8unorm`, `.a` = coverage, `.rgb` = 1 (8-bit is plenty for
 * a 0..1 coverage field and unifies with the existing bmask sampling pipeline;
 * `rgba8unorm` write-storage has the widest backend support).
 *
 * @module core/gpu/shaders/vmask
 */

import { SDF_PRIMITIVES_WGSL } from './sdfPrimitives';

/** Compute workgroup tile edge (WORKGROUP_SIZE × WORKGROUP_SIZE texels/group). */
export const VMASK_WORKGROUP_SIZE = 8;

/** Size of the VmaskUniforms block in bytes (32B = 8 u32/f32 slots). */
export const VMASK_UNIFORM_SIZE = 32;

/**
 * Size of one `SubMask` std430 record in bytes (16B = edge_start:u32,
 * edge_count:u32, feather:f32, flags:u32). The orchestrator packs
 * `submaskCount × VMASK_SUBMASK_SIZE` bytes into the submask storage buffer.
 */
export const VMASK_SUBMASK_SIZE = 16;

// SDF_PRIMITIVES_WGSL provides binding-free `sdf_segment` (shared with sdf.ts /
// layer.ts / blend.ts — one definition, no drift). WGSL has no imports, so it is
// spliced ahead of first use.
export const VMASK_WGSL = SDF_PRIMITIVES_WGSL + /* wgsl */ `
struct VmaskUniforms {
  dims       : vec2<u32>,   // offset 0  — mask texture size in texels (maskW, maskH)
  mask_count : u32,         // offset 8  — number of sub-masks in the submask table
  _pad0      : u32,         // offset 12
  px_scale   : vec2<f32>,   // offset 16 — texel (x+0.5, y+0.5) → ring-space coordinate
  _pad1      : vec2<f32>,   // offset 24 — pad to 32B
};

// One intersected sub-mask: a [edge_start, edge_start+edge_count) slice of the
// shared edge buffer, plus that mask's own feather / flags (baked per sub-mask
// before the product). std430: 16 bytes, tightly packed.
// flags bits: bit0 = inverted, bit1 = antiAliased (document-space sub-pixel AA).
struct SubMask {
  edge_start : u32,
  edge_count : u32,
  feather    : f32,
  flags      : u32,
};

// Flattened polygon edges: every ring closed (last vertex → first), all rings
// of all sub-masks concatenated. Each edge is (a.x, a.y, b.x, b.y) in ring space.
@group(0) @binding(0) var<uniform> u : VmaskUniforms;
@group(0) @binding(1) var<storage, read> edges : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> submasks : array<SubMask>;
@group(0) @binding(3) var out_tex : texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(${VMASK_WORKGROUP_SIZE}, ${VMASK_WORKGROUP_SIZE}, 1)
fn cs_main(@builtin(global_invocation_id) gid : vec3<u32>) {
  // Out-of-bounds guard: the dispatch is ceil(dims / workgroup), so the last
  // tiles overhang. Threads outside the texture must not store.
  if (gid.x >= u.dims.x || gid.y >= u.dims.y) {
    return;
  }

  let p = (vec2<f32>(f32(gid.x), f32(gid.y)) + vec2<f32>(0.5, 0.5)) * u.px_scale;

  // Even-odd SAMPLE point: pixel center nudged by (+1/64, +1/128) in ring
  // space — the CPU staircase's tie-break (polygon.ts shared rule document).
  // A nudge is required so CPU (f64) and GPU (f32) break exact ties (45°
  // integer-vertex edges of wand/DP output) identically; without it the two
  // sides disagree on individual boundary pixels. Used ONLY for the inside
  // test below — d_signed and the AA formula stay at the TRUE center p
  // (1-document-px coverage ramp is defined on the physical pixel center).
  let p_test = p + vec2<f32>(0.015625, 0.0078125); // (+1/64, +1/128) — exact in f32

  // Intersection of all sub-masks: coverage = Π cov_m. Start at 1.0 so a
  // single sub-mask degrades to its own coverage.
  var coverage = 1.0;
  for (var m = 0u; m < u.mask_count; m = m + 1u) {
    let sm = submasks[m];

    // (a) Even-odd winding via horizontal ray cast from p_test (independent
    //     oracle: pnpoly — same sample point as the CPU staircase).
    // (b) Nearest-edge unsigned distance at the TRUE center p, accumulated in
    //     the same loop — both restricted to THIS sub-mask's [start, end) edge slice.
    var inside = false;
    var min_dist = 1e30;
    let start = sm.edge_start;
    let end = sm.edge_start + sm.edge_count;
    for (var i = start; i < end; i = i + 1u) {
      let e = edges[i];
      let a = e.xy;
      let b = e.zw;
      // Ray-crossing test: does the edge straddle the horizontal line y = p_test.y?
      if ((a.y > p_test.y) != (b.y > p_test.y)) {
        let t = (p_test.y - a.y) / (b.y - a.y);
        let x_cross = a.x + t * (b.x - a.x);
        if (p_test.x < x_cross) {
          inside = !inside;
        }
      }
      min_dist = min(min_dist, sdf_segment(p, a, b));
    }

    // Signed field: negative inside, positive outside (matches SDF convention).
    let d_signed = select(min_dist, -min_dist, inside);

    var cov_m : f32;
    if (sm.feather > 0.0) {
      // Feather wins over the AA flag: the soft band is the requested effect.
      cov_m = 1.0 - smoothstep(-sm.feather, sm.feather, d_signed);
    } else if ((sm.flags & 2u) != 0u) {
      // AA ON (flag bit1): standard 1-document-pixel sub-pixel coverage from the
      // Euclidean distance field. UNIT CONTRACT: p = (texel + 0.5) * px_scale is
      // in RING SPACE (= layer-local document px), so d_signed is in DOCUMENT
      // PIXELS regardless of exportScale — the transition band is always 1
      // document px wide (~1 texel at 1×, ~2 texels at 2× export supersample).
      // Do NOT rewrite this in texel units. Formula B: linear ramp, exact on
      // horizontal/vertical edges (d is axis distance there), sampled at the
      // physical pixel centre. coverage ≥ 0.5 ⇔ d_signed ≤ 0 ⇔ the pixel centre
      // is inside — so thresholding this at 50% reproduces the AA-OFF mask.
      cov_m = clamp(0.5 - d_signed, 0.0, 1.0);
    } else {
      // AA OFF (flag bit1 clear): pure 1-bit binary hard edge — a jaggies-only
      // stair-stepped coverage, by explicit user choice (Photoshop AA off).
      cov_m = select(0.0, 1.0, inside);
    }

    // Per-sub-mask flags baked BEFORE the product: the texel IS final.
    // bit0 = inverted.
    if ((sm.flags & 1u) != 0u) {
      cov_m = 1.0 - cov_m;
    }

    coverage = coverage * cov_m;
  }

  textureStore(out_tex, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(1.0, 1.0, 1.0, coverage));
}
`;
