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
  Point2D, Rect, LocalPoint, LocalRect,
  LocalShape, LocalPolygon,
  asLocalRect, asLocalShape, asLocalPolygon,
} from '@opengpex/editor/core/types';

// ─────────────────────────── Shape ↔ Point2D Conversions ───────────────────────

/**
 * shapeToPoint2D: Decompose a LocalShape into plain Point2D rings.
 * - rect → single 4-point ring (CW)
 * - circle/ellipse → single 64-point approximation ring (CW)
 * - path → parse pathData (M/L/Z SVG commands) back into multi-ring Point2D[][]
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
  if (shape.type === 'path' && shape.pathData) {
    return parsePathDataToRings(shape.pathData);
  }
  // Default: rect (4-point CW ring)
  return [[{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]];
}

/**
 * parsePathDataToRings: Parse simple SVG path data (M/L/Z commands with absolute
 * coordinates) back into Point2D rings. This is the inverse of `polygonToShape`
 * which generates paths using `M x y`, `L x y`, `Z` only.
 *
 * Returns empty array if the path is empty or uses unsupported commands.
 */
export function parsePathDataToRings(pathData: string): Point2D[][] {
  const rings: Point2D[][] = [];
  let currentRing: Point2D[] = [];

  // Tokenize: split on M/L/Z commands while keeping the command letter
  const tokens = pathData.match(/[MLZ][^MLZ]*/gi);
  if (!tokens) return rings;

  for (const token of tokens) {
    const cmd = token[0].toUpperCase();
    if (cmd === 'M' || cmd === 'L') {
      const coords = token.slice(1).trim().split(/[\s,]+/).map(Number);
      if (coords.length >= 2 && !isNaN(coords[0]) && !isNaN(coords[1])) {
        if (cmd === 'M' && currentRing.length > 0) {
          // New sub-path: close the previous ring
          rings.push(currentRing);
          currentRing = [];
        }
        currentRing.push({ x: coords[0], y: coords[1] });
      }
    } else if (cmd === 'Z') {
      if (currentRing.length > 0) {
        rings.push(currentRing);
        currentRing = [];
      }
    }
  }

  // Flush any remaining ring without a closing Z
  if (currentRing.length > 0) {
    rings.push(currentRing);
  }

  return rings;
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

// ─────────────────────────── Shape → LocalPolygon Constructors ─────────────────

/**
 * rectToLocalPolygon: Convert a LocalRect into a 4-point axis-aligned LocalPolygon.
 *
 * Produces a clockwise ring: TL → TR → BR → BL.
 * This is the canonical representation for rect selections in the unified
 * `Frame.clipBoxes: Record<string, LocalPolygon>` architecture (Phase 1 of
 * selection_layer_unification_spec).
 *
 * @param rect        The bounding rectangle in local (canvas) coordinates.
 * @param antiAliased Whether the selection edge should be anti-aliased (default true).
 */
export function rectToLocalPolygon(rect: LocalRect, antiAliased: boolean = true): LocalPolygon {
  const { x, y, w, h } = rect;
  const ring: LocalPoint[] = [
    { x, y } as LocalPoint,
    { x: x + w, y } as LocalPoint,
    { x: x + w, y: y + h } as LocalPoint,
    { x, y: y + h } as LocalPoint,
  ];
  return asLocalPolygon([ring], asLocalRect({ x, y, w, h }), antiAliased);
}

/**
 * ellipseToLocalPolygon: Convert a LocalRect bounding box into a 64-point ellipse LocalPolygon.
 *
 * Samples 64 points uniformly around the ellipse (clockwise, starting at angle 0).
 * This is the canonical representation for ellipse selections in the unified
 * `Frame.clipBoxes: Record<string, LocalPolygon>` architecture (Phase 1 of
 * selection_layer_unification_spec).
 *
 * The 64-point count matches `shapeToPoint2D` (circle branch) and `point2dToLocalShape`
 * (ellipse recognition heuristic), ensuring round-trip fidelity:
 *   ellipseToLocalPolygon → point2dToLocalShape → type:'circle' ✓
 *
 * @param rect        The bounding rectangle of the ellipse in local (canvas) coordinates.
 * @param antiAliased Whether the selection edge should be anti-aliased (default true).
 */
export function ellipseToLocalPolygon(rect: LocalRect, antiAliased: boolean = true): LocalPolygon {
  const { x, y, w, h } = rect;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const N = 64;
  const ring: LocalPoint[] = [];
  for (let i = 0; i < N; i++) {
    const angle = (2 * Math.PI * i) / N;
    ring.push({ x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) } as LocalPoint);
  }
  return asLocalPolygon([ring], asLocalRect({ x, y, w, h }), antiAliased);
}
