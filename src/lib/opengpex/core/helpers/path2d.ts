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

import { Shape, LocalShape, WorldShape, LocalPolygon, WorldPolygon, Polygon } from '@opengpex/editor/core/types';

/**
 * Converts shape descriptors to browser-native Path2D objects
 * Shared logic, supporting both the main thread and WebWorker environments
 */
export function shapeToPath2D(shape: Shape): Path2D {
  const p = new Path2D();
  const { type, rect, antiAliased } = shape;
  
  if (type === 'rect') {
    p.rect(rect.x, rect.y, rect.w, rect.h);
  } else if (type === 'circle') {
    if (antiAliased === false) {
      // ==== Phase 4: Hard-Edge (Staired) Engine ====
      const w = Math.round(rect.w);
      const h = Math.round(rect.h);
      if (w > 0 && h > 0) {
        const rows: ({ minX: number; maxX: number } | null)[] = [];
        for (let Y = 0; Y < h; Y++) {
          const cy_offset = Y + 0.5 - h / 2;
          const R = 1 - Math.pow(cy_offset / (h / 2), 2);
          if (R >= 0) {
            const bound = (w / 2) * Math.sqrt(R);
            const minX = Math.ceil(-bound + w / 2 - 0.5);
            const maxX = Math.floor(bound + w / 2 - 0.5);
            rows.push(minX <= maxX ? { minX, maxX } : null);
          } else {
            rows.push(null);
          }
        }

        let prevMinX = -1;
        let prevMaxX = -1;
        let firstY = -1;
        const ox = rect.x;
        const oy = rect.y;

        // Trace Left Side (Top to Bottom)
        for (let Y = 0; Y < h; Y++) {
          const row = rows[Y];
          if (!row) continue;
          if (firstY === -1) {
            firstY = Y;
            p.moveTo(ox + row.minX, oy + Y);
            p.lineTo(ox + row.minX, oy + Y + 1);
          } else {
            if (prevMinX !== row.minX) p.lineTo(ox + row.minX, oy + Y);
            p.lineTo(ox + row.minX, oy + Y + 1);
          }
          prevMinX = row.minX;
        }

        // Trace Right Side (Bottom to Top)
        let lastY = -1;
        for (let Y = h - 1; Y >= 0; Y--) {
          const row = rows[Y];
          if (!row) continue;
          if (lastY === -1) {
            lastY = Y;
            p.lineTo(ox + row.maxX + 1, oy + lastY + 1);
            p.lineTo(ox + row.maxX + 1, oy + lastY);
          } else {
            if (prevMaxX !== row.maxX) p.lineTo(ox + row.maxX + 1, oy + Y + 1);
            p.lineTo(ox + row.maxX + 1, oy + Y);
          }
          prevMaxX = row.maxX;
        }
        p.closePath();
      }
    } else {
      // ==== Smooth Edge Engine ====
      const cx = rect.x + rect.w / 2;
      const cy = rect.y + rect.h / 2;
      p.ellipse(cx, cy, Math.abs(rect.w / 2), Math.abs(rect.h / 2), 0, 0, Math.PI * 2);
    }
  } else if (type === 'path' && shape.pathData) {
    const svgPath = new Path2D(shape.pathData);
    p.addPath(svgPath);
  }
  
  return p;
}

/**
 * Converts a Polygon to an equivalent Shape{type:'path'} descriptor.
 * This bridges the polygon type system into the vectorMask / clip pipeline.
 *
 * Unlike `polygonToSvgPathD` (which outputs bounds-relative coordinates for SVG overlay use),
 * this function generates ABSOLUTE coordinates suitable for direct Path2D consumption
 * via `shapeToPath2D` → `new Path2D(pathData)`.
 *
 * Overloaded: LocalPolygon → LocalShape, WorldPolygon → WorldShape.
 */
export function polygonToShape(poly: LocalPolygon): LocalShape;
export function polygonToShape(poly: WorldPolygon): WorldShape;
export function polygonToShape(poly: LocalPolygon | WorldPolygon): LocalShape | WorldShape {
  // Generate absolute-coordinate SVG path string (no bounds offset subtraction)
  let pathD = '';
  if (poly.rings.length) {
    const parts: string[] = [];
    for (const ring of poly.rings) {
      if (ring.length < 2) continue;
      const segs: string[] = [];
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i];
        segs.push(`${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`);
      }
      segs.push('Z');
      parts.push(segs.join(' '));
    }
    pathD = parts.join(' ');
  }

  return {
    type: 'path' as const,
    rect: poly.rect,
    hardEdge: false,
    antiAliased: poly.antiAliased !== false,
    pathData: pathD,
    __brand: poly.__brand,
  } as LocalShape | WorldShape;
}
