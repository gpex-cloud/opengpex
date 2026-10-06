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
 * bmaskCombine.ts — GPU compute combine pass for bitmap masks (eraser/restore).
 *
 * Replaces the retired bmask stack slots (`LAYER_FLAG_HAS_BMASK_STACK`,
 * bindings 5..7/6..8): instead of binding every enabled bmask record into the
 * layer/blend fragment shaders and multiplying there, ONE combined texture is
 * baked per layer BEFORE any composite render pass opens (same constraint and
 * same precedent as the polygon vmask fill-pass). The layer/blend shaders then
 * sample a single mask texture — the whole two-family semantics live HERE:
 *
 *   vis = max( Π_erase-family αᵢ , max_restore-family (1 − αⱼ) )
 *
 * With no `inverted` record (today's only production shape) the second term is
 * max(∅) = 0 and the formula collapses to the plain coverage product the
 * retired stack slots computed — pixel-identical behaviour.
 *
 * ── FAMILY + HARD SEMANTICS (per record, in evaluation order) ──
 *   • The HARD bit applies FIRST: `c = hard ? step(0.5, α) : α` — the record's
 *     own threshold, not the layer's.
 *   • erase family (`inverted: false`): the product term absorbs `c`.
 *   • restore family (`inverted: true`): the max term absorbs the inverted
 *     contribution. A HARD restore record thresholds the SAMPLE and inverts
 *     AFTER (`step(0.5, 1 − α)`): for 8-bit mask alphas this equals
 *     `1 − step(0.5, α)` except at the exact 0.5 tie, and keeps the same
 *     "threshold then family-op" reading order as the erase branch.
 *   • Both product and max are commutative/associative, so record ORDER carries
 *     no semantics (the first record only anchors the output dimensions).
 *
 * ── INCREMENTAL ACCUMULATION (why ping-pong) ──
 * WGSL has no runtime-sized texture arrays, so records are folded ONE PER
 * DISPATCH: each pass reads the running accumulator (`.r` = erase product,
 * `.g` = restore max) via `textureLoad`, folds the single bound record, and
 * writes the next accumulator — two ping-pong textures, with the FINAL pass
 * writing `max(product, max)` into the persistent output's red channel. Pass 0
 * starts from the identity pair (1, 0); a single-record layer degenerates to
 * one dispatch (first + final in one).
 *
 * ── COORDINATE CONTRACT ──
 * The output texel grid spans the FIRST record's texture dims (the anchor);
 * each record is read at the SAME normalized position (uv over the output
 * extent → texel in that record's own dims), reproducing the per-texture
 * normalization the retired shader slots got from `textureSample`. All records
 * are expected layer-bounds-sized, so this is identity in practice.
 *
 * ── CHANNEL CONTRACT (r8unorm record uploads) ──
 * Record textures upload as `r8unorm` (4× VRAM saving over `rgba8unorm` per
 * record): `WebGpuEngine.maskAlphaToRed` remaps each record's CPU-side ALPHA
 * coverage into R before the copy. `.r` is therefore the ONE bmask channel
 * convention on the GPU — this pass samples records via `.r` AND writes the
 * final coverage into the output's `.r`, so the identity fast path (which
 * binds a record texture directly) and the combined output sample
 * identically in the layer/blend shaders (`layer.ts` / `blend.ts`).
 *
 * Output: `rgba8unorm` storage (r8unorm has no storage variant), `.r` = vis,
 * `.gba` = 1 (unused by the samplers). The accumulator carries (product, max)
 * in `.r`/`.g` between passes.
 *
 * @module core/gpu/shaders/bmaskCombine
 */

/** Compute workgroup tile edge (WORKGROUP_SIZE × WORKGROUP_SIZE texels/group). */
export const BMASK_COMBINE_WORKGROUP_SIZE = 8;

/** Size of the BmaskCombineUniforms block in bytes (32B = 8 u32 slots). */
export const BMASK_COMBINE_UNIFORM_SIZE = 32;

/** Per-record/per-pass flag: the record's alpha is thresholded at 0.5 before the family op. */
export const BMASK_COMBINE_FLAG_HARD = 1 << 0;
/** Per-record flag: restore family — contributes `1 − α` into the max term (not the product). */
export const BMASK_COMBINE_FLAG_RESTORE = 1 << 1;
/** Per-pass flag: first fold — start from the identity accumulator, do not read `acc_tex`. */
export const BMASK_COMBINE_FLAG_FIRST = 1 << 2;
/** Per-pass flag: final fold — write `max(product, max)` into the output alpha. */
export const BMASK_COMBINE_FLAG_FINAL = 1 << 3;

export const BMASK_COMBINE_WGSL = /* wgsl */ `
struct BmaskCombineUniforms {
  out_dims : vec2<u32>,   // offset 0  — combined output texture size in texels
  rec_dims : vec2<u32>,   // offset 8  — THIS pass's record texture size in texels
  flags    : u32,         // offset 16 — bit0 HARD, bit1 RESTORE, bit2 FIRST, bit3 FINAL
  _pad0    : u32,         // offset 20 — scalar pads ONLY: a vec3<u32> member would
  _pad1    : u32,         // offset 24   claim 16-byte alignment in the uniform address
  _pad2    : u32,         // offset 28   space and inflate the struct to 48B (the 32B
};                         //             bind range / minBindingSize would fail validation).

@group(0) @binding(0) var<uniform> u : BmaskCombineUniforms;
@group(0) @binding(1) var record_tex : texture_2d<f32>;
// Running accumulator (previous fold's output). Unread when the FIRST flag is
// set — the bind group then binds the record texture here as an inert placeholder
// so the slot stays valid without a dedicated dummy texture.
@group(0) @binding(2) var acc_tex : texture_2d<f32>;
@group(0) @binding(3) var out_tex : texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(${BMASK_COMBINE_WORKGROUP_SIZE}, ${BMASK_COMBINE_WORKGROUP_SIZE}, 1)
fn cs_main(@builtin(global_invocation_id) gid : vec3<u32>) {
  // Out-of-bounds guard: the dispatch is ceil(dims / workgroup), so the last
  // tiles overhang. Threads outside the texture must not store.
  if (gid.x >= u.out_dims.x || gid.y >= u.out_dims.y) {
    return;
  }

  // Accumulator state: .x = erase-family coverage product, .y = restore-family max.
  // Identity pair (1, 0): max(1, 0) collapses to the product — a lone erase
  // record is its own coverage; a lone restore record stays neutral (max(1, ·)=1).
  var acc = vec2<f32>(1.0, 0.0);
  if ((u.flags & ${BMASK_COMBINE_FLAG_FIRST}u) == 0u) {
    let prev = textureLoad(acc_tex, vec2<i32>(gid.xy), 0);
    acc = prev.rg;
  }

  // Record sample at the same NORMALIZED position: uv over the output extent,
  // mapped into this record's own texel grid (each record texture's full extent
  // spans the same layer quad — the normalization the retired shader slots got
  // from textureSample). textureLoad — no sampler, no derivatives.
  // Record textures upload as r8unorm with the mask's alpha coverage remapped
  // into R (the ONE bmask channel convention — see WebGpuEngine's
  // maskAlphaToRed), so the coverage is read from the RED channel.
  let uv = (vec2<f32>(gid.xy) + vec2<f32>(0.5, 0.5)) / vec2<f32>(u.out_dims);
  let scaled = floor(uv * vec2<f32>(u.rec_dims));
  let coord = vec2<i32>(clamp(scaled, vec2<f32>(0.0), vec2<f32>(u.rec_dims) - vec2<f32>(1.0)));
  let a = textureLoad(record_tex, coord, 0).r;

  let hard    = (u.flags & ${BMASK_COMBINE_FLAG_HARD}u) != 0u;
  let restore = (u.flags & ${BMASK_COMBINE_FLAG_RESTORE}u) != 0u;

  // HARD bit FIRST (threshold the sampled alpha), family op second — the same
  // evaluation order the retired per-slot shader code used.
  if (restore) {
    // Restore family: 1 − α into the max term. A hard restore record thresholds
    // the sample and inverts AFTER: step(0.5, 1 − α) — a binary restore edge.
    let r = select(1.0 - a, step(0.5, 1.0 - a), hard);
    acc.y = max(acc.y, r);
  } else {
    // Erase family: coverage into the product ("erased in any record stays erased").
    let c = select(a, step(0.5, a), hard);
    acc.x = acc.x * c;
  }

  if ((u.flags & ${BMASK_COMBINE_FLAG_FINAL}u) != 0u) {
    // Two-family combine: the restore max can only RAISE visibility above the
    // erase product (max is the union of "kept by erase coverage" and
    // "restored by a restore record"). Coverage goes into the RED channel —
    // the ONE bmask channel convention — so the identity fast path (which
    // binds a record texture directly) and this combined output sample
    // identically.
    textureStore(out_tex, vec2<i32>(gid.xy), vec4<f32>(max(acc.x, acc.y), 1.0, 1.0, 1.0));
  } else {
    // Intermediate fold: carry (product, max) in .r/.g for the next pass.
    textureStore(out_tex, vec2<i32>(gid.xy), vec4<f32>(acc.x, acc.y, 0.0, 1.0));
  }
}
`;
