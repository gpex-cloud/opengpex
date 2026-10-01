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
 * poly-clip.ts — Polygon ∩ Polygon intersection using polygon-clipping library.
 *
 * Handles the general case: arbitrary polygon ∩ arbitrary polygon (including rect,
 * which is just a 4-point polygon), enabling exact geometric intersection for both
 * simple selections and holed/multi-ring shapes. `intersectWithLayer` (shape.ts)
 * routes every non-trivial case here; the former dedicated rect-clipper (`sut-hod.ts`,
 * Sutherland-Hodgman) was retired because it couldn't represent hole topology and
 * produced illegal double-ring output — see the M2/M3 design doc.
 *
 * Algorithm: Martinez-Rueda-Feito (via polygon-clipping@0.15.7)
 * Time complexity: O((n + k) log n) where n = total vertices, k = intersections.
 *
 * Public API:
 *   intersectPathWithPath(pathDataA, pathDataB)  → { pathData, rect } | null
 *   differencePathWithPath(pathDataA, pathDataB) → { pathData, rect } | null
 */

import type { Rect } from '@opengpex/editor/core/types';
import { parsePathDataToRings } from './operators/point2d';
import polygonClipping from 'polygon-clipping';

type Pt = { x: number; y: number };
type Ring = [number, number][];
type Polygon = Ring[];
type MultiPolygon = Polygon[];

function pointInRing(pt: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x, yi = ring[i].y;
    const xj = ring[j].x, yj = ring[j].y;
    const intersect = ((yi > pt.y) !== (yj > pt.y)) &&
      (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Representative interior point used to test ring-in-ring containment.
 *
 * The centroid (not the first vertex) is used deliberately: a ring produced by
 * a lasso/wand selection can have a vertex sitting exactly ON the parent ring's
 * boundary (a "keyhole" touch), where ray-casting containment is ill-defined.
 * The centroid of a hole/child ring is virtually never on the parent's edge.
 * Caveat: for a strongly non-convex ring the centroid can itself fall outside
 * the ring — still a looser assumption than "first vertex", not a proof.
 */
function centroid(pts: Pt[]): Pt {
  let sx = 0, sy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; }
  return { x: sx / pts.length, y: sy / pts.length };
}

/** Shoelace area (unsigned) of an open ring (no closing duplicate required). */
function ringAreaPts(pts: Pt[]): number {
  let area = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    area += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  }
  return Math.abs(area) / 2;
}

/** Shoelace area (unsigned) of a closed `Ring` (polygon-clipping coord format). */
function ringAreaFromCoords(coords: Ring): number {
  const pts = coords.map(([x, y]) => ({ x, y }));
  if (pts.length > 1) {
    const first = pts[0], last = pts[pts.length - 1];
    if (first.x === last.x && first.y === last.y) pts.pop();
  }
  return ringAreaPts(pts);
}

/**
 * Convert Point2D rings to polygon-clipping format.
 * polygon-clipping expects closed rings: first point === last point.
 * Distinguishes holes (contained in an outer ring) from separate polygon islands.
 *
 * INPUT ORDER CONTRACT: within a single ring set, a ring's outer boundary must
 * appear BEFORE any of its holes/nested rings (matches `Shape.pathData`'s own
 * convention: rings[0] = outer, rings[1..] = holes). Classification below is a
 * single left-to-right pass — a hole listed ahead of its outer has no existing
 * polygon to nest into yet and is silently registered as its own top-level
 * island instead, corrupting the topology. All current producers of the rings
 * fed here (`shape.ts`, `getEffectiveVisibleShape`) already honor this order;
 * the dev-only assertion below exists to catch a future producer that doesn't.
 */
function ringsToMultiPolygon(rings: Pt[][]): MultiPolygon {
  if (rings.length === 0) return [];

  const closedRings: { pts: Pt[]; coords: Ring }[] = [];
  for (const ring of rings) {
    if (ring.length < 3) continue;
    const coords: Ring = ring.map(p => [p.x, p.y]);
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      coords.push([first[0], first[1]]);
    }
    closedRings.push({ pts: ring, coords });
  }

  if (closedRings.length === 0) return [];
  if (closedRings.length === 1) return [[closedRings[0].coords]];

  const polygons: { outerPts: Pt[]; rings: Polygon }[] = [];
  for (const item of closedRings) {
    const testPt = centroid(item.pts);
    let parent: { outerPts: Pt[]; rings: Polygon } | null = null;
    for (const poly of polygons) {
      if (pointInRing(testPt, poly.outerPts)) {
        parent = poly;
        break;
      }
    }
    if (parent) {
      parent.rings.push(item.coords);
    } else {
      polygons.push({ outerPts: item.pts, rings: [item.coords] });
    }
  }

  // Dev-only order-contract guard: a hole/nested ring can never be larger than
  // the outer ring it nests inside. A violation here means a ring was fed out
  // of order (see contract note above) and got misclassified as a top-level
  // island rather than folded as a hole.
  if (process.env.NODE_ENV !== 'production') {
    for (const poly of polygons) {
      const outerArea = ringAreaPts(poly.outerPts);
      for (let k = 1; k < poly.rings.length; k++) {
        const holeArea = ringAreaFromCoords(poly.rings[k]);
        console.assert(
          holeArea <= outerArea,
          `ringsToMultiPolygon: nested ring area ${holeArea.toFixed(1)} exceeds its outer ring ` +
          `area ${outerArea.toFixed(1)} — ring input order contract violated (outer ring must ` +
          `precede its holes; see comment above ringsToMultiPolygon in poly-clip.ts).`
        );
      }
    }
  }

  return polygons.map(p => p.rings);
}

