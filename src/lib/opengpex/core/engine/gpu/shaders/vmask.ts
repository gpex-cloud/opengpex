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
 * edge_count)` slice into the shared edge buffer plus that mask's feather/invert.
 * `coverage = Π_m cov_m` — one even-odd + nearest-edge solve per sub-mask, the
 * per-mask invert baked, then multiplied. A single sub-mask degrades to the
 * plain one-polygon case (product of one term).
 *
 * ── PER-PIXEL ALGORITHM per sub-mask ──
 *   a. Even-odd winding: cast a horizontal ray from the texel and count edge
 *      crossings within THIS sub-mask's slice (odd ⇒ inside). Independent
 *      oracle: the classic pnpoly test, so self-intersecting rings get true
 *      even-odd semantics.
 *   b. Nearest-edge distance: min `sdf_segment(p,a,b)` over that slice, signed
 *      by the winding result — a continuous SDF field for feathering.
 *   `feather > 0` ⇒ `smoothstep(-feather, feather, d)`; `feather == 0` ⇒ the
 *   binary inside/outside coverage (hard edge, no AA).
 *
 * ── INVERT BAKED IN-PASS ──
 * Each sub-mask's `inverted` is resolved HERE (`1 - cov_m`) BEFORE the product,
 * so the baked texel IS the final mask value; the sampling side only does a
 * linear multiply. (Analytic keeps invert in `fs_main` because it has no
 * intermediate texture to bake into.) `hard` is NOT a polygon concept — a
 * non-feathered sub-mask (`feather == 0`) already yields a binary edge.
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
 * edge_count:u32, feather:f32, inverted:u32). The orchestrator packs
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
// shared edge buffer, plus that mask's own feather / invert (baked per sub-mask
// before the product). std430: 16 bytes, tightly packed.
struct SubMask {
  edge_start : u32,
  edge_count : u32,
  feather    : f32,
  inverted   : u32,
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

  // Intersection of all sub-masks: coverage = Π cov_m. Start at 1.0 so a
  // single sub-mask degrades to its own coverage.
  var coverage = 1.0;
  for (var m = 0u; m < u.mask_count; m = m + 1u) {
    let sm = submasks[m];

    // (a) Even-odd winding via horizontal ray cast (independent oracle: pnpoly).
    // (b) Nearest-edge unsigned distance, accumulated in the same loop — both
    //     restricted to THIS sub-mask's [start, end) edge slice.
    var inside = false;
    var min_dist = 1e30;
    let start = sm.edge_start;
    let end = sm.edge_start + sm.edge_count;
    for (var i = start; i < end; i = i + 1u) {
      let e = edges[i];
      let a = e.xy;
      let b = e.zw;
      // Ray-crossing test: does the edge straddle the horizontal line y = p.y?
      if ((a.y > p.y) != (b.y > p.y)) {
        let t = (p.y - a.y) / (b.y - a.y);
        let x_cross = a.x + t * (b.x - a.x);
        if (p.x < x_cross) {
          inside = !inside;
        }
      }
      min_dist = min(min_dist, sdf_segment(p, a, b));
    }

    // Signed field: negative inside, positive outside (matches SDF convention).
    let d_signed = select(min_dist, -min_dist, inside);

    var cov_m : f32;
    if (sm.feather > 0.0) {
      cov_m = 1.0 - smoothstep(-sm.feather, sm.feather, d_signed);
    } else {
      cov_m = select(0.0, 1.0, inside);
    }

    // Per-sub-mask invert baked BEFORE the product: the texel IS final.
    if (sm.inverted != 0u) {
      cov_m = 1.0 - cov_m;
    }

    coverage = coverage * cov_m;
  }

  textureStore(out_tex, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(1.0, 1.0, 1.0, coverage));
}
`;
