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
