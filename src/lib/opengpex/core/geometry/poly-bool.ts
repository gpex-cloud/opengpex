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
 * Pure boolean-geometry core shared by invert.worker.ts and its tests.
 *
 * The polygon-clipping library instance is injected: the worker loads the
 * browser bundle via importScripts (classic worker), while tests inject the
 * npm package directly. Keeping this module free of any library import is
 * what lets both entry points share one implementation.
 */

export interface Point2DLike { x: number; y: number }

/**
 * polygon-clipping API surface (subset used here). All operands and results
 * are MultiPolygons: Polygon = Ring[] = [x,y][][], MultiPolygon = Polygon[].
 */
export interface PolygonClippingLib {
  difference(
    subject: [number, number][][][],
    ...clips: [number, number][][][][]
  ): [number, number][][][];
  union(
    subject: [number, number][][][],
    ...clips: [number, number][][][][]
  ): [number, number][][][];
  intersection(
    subject: [number, number][][][],
    ...clips: [number, number][][][][]
  ): [number, number][][][];
}


export type PolyBoolOp = 'union' | 'intersection' | 'difference';

type ClippingRing = [number, number][];

/**
 * Convert Point2D rings to a polygon-clipping polygon (one polygon = outer
 * ring + holes). Each ring is closed (first point == last point) as the
 * library requires. Winding is irrelevant: consumers interpret the ring list
 * with the even-odd rule.
 */
export function toClippingPolygon(rings: Point2DLike[][]): ClippingRing[] {
  return rings.map(ring => {
    const coords: ClippingRing = ring.map(p => [p.x, p.y]);
    if (coords.length > 0) {
      const first = coords[0];
      const last = coords[coords.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) {
        coords.push([first[0], first[1]]);
      }
    }
    return coords;
  });
}

/**
 * Flatten a polygon-clipping MultiPolygon result into Point2D rings
 * (closing duplicate points removed, degenerate rings dropped).
 */
export function flattenResult(result: [number, number][][][]): Point2DLike[][] {
  const outputRings: Point2DLike[][] = [];
  for (const polygon of result) {
    for (const ring of polygon) {
      const pts = ring.map(([x, y]) => ({ x, y }));
      if (pts.length > 1) {
        const first = pts[0];
        const last = pts[pts.length - 1];
        if (first.x === last.x && first.y === last.y) {
          pts.pop();
        }
      }
      if (pts.length >= 3) {
        outputRings.push(pts);
      }
    }
  }
  return outputRings;
}

/**
 * Boolean combine between two ring sets sharing one coordinate space:
 * union, difference or intersection.
 * Returns null when the result is empty or the operands are degenerate
 * (mirroring the worker's short-circuit rules so caller semantics stay
 * identical whichever entry point runs the math).
 */
export function computeBooleanRings(
  lib: PolygonClippingLib,
  op: PolyBoolOp,
  base: Point2DLike[][],
  incoming: Point2DLike[][]
): Point2DLike[][] | null {
  // Degenerate operands short-circuit without invoking the library:
  //   union with no base = the incoming polygon as-is
  //   difference with no base = nothing to subtract from → empty
  //   empty incoming = no-op (union keeps base, difference/intersection → empty)
  if (!incoming || incoming.length === 0) {
    return op === 'union' ? base.map(r => r.map(p => ({ ...p }))) : null;
  }
  if (!base || base.length === 0) {
    return op === 'difference' ? null : incoming.map(r => r.map(p => ({ ...p })));
  }

  const basePoly = toClippingPolygon(base);
  const incomingPoly = toClippingPolygon(incoming);

  const result =
    op === 'union'
      ? lib.union([basePoly], [incomingPoly])
      : op === 'intersection'
        ? lib.intersection([basePoly], [incomingPoly])
        : lib.difference([basePoly], [incomingPoly]);

  if (!result || result.length === 0) return null;

  const outputRings = flattenResult(result);
  return outputRings.length > 0 ? outputRings : null;
}

/**
 * Invert a selection against the canvas rectangle: result = canvas − rings.
 * Empty input inverts to the full canvas rect.
 */
export function computeInvertRings(
  lib: PolygonClippingLib,
  rings: Point2DLike[][],
  canvasW: number,
  canvasH: number
): Point2DLike[][] | null {
  if (!rings || rings.length === 0) {
    return [
      [
        { x: 0, y: 0 },
        { x: canvasW, y: 0 },
        { x: canvasW, y: canvasH },
        { x: 0, y: canvasH },
      ],
    ];
  }

  const subject: ClippingRing[] = [
    [[0, 0], [canvasW, 0], [canvasW, canvasH], [0, canvasH], [0, 0]],
  ];

  const result = lib.difference([subject], [toClippingPolygon(rings)]);
  if (!result || result.length === 0) return null;

  const outputRings = flattenResult(result);
  return outputRings.length > 0 ? outputRings : null;
}
