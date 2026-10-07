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
 * text.ts — Embedded WGSL for the instanced glyph vector render strategy
 * (vector spine, Layer B — the `TextRenderer` strategy, GPU text).
 *
 * ONE MODULE, TWO ENTRY POINTS: unlike the stroke strategy (which needs a
 * compute stage and therefore two modules — its storage bindings and uniform
 * cannot share `@group(0) @binding(0)`), text is a pure render strategy: both
 * entry points share the same group-0 bindings (uniform + atlas texture +
 * sampler), so a single module keeps the pipeline layout minimal.
 *
 * ── INSTANCING MODEL ──
 * One instance per GLYPH (and per decoration rect). Buffer 0 is the shared
 * unit quad (vertex step, 6 vertices: pos + uv, only `corner` pos is read);
 * buffer 1 carries per-instance data: the quad's top-left origin and size in
 * LOGICAL layer-local pixels (from the CPU `TextLayout` — the renderer never
 * re-computes layout), plus the glyph's ink-box UV rect in the coverage atlas.
 * The vertex stage assembles `origin + corner × size` and maps it into NDC via
 * `target_size` exactly like `stroke.ts`/`sdf.ts` — the whole logical extent
 * fills the (possibly supersampled) transient, so export density renders
 * denser texels from the same logical geometry.
 *
 * ── COVERAGE SAMPLING ──
 * The atlas is a grayscale (r-channel) coverage texture rasterized at
 * `fontSize × band` physical px; the fragment multiplies coverage × text
 * colour. Per-glyph AA lives in the atlas raster (the band is quantized ≥
 * target density, so coverage is never linearly UPsampled — see
 * `glyphAtlas.ts`); no fwidth analytic edge here, unlike the SDF strategy.
 * Decoration quads (underline/strikethrough) sample a reserved all-white 1×1
 * pixel in the atlas (coverage 1), so the fragment stage is uniform for both
 * glyph and decoration instances.
 *
 * ── ALPHA CONVENTION (load-bearing, same as sdf.ts / stroke.ts) ──
 * The fragment emits STRAIGHT (un-premultiplied) alpha: rgb = text colour, a =
 * colour.a × coverage. TextRenderer draws with MAX blend so overlapping glyph
 * coverage (negative letterSpacing, underline crossing descenders) unions
 * without holes or double-darkening. Downstream `drawLayer` applies
 * layer.opacity / blend / mask / adjust as for any raster source.
 *
 * @module core/gpu/shaders/text
 */

/**
 * Uniform block size in bytes (32 = 8 float slots): `color` vec4 (16) +
 * `target_size` vec2 (8) + 8 bytes tail padding (WGSL uniform block rounding).
 */
export const TEXT_UNIFORM_BUFFER_SIZE = 32;

/** Bytes per instance: origin vec2 + size vec2 + uv_min vec2 + uv_size vec2. */
export const TEXT_INSTANCE_STRIDE = 32;

export const TEXT_PAINT_WGSL = /* wgsl */ `
struct TextUniforms {
  // offset 0 (16 bytes) — text colour, working-gamut linear, STRAIGHT alpha.
  color       : vec4<f32>,
  // offset 16 (8 bytes) — bounding size (logical px) the glyph quads map into NDC by.
  target_size : vec2<f32>,
  // offset 24 (8 bytes) — tail padding (uniform block rounding to 16).
  _pad        : vec2<f32>,
};

@group(0) @binding(0) var<uniform> u    : TextUniforms;
@group(0) @binding(1) var atlas_tex     : texture_2d<f32>;
@group(0) @binding(2) var atlas_samp    : sampler;

struct VSInput {
  // Buffer 0 (vertex step): shared unit quad.
  @location(0) corner  : vec2<f32>,
  // Buffer 1 (instance step): per-glyph quad + atlas ink rect.
  @location(2) origin  : vec2<f32>,
  @location(3) size    : vec2<f32>,
  @location(4) uv_min  : vec2<f32>,
  @location(5) uv_size : vec2<f32>,
};

struct VSOut {
  @builtin(position) clip_pos : vec4<f32>,
  @location(0) uv             : vec2<f32>,
};

@vertex
fn vs_text_instanced(in : VSInput) -> VSOut {
  var out : VSOut;
  // Assemble the glyph quad in LOGICAL layer-local px, then map to NDC the
  // same way stroke.ts maps its ribbon: divide by target_size, flip y.
  let p = in.origin + in.corner * in.size;
  let norm = p / max(u.target_size, vec2<f32>(1.0, 1.0));
  out.clip_pos = vec4<f32>(norm.x * 2.0 - 1.0, 1.0 - norm.y * 2.0, 0.0, 1.0);
  out.uv = in.uv_min + in.corner * in.uv_size;
  return out;
}

@fragment
fn fs_text(in : VSOut) -> @location(0) vec4<f32> {
  // Grayscale coverage × tint. Decoration quads sample the reserved white
  // pixel (coverage 1). STRAIGHT alpha — downstream drawLayer premultiplies
  // and applies layer.opacity.
  let cov = textureSample(atlas_tex, atlas_samp, in.uv).r;
  return vec4<f32>(u.color.rgb, u.color.a * cov);
}
`;
