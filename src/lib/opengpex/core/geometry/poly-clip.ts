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
 * Complements sut-hod.ts (which only handles polygon ∩ rect via Sutherland-Hodgman).
 * This module handles the general case: arbitrary polygon ∩ arbitrary polygon,
 * enabling logical (non-destructive) cuts when both selection and layer are paths.
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

/**
 * Convert Point2D rings to polygon-clipping format.
 * polygon-clipping expects closed rings: first point === last point.
 */
function ringsToMultiPolygon(rings: Pt[][]): MultiPolygon {
  // Treat the ring set as a single polygon with potential holes.
  // Ring[0] = outer boundary, Ring[1..n] = holes (standard GeoJSON winding convention).
  const polygon: Polygon = rings.map(ring => {
    const coords: Ring = ring.map(p => [p.x, p.y]);
    // Close the ring if not already closed
    if (coords.length > 0) {
      const first = coords[0];
      const last = coords[coords.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) {
        coords.push([first[0], first[1]]);
      }
    }
    return coords;
  });
  return [polygon];
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
