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
 * stroke.ts — Embedded WGSL for the compute-extruded ribbon vector render strategy
 * (vector spine, Layer B — the `StrokeRenderer` strategy, vector brush).
 *
 * TWO STAGES, TWO MODULES:
 *   1. `cs_extrude` (compute) reads the trajectory point stream and extrudes a ribbon
 *      mesh — one quad (2 triangles, 6 vertices) per segment — into a storage buffer.
 *   2. `vs_paint` / `fs_paint` (render) rasterize that ribbon with a soft-edge coverage
 *      falloff, writing STRAIGHT-alpha working-gamut linear light with REPLACE blend.
 *
 * WHY TWO SEPARATE WGSL MODULES (not one `STROKE_WGSL`): a single module cannot bind
 * both the compute stage's `pts`/`verts` and the paint stage's uniform at
 * `@group(0) @binding(0)` — bindings must be unique per module. Splitting the source
 * keeps each stage's group-0 layout clean and lets each pipeline declare only the
 * bindings its entry point actually reads. `sdf.ts` needs only one module because it
 * is fragment-only (zero geometry, zero compute).
 *
 * ── EXTRUSION GEOMETRY (capsule model) ──
 * For segment i (points a=pts[i], b=pts[i+1]): unit direction `dir = normalize(b-a)`,
 * left normal `n = (-dir.y, dir.x)`, per-endpoint half-width `ra/rb = width * 0.5`. Each
 * segment emits ONE quad that is the axis-aligned-to-the-segment BOUNDING BOX of the
 * tapered capsule — the box is extended by `rmax = max(ra, rb)` along the tangent at
 * BOTH ends (so the round end-caps have pixels to cover) and by `rmax` on each side. The
 * quad carries, at every vertex, the segment CORE (`a`, `b`) and both radii, so the
 * fragment can compute the true distance-to-capsule and round the caps / joins.
 * DEGENERATE SEGMENTS (coincident a==b) fall back to a tangent basis and a box around
 * `a`, so a duplicate point renders as a radius-`ra` disc rather than vanishing.
 *
 * WHY A DISTANCE FIELD (not uv coverage): a plain rectangular quad gives FLAT end-caps
 * and leaves wedge notches on the outer side of every turn. Rasterizing the per-segment
 * capsule SDF and unioning overlapping segments via MAX blend yields round caps at the
 * free ends and round joins at every corner, with no interior seams.
 *
 * ── THE `width` LANE (load-bearing) ──
 * The point stream's third lane is the EFFECTIVE TIP DIAMETER at that sample in logical
 * pixels — i.e. `StrokeData.size × StrokePoint.pressure`, pre-multiplied by the scene
 * mapper (`strokeToVectorSource`). It is NOT the raw 0..1 pen pressure: the compute pass
 * has no access to the paint uniform's `size`, so the brush diameter has to ride the
 * point stream. Feeding raw pressure here would clamp every stroke to a ≤1px hairline.
 *
 * ── COORDINATE SPACE ──
 * The compute pass emits positions in LOGICAL layer-local pixels (the trajectory's own
 * units). `vs_paint` maps them into NDC by dividing by `target_size` (the bounding
 * `width`/`height`), so the whole logical extent fills the transient regardless of the
 * transient's supersampled texel count — mirroring how `sdf.ts` maps uv × `layer_size`.
 *
 * ── ALPHA CONVENTION (load-bearing, same as sdf.ts) ──
 * The fragment emits STRAIGHT (un-premultiplied) alpha: `rgb` = brush colour directly,
 * `a` = colour.a × coverage. `StrokeRenderer` draws it with MAX blend (`dst = max(src,
 * dst)`) so the overlapping per-segment capsules UNION their coverage — a later segment's
 * AA edge can never punch a hole through a solid pixel a neighbour wrote, and equal-colour
 * overlaps do not double-darken. The downstream `drawLayer` applies `layer.opacity` /
 * blend / mask / adjust exactly as for any raster source. Colours arrive already in
 * WORKING-gamut (ProPhoto RGB) linear light (the scene-assembly mapper resolved them), and
 * the prepass entry is flagged `sourceIsLinear/WorkingGamut/IntentApplied = true`, so no
 * further decode / convert / tone-map runs downstream.
 *
 * @module core/gpu/shaders/stroke
 */

