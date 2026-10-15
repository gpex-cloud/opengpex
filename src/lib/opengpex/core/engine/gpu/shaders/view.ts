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
 *   • `gain_tex` (binding 3): the single-source gain map, 1:1 with the document
 *     extent. Only the HDR variant samples it — see the HDR variant section.
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
 * TWO PIPELINE VARIANTS (SDR / HDR presentation)
 * ----------------------------------------------
 * `VIEW_WGSL` is the SDR variant — the A-phase terminal contract, byte-for-byte:
 * project → clamp [0,1] → `linear_to_srgb` encode into a `bgra8unorm` swapchain.
 * `VIEW_WGSL_HDR` is the HDR variant for the per-document HDR presentation
 * switch (`SurfaceConfig.hdr`): the swapchain becomes `rgba16float` +
 * `toneMapping:'extended'`, and the fragment is the SDR contract MINUS the
 * upper clamp — un-premultiply → project → lower clamp ≥ 0 → the SAME
 * `linear_to_srgb` encode, unclamped above 1.
 *
 * ⚠️ THE ENCODE STAYS IN THE SHADER (device-verified 2026-10-14): an earlier
 * draft emitted LINEAR values on the theory that the compositor applies the
 * transfer function to float16 canvas content at present time. On real Chrome
 * the canvas colorspace's transfer applies to the buffer values AS-IS — linear
 * midtones displayed raw read as crushed-dark, over-saturated (the whole frame
 * drops by the missing OETF). So the canvas holds ENCODED display-p3 in both
 * variants; 'extended' changes only the RANGE the target can carry: an 8-bit
 * unorm ROP hard-clamps at 1 (the SDR white), while the float16 surface lets
 * encode(linear > 1) — the OETF tail beyond white — survive the write, and the
 * OS projects that excess onto the device's headroom. For ≤ 1 content the two
 * variants are byte-identical BY CONSTRUCTION (same projection, same encode;
 * the SDR clamp and the ROP clamp agree), which is the load-bearing rollback
 * anchor. Where the OS maps the > 1 tail is device behaviour, quantified in
 * the real-device batch.
 *
 * Both variants share the concatenated prefix (structs, vertex stage,
 * projection constant) so they cannot drift; the fragment tails are compiled
 * pipeline variants selected by `PipelineCache.getViewPipeline(targetFormat,
 * hdr)` — zero per-pixel branches.
 *
 * The HDR variant also sanitizes its INPUT (f16 upper bound 65504 ≈ +16 stops;
 * past it the composite buffer can hold Inf, and Inf cascades into NaN through
 * the blend math): NaN components are scrubbed to 0 and everything clamps to the
 * f16 max so the swapchain write is always finite.
 *
 * GAIN-MAP PRESENTATION (HDR variant only)
 * ----------------------------------------
 * When the presented frame is gain-map-eligible (a single visible layer whose
 * asset carries the map, covering the canvas) and HDR presentation is on, the
 * engine binds the decoded map at binding 3 and sets `gain_enabled`; the
 * fragment multiplies the un-premultiplied straight colour by 2^gain —
 * reconstructing the file's HDR rendition (`engine/color/gainMap.ts` holds the
 * golden-locked math). `gain_enabled = 0` (not eligible, HDR off, or the map
 * still decoding — first frames present SDR and flip bright when the async
 * decode lands) binds a 1×1 dummy instead, so there is exactly ONE shader pair
 * for the gain and no-gain cases. The SDR variant never samples the map: with
 * HDR off the file presents its authoritative SDR base, byte-identically.
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

/**
 * Everything both pipeline variants share: the TRC helpers, the uniform block,
 * the sampler bindings, the projection constant and the vertex stage. Each
 * variant appends exactly one `fs_main` (WGSL forbids duplicate top-level
 * definitions per module, so the tails must be mutually exclusive).
 */
