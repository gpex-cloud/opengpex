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
 * layer.ts — Types and embedded WGSL source for layer rendering (spec §8.1, §8.2).
 *
 * Embedded as a TypeScript constant so it is zero-config across Next.js
 * Turbopack, Webpack, tsx, and Vitest without needing raw-loader.
 *
 * @module core/gpu/shaders/layer
 */

export const LAYER_WGSL = /* wgsl */ `
struct LayerUniforms {
  transform    : mat3x3<f32>,   // Local Quad -> NDC (3 columns of vec3<f32>, std140: 16 bytes each -> 48 bytes)
  uv_rect      : vec4<f32>,     // (u0, v0, du, dv) (16 bytes, offset 48..63)
  opacity      : f32,           // Offset 64
  blend_mode   : u32,           // Offset 68
  flags        : u32,           // Offset 72 (bit 0: has_mask, bit 1: clip, bit 2: premultiplied_source)
  channel_mask : u32,           // Offset 76 (0: rgb, 1: r, 2: g, 3: b, 4: a)
};

@group(0) @binding(0) var<uniform> layer : LayerUniforms;
@group(0) @binding(1) var samp          : sampler;
@group(0) @binding(2) var layer_tex     : texture_2d<f32>;
@group(0) @binding(3) var mask_tex      : texture_2d<f32>;

struct VSInput {
  @location(0) pos : vec2<f32>,
  @location(1) uv  : vec2<f32>,
};

struct VSOut {
  @builtin(position) clip_pos : vec4<f32>,
  @location(0) uv             : vec2<f32>,
  @location(1) mask_uv        : vec2<f32>,
};

@vertex
fn vs_main(in : VSInput) -> VSOut {
  var out : VSOut;
  let p = layer.transform * vec3<f32>(in.pos, 1.0);
  out.clip_pos = vec4<f32>(p.xy, 0.0, 1.0);
  out.uv = layer.uv_rect.xy + in.uv * layer.uv_rect.zw;
  out.mask_uv = in.uv;
  return out;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  var color = textureSample(layer_tex, samp, in.uv);

  // Optional mask
  if ((layer.flags & 1u) != 0u) {
    var mask_alpha = textureSample(mask_tex, samp, in.mask_uv).a;
    if ((layer.flags & 8u) != 0u) {
      mask_alpha = step(0.5, mask_alpha);
    }
    color.a *= mask_alpha;
  }

  color.a *= layer.opacity;

  // Handle source premultiplication: if source was already premultiplied, don't double-multiply RGB
  var out_rgb = color.rgb;
  if ((layer.flags & 4u) == 0u) {
    // Unpremultiplied source -> premultiply on output
    out_rgb = color.rgb * color.a;
  } else {
    out_rgb = color.rgb * layer.opacity;
  }

  // Display channel mask swizzle (spec §2.5, §5.2)
  switch (layer.channel_mask) {
    case 1u: { // Red only
      let r = select(0.0, color.r, color.a > 0.0);
      return vec4<f32>(r, r, r, 1.0);
    }
    case 2u: { // Green only
      let g = select(0.0, color.g, color.a > 0.0);
      return vec4<f32>(g, g, g, 1.0);
    }
    case 3u: { // Blue only
      let b = select(0.0, color.b, color.a > 0.0);
      return vec4<f32>(b, b, b, 1.0);
    }
    case 4u: { // Alpha only
      let r_val = color.a;
      return vec4<f32>(r_val, r_val, r_val, 1.0);
    }
    default: {
      return vec4<f32>(out_rgb, color.a);
    }
  }
}
`;

/** Size of LayerUniforms in bytes (80 bytes = 20 float/u32 slots). */
export const LAYER_UNIFORM_BUFFER_SIZE = 80;

export const LAYER_FLAG_HAS_MASK = 1 << 0;
export const LAYER_FLAG_CLIP = 1 << 1;
export const LAYER_FLAG_PREMULTIPLIED_SOURCE = 1 << 2;
export const LAYER_FLAG_HARD_MASK = 1 << 3;

export type ChannelMaskMode = 'rgb' | 'r' | 'g' | 'b' | 'a';

export function channelMaskToUniformValue(mode: ChannelMaskMode): number {
  switch (mode) {
    case 'r':
      return 1;
    case 'g':
      return 2;
    case 'b':
      return 3;
    case 'a':
      return 4;
    case 'rgb':
    default:
      return 0;
  }
}
