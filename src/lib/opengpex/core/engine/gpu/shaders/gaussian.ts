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
 * gaussian.ts — Separable Gaussian blur COMPUTE shader + kernel maths
 * (separable-Gaussian blur).
 *
 * TWO PASSES, ONE ENTRY POINT: the blur is separable, so a 2D Gaussian is two
 * 1D passes (horizontal then vertical) sharing this single `cs_gaussian` kernel;
 * `axis` selects which. Cost is O(2r) taps per pixel instead of O(r²).
 *
 * TILING + HALO (shared memory tile with halo): each workgroup produces
 * `GAUSS_WORKGROUP_SIZE` consecutive output pixels along the filtered axis and
 * cooperatively loads that tile PLUS its `radius`-wide halo on both sides into
 * `var<workgroup>` shared memory. Every tap then reads shared memory instead of
 * re-fetching global texels, so each input texel is fetched once per workgroup
 * rather than up to (2r+1) times.
 *
 * ⚠️ COLOUR SPACE — LINEAR LIGHT
 * -------------------------------------------------------------
 * Blur runs in LINEAR LIGHT + PREMULTIPLIED alpha, and
 * delivers it: `gauss_load` decodes sRGB→linear (unless the source is already
 * linear, see `GAUSS_FLAG_SRC_LINEAR`) and only THEN premultiplies, so the whole
 * convolution accumulates physically-meaningful radiance. This is what removes
 * the halo artefacts a gamma-domain blur produces around high-contrast edges.
 *
 * ⚠️ ORDER IS LOAD-BEARING: decode MUST precede the premultiply. `encode(c)·a` and
 * `encode⁻¹(encode(c))·a` are different values; premultiplying in the gamma domain
 * is the classic dark-edge bug (v1's `filter2d.ts` manual TRC dance).
 *
 * ⚠️ DOWNSTREAM DOMAIN CONTRACT: the output stays LINEAR. When the input came from
 * `AdjustPrePass` (an rgba16float bake that is already linear), `FilterPass` sets
 * `GAUSS_FLAG_SRC_LINEAR` so this kernel does not decode a second time; the
 * composite/blend pass that consumes the result likewise sets
 * `LAYER_FLAG_SOURCE_LINEAR`. Every hand-off is explicit — no implicit assumption
 * about who converted what.
 *
 * ⚠️ ALPHA — PREMULTIPLY ACROSS THE CONVOLUTION (no edge darkening)
 * ----------------------------------------------------------------
 * Resident asset textures hold STRAIGHT (un-premultiplied) alpha:
 * `CompositePass.drawLayer` never sets `LAYER_FLAG_PREMULTIPLIED_SOURCE`, and
 * `layer.wgsl` premultiplies on output. Convolving straight RGB would let the
 * (meaningless) RGB of fully-transparent texels bleed into visible pixels — the
 * classic dark halo. So the kernel premultiplies on LOAD, accumulates in
 * premultiplied space, and un-premultiplies on the FINAL store:
 *   pass H → `GAUSS_FLAG_PREMULTIPLY_ON_LOAD`     (intermediate stays premultiplied)
 *   pass V → `GAUSS_FLAG_UNPREMULTIPLY_ON_STORE`  (output is STRAIGHT again)
 * The output alpha convention therefore MATCHES the input, leaving the downstream
 * composite/blend passes unchanged.
 *
 * SIGMA SEMANTICS (v1 continuity): `FilterDesc.gaussianBlur.radius` is the
 * Gaussian STANDARD DEVIATION σ in pixels — the same quantity v1 passed to
 * `boxBlurRGBAInPlace(…, radius)` (whose parameter is `sigma` internally) and the
 * same quantity CSS `filter: blur(Npx)` takes. Kernel half-width is `ceil(3σ)`
 * (≈99.7% of the Gaussian's mass).
 *
 * ⚠️ NOT v1-BOX-BLUR PARITY: v1 approximated the Gaussian with a 3-pass box blur
 * (Wells 1986). A true separable Gaussian is used, so v2 is deliberately a
 * quality UPGRADE and does NOT reproduce v1's box-approximation pixels. The golden
 * gate compares against an independent TRUE-Gaussian reference (≤1/255), not v1.
 *
 * @module core/gpu/shaders/gaussian
 */

import { COLORSPACE_WGSL } from './colorspace';

/** Output pixels produced per workgroup along the filtered axis. */
export const GAUSS_WORKGROUP_SIZE = 64;

/**
 * Largest kernel half-width supported. `adjustments.blur` is a 0–20 px σ slider
 * and half-width is `ceil(3σ)`, so 60 covers the whole UI range. Shared memory is
 * `(64 + 2·60) × vec4<f32>` = 2 944 B — far below the 16 KiB workgroup limit.
 */
export const GAUSS_MAX_RADIUS = 60;

/** Shared-memory tile length: the output tile plus a halo on both sides. */
export const GAUSS_TILE_LEN = GAUSS_WORKGROUP_SIZE + 2 * GAUSS_MAX_RADIUS;

/** `flags` bit: premultiply RGB by alpha when loading (first pass). */
export const GAUSS_FLAG_PREMULTIPLY_ON_LOAD = 1 << 0;
/** `flags` bit: un-premultiply RGB on store (final pass). */
export const GAUSS_FLAG_UNPREMULTIPLY_ON_STORE = 1 << 1;
/**
 * `flags` bit: the SOURCE texture already holds linear light, so `gauss_load` must
 * SKIP the sRGB→linear decode.
 *
 * Set for (a) the second (vertical) pass, whose input is this kernel's own linear
 * output, and (b) a first pass fed by `AdjustPrePass`'s rgba16float bake or by a
 * genuinely linear source asset. Clear for a first pass reading an sRGB-encoded
 * `rgba8unorm` asset — the common case.
 */
export const GAUSS_FLAG_SRC_LINEAR = 1 << 2;


/** `axis` value: filter along X (horizontal pass). */
export const GAUSS_AXIS_HORIZONTAL = 0;
/** `axis` value: filter along Y (vertical pass). */
export const GAUSS_AXIS_VERTICAL = 1;

/** vec4-packed weight slots (16 × vec4 = 64 f32 ≥ GAUSS_MAX_RADIUS + 1). */
export const GAUSS_WEIGHT_VEC4_COUNT = 16;

/**
 * `GaussianUniforms` size in bytes: `array<vec4<f32>, 16>` weights (256) +
 * `dims` vec2<u32> (8) + `radius` u32 (4) + `axis` u32 (4) + `flags` u32 (4) +
 * 12 B tail padding to a 16-B multiple = 288.
 */
export const GAUSS_UNIFORM_BUFFER_SIZE = 288;

/** Number of 4-byte slots in `GaussianUniforms`. */
export const GAUSS_UNIFORM_FLOATS = GAUSS_UNIFORM_BUFFER_SIZE / 4;

/**
 * Kernel half-width for a given σ: `ceil(3σ)` clamped to {@link GAUSS_MAX_RADIUS}.
 * σ ≤ 0 yields 0 (identity — no taps beyond the centre).
 */
export function gaussianKernelRadius(sigma: number): number {
  if (!Number.isFinite(sigma) || sigma <= 0) return 0;
  return Math.min(GAUSS_MAX_RADIUS, Math.ceil(3 * sigma));
}

/**
 * Normalised HALF-kernel for a given σ: `out[0]` is the centre weight and `out[i]`
 * the weight of BOTH taps at ±i, so the full kernel sums to 1
 * (`out[0] + 2·Σ_{i≥1} out[i] === 1`). Length = `gaussianKernelRadius(sigma) + 1`.
 *
 * The discrete Gaussian is sampled at integer offsets then normalised by the
 * ACTUAL (truncated) sum rather than the analytic `1/(σ√2π)`. That is what keeps
 * the kernel energy-preserving despite truncation at 3σ — a flat region keeps its
 * exact value instead of darkening or brightening.
 */
export function gaussianWeights(sigma: number): Float32Array {
  const r = gaussianKernelRadius(sigma);
  const out = new Float32Array(r + 1);
  if (r === 0) {
    out[0] = 1;
    return out;
  }
  const twoSigmaSq = 2 * sigma * sigma;
  let sum = 0;
  for (let i = 0; i <= r; i++) {
    const w = Math.exp(-(i * i) / twoSigmaSq);
    out[i] = w;
    // Centre tap counted once, every offset tap twice (±i).
    sum += i === 0 ? w : 2 * w;
  }
  for (let i = 0; i <= r; i++) out[i] /= sum;
  return out;
}

/**
 * Pack `GaussianUniforms` for one pass. Weights are written as 16 `vec4<f32>`
 * (WGSL uniform arrays stride 16 B per element), so half-kernel entry `i` lands
 * at float slot `i` — i.e. `weights[i/4][i%4]`, exactly how the shader indexes it.
 */
export function packGaussianUniform(
  sigma: number,
  width: number,
  height: number,
  axis: number,
  flags: number,
): Float32Array {
  const out = new Float32Array(GAUSS_UNIFORM_FLOATS);
  const uints = new Uint32Array(out.buffer);
  const weights = gaussianWeights(sigma);
  const radius = weights.length - 1;

  // [0..63] weights (16 × vec4<f32>), zero-filled beyond the half-kernel.
  out.set(weights.subarray(0, Math.min(weights.length, GAUSS_WEIGHT_VEC4_COUNT * 4)), 0);

  // [64..65] dims, [66] radius, [67] axis, [68] flags.
  uints[64] = Math.max(1, width) >>> 0;
  uints[65] = Math.max(1, height) >>> 0;
  uints[66] = radius >>> 0;
  uints[67] = axis >>> 0;
  uints[68] = flags >>> 0;
  return out;
}

/**
 * WGSL for the separable Gaussian compute pass, parameterised by the STORAGE
 * texture format (WGSL bakes the format into `texture_storage_2d<F, write>`, so a
 * `rgba16float` and a `rgba32float` working format need distinct modules).
 *
 * Bindings (group 0):
 *   0 — `GaussianUniforms` (weights + dims + radius + axis + flags)
 *   1 — `src_tex` : `texture_2d<f32>`                     (read, textureLoad)
 *   2 — `dst_tex` : `texture_storage_2d<format, write>`   (write, textureStore)
 *
 * DISPATCH CONTRACT: `x` = tiles along the FILTERED axis
 * (`ceil(axisLen / GAUSS_WORKGROUP_SIZE)`), `y` = number of lines (the other
 * axis), `z` = 1. So one workgroup owns one `GAUSS_WORKGROUP_SIZE`-long run of a
 * single row (axis=0) or column (axis=1).
 */
export function buildGaussianWgsl(format: 'rgba16float' | 'rgba32float'): string {
  return COLORSPACE_WGSL + /* wgsl */ `
struct GaussianUniforms {
  // Half-kernel, vec4-packed: entry i is weights[i/4][i%4]. weights[0] is the
  // centre tap; entry i applies to BOTH taps at ±i (see gaussianWeights()).
  weights : array<vec4<f32>, ${GAUSS_WEIGHT_VEC4_COUNT}>,
  dims    : vec2<u32>,   // source/destination size in texels
  radius  : u32,         // kernel half-width, 0 = identity
  axis    : u32,         // 0 = horizontal, 1 = vertical
  flags   : u32,         // bit0 premultiply-on-load, bit1 unpremultiply-on-store, bit2 src-is-linear
};

@group(0) @binding(0) var<uniform> gauss : GaussianUniforms;
@group(0) @binding(1) var src_tex : texture_2d<f32>;
@group(0) @binding(2) var dst_tex : texture_storage_2d<${format}, write>;

// Shared tile: GAUSS_WORKGROUP_SIZE outputs + GAUSS_MAX_RADIUS halo either side.
// Sized for the MAX radius so the array length stays a compile-time constant; the
// live prefix is (workgroup_size + 2·radius).
var<workgroup> tile : array<vec4<f32>, ${GAUSS_TILE_LEN}>;

fn gauss_weight(i : u32) -> f32 {
  return gauss.weights[i / 4u][i % 4u];
}

// Fetch one source texel with clamp-to-edge addressing (matches the v1 blur's
// edge behaviour), DECODING to linear light and then premultiplying so the
// convolution runs in linear premultiplied space and transparent texels
// cannot bleed dark RGB.
//
// ⚠️ ORDER: decode BEFORE premultiply. Premultiplying gamma-encoded values is
// mathematically wrong and is the classic edge-darkening bug. Alpha itself is a
// coverage ratio and is never transfer-encoded.
fn gauss_load(coord : vec2<i32>) -> vec4<f32> {
  let max_x = i32(gauss.dims.x) - 1;
  let max_y = i32(gauss.dims.y) - 1;
  let c = vec2<i32>(clamp(coord.x, 0, max_x), clamp(coord.y, 0, max_y));
  var s = textureLoad(src_tex, c, 0);
  if ((gauss.flags & ${GAUSS_FLAG_SRC_LINEAR}u) == 0u) {
    s = vec4<f32>(srgb_to_linear(s.rgb), s.a);
  }
  if ((gauss.flags & ${GAUSS_FLAG_PREMULTIPLY_ON_LOAD}u) != 0u) {
    s = vec4<f32>(s.rgb * s.a, s.a);
  }
  return s;
}

@compute @workgroup_size(${GAUSS_WORKGROUP_SIZE}, 1, 1)
fn cs_gaussian(
  @builtin(workgroup_id) wg : vec3<u32>,
  @builtin(local_invocation_id) lid : vec3<u32>,
) {
  // Clamp defensively: keeps every tile index provably in range even if a caller
  // ever packs a radius above GAUSS_MAX_RADIUS.
  let r = min(gauss.radius, ${GAUSS_MAX_RADIUS}u);
  let tile_len = ${GAUSS_WORKGROUP_SIZE}u + 2u * r;
  let tile_start = i32(wg.x * ${GAUSS_WORKGROUP_SIZE}u) - i32(r);
  let line = i32(wg.y);

  // ① Cooperative load of tile + halo. Every invocation strides by the workgroup
  // size, so the (tile_len) texels are fetched exactly once per workgroup.
  for (var t = lid.x; t < tile_len; t = t + ${GAUSS_WORKGROUP_SIZE}u) {
    let pos = tile_start + i32(t);
    var coord = vec2<i32>(pos, line);
    if (gauss.axis != 0u) {
      coord = vec2<i32>(line, pos);
    }
    tile[t] = gauss_load(coord);
  }

  // Barrier is reached by EVERY invocation (the bounds check below happens after)
  // — required for uniform control flow.
  workgroupBarrier();

  let out_pos = i32(wg.x * ${GAUSS_WORKGROUP_SIZE}u + lid.x);
  var out_coord = vec2<i32>(out_pos, line);
  var axis_len = i32(gauss.dims.x);
  if (gauss.axis != 0u) {
    out_coord = vec2<i32>(line, out_pos);
    axis_len = i32(gauss.dims.y);
  }
  if (out_pos >= axis_len) {
    return;
  }

  // ② Convolve from shared memory. centre index is provably within [r, 63+r] and
  // centre ± i within [0, tile_len-1] because i <= r.
  let centre = lid.x + r;
  var acc = tile[centre] * gauss_weight(0u);
  for (var i = 1u; i <= r; i = i + 1u) {
    acc = acc + (tile[centre - i] + tile[centre + i]) * gauss_weight(i);
  }

  // ③ Restore STRAIGHT alpha on the final pass so the output convention matches
  // the input (resident textures are un-premultiplied — see the module header).
  if ((gauss.flags & ${GAUSS_FLAG_UNPREMULTIPLY_ON_STORE}u) != 0u) {
    if (acc.a > 0.0001) {
      acc = vec4<f32>(acc.rgb / acc.a, acc.a);
    } else {
      acc = vec4<f32>(0.0, 0.0, 0.0, acc.a);
    }
  }

  textureStore(dst_tex, out_coord, acc);
}
`;
}

/**
 * Default-format module source (the `rgba16float` working format, which is
 * unconditionally available). Exported as a stable string so the pure-Node
 * structural guards (`wgsl-entrypoint`, `bindgroup-visibility`) can parse it.
 */
export const GAUSSIAN_WGSL = buildGaussianWgsl('rgba16float');
