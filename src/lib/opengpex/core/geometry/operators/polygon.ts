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

import {
  Point2D, Rect,
  Layer, Frame,
  LocalPoint, WorldPoint,
  LocalPolygon, WorldPolygon,
  asLocalPoint, asWorldPoint,
  asLocalRect, asWorldRect,
  asLocalPolygon, asWorldPolygon,
} from '@opengpex/editor/core/types';
import { getLayerWorldMatrix } from './transform';

/**
 * Detects whether a source/target is a Layer (image/text/vector/color) vs a Frame.
 * Aligned with shape.ts::localToWorldShape branch test.
 */
function isLayerSource(s: Layer | Frame): s is Layer {
  return 'type' in s && (s.type === 'image' || s.type === 'text' || s.type === 'vector' || s.type === 'color');
}

/**
 * computePolygonBounds: Calculates the axis-aligned bounding box of a multi-ring point set.
 *
 * Returns a generic Rect (no brand) so the caller can wrap with the appropriate caster
 * (`asLocalRect` / `asWorldRect`) to match the polygon space.
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
 * localToWorldPolygon: Project polygon from local space to world space.
 *
 * Branching mirrors `shape.ts::localToWorldShape`:
 *   - Layer source: apply per-point through `getLayerWorldMatrix`
 *   - Frame source: translate by (-canvas.w/2, -canvas.h/2)
 */
export function localToWorldPolygon(poly: LocalPolygon, source: Layer | Frame): WorldPolygon {
  let worldRings: WorldPoint[][];

  if (isLayerSource(source)) {
    const wm = getLayerWorldMatrix(source);
    worldRings = poly.rings.map(ring => ring.map(p => {
      const wx = (p.x * wm.a) + (p.y * wm.c) + wm.tx;
      const wy = (p.x * wm.b) + (p.y * wm.d) + wm.ty;
      return asWorldPoint({ x: wx, y: wy });
    }));
  } else {
    const f = source;
    const dx = -f.canvas.w / 2;
    const dy = -f.canvas.h / 2;
    worldRings = poly.rings.map(ring => ring.map(p => asWorldPoint({ x: p.x + dx, y: p.y + dy })));
  }

  const worldBounds = asWorldRect(computePolygonBounds(worldRings));
  return asWorldPolygon(worldRings, worldBounds, poly.antiAliased);
}

/**
 * worldToLocalPolygon: Project polygon from world space to local space.
 *
 * Branching mirrors `shape.ts::worldToLocalShape`:
 *   - Layer target: apply inverse of `getLayerWorldMatrix` per point
 *   - Frame target: translate by (+canvas.w/2, +canvas.h/2)
 */
export function worldToLocalPolygon(poly: WorldPolygon, target: Layer | Frame): LocalPolygon {
  let localRings: LocalPoint[][];

  if (isLayerSource(target)) {
    // getLayerWorldMatrix returns a concrete Matrix3x3 instance (see transform.ts return type),
    // which exposes .inverse() directly. Mirrors space.ts::getLayerLocalAABB usage.
    const inv = getLayerWorldMatrix(target).inverse();
    localRings = poly.rings.map(ring => ring.map(p => {
      const out = inv.apply({ x: p.x, y: p.y });
      return asLocalPoint(out);
    }));
  } else {
    const f = target;
    const dx = f.canvas.w / 2;
    const dy = f.canvas.h / 2;
    localRings = poly.rings.map(ring => ring.map(p => asLocalPoint({ x: p.x + dx, y: p.y + dy })));
  }

  const localBounds = asLocalRect(computePolygonBounds(localRings));
  return asLocalPolygon(localRings, localBounds, poly.antiAliased);
}

/**
 * frameLocalToLayerLocal: Project polygon under artboard space (Frame) to layer (Layer) local space.
 * Composition: localToWorldPolygon(frame) -> worldToLocalPolygon(layer).
 *
 * Mirrors `shape.ts::frameLocalToLayerLocal`.
 */
export function frameLocalToLayerLocal(poly: LocalPolygon, frame: Frame, layer: Layer): LocalPolygon {
  const world = localToWorldPolygon(poly, frame);
  return worldToLocalPolygon(world, layer);
}

/**
 * layerLocalToFrameLocal: Inverse of `frameLocalToLayerLocal`.
 * Composition: localToWorldPolygon(layer) -> worldToLocalPolygon(frame).
 *
 * Mirrors `shape.ts::layerLocalToFrameLocal`. Used by the magic-wand handler
 * to project Worker-produced layer-local rings back into frame-local polygon
 * space before writing `irregularCropBox`.
 */
