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
 * layer.ts — Types and embedded WGSL source for layer rendering.
 *
 * Embedded as a TypeScript constant so it is zero-config across Next.js
 * Turbopack, Webpack, tsx, and Vitest without needing raw-loader.
 *
 * @module core/gpu/shaders/layer
 */

import { ADJUST_WGSL } from './adjust';
import { SOURCENORMALIZE_WGSL } from './sourceNormalize';
import { SDF_PRIMITIVES_WGSL } from './sdfPrimitives';

// ADJUST_WGSL leads with COLORSPACE_WGSL (srgb_to_linear / gamut_to_working /
// tone_map_filmic); SOURCENORMALIZE_WGSL uses those, so it must follow — WGSL has
// no imports, every definition precedes its first use. SDF_PRIMITIVES_WGSL is
// binding-free geometry maths for the analytic vmask branch.
export const LAYER_WGSL = ADJUST_WGSL + SOURCENORMALIZE_WGSL + SDF_PRIMITIVES_WGSL + /* wgsl */ `
struct LayerUniforms {
  transform    : mat3x3<f32>,   // Local Quad -> NDC (3 columns of vec3<f32>, std140: 16 bytes each -> 48 bytes)
  uv_rect      : vec4<f32>,     // (u0, v0, du, dv) (16 bytes, offset 48..63)
  opacity      : f32,           // Offset 64
  blend_mode   : u32,           // Offset 68
  flags        : u32,           // Offset 72 (bits 0..3: has_mask/clip/premult/hard_mask, bit 4: source_is_linear, bits 5..7: gamut_id, bits 8..9: render_intent, bit 10: bmask_inverted)
  vmask_flags  : u32,           // Offset 76 (was _pad; bit0 HAS_VMASK_ANALYTIC, bit1 HAS_VMASK_TEX, bit2 INVERTED, bit3 HARD, bits4-5 SHAPE 0=rect/1=ellipse)
  vmask_rect   : vec4<f32>,     // Offset 80 (16B) — (cx, cy, halfW, halfH) in layer-local pixel space (analytic only)
  vmask_feather: vec4<f32>,     // Offset 96 (16B) — (featherPx, maskPxW, maskPxH, _reserved)
};

@group(0) @binding(0) var<uniform> layer : LayerUniforms;
@group(0) @binding(1) var samp          : sampler;
@group(0) @binding(2) var layer_tex     : texture_2d<f32>;
@group(0) @binding(3) var mask_tex      : texture_2d<f32>;
@group(0) @binding(4) var vmask_tex     : texture_2d<f32>;

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

  // ── Normalise the sampled source
  // into WORKING-space (Display-P3) linear light with its rendering intent applied.
  // ONE call shared by layer.ts / blend.ts / adjustPre.ts (sourceNormalize.wgsl):
  //   ① sRGB→linear decode unless flags bit 4 (SOURCE_LINEAR) is set — gamma-domain
  //      alpha maths is the root cause of v1's dark edges, so it must precede the
  //      alpha arithmetic below. Judged PER-ASSET, never from frame.trc.
  //   ② source gamut → Display-P3 in linear light (flags bits 5..7; 0 = no-op).
  //   ③ render-intent tone-map in the STRAIGHT domain (flags bits 8..9; 0 = SDR
  //      passthrough). Applied here — BEFORE per-layer adjustments (method α).
  // Alpha is never transfer-encoded; only .rgb is converted.
  color = normalize_layer_source(color, layer.flags);

  // Per-layer colour adjustments operate on STRAIGHT (un-premultiplied)
  // rgb in LINEAR light; apply_adjustments TRC-wraps its own chain internally.
  // Gated on adj.flags != 0 so an un-adjusted layer skips the round-trip entirely
  // (identity no-op).
  if (adj.flags != 0u) {
    var straight = color.rgb;
    if ((layer.flags & 4u) != 0u && color.a > 0.0001) {
      straight = color.rgb / color.a;
    }
    straight = apply_adjustments(straight);
    if ((layer.flags & 4u) != 0u) {
      color = vec4<f32>(straight * color.a, color.a);
    } else {
      color = vec4<f32>(straight, color.a);
    }
  }

  // Optional mask (bmask — freehand raster alpha)
  if ((layer.flags & 1u) != 0u) {
    var mask_alpha = textureSample(mask_tex, samp, in.mask_uv).a;
    if ((layer.flags & 8u) != 0u) {
      mask_alpha = step(0.5, mask_alpha);
    }
    if ((layer.flags & 1024u) != 0u) {            // HAS_BMASK_INVERTED (bit10)
      mask_alpha = 1.0 - mask_alpha;              // destination-out (erase semantics)
    }
    color.a *= mask_alpha;
  }

  // Optional vmask (analytic SDF or baked polygon texture). Independent
  // of bmask — both are multiplied into color.a (shader composition). Skipped
  // entirely when vmask_flags == 0 (layer has no vmask), byte-for-byte compatible.
  if ((layer.vmask_flags & 1u) != 0u) {              // HAS_VMASK_ANALYTIC
    let px = in.mask_uv * layer.vmask_feather.yz;    // normalized uv → layer-local px
    let center = layer.vmask_rect.xy;
    let half = layer.vmask_rect.zw;
    let shape = (layer.vmask_flags >> 4u) & 3u;
    var d: f32;
    if (shape == 0u) {
      d = sdf_rounded_rect(px - center, half, 0.0);
    } else {
      d = sdf_ellipse(px - center, half);
    }
    let aa = max(fwidth(d), 1e-6) * 0.5;
    let feather = max(layer.vmask_feather.x, aa);
    var vmask_alpha = 1.0 - smoothstep(-feather, feather, d);
    if ((layer.vmask_flags & 4u) != 0u) { vmask_alpha = 1.0 - vmask_alpha; }   // VMASK_INVERTED
    if ((layer.vmask_flags & 8u) != 0u) { vmask_alpha = step(0.5, vmask_alpha); } // VMASK_HARD
    color.a *= vmask_alpha;
  } else if ((layer.vmask_flags & 2u) != 0u) {       // HAS_VMASK_TEX
    var vmask_alpha = textureSample(vmask_tex, samp, in.mask_uv).a;
    if ((layer.vmask_flags & 4u) != 0u) { vmask_alpha = 1.0 - vmask_alpha; }
    if ((layer.vmask_flags & 8u) != 0u) { vmask_alpha = step(0.5, vmask_alpha); }
    color.a *= vmask_alpha;
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

  // Premultiplied LINEAR light into the rgba16float working buffer. Channel
  // isolation is NOT applied here: compositing is channel-agnostic so the
  // composited texture stays cacheable (compose-once/view-many); the
  // display channel swizzle lives in the view pass (view.ts). The single
  // terminal TRC encode also happens there.
  return vec4<f32>(out_rgb, color.a);
}
`;

