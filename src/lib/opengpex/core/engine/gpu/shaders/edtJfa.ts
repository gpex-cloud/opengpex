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
 * edtJfa.ts — Dual-field 1+JFA Euclidean Distance Transform compute shaders
 * (G1: replaces the octagonal chamfer dilation).
 *
 * One `rgba16uint` texture stores BOTH distance fields simultaneously:
 *   • `.rg` = nearest FOREGROUND (alpha >= 0.5) seed coordinate `(x, y)`
 *   • `.ba` = nearest BACKGROUND (alpha <  0.5) seed coordinate `(x, y)`
 *   • `0xFFFFu` = sentinel (no seed recorded)
 *
 * `cs_edt_seed` initializes the grid from the content texture's alpha (with
 * explicit texture-bounds and visible-rect guards so cropped shared-asset
 * fragments never seed from neighbor pixels). `cs_edt_jfa` runs the 1+JFA
 * ping-pong passes (`step0 = 2^floor(log2(maxDim - 1))` down to `1`, plus one
 * extra `step = 1` pass), producing an exact Euclidean dual-field seed map
 * independent of stroke width, color, or position.
 *
 * @module core/gpu/shaders/edtJfa
 */

/** 2D workgroup edge for seed and JFA passes (ceil(dim/8) per axis). */
export const EDT_WORKGROUP_SIZE = 8;

/** Sentinel coordinate component meaning "no seed" in `rgba16uint`. */
export const EDT_SEED_INVALID = 0xffff;

/** `EdtSeedUniforms` size in bytes (48B, 16-byte aligned). */
export const EDT_SEED_UNIFORM_BUFFER_SIZE = 48;
export const EDT_SEED_UNIFORM_FLOATS = EDT_SEED_UNIFORM_BUFFER_SIZE / 4;

/** `EdtJfaUniforms` size in bytes (16B). */
export const EDT_JFA_UNIFORM_BUFFER_SIZE = 16;
export const EDT_JFA_UNIFORM_FLOATS = EDT_JFA_UNIFORM_BUFFER_SIZE / 4;

/**
 * Compute the 1+JFA step sequence for a `(width, height)` grid:
 * largest power-of-2 `< max(width, height)` halved down to `1`, followed by
 * one additional `1`-step pass (`+1` polish).
 */
export function jfaStepSequence(width: number, height: number): number[] {
  const maxDim = Math.max(1, Math.floor(width), Math.floor(height));
  if (maxDim <= 1) return [1];
  const steps: number[] = [];
  let step = 1 << Math.floor(Math.log2(maxDim - 1));
  while (step >= 1) {
    steps.push(step);
    step >>= 1;
  }
  steps.push(1);
  return steps;
}

/** Pack `EdtSeedUniforms` (48B). */
export function packEdtSeedUniform(
  width: number,
  height: number,
  src: {
    readonly width: number;
    readonly height: number;
    readonly originX: number;
    readonly originY: number;
    readonly visibleRect?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  },
): Float32Array {
  const out = new Float32Array(EDT_SEED_UNIFORM_FLOATS);
  const uints = new Uint32Array(out.buffer);
  const vis = src.visibleRect;
  const vx0 = vis ? Math.floor(vis.x) : 0;
  const vy0 = vis ? Math.floor(vis.y) : 0;
  const vw = vis ? Math.max(0, Math.ceil(vis.x + vis.w) - vx0) : src.width;
  const vh = vis ? Math.max(0, Math.ceil(vis.y + vis.h) - vy0) : src.height;
  uints[0] = Math.max(1, width) >>> 0;
  uints[1] = Math.max(1, height) >>> 0;
  uints[2] = Math.max(1, src.width) >>> 0;
  uints[3] = Math.max(1, src.height) >>> 0;
  uints[4] = Math.round(src.originX) >>> 0;
  uints[5] = Math.round(src.originY) >>> 0;
  uints[6] = 0;
  uints[7] = 0;
  uints[8] = vx0 >>> 0;
  uints[9] = vy0 >>> 0;
  uints[10] = vw >>> 0;
  uints[11] = vh >>> 0;
  return out;
}

/** Pack `EdtJfaUniforms` (16B). */
export function packEdtJfaUniform(width: number, height: number, step: number): Float32Array {
  const out = new Float32Array(EDT_JFA_UNIFORM_FLOATS);
  const uints = new Uint32Array(out.buffer);
  uints[0] = Math.max(1, width) >>> 0;
  uints[1] = Math.max(1, height) >>> 0;
  uints[2] = Math.max(1, Math.floor(step)) >>> 0;
  uints[3] = 0;
  return out;
}