const VIEW_WGSL_COMMON = COLORSPACE_WGSL + /* wgsl */ `
struct ViewUniforms {
  view_matrix  : mat3x3<f32>,   // unit quad (document extent) -> NDC (48 bytes: 3× vec3 padded)
  uv_scale     : vec2<f32>,     // content fraction of the (POT-bucketed) source texture (offset 48)
  channel_mask : u32,           // 4-bit visibility mask: bit0=R bit1=G bit2=B bit3=A (offset 56)
  _pad         : u32,           // offset 60
  gain_min     : f32,           // gain-map value at byte 0, log2 HDR/SDR ratio (offset 64)
  gain_max     : f32,           // gain-map value at byte 255 (offset 68)
  gain_gamma   : f32,           // payload gamma; 1 = log2-linear (offset 72)
  gain_enabled : u32,           // 0 = present the SDR base verbatim (offset 76)
  gain_uv_origin : vec2<f32>,   // document-normalized uv of the composite's (0,0) corner (offset 80)
  gain_uv_scale  : vec2<f32>,   // document fraction the composite covers per axis (offset 88)
};

@group(0) @binding(0) var<uniform> view_u : ViewUniforms;
@group(0) @binding(1) var samp            : sampler;
@group(0) @binding(2) var src_tex         : texture_2d<f32>;
// The single-source gain map (1:1 with the document extent; r8unorm). ALWAYS
// bound: when no gain applies it is a 1×1 dummy and gain_enabled is 0, so one
// bind group layout serves both the gain and no-gain cases with zero pipeline
// variants beyond the SDR/HDR pair.
@group(0) @binding(3) var gain_tex        : texture_2d<f32>;

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
`;

/**
 * SDR pipeline variant — the A-phase terminal contract, UNCHANGED: project →
 * clamp [0,1] → sRGB TRC encode, into the `bgra8unorm` swapchain. Every byte of
 * this fragment is load-bearing for the SDR byte-identity guarantee (铁律: the
 * SDR path is byte-identical to the A-phase terminal state by construction).
 */