/** Size of LayerUniforms in bytes (112 bytes = 28 float/u32 slots, including vmask fields). */
export const LAYER_UNIFORM_BUFFER_SIZE = 112;

/**
 * `vmask_flags` bit layout. Mirrors the WGSL branch in LAYER_WGSL /
 * BLEND_WGSL. HAS_ANALYTIC and HAS_TEX are mutually exclusive;
 * INVERTED/HARD are set by the CPU only on the analytic sub-path — the polygon
 * sub-path bakes invert/hard into the texture during the fill-pass, so the
 * sampling side just multiplies.
 */
export const VMASK_FLAG_HAS_ANALYTIC = 1;
export const VMASK_FLAG_HAS_TEX = 2;
export const VMASK_FLAG_INVERTED = 4;
export const VMASK_FLAG_HARD = 8;
/** Shape id occupies bits 4-5 (analytic only): 0 = rect, 1 = ellipse. */
export const VMASK_SHAPE_SHIFT = 4;
export const VMASK_SHAPE_RECT = 0;
export const VMASK_SHAPE_ELLIPSE = 1;

/**
 * Layer `flags` bit layout constants moved to `sourceNormalize.ts` (the single
 * source of truth shared by all three sampling passes). Re-exported
 * here so existing importers (`CompositePass`, `BlendPass`) keep resolving them from
 * `shaders/layer` unchanged.
 */
export {
  LAYER_FLAG_HAS_MASK,
  LAYER_FLAG_CLIP,
  LAYER_FLAG_PREMULTIPLIED_SOURCE,
  LAYER_FLAG_HARD_MASK,
  LAYER_FLAG_SOURCE_LINEAR,
  LAYER_GAMUT_SHIFT,
  LAYER_GAMUT_MASK,
  LAYER_RENDER_INTENT_SHIFT,
  LAYER_RENDER_INTENT_MASK,
  LAYER_FLAG_HAS_BMASK_INVERTED,
} from './sourceNormalize';

