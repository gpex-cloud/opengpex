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
 * effectMaskBake.ts — Compute pass that bakes a layer's combined bitmap mask
 * (bmask, `.r`) and baked vector mask (vmask, `.a`) into the content alpha
 * BEFORE stroke dilation runs (G3 stage 1).
 *
 * Baking masks into the content texture before dilation makes the stroke ring
 * follow the true visible silhouette (holes, ellipse/polygon cutouts, feathered
 * edges) and lets the prepass output declare `maskFree: true` so the
 * compositor skips vmask/bmask on the expanded effect quad.
 *
 * Preserves the content's colour domain untouched (`rgb` passes through
 * verbatim; only `.a` is multiplied by the mask coverages).
 *
 * @module core/gpu/shaders/effectMaskBake
 */

/** Workgroup edge for the 2D-tiled dispatch (ceil(dim/8) per axis). */
export const EFFECT_MASK_BAKE_WORKGROUP = 8;

/** `flags` bit: sample `bmask_tex.r`. */
export const EFFECT_MASK_BAKE_FLAG_BMASK = 1 << 0;
/** `flags` bit: sample `vmask_tex.a`. */
export const EFFECT_MASK_BAKE_FLAG_VMASK = 1 << 1;

/**
 * `EffectMaskBakeUniforms` size in bytes:
 * dst_dims vec2<u32> (8) + flags u32 (4) + pad u32 (4) +
 * content_offset vec2<u32> (8) + content_dims vec2<u32> (8) +
 * base_origin_in_dst vec2<f32> (8) + base_size vec2<f32> (8) +
 * vmask_uv_xform vec4<f32> (16) = 64.
 */
export const EFFECT_MASK_BAKE_UNIFORM_BUFFER_SIZE = 64;

/** Number of 4-byte slots in `EffectMaskBakeUniforms`. */
export const EFFECT_MASK_BAKE_UNIFORM_FLOATS = EFFECT_MASK_BAKE_UNIFORM_BUFFER_SIZE / 4;

/**
 * Pack `EffectMaskBakeUniforms`.
 *
 * `contentOffsetX/Y` is the integer texel origin of `dst` inside `content_tex`
 * (bit-exact i32). `baseOriginInDstX/Y` and `baseWidth/Height` define the
 * visible content rect inside `dst` texels so `mask_uv` spans `[0,1]^2` across
 * the exact visible region. `vmaskWindow` + `contentLogicalWidth/Height` map
 * `mask_uv` into a windowed polygon vmask bake when present.
 */
export function packEffectMaskBakeUniform(
  dstWidth: number,
  dstHeight: number,
  opts: {
    readonly hasBmask: boolean;
    readonly hasVmask: boolean;
    readonly contentWidth: number;
    readonly contentHeight: number;
    readonly contentOffsetX: number;
    readonly contentOffsetY: number;
    readonly baseOriginInDstX: number;
    readonly baseOriginInDstY: number;
    readonly baseWidth: number;
    readonly baseHeight: number;
    readonly contentLogicalWidth: number;
    readonly contentLogicalHeight: number;
    readonly vmaskWindow?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  },
): Float32Array {
  const out = new Float32Array(EFFECT_MASK_BAKE_UNIFORM_FLOATS);
  const uints = new Uint32Array(out.buffer);
  let flags = 0;
  if (opts.hasBmask) flags |= EFFECT_MASK_BAKE_FLAG_BMASK;
  if (opts.hasVmask) flags |= EFFECT_MASK_BAKE_FLAG_VMASK;
  uints[0] = Math.max(1, dstWidth) >>> 0;
  uints[1] = Math.max(1, dstHeight) >>> 0;
  uints[2] = flags >>> 0;
  uints[3] = 0;
  uints[4] = Math.round(opts.contentOffsetX) >>> 0;
  uints[5] = Math.round(opts.contentOffsetY) >>> 0;
  uints[6] = Math.max(1, opts.contentWidth) >>> 0;
  uints[7] = Math.max(1, opts.contentHeight) >>> 0;
  out[8] = opts.baseOriginInDstX;
  out[9] = opts.baseOriginInDstY;
  out[10] = Math.max(1, opts.baseWidth);
  out[11] = Math.max(1, opts.baseHeight);
  if (opts.vmaskWindow && opts.vmaskWindow.w > 0 && opts.vmaskWindow.h > 0) {
    out[12] = opts.contentLogicalWidth / opts.vmaskWindow.w;
    out[13] = opts.contentLogicalHeight / opts.vmaskWindow.h;
    out[14] = -opts.vmaskWindow.x / opts.vmaskWindow.w;
    out[15] = -opts.vmaskWindow.y / opts.vmaskWindow.h;
  } else {
    out[12] = 1;
    out[13] = 1;
    out[14] = 0;
    out[15] = 0;
  }
  return out;
}