/**
 * Convert polygon-clipping result back to pathData string and compute tight bounding rect.
 */
function multiPolygonToPathData(result: MultiPolygon): { pathData: string; rect: Rect } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const parts: string[] = [];

  for (const polygon of result) {
    for (const ring of polygon) {
      // polygon-clipping outputs closed rings; remove closing duplicate
      const pts: Pt[] = ring.map(([x, y]) => ({ x, y }));
      if (pts.length > 1) {
        const first = pts[0];
        const last = pts[pts.length - 1];
        if (first.x === last.x && first.y === last.y) {
          pts.pop();
        }
      }
      if (pts.length < 3) continue;

      // Build path segment and track bounds
      const segs: string[] = [];
      for (let i = 0; i < pts.length; i++) {
        const { x, y } = pts[i];
        segs.push(`${i === 0 ? 'M' : 'L'} ${x} ${y}`);
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      segs.push('Z');
      parts.push(segs.join(' '));
    }
  }

  if (parts.length === 0 || minX >= maxX || minY >= maxY) return null;

  return {
    pathData: parts.join(' '),
    rect: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
  };
}

/**
 * Compute the geometric union of N ring sets.
 *
 * Each ring set is a Point2D[][] (as produced by `shapeToPoint2D`).
 * polygon-clipping.union() natively supports multi-polygon input.
 *
 * @param ringSets - One or more ring sets (each Point2D[][]) to union together
 * @returns Combined pathData and tight bounding rect, or null if result is empty
 */
export function unionRings(...ringSets: Pt[][][]): { pathData: string; rect: Rect } | null {
  if (ringSets.length === 0) return null;

  const multiPolygons = ringSets
    .filter(rs => rs.length > 0)
    .map(rs => ringsToMultiPolygon(rs));

  if (multiPolygons.length === 0) return null;

  let result: MultiPolygon;
  try {
    // polygon-clipping.union accepts variadic multi-polygons
    result = (polygonClipping.union as (...args: MultiPolygon[]) => MultiPolygon)(...multiPolygons);
  } catch {
    // polygon-clipping can throw on degenerate inputs
    return null;
  }

  if (!result || result.length === 0) return null;

  return multiPolygonToPathData(result);
}

/**
 * Compute the geometric intersection of two paths (both defined by pathData strings).
 *
 * @param pathDataA - SVG-like M/L/Z path string (e.g. layer's visibleShape pathData)
 * @param pathDataB - SVG-like M/L/Z path string (e.g. selection's pathData)
 * @returns New pathData representing A ∩ B and its tight bounding rect, or null if empty
 */
export function intersectPathWithPath(
  pathDataA: string,
  pathDataB: string
): { pathData: string; rect: Rect } | null {
  const ringsA = parsePathDataToRings(pathDataA);
  const ringsB = parsePathDataToRings(pathDataB);

  if (!ringsA.length || !ringsB.length) return null;

  const multiPolyA = ringsToMultiPolygon(ringsA);
  const multiPolyB = ringsToMultiPolygon(ringsB);

  let result: MultiPolygon;
  try {
    result = polygonClipping.intersection(multiPolyA, multiPolyB) as MultiPolygon;
  } catch {
    // polygon-clipping can throw on degenerate inputs (e.g. collinear edges)
    return null;
  }

  if (!result || result.length === 0) return null;

  return multiPolygonToPathData(result);
}

/**
 * Compute A − B (subtract path B from path A) using polygon-clipping.difference.
 *
 * Used to punch hole masks (inverted vectorMasks) out of a layer's effective
 * visible shape. The result may be a multi-ring polygon with holes; the shared
 * `multiPolygonToPathData` serializer already emits multi-ring pathData that the
 * tile renderer clips with even-odd fill.
 *
 * @param pathDataA - SVG-like M/L/Z path string (the minuend, e.g. current effective shape)
 * @param pathDataB - SVG-like M/L/Z path string (the subtrahend, e.g. hole mask shape)
 * @returns New pathData representing A − B and its tight bounding rect, or null if
 *          the result is empty (A fully covered by B).
 */
export function differencePathWithPath(
  pathDataA: string,
  pathDataB: string
): { pathData: string; rect: Rect } | null {
  const ringsA = parsePathDataToRings(pathDataA);
  const ringsB = parsePathDataToRings(pathDataB);

  if (!ringsA.length) return null;
  if (!ringsB.length) {
    // Nothing to subtract — return A unchanged (normalized through the same serializer)
    return multiPolygonToPathData(ringsToMultiPolygon(ringsA));
  }

  const multiPolyA = ringsToMultiPolygon(ringsA);
  const multiPolyB = ringsToMultiPolygon(ringsB);

  let result: MultiPolygon;
  try {
    result = polygonClipping.difference(multiPolyA, multiPolyB) as MultiPolygon;
  } catch {
    // polygon-clipping can throw on degenerate inputs (e.g. collinear edges)
    return null;
  }

  if (!result || result.length === 0) return null; // A fully covered by B → empty

  return multiPolygonToPathData(result);
}
