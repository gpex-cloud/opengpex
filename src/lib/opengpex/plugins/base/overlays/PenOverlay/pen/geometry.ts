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
 * penGeometry.ts — Pure coordinate / flatten / fit bridges for the pen tool.
 *
 * All functions take their dependencies (matrices, bézier operators) as
 * arguments so the module stays DOM-free and unit-testable; production call
 * sites pass the `GeometryService` pieces, tests pass the same operators
 * directly. Plugin code never imports the geometry operators itself (the
 * ESLint boundary) — it receives them injected from the service.
 */

import type { CubicSegment, IMatrix3x3, Layer, PenAnchor, PenPathData, PenSubPath, Point2D } from '@opengpex/editor/core/types';

// ─── Coordinate mapping: canvas ↔ layer-local ─────────────────────────────────

/**
 * Bidirectional canvas ↔ layer-local point mapping derived from the layer's
 * canvas matrix (the same `getLayerLocalMatrix` the renderer uses: layer-local
 * → canvas). `scale` is the layer's uniform-ish scale factor, used to convert
 * screen-pixel hit tolerances into layer-local distances.
 */
export interface LayerPointMapping {
  toLayer: (canvasPt: Point2D) => Point2D;
  toCanvas: (layerPt: Point2D) => Point2D;
  /** Approximate layer-local units per canvas px. */
  scale: number;
}

export function makeLayerPointMapping(layerToCanvas: IMatrix3x3): LayerPointMapping {
  const canvasToLayer = layerToCanvas.inverse();
  const scale = Math.hypot(layerToCanvas.a, layerToCanvas.b) || 1;
  return {
    toLayer: (p) => canvasToLayer.apply(p),
    toCanvas: (p) => layerToCanvas.apply(p),
    scale,
  };
}

/** Convenience overload: mapping for a layer inside a canvas of `canvasDim`. */
export function layerPointMapping(layer: Layer, canvasDim: { w: number; h: number }, getLayerLocalMatrix: (l: Layer, c: { w: number; h: number }) => IMatrix3x3): LayerPointMapping {
  return makeLayerPointMapping(getLayerLocalMatrix(layer, canvasDim));
}

/**
 * Converts a screen-pixel distance into layer-local units for `layer`:
 * screen px → canvas px divides by the camera zoom; canvas px → layer-local
 * divides by the layer's own scale.
 */
export function screenToleranceToLayer(screenPx: number, cameraZoom: number, mapping: LayerPointMapping): number {
  return screenPx / (cameraZoom * mapping.scale);
}

// ─── Flatten / fit bridges ─────────────────────────────────────────────────────

/** Minimal bézier surface the pen needs (matches GeometryService.bezier). */
export interface PenBezierOps {
  penPathToCubicSegments(path: PenPathData): CubicSegment[];
  flattenCubicChain(segments: readonly CubicSegment[], toleranceDocPx: number): Point2D[];
  fitCubicsToPolyline(ring: readonly Point2D[], toleranceDocPx: number, closed: boolean): PenAnchor[];
}

/**
 * Flattens one anchor subpath to a polyline. Closed subpaths yield a ring
 * whose last point repeats the first (the mask/selection pipeline's ring
 * convention); open subpaths yield the bare polyline. Returns null for
 * subpaths that produce fewer than 2 points.
 */
export function flattenSubPath(sub: PenSubPath, ops: PenBezierOps, toleranceDocPx: number): Point2D[] | null {
  const pts = ops.flattenCubicChain(ops.penPathToCubicSegments({ paths: [sub] }), toleranceDocPx);
  if (pts.length < 2) return null;
  if (sub.closed) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) > 1e-6) pts.push({ x: first.x, y: first.y });
  }
  return pts;
}

/**
 * Fits each ring of a selection into a closed pen subpath (Schneider fit).
 * Tiny / degenerate rings (fewer than 3 points) are dropped. This is the
 * "selection → pen draft" conversion used by Import-selection.
 */