/** Compute workgroup size for `cs_extrude` (one invocation per segment). */
export const STROKE_EXTRUDE_WORKGROUP_SIZE = 64;

/** Bytes per input point `Pt { pos: vec2<f32>, width: f32, alpha: f32 }`. */
export const STROKE_POINT_STRIDE = 16;

/**
 * Bytes per output ribbon vertex (40 = 10 floats): `pos` vec2 (logical px, rasterized +
 * interpolated as the fragment sample point) + segment core `a` vec2 + `b` vec2 + `radii`
 * vec2 (ra, rb) + endpoint alphas vec2 (per-point opacity multipliers, interpolated by
 * the fragment). The compute writes each vertex as TEN flat f32s — the stride is not a
 * multiple of 16, so the verts storage is an `array<f32>` (f32 has 4-byte alignment),
 * NOT an `array<vec4<f32>>`. The paint pipeline reads it back with attributes at
 * offsets 0/8/16/24/32.
 */
export const STROKE_VERTEX_STRIDE = 40;

/** Ribbon vertices emitted per segment (one bounding quad = two triangles). */
export const STROKE_VERTS_PER_SEGMENT = 6;

/**
 * Paint uniform block size in bytes (48 = 12 float slots):
 * `color` vec4 (16) + `target_size` vec2 (8) + `size` f32 (4) + `hardness` f32 (4)
 * + `hard_edge` u32 (4) + 4 bytes tail padding (WGSL uniform block rounding to 16).
 */
export const STROKE_UNIFORM_BUFFER_SIZE = 48;

/**
 * COMPUTE module: extrude the capsule bounding quad from the trajectory point stream.
 *
 * Bindings (group 0):
 *   0 — `pts`   : `array<Pt>`        (read storage,       trajectory in)
 *   1 — `verts` : `array<f32>`       (read_write storage, ribbon mesh out — 10 f32/vertex)
 *
 * DISPATCH CONTRACT: `x = ceil((pointCount-1) / STROKE_EXTRUDE_WORKGROUP_SIZE)`,
 * `y = z = 1`. Each invocation owns exactly one segment i and writes the 6 vertices
 * (60 floats) at verts[i*60 .. i*60+59].
 */