/**
 * WGSL for the effect mask-bake pass, keyed by the working storage format.
 *
 * Bindings (group 0):
 *   0 - EffectMaskBakeUniforms
 *   1 - content_tex : texture_2d<f32>
 *   2 - bmask_tex   : texture_2d<f32>  (combined bmask; read .r)
 *   3 - vmask_tex   : texture_2d<f32>  (baked polygon vmask; read .a)
 *   4 - mask_samp   : sampler          (linear clamp-to-edge)
 *   5 - dst_tex     : texture_storage_2d<format, write>
 */
export function buildEffectMaskBakeWgsl(format: 'rgba16float' | 'rgba32float'): string {
  return /* wgsl */ `
struct EffectMaskBakeUniforms {
  dst_dims           : vec2<u32>,
  flags              : u32,
  _pad               : u32,
  content_offset     : vec2<u32>,
  content_dims       : vec2<u32>,
  base_origin_in_dst : vec2<f32>,
  base_size          : vec2<f32>,
  vmask_uv_xform     : vec4<f32>,
};

@group(0) @binding(0) var<uniform> u : EffectMaskBakeUniforms;
@group(0) @binding(1) var content_tex : texture_2d<f32>;
@group(0) @binding(2) var bmask_tex : texture_2d<f32>;
@group(0) @binding(3) var vmask_tex : texture_2d<f32>;
@group(0) @binding(4) var mask_samp : sampler;
@group(0) @binding(5) var dst_tex : texture_storage_2d<${format}, write>;

@compute @workgroup_size(${EFFECT_MASK_BAKE_WORKGROUP}, ${EFFECT_MASK_BAKE_WORKGROUP}, 1)
fn cs_effect_mask_bake(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= u.dst_dims.x || gid.y >= u.dst_dims.y) {
    return;
  }
  let dst_xy = vec2<i32>(gid.xy);
  let src_xy = dst_xy + vec2<i32>(u.content_offset);
  var c = vec4<f32>(0.0);
  if (src_xy.x >= 0 && src_xy.y >= 0
    && src_xy.x < i32(u.content_dims.x) && src_xy.y < i32(u.content_dims.y)) {
    c = textureLoad(content_tex, src_xy, 0);
  }

  let mask_uv = (vec2<f32>(dst_xy) + vec2<f32>(0.5) - u.base_origin_in_dst) / u.base_size;
  var cov = 1.0;
  if ((u.flags & ${EFFECT_MASK_BAKE_FLAG_BMASK}u) != 0u) {
    cov *= textureSampleLevel(bmask_tex, mask_samp, mask_uv, 0.0).r;
  }
  if ((u.flags & ${EFFECT_MASK_BAKE_FLAG_VMASK}u) != 0u) {
    let vmask_uv = mask_uv * u.vmask_uv_xform.xy + u.vmask_uv_xform.zw;
    cov *= textureSampleLevel(vmask_tex, mask_samp, vmask_uv, 0.0).a;
  }
  textureStore(dst_tex, dst_xy, vec4<f32>(c.rgb, c.a * cov));
}
`;
}

/** Default-format module source for pure-Node structural guards. */
export const EFFECT_MASK_BAKE_WGSL = buildEffectMaskBakeWgsl('rgba16float');
