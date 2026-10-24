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
 * face.ts — Embedded WGSL for the face vector render strategy (vector spine).
 *
 * The `FaceRenderer` draws CPU-prebuilt geometry in one vertex stream of two
 * vertex KINDS (per-vertex `kind` attribute, flat-interpolated):
 *
 *   kind 0 — FILL triangles: ear-clipped interior triangles of normalized
 *            simple polygons (outer rings with holes bridged). Painted with
 *            `fill_color` at full coverage; the `dist` attribute is ignored.
 *   kind 1 — EDGE quads/joins: thin quads extruded along each boundary segment
 *            plus round-join fans at the vertices. `dist` carries the signed
 *            distance to the boundary centerline in logical px (0 at the
 *            centerline, ±half-width at the quad rim, radial on join fans);
 *            coverage falls off via smoothstep for analytic AA, and the colour
 *            is `edge_color`. With a stroke configured this IS the visible
 *            stroke; fill-only faces use a hairline same-colour edge ring as
 *            the AA rim over the aliased triangle boundary.
 *
 * Two pipelines consume this module (`getFaceFillPipeline` / `getFaceEdgePipeline`
 * in PipelineCache): they differ ONLY in blend — fill uses REPLACE (normalized
 * triangles never overlap), edge uses MAX (neighbouring edge quads overlap at
 * joins; per-channel max = coverage union, the same white-speckle fix the
 * stroke paint pipeline uses). Colours arrive in WORKING-gamut linear light,
 * straight alpha; NO layer_opacity/mask term (downstream drawLayer's job) —
 * the same output contract as sdf/stroke.
 *
 * Geometry arrives in LOGICAL layer-local px; `vs_face` maps to NDC by
 * dividing by `target_size` (y flipped), identical to `stroke.ts` / `sdf.ts`.
 *
 * NAMING NOTE: "face" here is the REGION enclosed by the boundary rings — it
 * is unrelated to the GPU/mesh sense of face (a mesh triangle; front/back-face
 * culling), and the renderer never reads mesh topology.
 *
 * @module core/gpu/shaders/face
 */

export const FACE_WGSL = /* wgsl */ `
struct FaceUniforms {
  fill_color      : vec4<f32>,  // offset 0  — working-gamut linear, straight alpha
  edge_color      : vec4<f32>,  // offset 16 — working-gamut linear, straight alpha
  target_size     : vec2<f32>,  // offset 32 — bounding logical px (NDC map)
  edge_half_width : f32,        // offset 40 — logical px
  _pad0           : f32,        // offset 44
}                                 // sizeof = 48 (multiple of 16)

struct VSInput {
  @builtin(vertex_index) vi : u32,
  @location(0) pos  : vec2<f32>,  // logical layer-local px
  @location(1) dist : f32,        // signed distance to boundary centerline (px)
  @location(2) kind : f32,        // 0 fill triangle, 1 edge quad/join (f32: the project's minimal GPUVertexFormat has no uint types)
}

struct VSOut {
  @builtin(position) clip_pos : vec4<f32>,
  @location(0) dist : f32,
  @location(1) @interpolate(flat) kind : f32,
}

@vertex
fn vs_face(in : VSInput) -> VSOut {
  var out : VSOut;
  // Logical px -> [0,1] -> NDC; y grows downward in layer space, flip (same
  // convention as stroke.ts / sdf.ts).
  let norm = in.pos / max(u.target_size, vec2<f32>(1.0, 1.0));
  out.clip_pos = vec4<f32>(norm.x * 2.0 - 1.0, 1.0 - norm.y * 2.0, 0.0, 1.0);
  out.dist = in.dist;
  out.kind = in.kind;
  return out;
}

@group(0) @binding(0) var<uniform> u : FaceUniforms;

@fragment
fn fs_face(in : VSOut) -> @location(0) vec4<f32> {
  // UNIFORM CONTROL FLOW CONTRACT: fwidth() must run outside any non-uniform
  // branch (kind is a per-vertex attribute, so an early-return on its value
  // fails WGSL validation). Both colour paths are computed unconditionally;
  // select() picks per fragment.
  let aa = max(fwidth(in.dist), 1e-4);
  let coverage = 1.0 - smoothstep(u.edge_half_width - aa, u.edge_half_width + aa, abs(in.dist));
  let edge = vec4<f32>(u.edge_color.rgb, u.edge_color.a * coverage);
  return select(edge, u.fill_color, in.kind < 0.5);
}
`;

/** sizeof(FaceUniforms) — uniform scratch packing + bind group min size. */
export const FACE_UNIFORM_BUFFER_SIZE = 48;

/** Vertex stride of the packed stream: [x, y, dist, kind] = 16 bytes. */
export const FACE_VERTEX_STRIDE = 16;