export const STROKE_EXTRUDE_WGSL = /* wgsl */ `
struct Pt {
  pos   : vec2<f32>,   // logical layer-local pixels
  width : f32,         // effective tip DIAMETER here (size × pressure); half-width = width * 0.5
  alpha : f32,         // per-point paint-opacity multiplier 0..1 (absent samples = 1)
};

@group(0) @binding(0) var<storage, read>       pts   : array<Pt>;
// Flat f32 ring: a vertex is 10 floats (40 bytes) — NOT a multiple of 16, so an
// array<vec4<f32>> would misalign every vertex after the first.
@group(0) @binding(1) var<storage, read_write> verts : array<f32>;

// Write one ribbon vertex (10 flat floats): pos, coreA, coreB, radii, endpoint alphas.
fn write_vert(base : u32, pos : vec2<f32>, ca : vec2<f32>, cb : vec2<f32>, rr : vec2<f32>, al : vec2<f32>) {
  verts[base + 0u] = pos.x;  verts[base + 1u] = pos.y;
  verts[base + 2u] = ca.x;   verts[base + 3u] = ca.y;
  verts[base + 4u] = cb.x;   verts[base + 5u] = cb.y;
  verts[base + 6u] = rr.x;   verts[base + 7u] = rr.y;
  verts[base + 8u] = al.x;   verts[base + 9u] = al.y;
}

@compute @workgroup_size(${STROKE_EXTRUDE_WORKGROUP_SIZE})
fn cs_extrude(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  // Last point starts no segment; guards over-dispatch from the ceil() division too.
  if (i + 1u >= arrayLength(&pts)) { return; }

  let a = pts[i];
  let b = pts[i + 1u];

  // Tangent basis. Coincident points have no direction — fall back to a fixed basis so
  // the segment renders a disc (round dot) at 'a' instead of collapsing to nothing.
  let delta = b.pos - a.pos;
  let len = length(delta);
  var dir = vec2<f32>(1.0, 0.0);
  if (len > 1e-6) {
    dir = delta / len;
  }
  let nrm = vec2<f32>(-dir.y, dir.x);       // left normal

  let ra = a.width * 0.5;
  let rb = b.width * 0.5;
  let rmax = max(ra, rb);

  // Bounding quad of the tapered capsule: extend by rmax along the tangent at BOTH ends
  // (room for the round caps) and rmax on each side. The fragment carves the true capsule
  // out of this box via the distance field, discarding pixels outside it (coverage 0).
  let a0 = a.pos - dir * rmax;
  let b0 = b.pos + dir * rmax;
  let c0 = a0 + nrm * rmax;
  let c1 = a0 - nrm * rmax;
  let c2 = b0 + nrm * rmax;
  let c3 = b0 - nrm * rmax;

  // Segment core carried on every vertex (constant across the quad).
  let ca = a.pos;
  let cb = b.pos;
  let rr = vec2<f32>(ra, rb);

  // Per-point paint opacity rides to the fragment through the quad's endpoints.
  let al = vec2<f32>(a.alpha, b.alpha);

  // Float offset of this segment's first vertex; per-vertex stride = 10 floats.
  let vstride = ${STROKE_VERTEX_STRIDE / 4}u;
  let base = i * ${STROKE_VERTS_PER_SEGMENT}u * vstride;
  // Two triangles: (c0,c1,c2) and (c3,c2,c1). cullMode 'none', winding irrelevant.
  write_vert(base + 0u * vstride, c0, ca, cb, rr, al);
  write_vert(base + 1u * vstride, c1, ca, cb, rr, al);
  write_vert(base + 2u * vstride, c2, ca, cb, rr, al);
  write_vert(base + 3u * vstride, c3, ca, cb, rr, al);
  write_vert(base + 4u * vstride, c2, ca, cb, rr, al);
  write_vert(base + 5u * vstride, c1, ca, cb, rr, al);
}
`;

/**
 * RENDER module: rasterize the extruded capsule with a distance-field soft-edge falloff.
 *
 * Bindings (group 0):
 *   0 — `u` : `StrokeUniforms` (color / target_size / size / hardness / hard_edge) —
 *       VERTEX reads `target_size` (NDC map), FRAGMENT reads `color` + `hardness` +
 *       `hard_edge` (coverage).
 *
 * Vertex buffer: the `cs_extrude` output (arrayStride 40; pos @0, a @8, b @16, radii @24,
 * endpoint alphas @32).
 */
