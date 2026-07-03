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
 * point2d.ts — Pure Point2D ring operations.
 *
 * This module operates exclusively on raw `Point2D[][]` (rings) and plain
 * geometry types (Rect). It serves as the foundational data layer beneath
 * the branded container types (LocalShape, LocalPolygon).
 *
 * Dependency direction:
 *   point2d.ts → types only (no imports from shape.ts, polygon.ts, or transform.ts)
 *   polygon.ts → point2d.ts (for computePolygonBounds, point2dToLocalPolygon)
 *   shape.ts   remains independent (shapeToPoint2D has no cross-operator deps)
 */

import {
  Point2D, Rect, LocalPoint,
  LocalShape, LocalPolygon,
  asLocalRect, asLocalShape, asLocalPolygon,
} from '@opengpex/editor/core/types';

// ─────────────────────────── Shape ↔ Point2D Conversions ───────────────────────

/**
 * shapeToPoint2D: Decompose a LocalShape into plain Point2D rings.
 * - rect → single 4-point ring (CW)
 * - circle/ellipse → single 64-point approximation ring (CW)
 */
export function shapeToPoint2D(shape: LocalShape): Point2D[][] {
  const { x, y, w, h } = shape.rect;
  if (shape.type === 'circle') {
    const cx = x + w / 2, cy = y + h / 2;
    const rx = w / 2, ry = h / 2;
    const N = 64;
    const ring: Point2D[] = [];
    for (let i = 0; i < N; i++) {
      const angle = (2 * Math.PI * i) / N;
      ring.push({ x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) });
    }
    return [ring];
  }
  return [[{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]];
}

/**
 * point2dToLocalShape: Attempt to convert Point2D rings into a LocalShape.
 * Returns null if the rings cannot be represented as a simple rect/ellipse.
 *
 * Heuristics:
 *   - 1 ring with 4 axis-aligned points → rect
 *   - 1 ring with 64 points fitting an ellipse equation → circle
 */
export function point2dToLocalShape(rings: readonly Point2D[][], antiAliased: boolean): LocalShape | null {
  if (rings.length !== 1) return null;
  const ring = rings[0];

  // Try restore to rect (4 points, axis-aligned)
  if (ring.length === 4) {
    const xs = ring.map(p => p.x);
    const ys = ring.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const isAxisAligned = ring.every(p =>
      (Math.abs(p.x - minX) < 0.5 || Math.abs(p.x - maxX) < 0.5) &&
      (Math.abs(p.y - minY) < 0.5 || Math.abs(p.y - maxY) < 0.5)
    );
    if (isAxisAligned) {
      return { ...asLocalShape({ x: minX, y: minY, w: maxX - minX, h: maxY - minY }), type: 'rect', antiAliased };
    }
  }

  // Try restore to ellipse (64 points, fits ellipse equation)
  if (ring.length === 64) {
    const xs = ring.map(p => p.x);
    const ys = ring.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const rx = (maxX - minX) / 2, ry = (maxY - minY) / 2;
    if (rx > 0 && ry > 0) {
      const isEllipse = ring.every(p => {
        const dx = (p.x - cx) / rx;
        const dy = (p.y - cy) / ry;
        return Math.abs(dx * dx + dy * dy - 1) < 0.05;
      });
      if (isEllipse) {
        return { ...asLocalShape({ x: minX, y: minY, w: maxX - minX, h: maxY - minY }), type: 'circle', antiAliased };
      }
    }
  }

  return null;
}

// ─────────────────────────── Point2D → LocalPolygon ────────────────────────────

/**
 * computePolygonBounds: Calculates the axis-aligned bounding box of a multi-ring point set.
 *
 * Returns a generic Rect (no brand) so the caller can wrap with the appropriate caster.
 */
export function computePolygonBounds(rings: Point2D[][]): Rect {
  if (!rings.length || !rings.some(r => r.length > 0)) {
    return { x: 0, y: 0, w: 0, h: 0 };
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of rings) {
    for (const p of ring) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }

  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * point2dToLocalPolygon: Build a LocalPolygon from raw Point2D rings,
 * computing the bounding rect automatically.
 */
export function point2dToLocalPolygon(rings: Point2D[][], antiAliased: boolean): LocalPolygon {
  const rect = asLocalRect(computePolygonBounds(rings));
  return asLocalPolygon(rings as unknown as LocalPoint[][], rect, antiAliased);
}

// ─────────────────────────── Ring Inversion ────────────────────────────────────

/**
 * Check if a single ring matches the bounding rectangle (0,0)→(w,0)→(w,h)→(0,h) (±1px tolerance).
 */
export function isBoundingRing(ring: readonly Point2D[], boundingW: number, boundingH: number): boolean {
  if (ring.length !== 4) return false;
  const corners = [
    { x: 0, y: 0 }, { x: boundingW, y: 0 },
    { x: boundingW, y: boundingH }, { x: 0, y: boundingH },
  ];
  return corners.every((c, i) =>
    Math.abs(ring[i].x - c.x) < 1 && Math.abs(ring[i].y - c.y) < 1
  );
}

/**
 * invertRings: Invert a set of Point2D rings against a bounding area (evenodd semantics).
 *
 *   - If rings[0] IS the bounding rect (already inverted) → strip it (reverse invert).
 *   - Otherwise → prepend the bounding rect as outer ring (forward invert).
 *   - Special case: single ring == bounding rect → result is empty (null).
 *   - Special case: already inverted with 0 inner rings → result is empty (null).
 *
 * Returns `null` when the result represents "no selection" (empty).
 */
export function invertRings(rings: Point2D[][], boundingW: number, boundingH: number): Point2D[][] | null {
  const boundingRing: Point2D[] = [
    { x: 0, y: 0 }, { x: boundingW, y: 0 },
    { x: boundingW, y: boundingH }, { x: 0, y: boundingH },
  ];

  const alreadyInverted = rings.length >= 2 && isBoundingRing(rings[0], boundingW, boundingH);

  if (alreadyInverted) {
    const inner = rings.slice(1);
    return inner.length > 0 ? inner : null;
  } else {
    if (rings.length === 1 && isBoundingRing(rings[0], boundingW, boundingH)) {
      return null;
    }
    return [boundingRing, ...rings];
  }
}
