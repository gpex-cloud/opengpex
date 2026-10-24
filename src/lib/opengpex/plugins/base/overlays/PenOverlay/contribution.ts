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
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * contribution.ts — the pen plugin's translation into the engine's vector
 * source vocabulary: business `penData` (+ `penStyle`) → `renderer: 'face'`
 * LayerSource. This is the plugin's ENTIRE exposure to the engine's scene
 * assembly; the engine never imports this module (wired through the plugin
 * registry's `contributions.engine.vectorSource` slot).
 *
 * Geometry pipeline (spec §14.3):
 *   penData ─ flatten (L0 operators, 0.25 doc px) ─▶ closed polylines
 *           ─ nest by parity ─▶ outer/hole ring sets
 *           ─ unionRingsMulti (poly-clip; cleans self-intersections) ─▶
 *             simple polygon sets
 *           ─ tessellate.ts (ear clip + hole bridging) ─▶ fill triangles
 *           ─ boundary extrusion + round joins ─▶ edge quads
 *           ─▶ packed FaceParams.verts [x, y, dist, kind]
 *
 * SEMANTICS NOTE (documented deviation, spec §14.3): properly nested rings
 * union to exactly the even-odd region; a SELF-INTERSECTING single ring is
 * interpreted by union semantics, not even-odd — an edge case produced only
 * by mis-anchored paths, accepted for this renderer.
 *
 * COST: flattening + normalization + tessellation run only on a digest MISS;
 * the packed vertex stream is memoized (cap 8) so the per-frame translate is
 * an O(1) digest + a reference hand-off. SceneAssembler calls translate every
 * frame — this cache is why that is affordable.
 */

import type { Layer, PenPathData, PenSubPath } from '@opengpex/editor/core/types';
import type { ColorValue } from '@opengpex/editor/core/engine/color/ColorValue';
import { toWorkingLinearRgba } from '@opengpex/editor/core/engine/color';
import type {
  LayerSource,
  VectorSourceContributor,
  VectorSourceContext,
} from '@opengpex/editor/core/engine/pipeline/scene/vectorSources';
import {
  penPathToCubicSegments,
  flattenCubicChain,
  fitCubicsToPolyline,
} from '@opengpex/editor/core/geometry/public';
import { computeRingArea, isPointInPolygon } from '@opengpex/editor/core/geometry/public';
import { flattenSubPath, type PenBezierOps } from './pen/geometry';
import { triangulateFaces, type Pt, type SimplePolygon } from '@opengpex/editor/core/geometry/tessellate';
import { unionRingsMulti } from '@opengpex/editor/core/geometry/poly-clip';
import { PEN_FLATTEN_TOLERANCE_DOC_PX } from './protocols';

/** The L0 operator module satisfies the PenBezierOps structural contract. */
export const L0_OPS: PenBezierOps = { penPathToCubicSegments, flattenCubicChain, fitCubicsToPolyline };


// ─── Ring classification (parity nesting) ──────────────────────────────────────

/**
 * Groups flattened rings into simple polygons by CONTAINMENT PARITY: a ring
 * nested inside an even number of others is an outer, odd = a hole of its
 * immediate container. Drawing order independent — the pen session lets a
 * user draw a hole before its outer, which `poly-clip`'s own outer-first
 * order contract would misread as an island.
 */
function classifyRings(rings: readonly (readonly Pt[])[]): SimplePolygon[] {
  const depth = rings.map((r) => {
    // Containment by the ring's first vertex against all other rings.
    let count = 0;
    for (const other of rings) {
      if (other !== r && other.length >= 3 && isPointInPolygon(r[0], [other])) count++;
    }
    return count;
  });
  const outers: SimplePolygon[] = [];
  for (let i = 0; i < rings.length; i++) {
    if (depth[i] % 2 === 0) outers.push({ outer: rings[i], holes: [] });
  }
  for (let i = 0; i < rings.length; i++) {
    if (depth[i] % 2 === 1) {
      // Immediate container: the outer with the smallest area containing this hole.
      let best: SimplePolygon | null = null;
      let bestArea = Infinity;
      for (const poly of outers) {
        if (poly.outer.length >= 3 && isPointInPolygon(rings[i][0], [poly.outer])) {
          const area = computeRingArea(poly.outer);
          if (area < bestArea) {
            best = poly;
            bestArea = area;
          }
        }
      }
      best?.holes.push(rings[i] as Pt[]);
    }
  }
  return outers;
}

// ─── Face geometry build (cached) ──────────────────────────────────────────────

interface FaceGeometry {
  verts: Float32Array;
  vertexCount: number;
  hasFill: boolean;
  hasEdge: boolean;
}

const GEOMETRY_CACHE_MAX = 8;
const geometryCache = new Map<string, FaceGeometry>();

/**
 * Fill-only AA rim: covers the aliased triangle boundary with a same-colour
 * 0.75px-total hairline (no density channel exists at translate time).
 */
const EDGE_HAIRLINE_HALF_WIDTH = 0.375;

/**
 * Stable digest of the render-relevant business state. Key order independent
 * (recursive sorted-key stringify) so programmatic anchor edits that rebuild
 * objects with different key order don't spuriously invalidate the cache.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function flattenPenData(penData: PenPathData): Pt[][] {
  const rings: Pt[][] = [];
  for (const sub of penData.paths) {
    // Every subpath participates in the fill with SVG semantics: OPEN
    // subpaths are implicitly closed (a 2-anchor sliver has zero area and
    // simply contributes nothing after normalization).
    const closedSub: PenSubPath = { ...sub, closed: true };
    const pts = flattenSubPath(closedSub, L0_OPS, PEN_FLATTEN_TOLERANCE_DOC_PX);
    if (pts && pts.length >= 3) rings.push(pts);
  }
  return rings;
}

/**
 * Packs the boundary BAND geometry for one closed ring: a quad per segment
 * (signed distance across the half width) plus a ROUND-JOIN fan per vertex —
 * a `FAN_SEGMENTS`-segment disc of radius hw centred on the vertex (centre
 * dist 0, rim dist +hw). The disc covers BOTH the outer and the inner wedge
 * at every corner, so the band is continuous with no fins and no notches,
 * and corners render as round joins of radius hw.
 *
 * Blend contract: the edge pass runs plain src-over (STRAIGHT_OVER_BLEND) —
 * a dark stroke must paint OVER a lighter fill, which channel-wise `max`
 * cannot do. Same-colour overlaps between the fans and the quads are benign
 * under src-over (solid interior over solid interior); their AA fringes
 * cross only along 1px junction arcs.
 *
 * History note: a miter variant (quads extended past each vertex by
 * hw/tan(θ/2)) produced blocky fins at sharp corners — the extension's INNER
 * rim crosses the neighbouring band and pokes out its far side (measured
 * 2.1× hw from the path), and a linear dist attribute cannot express the
 * miter wedge's AA anyway. Round joins keep every band vertex within hw of
 * the path.
 */
const FAN_SEGMENTS = 16;

function pushRingEdges(
  verts: number[],
  ring: readonly Pt[],
  hw: number,
): void {
  const n = ring.length;
  if (n < 2) return;
  for (let i = 0; i < n; i++) {
    const p0 = ring[i];
    const p1 = ring[(i + 1) % n];
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const nx = -dy / len * hw;
    const ny = dx / len * hw;
    // Quad: p0-n*hw, p1-n*hw, p1+n*hw | p0-n*hw, p1+n*hw, p0+n*hw
    verts.push(
      p0.x - nx, p0.y - ny, -hw, 1,
      p1.x - nx, p1.y - ny, -hw, 1,
      p1.x + nx, p1.y + ny, hw, 1,
      p0.x - nx, p0.y - ny, -hw, 1,
      p1.x + nx, p1.y + ny, hw, 1,
      p0.x + nx, p0.y + ny, hw, 1,
    );
    // Round-join fan at p1 (caps the corner between this and the next segment).
    for (let k = 0; k < FAN_SEGMENTS; k++) {
      const a0 = (k / FAN_SEGMENTS) * Math.PI * 2;
      const a1 = ((k + 1) / FAN_SEGMENTS) * Math.PI * 2;
      verts.push(
        p1.x, p1.y, 0, 1,
        p1.x + Math.cos(a0) * hw, p1.y + Math.sin(a0) * hw, hw, 1,
        p1.x + Math.cos(a1) * hw, p1.y + Math.sin(a1) * hw, hw, 1,
      );
    }
  }
}

function buildFaceGeometry(penData: PenPathData, strokeHalfWidth: number): FaceGeometry | null {
  const rings = flattenPenData(penData);
  if (rings.length === 0) return null;

  // Normalize: parity nesting → Martinez union (cleans self-intersections,
  // keeps outer+holes structure). Degenerate unions degrade to null → no face.
  const normalized = unionRingsMulti(
    ...classifyRings(rings).map((p) => [p.outer as Pt[], ...p.holes.map((h) => h as Pt[])]),
  );
  if (!normalized || normalized.length === 0) return null;

  const fill = triangulateFaces(normalized.map((poly) => ({ outer: poly[0], holes: poly.slice(1) })));

  // Edge geometry MUST be extruded at the final half width: the shader's
  // edge_half_width uniform can only fade coverage WITHIN the existing quads,
  // never widen them — a hairline-extruded ring with a 6px uniform still
  // renders a 0.75px stroke. With a stroke configured the extrusion IS the
  // stroke width; fill-only faces keep the fixed 0.75px AA hairline rim.
  const hw = Math.max(strokeHalfWidth, EDGE_HAIRLINE_HALF_WIDTH);
  const verts: number[] = [];
  let vertexCount = 0;
  for (let i = 0; i < fill.triangleCount; i++) {
    for (let k = 0; k < 3; k++) {
      verts.push(fill.positions[i * 6 + k * 2], fill.positions[i * 6 + k * 2 + 1], 0, 0);
      vertexCount++;
    }
  }
  const hasFill = fill.triangleCount > 0;

  for (const poly of normalized) {
    for (const ring of poly) {
      if (ring.length < 2) continue;
      const before = vertexCount;
      pushRingEdges(verts, ring, hw);
      vertexCount += (verts.length / 4) - before;
    }
  }
  const hasEdge = vertexCount > (hasFill ? fill.triangleCount * 3 : 0);

  if (vertexCount === 0) return null;
  return { verts: new Float32Array(verts), vertexCount, hasFill, hasEdge };
}

function getCachedFaceGeometry(digest: string, penData: PenPathData, strokeHalfWidth: number): FaceGeometry | null {
  const hit = geometryCache.get(digest);
  if (hit) {
    // LRU touch: re-insert to move the key to the newest position.
    geometryCache.delete(digest);
    geometryCache.set(digest, hit);
    return hit;
  }
  const built = buildFaceGeometry(penData, strokeHalfWidth);
  geometryCache.set(digest, built ?? { verts: new Float32Array(0), vertexCount: 0, hasFill: false, hasEdge: false });
  if (geometryCache.size > GEOMETRY_CACHE_MAX) {
    const oldest = geometryCache.keys().next().value;
    if (oldest !== undefined && oldest !== digest) geometryCache.delete(oldest);
  }
  return built;
}

// ─── Translator ────────────────────────────────────────────────────────────────

/** Style payload for `cmd.pen_create_shape` (mirrors PenLayerStyle channels). */
export interface PenShapeStylePayload {
  fill?: ColorValue | null;
  stroke?: { color: ColorValue; width: number } | null;
}

/** Default panel fill for a new shape (#0d99ff, sRGB) — see PenPanel. */
export const PEN_DEFAULT_FILL_HEX = '#0d99ff';

function faceToVectorSource(
  layer: Layer,
  ctx: VectorSourceContext,
): LayerSource | undefined {
  const data = layer.penData;
  if (!data || layer.type !== 'vector' || data.paths.length === 0) return undefined;
  const style = layer.penStyle;
  const fill = style?.fill ?? null;
  const stroke = style?.stroke ?? null;
  if (!fill && !stroke) return undefined; // nothing to paint → not mappable

  const digest = stableStringify({ p: data, s: style ?? null });
  // With a stroke, the edge quads ARE the stroke: extrude at its half width
  // (digest includes the style, so width edits rebuild the geometry).
  const strokeHalfWidth = stroke ? Math.max(0.5, stroke.width) / 2 : EDGE_HAIRLINE_HALF_WIDTH;
  const geo = getCachedFaceGeometry(digest, data, strokeHalfWidth);
  if (!geo || geo.vertexCount < 3) return undefined;

  const w = Math.max(1, ctx.width ?? 0);
  const h = Math.max(1, ctx.height ?? 0);
  const fillColor = fill
    ? toWorkingLinearRgba(fill, ctx.workingSpace)
    : ([0, 0, 0, 0] as const);
  const edgeColor = stroke
    ? toWorkingLinearRgba(stroke.color, ctx.workingSpace)
    : fillColor; // fill-only: hairline same-colour AA rim (see buildFaceGeometry)

  return {
    kind: 'vector',
    renderer: 'face',
    face: {
      verts: geo.verts,
      vertexCount: geo.vertexCount,
      fillColor: fillColor as readonly [number, number, number, number],
      edgeColor: edgeColor as readonly [number, number, number, number],
      strokeWidth: stroke?.width ?? 0.75, // fill-only: the 0.75px AA ring's full width
      width: w,
      height: h,
      digest,
    },
  };
}

/** The pen plugin's entire exposure to the engine's vector-source registry. */
export const penContributor: VectorSourceContributor = {
  toolId: 'pen',
  translate: faceToVectorSource,
};

// ─── Style helpers shared with the panel ───────────────────────────────────────

/** Parses an `#rrggbb` hex string into a simple sRGB ColorValue. */
export function srgbHexToColorValue(hex: string, alpha = 1): ColorValue {
  const n = hex.replace('#', '');
  return {
    space: 'srgb',
    coords: {
      r: parseInt(n.slice(0, 2), 16) / 255,
      g: parseInt(n.slice(2, 4), 16) / 255,
      b: parseInt(n.slice(4, 6), 16) / 255,
    },
    alpha,
    hex,
  };
}