export const VIEW_WGSL = VIEW_WGSL_COMMON + /* wgsl */ `

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
  // Encoding discipline (same as the identity path below): the stored
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

/**
 * HDR pipeline variant (per-document HDR presentation switch, `SurfaceConfig.hdr`):
 * the swapchain is `rgba16float` + `toneMapping:'extended'`, and this fragment
 * is the SDR contract MINUS the upper clamp — un-premultiply → project →
 * lower clamp ≥ 0 → the SAME `linear_to_srgb` encode, unclamped above 1 (the
 * OETF tail past white survives the float16 write; the OS maps it onto the
 * device headroom — see the module header for the device evidence that the
 * encode cannot move to the compositor). For ≤ 1 content this is byte-identical
 * to the SDR variant, which keeps the SDR rollback anchor constructive.
 */
export const VIEW_WGSL_HDR = VIEW_WGSL_COMMON + /* wgsl */ `

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  // Input guard (f16 ceiling): the composite buffer is rgba16float, whose max
  // finite value is 65504 (~+16 stops over white). Values past it are Inf, and
  // Inf cascades into NaN through the blend arithmetic; both must never reach
  // the swapchain write. WGSL has no isnan/isinf builtins and its min/max
  // propagate the FIRST operand on unordered comparisons, so neither
  // min(x, 65504) nor clamp can be trusted against NaN/Inf. Two select
  // guards instead, each on an ordered test that IEEE makes total:
  //   1. NaN → 0: x != x is true ONLY for NaN (IEEE 754 self-comparison);
  //   2. ≥ 65504 → 65504: catches +Inf and every over-range value (negative
  //      Inf survives but is not light — the projection lower-clamp lands it).
  let sampled = textureSample(src_tex, samp, in.uv);

  // ── GAIN MAP SAMPLE (uniform control flow is a WGSL REQUIREMENT) ──
  // A gain-map document's eligible HDR frame reconstructs the HDR rendition as
  // hdr = sdr_linear × 2^gain, gain decoded affinely from the map byte exactly
  // as engine/color/gainMap.ts::decodeGainSample states it (pow(s, 1/gamma) →
  // affine → exp2 — the golden-locked operation order). The sample MUST sit in
  // uniform control flow: WGSL forbids textureSample inside any branch
  // conditioned on a possibly-non-uniform value, and the alpha early-outs
  // below condition on the SOURCE sample — so a nested gain sample would fail
  // shader compilation (real device, 2026-10-15). Hence: hoisted beside the
  // source sample, gated by select() instead of a branch. When gain_enabled=0
  // the bound texture is the 1×1 dummy and the factor collapses to exactly 1.
  // gain_min may be NEGATIVE (ISO-legal darkening tail); exp2 of a negative
  // gain legitimately dims those samples.
  let doc_uv = in.uv / view_u.uv_scale;
  let map_uv = view_u.gain_uv_origin + doc_uv * view_u.gain_uv_scale;
  let gain_s = textureSample(gain_tex, samp, map_uv).r;
  let gain_lin = pow(gain_s, 1.0 / max(view_u.gain_gamma, 1e-6));
  let gain_factor = select(
    1.0,
    exp2(view_u.gain_min + gain_lin * (view_u.gain_max - view_u.gain_min)),
    view_u.gain_enabled != 0u,
  );

  let no_nan = select(sampled, vec4<f32>(0.0), sampled != sampled);
  let color = select(no_nan, vec4<f32>(65504.0), no_nan >= vec4<f32>(65504.0));

  // Same 4-bit channel-isolation rule and the SAME terminal encode as the SDR
  // variant — the canvas holds ENCODED display-p3 in both (see the module
  // header: the compositor does not re-encode float16 content; 'extended' only
  // widens the range the surface can carry).
  let mask = view_u.channel_mask;
  let r_on = (mask & 1u) != 0u;
  let g_on = (mask & 2u) != 0u;
  let b_on = (mask & 4u) != 0u;
  let a_on = (mask & 8u) != 0u;
  let rgb_count = countOneBits(mask & 7u);

  // Alpha isolation: coverage shown as grayscale (never transfer-encoded).
  if (a_on) {
    let a = color.a;
    return vec4<f32>(a, a, a, 1.0);
  }

  // Fully transparent pixels stay at zero for every colour path. The 1e-4
  // epsilon (same constant blend.wgsl's un-premultiply guards) also keeps the
  // divide below in non-absurd territory: an f16-sourced premultiplied buffer
  // cannot make rgb/a reach Inf in f32 (≤ 65504/2⁻²⁴ ≈ 1.1e12), but there is
  // no reason to ride that arithmetic bound when sub-ε alpha is invisible
  // anyway (encode·a ≤ ~1/255).
  if (color.a <= 0.0001) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }
  let straight = color.rgb / color.a;
  // The scalar gain commutes with premultiplication ((c·s)·a = (c·a)·s), so
  // applying it to the STRAIGHT colour here and re-premultiplying at the encode
  // is identical to scaling the stored premultiplied value — and every
  // downstream branch reads one variable.
  let linear_rgb = straight * gain_factor;

  // ── DISPLAY PROJECTION, lower clamp only ──
  // W → display-p3 in linear light (same build-time matrix as the SDR variant).
  // The LOWER clamp stays: a wide-gamut projection legitimately produces
  // negative coordinates (out-of-display-triangle colors), and a negative value
  // would invert toward black. The UPPER clamp is gone — the entire point of
  // the HDR contract: linear light above display white encodes past 1.0 (the
  // OETF is monotone, so the tail stays ordered), survives the float16 write,
  // and the OS maps that excess onto the device headroom. For ≤ 1 content this
  // is byte-identical to the SDR variant.
  let display = max(
    MAT_WORKING_TO_DISPLAY * linear_rgb,
    vec3<f32>(0.0),
  );

  // Single-channel isolation: grayscale of the one enabled channel (encoded,
  // same as the SDR inspection views).
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

  // Full RGB (all three bits) or all-off safety: normal present. Un-premultiply
  // → project to the display gamut → encode the STRAIGHT colour (unclamped
  // above 1 — the HDR tail) → re-premultiply.
  return vec4<f32>(linear_to_srgb(display) * color.a, color.a);
}
`;

/** Size of ViewUniforms in bytes: 48 matrix + 8 uv_scale + 4 mask + 4 pad
 * + 16 gain params + 16 gain uv placement = 96 (6 × 16, std140-friendly). */
export const VIEW_UNIFORM_BUFFER_SIZE = 96;