export function ringsToPenSubPaths(rings: readonly (readonly Point2D[])[], ops: PenBezierOps, toleranceDocPx: number): PenSubPath[] {
  const subs: PenSubPath[] = [];
  for (const ring of rings) {
    if (ring.length < 3) continue;
    const anchors = ops.fitCubicsToPolyline(ring, toleranceDocPx, true);
    // 2-anchor closed rings are legitimate (two arcs ≈ a circle) — the same
    // projection minimum the commit path enforces.
    if (anchors.length >= 2) subs.push({ anchors, closed: true });
  }
  return subs;
}

/**
 * One pass of a closed-ring 1-2-1 neighbour average. Applied iteratively this
 * is a cheap low-pass filter: high-frequency vertex jitter (pixel staircase
 * harmonics, worker noise) melts away, which matters because the Schneider
 * fitter turns EVERY detected corner into a forced anchor — on a jittery ring
 * nearly every vertex reads as a corner and no tolerance increase helps.
 */
function smoothClosedRing(ring: readonly Point2D[]): Point2D[] {
  const n = ring.length;
  return ring.map((pt, i) => {
    const a = ring[(i - 1 + n) % n];
    const b = ring[(i + 1) % n];
    return { x: (a.x + 2 * pt.x + b.x) / 4, y: (a.y + 2 * pt.y + b.y) / 4 };
  });
}

/**
 * Budget-driven variant of {@link ringsToPenSubPaths}: starts at the base
 * tolerance and, while the fitted anchor count exceeds the budget, scales the
 * tolerance up, adds one more smoothing pass to the rings and refits.
 * Tolerance scaling alone converges on detailed-but-smooth inputs; the
 * smoothing pass is what converges jittery ones (corner-forced anchors — see
 * {@link smoothClosedRing}). The round cap keeps a pathological input from
 * hanging the conversion — past it the last fit is accepted (the budget is a
 * UX target, not a hard invariant). Returns the subpaths plus the counts the
 * caller reports in the HUD ("N anchors from M vertices") so users can see
 * that simplification happened.
 */
export function ringsToPenSubPathsBudgeted(
  rings: readonly (readonly Point2D[])[],
  ops: PenBezierOps,
  budget: number,
  baseToleranceDocPx: number,
): { subs: PenSubPath[]; anchorCount: number; vertexCount: number; toleranceDocPx: number } {
  const vertexCount = rings.reduce((sum, ring) => sum + ring.length, 0);
  const MAX_ROUNDS = 12;
  const countAnchors = (subs: PenSubPath[]) => subs.reduce((sum, sub) => sum + sub.anchors.length, 0);
  let tolerance = baseToleranceDocPx;
  let current = rings.map((ring) => ring.slice());
  let subs = ringsToPenSubPaths(current, ops, tolerance);
  for (let round = 0; round < MAX_ROUNDS && countAnchors(subs) > budget; round++) {
    tolerance *= 1.6;
    current = current.map((ring) => (ring.length >= 3 ? smoothClosedRing(ring) : ring));
    subs = ringsToPenSubPaths(current, ops, tolerance);
  }
  return { subs, anchorCount: countAnchors(subs), vertexCount, toleranceDocPx: tolerance };
}

/**
 * Maps a committed layer's `penData` (layer-local anchors) into draft subpaths
 * under an arbitrary point map (layer-local → frame-local for "release path to
 * draft"). Handles are stored RELATIVE to their anchor, so each handle is
 * mapped as an absolute endpoint and re-based onto the mapped anchor — a plain
 * copy would ignore the map's translation and scale.
 */
export function penDataToFrameSubPaths(penData: PenPathData, map: (p: Point2D) => Point2D): PenSubPath[] {
  return penData.paths.map((sub) => ({
    closed: sub.closed,
    anchors: sub.anchors.map((a: PenAnchor) => {
      const p = map({ x: a.x, y: a.y });
      const rel = (h: { x: number; y: number } | null | undefined) => {
        if (!h) return null;
        const e = map({ x: a.x + h.x, y: a.y + h.y });
        return { x: e.x - p.x, y: e.y - p.y };
      };
      return { x: p.x, y: p.y, handleIn: rel(a.handleIn), handleOut: rel(a.handleOut) };
    }),
  }));
}
