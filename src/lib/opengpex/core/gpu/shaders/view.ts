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
 * view.ts — The VIEW pass shader (缺陷 5 §5, "Compose-Once, View-Many").
 *
 * ARCHITECTURAL ROLE
 * ------------------
 * The engine composites all layers ONCE into a document-space "composited
 * texture" (camera-independent). The VIEW pass then maps that composited
 * texture onto the swapchain applying the camera (`scene.view.transform`).
 * Pan/zoom only replay this pass — no re-compositing (that is the root fix for
 * 缺陷 5). This supersedes the old `blit.ts` (1:1 copy): a 1:1 blit is just this
 * pass with an identity full-screen `view_matrix`.
 *
 * INPUTS
 * ------
 *   • `view_matrix`: maps the unit quad (0..1, document extent) → clip/NDC. It
 *     folds document-extent → camera(view.transform) → NDC into one 3×3, packed
 *     column-major (std140 mat3x3 = 3× vec3 padded to 16 bytes each = 48 bytes).
 *   • `uv_scale`: the fraction of the source texture holding real content. The
 *     composited texture comes from a power-of-2 bucketed pool (e.g. a 1304×822
 *     document lives in a 2048×1024 texture), so sampling uv 0..1 would drag in
 *     never-written garbage. Same mechanism the old BlitPass used (maxU/maxV).
 *   • `channel_mask`: display channel isolation swizzle (§2.5, §5.2). The
 *     fragment stage is a line-for-line port of the old `blit.ts` `fs_main`, so
 *     output is identical for the identity/1:1 case.
 *
 * @module core/gpu/shaders/view
 */

export const VIEW_WGSL = /* wgsl */ `
struct ViewUniforms {
  view_matrix  : mat3x3<f32>,   // unit quad (document extent) -> NDC (48 bytes: 3× vec3 padded)
  uv_scale     : vec2<f32>,     // content fraction of the (POT-bucketed) source texture (offset 48)
  channel_mask : u32,           // 0: rgb, 1: r, 2: g, 3: b, 4: a (offset 56)
  _pad         : u32,           // offset 60
};

@group(0) @binding(0) var<uniform> view_u : ViewUniforms;
@group(0) @binding(1) var samp            : sampler;
@group(0) @binding(2) var src_tex         : texture_2d<f32>;

struct VSInput {
  @location(0) pos : vec2<f32>,
  @location(1) uv  : vec2<f32>,
};

struct VSOut {
  @builtin(position) clip_pos : vec4<f32>,
  @location(0) uv             : vec2<f32>,
};

@vertex
fn vs_main(in : VSInput) -> VSOut {
  var out : VSOut;
  // Unit quad (0..1, document extent) -> NDC via the packed view matrix. The
  // matrix already includes the Y flip, camera and NDC mapping (see view.ts doc).
  let p = view_u.view_matrix * vec3<f32>(in.pos, 1.0);
  out.clip_pos = vec4<f32>(p.xy, 0.0, 1.0);
  out.uv = in.uv * view_u.uv_scale;
  return out;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  // The composited texture is ALREADY premultiplied (both compose paths store
  // premultiplied RGBA: layer.wgsl and blend.wgsl both output premultiplied
  // rgb). The swapchain is 'premultiplied' alphaMode, so the correct present is
  // a straight PASSTHROUGH — do NOT multiply rgb by a again.
  //
  // ⚠️ 缺陷 5 §5 阶段 1a note: the OLD blit.ts multiplied rgb by alpha here,
  // which DOUBLE-premultiplied the already-premultiplied composited color.
  // That was a latent bug masked by opaque-final-alpha test scenes (a≈1 makes
  // rgb*a == rgb). The pure-direct path never went through blit and was already
  // a correct premultiplied passthrough; unifying both paths onto the view pass
  // adopts that correct behavior and fixes the ping-pong double-premultiply.
  let color = textureSample(src_tex, samp, in.uv);

  switch (view_u.channel_mask) {
    // Channel isolation is an inspection mode: un-premultiply to show the TRUE
    // per-channel value (matches the old pure-direct layer.wgsl which swizzled
    // the straight, unpremultiplied sample).
    case 1u: { // Red only
      let r = select(0.0, color.r / color.a, color.a > 0.0);
      return vec4<f32>(r, r, r, 1.0);
    }
    case 2u: { // Green only
      let g = select(0.0, color.g / color.a, color.a > 0.0);
      return vec4<f32>(g, g, g, 1.0);
    }
    case 3u: { // Blue only
      let b = select(0.0, color.b / color.a, color.a > 0.0);
      return vec4<f32>(b, b, b, 1.0);
    }
    case 4u: { // Alpha only
      let a = color.a;
      return vec4<f32>(a, a, a, 1.0);
    }
    default: {
      // Premultiplied passthrough onto the premultiplied swapchain.
      return vec4<f32>(color.rgb, color.a);
    }
  }
}
`;

/** Size of ViewUniforms in bytes (48 matrix + 8 uv_scale + 4 mask + 4 pad = 64). */
export const VIEW_UNIFORM_BUFFER_SIZE = 64;
