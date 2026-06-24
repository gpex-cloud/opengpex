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
 * frameLocalToLayerLocalPolygon: Project polygon under artboard space (Frame) to layer (Layer) local space.
 * Composition: localToWorldPolygon(frame) -> worldToLocalPolygon(layer).
 *
 * Mirrors `shape.ts::frameLocalToLayerLocal`.
 */
export function frameLocalToLayerLocalPolygon(poly: LocalPolygon, frame: Frame, layer: Layer): LocalPolygon {
  const world = localToWorldPolygon(poly, frame);
  return worldToLocalPolygon(world, layer);
}

/**
 * layerLocalToFrameLocalPolygon: Inverse of `frameLocalToLayerLocalPolygon`.
 * Composition: localToWorldPolygon(layer) -> worldToLocalPolygon(frame).
 *
 * Mirrors `shape.ts::layerLocalToFrameLocal`. Used by the magic-wand handler
 * to project Worker-produced layer-local rings back into frame-local polygon
 * space before writing `irregularCropBox`.
 */
export function layerLocalToFrameLocalPolygon(poly: LocalPolygon, layer: Layer, frame: Frame): LocalPolygon {
  const world = localToWorldPolygon(poly, layer);
  return worldToLocalPolygon(world, frame);
}

/**
 * polygonToSvgPathD: Generate a multi-ring SVG path `d` string with evenodd fill rule.
 *
 * Output is RELATIVE to `poly.bounds.x/y` (subtracted), so the resulting `d` is meant to be
 * placed inside an SVG <g> whose transform translates by (bounds.x, bounds.y). This matches
 * the existing `getSmoothSvgPath(LocalShape)` convention (which also outputs from origin (0,0)).
 *
 * Each ring becomes an "M x y L x y L ... Z" subpath. Empty rings are skipped.
 *
 * NOTE: name is intentionally NEUTRAL (not `polygonToSmoothSvgPathD`). Phase 2 may add a
 * sibling `polygonToStairedSvgPathD` and route through `poly.antiAliased`.
 */
export function polygonToSvgPathD(poly: LocalPolygon): string {
  if (!poly.rings.length) return '';

  const ox = poly.bounds.x;
  const oy = poly.bounds.y;

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