export const STROKE_PAINT_WGSL = /* wgsl */ `
struct StrokeUniforms {
  // offset 0 (16 bytes) — brush colour, working-gamut linear, STRAIGHT alpha.
  color       : vec4<f32>,
  // offset 16 (8 bytes) — bounding size (logical px) the trajectory maps into NDC by.
  target_size : vec2<f32>,
  // offset 24 (4 bytes) — tip diameter at pressure=1 (px). The GEOMETRY does not read
  // it (the per-point width lane already carries size × pressure); kept for
  // pixel-space feather scaling, which the current normalized falloff does not need.
  size        : f32,
  // offset 28 (4 bytes) — soft-edge hardness 0..1 (fraction of the radius kept
  // fully opaque before the edge falloff begins).
  hardness    : f32,
  // offset 32 (4 bytes) — edge style flag, packed as u32 by the renderer's Uint32
  // view. 0 = analytic smoothstep AA (default), 1 = binary hard edge
  // (coverage 1 inside the capsule, 0 outside; pixel-art pencil tip).
  hard_edge   : u32,
};

@group(0) @binding(0) var<uniform> u : StrokeUniforms;

// Group 1 — confinement coverage (selection multiply). ALWAYS bound: a stroke
// drawn without an active selection binds a 1×1 alpha=1 dummy, so one pipeline
// serves constrained and free strokes alike. Coverage rides the RED channel.
@group(1) @binding(0) var confinement_tex : texture_2d<f32>;
@group(1) @binding(1) var confinement_smp : sampler;

struct VSInput {
  @location(0) pos    : vec2<f32>,
  @location(1) core_a : vec2<f32>,
  @location(2) core_b : vec2<f32>,
  @location(3) radii  : vec2<f32>,
  // location(4): per-point opacity at the segment's endpoints.
  @location(4) alphas : vec2<f32>,
}

struct VSOut {
  @builtin(position) clip_pos : vec4<f32>,
  @location(0) p      : vec2<f32>,  // interpolated fragment position (logical px)
  @location(1) core_a : vec2<f32>,
  @location(2) core_b : vec2<f32>,
  @location(3) radii  : vec2<f32>,
  @location(4) alphas : vec2<f32>,
}

@vertex
fn vs_paint(in : VSInput) -> VSOut {
  var out : VSOut;
  // Logical pixels -> [0,1] -> NDC. y grows downward in layer space (matches sdf.ts),
  // so flip to NDC's upward y. The whole logical extent fills the (possibly
  // supersampled) transient — the texel count is a downstream sampling concern.
  let norm = in.pos / max(u.target_size, vec2<f32>(1.0, 1.0));
  out.clip_pos = vec4<f32>(norm.x * 2.0 - 1.0, 1.0 - norm.y * 2.0, 0.0, 1.0);
  out.p = in.pos;
  out.core_a = in.core_a;
  out.core_b = in.core_b;
  out.radii = in.radii;
  out.alphas = in.alphas;
  return out;
}

@fragment
fn fs_paint(in : VSOut) -> @location(0) vec4<f32> {
  // Distance from the fragment to the tapered-capsule core: project onto the segment,
  // clamp to [0,1] (so the ends round into caps), and interpolate the radius.
  let ba = in.core_b - in.core_a;
  let pa = in.p - in.core_a;
  let denom = max(dot(ba, ba), 1e-8);
  let t = clamp(dot(pa, ba) / denom, 0.0, 1.0);
  let c = in.core_a + t * ba;
  let r = max(mix(in.radii.x, in.radii.y, t), 1e-4);

  // Per-point paint opacity, interpolated along the segment the same way the
  // radius is (pressure-opacity dynamics: pen pressure → ink density).
  let ptAlpha = mix(in.alphas.x, in.alphas.y, t);

  // Normalized radial distance: 0 on the core, 1 at the capsule edge, >1 outside.
  let dn = length(in.p - c) / r;

  // Selection confinement: the fragment's normalized position samples the frozen
  // selection's baked coverage 1:1 (the texture spans the transient's logical
  // extent). COVERAGE RIDES THE ALPHA CHANNEL (vmask bake convention: .a =
  // coverage, .rgb = 1). Unconstrained strokes sample the 1×1 dummy (coverage
  // 1) — a free stroke multiplies by exactly 1 and stays bit-identical to the
  // pre-confinement pipeline. Multiplied BEFORE the MAX union so every
  // overlapping segment's contribution carries the same selection falloff.
  let conf = textureSampleLevel(confinement_tex, confinement_smp, in.p / max(u.target_size, vec2<f32>(1.0, 1.0)), 0.0).a;

  // Hard-edge branch: binary capsule coverage — every sample inside the capsule
  // (dn <= 1) is fully opaque, everything outside fully transparent. hardness is
  // ignored (the hard-edge flag only makes sense with a fully-hard tip). No
  // fwidth term: the step lands exactly on the geometry edge (pixel-art look).
  if (u.hard_edge == 1u) {
    let cov = select(0.0, 1.0, dn <= 1.0);
    return vec4<f32>(u.color.rgb, u.color.a * cov * conf * ptAlpha);
  }

  // Analytic edge AA from the screen-space gradient, so the geometric edge stays smooth
  // at any zoom / export scale.
  let aa = max(fwidth(dn), 1e-5);

  // hardness = fraction of the radius held fully opaque; the remainder feathers to the
  // edge. hardness→1 is a near-hard edge (still AA'd), 0 a soft brush.
  let inner = clamp(u.hardness, 0.0, 1.0 - aa);
  let cov = 1.0 - smoothstep(inner, 1.0, dn);

  // STRAIGHT alpha — downstream drawLayer premultiplies and applies layer.opacity.
  return vec4<f32>(u.color.rgb, u.color.a * cov * conf * ptAlpha);
}
`;