/** WGSL for `cs_edt_seed`: initialize foreground (.rg) and background (.ba) seeds. */
export function buildEdtSeedWgsl(): string {
  return /* wgsl */ `
struct EdtSeedUniforms {
  dims        : vec2<u32>,
  src_dims    : vec2<u32>,
  src_origin  : vec2<u32>,
  _pad        : vec2<u32>,
  src_visible : vec4<u32>,
};

@group(0) @binding(0) var<uniform> u : EdtSeedUniforms;
@group(0) @binding(1) var src_tex : texture_2d<f32>;
@group(0) @binding(2) var dst_tex : texture_storage_2d<rgba16uint, write>;

@compute @workgroup_size(${EDT_WORKGROUP_SIZE}, ${EDT_WORKGROUP_SIZE}, 1)
fn cs_edt_seed(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= u.dims.x || gid.y >= u.dims.y) {
    return;
  }
  let sc = vec2<i32>(gid.xy) + vec2<i32>(u.src_origin);
  var a = 0.0;
  if (sc.x >= 0 && sc.y >= 0 && sc.x < i32(u.src_dims.x) && sc.y < i32(u.src_dims.y)) {
    let vx0 = i32(u.src_visible.x);
    let vy0 = i32(u.src_visible.y);
    let vx1 = vx0 + i32(u.src_visible.z);
    let vy1 = vy0 + i32(u.src_visible.w);
    if (sc.x >= vx0 && sc.y >= vy0 && sc.x < vx1 && sc.y < vy1) {
      a = textureLoad(src_tex, sc, 0).a;
    }
  }
  let invalid = vec2<u32>(${EDT_SEED_INVALID}u, ${EDT_SEED_INVALID}u);
  let self_xy = vec2<u32>(gid.xy);
  let fg = select(invalid, self_xy, a >= 0.5);
  let bg = select(self_xy, invalid, a >= 0.5);
  textureStore(dst_tex, vec2<i32>(gid.xy), vec4<u32>(fg, bg));
}
`;
}

/** WGSL for `cs_edt_jfa`: one 3x3 jump-flooding step over both seed channels. */
export function buildEdtJfaWgsl(): string {
  return /* wgsl */ `
struct EdtJfaUniforms {
  dims : vec2<u32>,
  step : u32,
  _pad : u32,
};

@group(0) @binding(0) var<uniform> u : EdtJfaUniforms;
@group(0) @binding(1) var src_tex : texture_2d<u32>;
@group(0) @binding(2) var dst_tex : texture_storage_2d<rgba16uint, write>;

fn seed_dist2(p : vec2<i32>, s : vec2<u32>) -> u32 {
  if (s.x == ${EDT_SEED_INVALID}u) {
    return 0xFFFFFFFFu;
  }
  let dx = abs(p.x - i32(s.x));
  let dy = abs(p.y - i32(s.y));
  return u32(dx * dx + dy * dy);
}

@compute @workgroup_size(${EDT_WORKGROUP_SIZE}, ${EDT_WORKGROUP_SIZE}, 1)
fn cs_edt_jfa(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= u.dims.x || gid.y >= u.dims.y) {
    return;
  }
  let p = vec2<i32>(gid.xy);
  let cur = textureLoad(src_tex, p, 0);
  var best_fg = cur.xy;
  var best_bg = cur.zw;
  var best_fg_d2 = seed_dist2(p, best_fg);
  var best_bg_d2 = seed_dist2(p, best_bg);

  let step_i = i32(u.step);
  for (var dy = -1; dy <= 1; dy = dy + 1) {
    for (var dx = -1; dx <= 1; dx = dx + 1) {
      if (dx == 0 && dy == 0) {
        continue;
      }
      let np = p + vec2<i32>(dx * step_i, dy * step_i);
      if (np.x < 0 || np.y < 0 || np.x >= i32(u.dims.x) || np.y >= i32(u.dims.y)) {
        continue;
      }
      let cand = textureLoad(src_tex, np, 0);
      let fg_d2 = seed_dist2(p, cand.xy);
      if (fg_d2 < best_fg_d2) {
        best_fg_d2 = fg_d2;
        best_fg = cand.xy;
      }
      let bg_d2 = seed_dist2(p, cand.zw);
      if (bg_d2 < best_bg_d2) {
        best_bg_d2 = bg_d2;
        best_bg = cand.zw;
      }
    }
  }
  textureStore(dst_tex, p, vec4<u32>(best_fg, best_bg));
}
`;
}

export const EDT_SEED_WGSL = buildEdtSeedWgsl();
export const EDT_JFA_WGSL = buildEdtJfaWgsl();
