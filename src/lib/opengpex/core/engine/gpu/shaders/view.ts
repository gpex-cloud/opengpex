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
 * view.ts — The VIEW pass shader ("Compose-Once, View-Many").
 *
 * ARCHITECTURAL ROLE
 * ------------------
 * The engine composites all layers ONCE into a document-space "composited
 * texture" (camera-independent). The VIEW pass then maps that composited
 * texture onto the swapchain applying the camera (`scene.view.transform`).
 * Pan/zoom only replay this pass — avoiding redundant re-compositing.
 * This supersedes the old 1:1 copy blit: a 1:1 blit is just this
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
 *   • `channel_mask`: display channel isolation as a 4-bit visibility mask
 *     (bit0=R bit1=G bit2=B bit3=A). One Photoshop-style rule in
 *     `fs_main` covers grayscale/alpha/two-channel colour; the identity (all
 *     RGB on) path is byte-identical to the old 1:1 blit present.
 *
 * DISPLAY PROJECTION
 * ------------------
 * The composited texture is linear light in `WORKING_GAMUT` (ProPhoto RGB — a
 * superset of every display), but the swapchain is pinned to
 * `colorSpace:'display-p3'` (`GpuDevice.configureSurface`). Before the terminal
 * TRC encode, `fs_main` therefore PROJECTS W → display-p3 (build-time matrix,
 * Bradford-adapted for the D50→D65 white shift) and clamps to [0,1] — the
 * soft-proof step that turns the screen into a window onto W. The projection is
 * INLINED here on purpose: a separate projection pass would add a full-screen
 * read+write for ~12 ALU ops of work. With W = display-p3 the matrix degenerates
 * to identity and the pass is byte-identical to the pre-projection present.
 *
 * @module core/gpu/shaders/view
 */

import { COLORSPACE_WGSL, wgslMat } from './colorspace';
import { deriveMatrix64, WORKING_GAMUT } from '@opengpex/editor/core/engine/color/gamut';

/**
 * The swapchain is ALWAYS display-p3 (`GpuDevice.configureSurface` pins it), so
 * the projection target is a build-time constant — no uniform, no per-frame cost
 * beyond the one 3×3 + clamp every presented pixel pays anyway.
 */
const MAT_WORKING_TO_DISPLAY = wgslMat(deriveMatrix64(WORKING_GAMUT, 'display-p3'));

