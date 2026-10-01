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
 * sourceNormalize.ts — the SINGLE source of truth for the layer `flags` u32 bit
 * layout, plus the WGSL that unpacks it and normalises a sampled source pixel into
 * WORKING-space (Display-P3) linear light with its rendering intent applied
 * (RAW image handling).
 *
 * WHY ONE MODULE: `layer.ts` (Pass 1), `blend.ts` (Pass 2) and `adjustPre.ts`
 * (Pass 3) all sample a source texture and must run the SAME normalise pipeline —
 * TRC decode → gamut fold → render-intent tone-map. Before this module each pass
 * open-coded the bit math and the decode/fold steps, so the three could silently
 * drift (an image correct on `source-over`, wrong on `multiply`). Here the bit
 * positions are defined ONCE in TypeScript and interpolated into the WGSL, and the
 * normalise steps live in ONE pair of WGSL functions every pass calls.
 *
 * ⚠️ WGSL CONCATENATION ORDER: `SOURCENORMALIZE_WGSL` calls `srgb_to_linear`,
 * `gamut_to_working` and `tone_map_filmic`, all defined in `COLORSPACE_WGSL`. A
 * consuming shader module MUST concatenate `COLORSPACE_WGSL` BEFORE this string
 * (WGSL has no imports; every definition must precede its first use).
 *
 * @module core/gpu/shaders/sourceNormalize
 */

// ────────────────────────────────────────────────────────────
// Layer `flags` u32 bit layout — the ONE definition (TS side).
// The WGSL below interpolates these, so the shader can never drift from them.
// ────────────────────────────────────────────────────────────

/** `flags` bit 0: a mask texture is bound; sample it and multiply into alpha. */
export const LAYER_FLAG_HAS_MASK = 1 << 0;
/** `flags` bit 1: this layer clips to the one below (`source-atop`-style). */
export const LAYER_FLAG_CLIP = 1 << 1;
/**
 * `flags` bit 2: the source texture is PREMULTIPLIED. Governs the un-premultiply /
 * re-premultiply dance around every STRAIGHT-domain, non-linear operation.
 */
export const LAYER_FLAG_PREMULTIPLIED_SOURCE = 1 << 2;
/** `flags` bit 3: mask is HARD — threshold its alpha at 0.5 instead of sampling soft. */
export const LAYER_FLAG_HARD_MASK = 1 << 3;
/**
 * `flags` bit 4: this layer's source pixels are ALREADY linear light, so the shader
 * must SKIP the sRGB→linear decode.
 *
 * Judged per ASSET from the decoder's reported colour interpretation
 * (`HighDepthSource.trc` → `LayerSource.trc`), never from `frame.trc` — see the
 * decode comment in `layer.ts`'s `fs_main` for why that document-level field is
 * unusable here. 8-bit `bitmap` sources are always sRGB-encoded, so this bit stays
 * clear for them. Arbitrated by `isSourceLinear` (`passes/sourceDomain.ts`).
 */
export const LAYER_FLAG_SOURCE_LINEAR = 1 << 4;

/**
 * `flags` bits 5..7: GAMUT_ID (0..4) — the source physical gamut the shader must
 * convert to the working space (Display-P3) via `gamut_to_working`, in LINEAR light
 * AFTER the TRC decode.
 *
 * 0 = already working / direct, 1 = sRGB, 2 = Adobe RGB, 3 = ProPhoto, 4 = Rec.2020.
 * Arbitrated by `resolveSourceGamutId` (`passes/sourceGamut.ts`).
 */
export const LAYER_GAMUT_SHIFT = 5;
/** Field width mask for GAMUT_ID (3 bits → 0..7, of which 0..4 are used). */
export const LAYER_GAMUT_MASK = 0x7;

/**
 * `flags` bits 8..9: RENDER_INTENT (0..2) — the out-of-box rendering intent applied
 * in the STRAIGHT domain at composite time.
 *
 * 0 = SDR passthrough (no tone-map), 1 = generic Filmic S-curve, 2 = DNG
 * ProfileToneCurve LUT (falls back to Filmic until the LUT sampler lands). Carried
 * FORWARD explicitly from the ingest decision; arbitrated by
 * `resolveSourceRenderIntent` (`passes/sourceIntent.ts`).
 */
