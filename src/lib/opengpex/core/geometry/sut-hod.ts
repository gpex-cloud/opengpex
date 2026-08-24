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
 * sut-hod.ts — Sutherland-Hodgman polygon clipping against a rectangle.
 *
 * Provides a single public API:
 *   intersectPathWithRect(pathData, clipRect) → { pathData, rect } | null
 *
 * Algorithm:
 *   For each ring in the path, clip against the rectangle's 4 edges sequentially.
 *   This is the standard Sutherland-Hodgman algorithm, optimal for polygon vs convex clip.
 *   Time complexity: O(n) per ring where n = number of vertices.
 *
 * Limitations:
 *   - Only supports polygon ∩ convex (rect). For polygon ∩ polygon, see poly-clip.ts.
 *   - Assumes simple (non-self-intersecting) input polygons.
 */

import type { Rect } from '@opengpex/editor/core/types';
import { parsePathDataToRings } from './operators/point2d';

type Pt = { x: number; y: number };

/**
 * Clip a single polygon ring against a rectangle using Sutherland-Hodgman.
 * Returns the clipped polygon vertices, or empty array if fully outside.
 */
function clipRingByRect(ring: Pt[], rect: Rect): Pt[] {
  if (ring.length < 3) return [];

  let output: Pt[] = ring;

  // Clip against each of the 4 edges: left, right, top, bottom
  const edges: Array<{ inside: (p: Pt) => boolean; intersect: (a: Pt, b: Pt) => Pt }> = [
    { // Left edge: x >= rect.x
      inside: (p) => p.x >= rect.x,
      intersect: (a, b) => {
        const t = (rect.x - a.x) / (b.x - a.x);
        return { x: rect.x, y: a.y + t * (b.y - a.y) };
      }
    },
    { // Right edge: x <= rect.x + rect.w
      inside: (p) => p.x <= rect.x + rect.w,
      intersect: (a, b) => {
        const t = (rect.x + rect.w - a.x) / (b.x - a.x);
        return { x: rect.x + rect.w, y: a.y + t * (b.y - a.y) };
      }
    },
    { // Top edge: y >= rect.y
      inside: (p) => p.y >= rect.y,
      intersect: (a, b) => {
        const t = (rect.y - a.y) / (b.y - a.y);
        return { x: a.x + t * (b.x - a.x), y: rect.y };
      }
    },
    { // Bottom edge: y <= rect.y + rect.h
      inside: (p) => p.y <= rect.y + rect.h,
      intersect: (a, b) => {
        const t = (rect.y + rect.h - a.y) / (b.y - a.y);
        return { x: a.x + t * (b.x - a.x), y: rect.y + rect.h };
      }
    },
  ];

  for (const edge of edges) {
    if (output.length === 0) return [];
    const input = output;
    output = [];

    for (let i = 0; i < input.length; i++) {
      const current = input[i];
      const next = input[(i + 1) % input.length];
      const curInside = edge.inside(current);
      const nextInside = edge.inside(next);

      if (curInside && nextInside) {
        output.push(next);
      } else if (curInside && !nextInside) {
        output.push(edge.intersect(current, next));
      } else if (!curInside && nextInside) {
        output.push(edge.intersect(current, next));
        output.push(next);
      }
      // Both outside: skip
    }
  }

  return output;
}

/**
 * Compute the geometric intersection of a path (defined by pathData) with a rectangle.
 *
 * @param pathData - SVG-like M/L/Z path string (absolute coordinates)
 * @param clipRect - The clipping rectangle
 * @returns New pathData and its tight bounding rect, or null if no intersection
 */
export function intersectPathWithRect(pathData: string, clipRect: Rect): { pathData: string; rect: Rect } | null {
  const rings = parsePathDataToRings(pathData);
  if (!rings.length) return null;

  const clippedRings: Pt[][] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const ring of rings) {
    const clipped = clipRingByRect(ring, clipRect);
    if (clipped.length >= 3) {
      clippedRings.push(clipped);
      for (const pt of clipped) {
        if (pt.x < minX) minX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y > maxY) maxY = pt.y;
      }
    }
  }

  if (clippedRings.length === 0) return null;

  // Rebuild pathData in the same M/L/Z format as polygonToShape
  const parts: string[] = [];
  for (const ring of clippedRings) {
    const segs: string[] = [];
    for (let i = 0; i < ring.length; i++) {
      segs.push(`${i === 0 ? 'M' : 'L'} ${ring[i].x} ${ring[i].y}`);
    }
    segs.push('Z');
    parts.push(segs.join(' '));
  }

  return {
    pathData: parts.join(' '),
    rect: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
  };
}