export function layerLocalToFrameLocal(poly: LocalPolygon, layer: Layer, frame: Frame): LocalPolygon {
  const world = localToWorldPolygon(poly, layer);
  return worldToLocalPolygon(world, frame);
}

// ─────────────────────────── Polygon Utility Algorithms ────────────────────────

/**
 * isPointInPolygon: Determines whether a point lies inside a multi-ring polygon
 * using the ray-casting (even-odd) algorithm.
 *
 * Works with the evenodd fill rule: a point is "inside" if the total number of
 * ring boundary crossings (by a horizontal ray to +∞) is odd.
 *
 * @param point  The test point.
 * @param rings  Array of closed rings (each ring is an array of Point2D vertices).
 * @returns `true` if the point is inside the polygon (evenodd sense).
 */
export function isPointInPolygon(point: Point2D, rings: Point2D[][]): boolean {
  let inside = false;
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = ring[i].x, yi = ring[i].y;
      const xj = ring[j].x, yj = ring[j].y;
      const intersect = ((yi > point.y) !== (yj > point.y))
        && (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
  }
  return inside;
}

/**
 * computeRingArea: Calculates the unsigned area of a single closed ring using the
 * Shoelace formula (Gauss's area formula).
 *
 * Returns the absolute value so callers don't need to worry about winding direction.
 *
 * @param ring  Array of vertices forming a closed polygon ring.
 * @returns Absolute area in square units of the coordinate system.
 */
export function computeRingArea(ring: Point2D[]): number {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y);
  }
  return Math.abs(area) / 2;
}

/**
 * simplifyOpen: Iterative Douglas–Peucker simplification for an OPEN polyline.
 *
 * Returns a simplified copy of `points`, keeping only vertices whose perpendicular
 * distance to the active line segment exceeds `epsilon`.
 *
 * @param points  Open polyline vertices (first and last are always retained).
 * @param epsilon Distance threshold — vertices closer than this to the simplified
 *                line are dropped. Must be > 0; if ≤ 0 returns a copy of the input.
 * @returns New array containing the simplified vertices.
 */
export function simplifyOpen(points: Point2D[], epsilon: number): Point2D[] {
  const n = points.length;
  if (n < 3 || epsilon <= 0) return points.slice();

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  // Stack of [start, end] index pairs.
  const stack: number[] = [0, n - 1];
  while (stack.length > 0) {
    const e = stack.pop() as number;
    const s = stack.pop() as number;
    if (e <= s + 1) continue;

    const ax = points[s].x, ay = points[s].y;
    const bx = points[e].x, by = points[e].y;
    const dx = bx - ax, dy = by - ay;
    const segLen2 = dx * dx + dy * dy;

    let maxD2 = -1;
    let maxIdx = -1;
    for (let i = s + 1; i < e; i++) {
      const px = points[i].x, py = points[i].y;
      let d2: number;
      if (segLen2 === 0) {
        const ex = px - ax, ey = py - ay;
        d2 = ex * ex + ey * ey;
      } else {
        // Perpendicular distance squared from p to line (a, b).
        const cross = (dx * (ay - py) - (ax - px) * dy);
        d2 = (cross * cross) / segLen2;
      }
      if (d2 > maxD2) { maxD2 = d2; maxIdx = i; }
    }

    if (maxIdx >= 0 && maxD2 > epsilon * epsilon) {
      keep[maxIdx] = 1;
      stack.push(s, maxIdx, maxIdx, e);
    }
  }

  const out: Point2D[] = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push(points[i]);
  }
  return out;
}

/**
 * simplifyRing: Douglas–Peucker simplification for a CLOSED polygon ring.
 *
 * Appends a copy of the first vertex, runs the open-polyline simplification,
 * then removes the trailing duplicate before returning.
 *
 * @param ring    Closed ring vertices (no duplicated start/end vertex expected).
 * @param epsilon Distance threshold (same semantics as `simplifyOpen`).
 * @returns Simplified ring. Guaranteed to have ≥ 3 vertices if the input did,
 *          unless epsilon is extremely large.
 */
export function simplifyRing(ring: Point2D[], epsilon: number): Point2D[] {
  if (ring.length < 4 || epsilon <= 0) return ring.slice();
  const closed = ring.slice();
  closed.push(ring[0]);
  const simplified = simplifyOpen(closed, epsilon);
  if (simplified.length > 1 &&
      simplified[0].x === simplified[simplified.length - 1].x &&
      simplified[0].y === simplified[simplified.length - 1].y) {
    simplified.pop();
  }
  return simplified;
}