export const VIEW_WGSL = COLORSPACE_WGSL + /* wgsl */ `
struct ViewUniforms {
  view_matrix  : mat3x3<f32>,   // unit quad (document extent) -> NDC (48 bytes: 3× vec3 padded)
  uv_scale     : vec2<f32>,     // content fraction of the (POT-bucketed) source texture (offset 48)
  channel_mask : u32,           // 4-bit visibility mask: bit0=R bit1=G bit2=B bit3=A (offset 56)
  _pad         : u32,           // offset 60
};

@group(0) @binding(0) var<uniform> view_u : ViewUniforms;
@group(0) @binding(1) var samp            : sampler;
@group(0) @binding(2) var src_tex         : texture_2d<f32>;

// WORKING_GAMUT → display-p3 projection (column-major, auto-derived — see the
// module doc). Declared before fs_main, the only consumer.
const MAT_WORKING_TO_DISPLAY = ${MAT_WORKING_TO_DISPLAY};

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
  // The composited texture is ALREADY premultiplied AND in LINEAR LIGHT of the
  // WORKING gamut (both compose paths store premultiplied linear rgba: layer.wgsl
  // and blend.wgsl). The swapchain is 'premultiplied' alphaMode.
  //
  // ── THE SINGLE TERMINAL ENCODE (projection + TRC) ──
  // This is the ONE place working-gamut linear light becomes display-p3-encoded
  // sRGB for screen: a W → display-p3 matrix projection (+ clamp, below) followed
  // by the sRGB TRC. Two rules make it correct and keep it unique:
  //   1. ENCODE THE STRAIGHT VALUE: the right premultiplied result is
  //      encode(rgb/a)·a, NOT encode(rgb). Encoding the premultiplied value
  //      directly would shift the colour of every semi-transparent pixel.
  //   2. THE SWAPCHAIN MUST NOT BE -srgb: GpuDevice.configureSurface pins the
  //      canvas format to a non-srgb format precisely so the hardware does not
  //      encode a second time on top of this. See the note there before changing
  //      either side.
  //
  // Note: the old blit multiplied rgb by alpha here,
  // which DOUBLE-premultiplied the already-premultiplied composited color.
  // That was a latent bug masked by opaque-final-alpha test scenes (a≈1 makes
  // rgb*a == rgb). The pure-direct path never went through blit and was already
  // a correct premultiplied passthrough; unifying both paths onto the view pass
  // adopts that correct behavior and fixes the ping-pong double-premultiply.
  let color = textureSample(src_tex, samp, in.uv);

  // ── Display channel isolation ──
  // channel_mask is a 4-bit visibility mask (bit0=R bit1=G bit2=B bit3=A). One
  // Photoshop-style rule covers every combination, so single-channel, alpha and
  // any two-channel colour view all fall out of the same code — no per-mode case,
  // no "missing combination" (the class of bug the old string enum caused).
  //
  // Encoding discipline (boundary ⑥, same as the identity path below): the stored
  // value is premultiplied LINEAR light, so a colour channel is un-premultiplied
  // to its STRAIGHT value, then TRC-encoded — encode(rgb/a)·a, never encode(rgb).
  // Alpha is coverage and is never transfer-encoded.
  let mask = view_u.channel_mask;
  let r_on = (mask & 1u) != 0u;
  let g_on = (mask & 2u) != 0u;
  let b_on = (mask & 4u) != 0u;
  let a_on = (mask & 8u) != 0u;
  let rgb_count = countOneBits(mask & 7u);

  // Alpha isolation: coverage shown as grayscale, no TRC encode.
  if (a_on) {
    let a = color.a;
    return vec4<f32>(a, a, a, 1.0);
  }

  // Fully transparent pixels stay at zero for every colour path.
  if (color.a <= 0.0) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }
  let straight = color.rgb / color.a;

  // ── THE DISPLAY PROJECTION (soft-proof, W → swapchain gamut) ──
  // The composite is linear WORKING_GAMUT (ProPhoto) light; the swapchain is
  // display-p3. Project in LINEAR light, then clamp to [0,1]: colours outside
  // the display triangle (the whole point of a wide working gamut) clip to the
  // display edge here, at the ONE presentation boundary — the composite buffer
  // itself keeps the full W values. Clamp-before-encode (not after) so the TRC
  // never sees a negative base. When W = display-p3 this matrix is identity and
  // the clamp is a no-op on already-bounded values.
  let display = clamp(
    MAT_WORKING_TO_DISPLAY * straight,
    vec3<f32>(0.0),
    vec3<f32>(1.0),
  );

  // Single-channel isolation: grayscale of the one enabled channel (TRC-encoded).
  if (rgb_count == 1u) {
    var c = display.r;
    if (g_on) { c = display.g; }
    else if (b_on) { c = display.b; }
    let s = linear_to_srgb_channel(c);
    return vec4<f32>(s, s, s, 1.0);
  }

  // Two-channel colour mask: keep the enabled channels' colour, zero the other.
  if (rgb_count == 2u) {
    let masked = vec3<f32>(
      select(0.0, display.r, r_on),
      select(0.0, display.g, g_on),
      select(0.0, display.b, b_on),
    );
    return vec4<f32>(linear_to_srgb(masked) * color.a, color.a);
  }

  // Full RGB (all three bits) or all-off safety: normal present. Un-premultiply →
  // project to the display gamut → encode the STRAIGHT colour → re-premultiply
  // (rule 1 above).
  return vec4<f32>(linear_to_srgb(display) * color.a, color.a);
}
`;

/** Size of ViewUniforms in bytes (48 matrix + 8 uv_scale + 4 mask + 4 pad = 64). */
export const VIEW_UNIFORM_BUFFER_SIZE = 64;