export const LAYER_RENDER_INTENT_SHIFT = 8;
/** Field width mask for RENDER_INTENT (2 bits → 0..3, of which 0..2 are used). */
export const LAYER_RENDER_INTENT_MASK = 0x3;

/**
 * `flags` bit 10: the bound bmask (bitmap/freehand raster mask) alpha is INVERTED —
 * destination-out erase semantics (`1 - mask_alpha`) instead of the default
 * destination-in (multiply). Mirrors `VMASK_FLAG_INVERTED` for the vector-mask path
 * Bits 5..9 are GAMUT_ID/RENDER_INTENT, so this
 * is the next free bit. Packed by `CompositePass`/`BlendPass` from
 * `layer.bmask?.inverted`; consumed by the bmask block in `layer.ts`/`blend.ts`
 * `fs_main`, gated so pre-existing (non-inverted) bmask layers render byte-for-byte
 * unchanged.
 */
export const LAYER_FLAG_HAS_BMASK_INVERTED = 1 << 10;

// ────────────────────────────────────────────────────────────
// Source normalise pipeline (WGSL). Prepended after COLORSPACE_WGSL.
// Bit positions are interpolated from the constants above — single truth.
// ────────────────────────────────────────────────────────────

export const SOURCENORMALIZE_WGSL = /* wgsl */ `
// Normalise a sampled source pixel into WORKING-space (Display-P3) linear light
// with its rendering intent applied. Takes UNPACKED scalar parameters so the
// 32-byte AdjustPrePass uniform (which cannot carry a u32 flags word) can call it
// directly.
//
// Pipeline: ① TRC decode (if the source is not already linear)
//           ② gamut fold to Display-P3 (if a non-working source gamut)
//           ③ render intent tone-map — CONSTRAINT B: run STRICTLY in the STRAIGHT
//              (un-premultiplied) domain, because tone_map_filmic is non-linear and
//              would crush semi-transparent edges to black if applied to c·α.
fn normalize_source_components(
  raw_sample : vec4<f32>,
  is_linear  : bool,
  is_premult : bool,
  gamut_id   : u32,
  intent     : u32,
) -> vec4<f32> {
  var color = raw_sample;

  // ① TRC decode (RGB only — alpha is a coverage ratio, never transfer-encoded).
  if (!is_linear) {
    color = vec4<f32>(srgb_to_linear(color.rgb), color.a);
  }

  // ② Source gamut → working (Display-P3), in linear light. gamut_id 0 is a no-op.
  if (gamut_id != 0u) {
    color = vec4<f32>(gamut_to_working(color.rgb, gamut_id), color.a);
  }

  // ③ Render intent. intent 0 = SDR passthrough (untouched). intent 1 = Filmic;
  // intent 2 = DNG LUT, which falls back to Filmic until the LUT sampler lands
  // CONSTRAINT B: un-premultiply → curve → re-premultiply.
  if (intent == 1u || intent == 2u) {
    var straight = color.rgb;
    if (is_premult && color.a > 0.0001) {
      straight = color.rgb / color.a;
    }
    straight = tone_map_filmic(straight);
    if (is_premult) {
      color = vec4<f32>(straight * color.a, color.a);
    } else {
      color = vec4<f32>(straight, color.a);
    }
  }

  return color;
}

// Convenience wrapper for layer.ts / blend.ts, whose uniform carries the packed
// u32 flags word. Unpacks the bit layout (interpolated from the TS constants) and
// delegates. AdjustPrePass calls normalize_source_components directly instead.
fn normalize_layer_source(raw_sample : vec4<f32>, flags : u32) -> vec4<f32> {
  let is_linear  = (flags & ${LAYER_FLAG_SOURCE_LINEAR}u) != 0u;
  let is_premult = (flags & ${LAYER_FLAG_PREMULTIPLIED_SOURCE}u) != 0u;
  let gamut_id   = (flags >> ${LAYER_GAMUT_SHIFT}u) & ${LAYER_GAMUT_MASK}u;
  let intent     = (flags >> ${LAYER_RENDER_INTENT_SHIFT}u) & ${LAYER_RENDER_INTENT_MASK}u;
  return normalize_source_components(raw_sample, is_linear, is_premult, gamut_id, intent);
}
`;