// ─────────────────────────── SVG Path Generation ───────────────────────────────

/**
 * polygonToSvgPathD: Generate a multi-ring SVG path `d` string with evenodd fill rule.
 *
 * Output is RELATIVE to `poly.rect.x/y` (subtracted), so the resulting `d` is meant to be
 * placed inside an SVG <g> whose transform translates by (rect.x, rect.y). This matches
 * the existing `getSmoothSvgPath(LocalShape)` convention (which also outputs from origin (0,0)).
 *
 * Routing by `poly.antiAliased`:
 *   - `true` (default): Linear `M/L/Z` — connects integer-coordinate vertices directly.
 *     Sub-pixel smoothing happens at the mask bake stage (Canvas 2D AA).
 *   - `false`: Stair-stepped `M/H/V/Z` — every segment between consecutive vertices is
 *     Bresenham-interpolated into purely horizontal (H) and vertical (V) steps. This
 *     eliminates half-pixel diagonal crossings and produces the classic pixel-staircase
 *     appearance expected in "No Anti-Alias" mode.
 */
export function polygonToSvgPathD(poly: LocalPolygon): string {
  if (!poly.rings.length) return '';

  // Route to stair-stepped path when AA is explicitly OFF.
  if (poly.antiAliased === false) {
    return polygonToStairedPathD(poly);
  }

  const ox = poly.rect.x;
  const oy = poly.rect.y;

  const parts: string[] = [];
  for (const ring of poly.rings) {
    if (ring.length < 2) continue;
    const segs: string[] = [];
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const x = p.x - ox;
      const y = p.y - oy;
      segs.push(`${i === 0 ? 'M' : 'L'} ${x} ${y}`);
    }
    segs.push('Z');
    parts.push(segs.join(' '));
  }

  return parts.join(' ');
}

/**
 * polygonToStairedPathD: Bresenham stair-stepped path for No-AA polygons.
 *
 * Converts every segment between consecutive integer-coordinate vertices into
 * a sequence of single-pixel horizontal (H) and vertical (V) SVG commands.
 * This ensures the rendered path never crosses pixel boundaries diagonally,
 * producing the classic pixel-art staircase outline.
 *
 * Algorithm: for each segment (x0,y0)→(x1,y1), we run integer Bresenham and
 * emit H/V steps. The closing `Z` segment (last→first) is also stair-stepped
 * by explicitly walking it rather than relying on SVG's implicit close.
 */
function polygonToStairedPathD(poly: LocalPolygon): string {
  const ox = poly.rect.x;
  const oy = poly.rect.y;

  const parts: string[] = [];
  for (const ring of poly.rings) {
    if (ring.length < 2) continue;

    const segs: string[] = [];
    const x0 = Math.round(ring[0].x - ox);
    const y0 = Math.round(ring[0].y - oy);
    segs.push(`M ${x0} ${y0}`);

    // Walk all edges including the closing edge (last → first).
    const len = ring.length;
    for (let i = 0; i < len; i++) {
      const next = (i + 1) % len;
      const ax = Math.round(ring[i].x - ox);
      const ay = Math.round(ring[i].y - oy);
      const bx = Math.round(ring[next].x - ox);
      const by = Math.round(ring[next].y - oy);

      // Skip zero-length segments.
      if (ax === bx && ay === by) continue;

      // Pure horizontal or vertical — emit directly.
      if (ay === by) {
        segs.push(`H ${bx}`);
        continue;
      }
      if (ax === bx) {
        segs.push(`V ${by}`);
        continue;
      }

      // Diagonal: Bresenham stair-step decomposition.
      bresenhamSteps(ax, ay, bx, by, segs);
    }

    segs.push('Z');
    parts.push(segs.join(' '));
  }

  return parts.join(' ');
}

/**
 * Bresenham integer line: emits H/V steps from (x0,y0) to (x1,y1).
 * Does NOT emit the starting point (assumes cursor is already there).
 * Uses the classic octant-agnostic Bresenham with H-priority steps
 * (horizontal steps are emitted first when both axes advance).
 */
function bresenhamSteps(
  x0: number, y0: number,
  x1: number, y1: number,
  segs: string[]
): void {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  let cx = x0;
  let cy = y0;

  while (cx !== x1 || cy !== y1) {
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      cx += sx;
      segs.push(`H ${cx}`);
    }
    if (e2 < dx) {
      err += dx;
      cy += sy;
      segs.push(`V ${cy}`);
    }
  }
}
