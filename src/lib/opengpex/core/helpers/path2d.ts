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

import { Shape, LocalShape, WorldShape, LocalPolygon, WorldPolygon } from '@opengpex/editor/core/types';
import { point2dToLocalShape, parsePathDataToRings } from '@opengpex/editor/core/geometry/operators/point2d';

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
    // ── P6: Render-time AA routing ─────────────────────────────────────────
    // pathData is always stored as smooth M/L/Z (see `polygonToShape`).
    // When antiAliased is explicitly false, convert to Bresenham stair-stepped
    // path at render time so the mask never crosses pixel boundaries diagonally.
    if (antiAliased === false) {
      const stairedD = stairedPathFromSmooth(shape.pathData);
      p.addPath(new Path2D(stairedD));
    } else {
      p.addPath(new Path2D(shape.pathData));
    }
  }

  return p;
}

/**
 * Converts a Polygon to an equivalent Shape descriptor.
 * This bridges the polygon type system into the vectorMask / clip pipeline.
 *
 * Unlike `polygonToSvgPathD` (which outputs bounds-relative coordinates for SVG overlay use),
 * this function generates ABSOLUTE coordinates suitable for direct Path2D consumption
 * via `shapeToPath2D` → `new Path2D(pathData)`.
 *
 * Shape recognition (P5 — selection_layer_unification_spec §3.2):
 *   - 4-point axis-aligned ring → `type:'rect'` (preserves rendering precision)
 *   - 64-point ellipse approximation ring → `type:'circle'` (preserves rendering precision)
 *   - All other polygons → `type:'path'` with smooth M/L/Z pathData
 *
 * AA routing: pathData is ALWAYS written as smooth M/L/Z. The `antiAliased` flag is
 * preserved on the output shape so that `shapeToPath2D` can apply Bresenham stair-stepping
 * at render time (P6). This ensures `polygonToShape` is a pure serialization step with
 * no rendering-time decisions baked in.
 *
 * Overloaded: LocalPolygon → LocalShape, WorldPolygon → WorldShape.
 */
export function polygonToShape(poly: LocalPolygon): LocalShape;
export function polygonToShape(poly: WorldPolygon): WorldShape;
export function polygonToShape(poly: LocalPolygon | WorldPolygon): LocalShape | WorldShape {
  const antiAliased = poly.antiAliased !== false;

  // ── P5: Shape recognition ──────────────────────────────────────────────────
  // Only attempt recognition for single-ring polygons (multi-ring = complex shape).
  // `point2dToLocalShape` is typed for LocalPolygon rings (LocalPoint[][]) but the
  // underlying algorithm only uses x/y coordinates, so casting is safe here.
  if (poly.rings.length === 1) {
    const recognized = point2dToLocalShape(
      poly.rings as unknown as { x: number; y: number }[][],
      antiAliased
    );
    if (recognized) {
      // Preserve brand from the source polygon.
      return { ...recognized, __brand: poly.__brand } as LocalShape | WorldShape;
    }
  }

  // ── Irregular polygon: serialize to smooth M/L/Z pathData ─────────────────
  // pathData is ALWAYS smooth (no pre-baked stair-stepping). AA routing happens
  // at render time in `shapeToPath2D` (P6).
  let pathD = '';
  if (poly.rings.length) {
    const parts: string[] = [];
    for (const ring of poly.rings) {
      if (ring.length < 2) continue;
      const segs: string[] = [];
      for (let i = 0; i < ring.length; i++) {
        const pt = ring[i];
        segs.push(`${i === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`);
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
    antiAliased,
    pathData: pathD,
    __brand: poly.__brand,
  } as LocalShape | WorldShape;
}

// ─────────────────────────── Render-time AA routing (P6) ───────────────────────

/**
 * stairedPathFromSmooth: Convert a smooth M/L/Z SVG path string into a
 * Bresenham stair-stepped path string for No-AA (hard-edge) rendering.
 *
 * This is the `type:'path'` equivalent of the stair-step engine already
 * implemented for `type:'circle'` in `shapeToPath2D`. It is called at
 * render time when `antiAliased === false` on a path-type shape.
 *
 * Algorithm:
 *   1. Parse the smooth pathData back into Point2D rings (via `parsePathDataToRings`).
 *   2. For each ring, walk every edge (including the closing edge) and decompose
 *      diagonal segments into H/V Bresenham steps.
 *   3. Reassemble into a valid SVG path string.
 *
 * The output path uses only M, H, V, Z commands — no diagonal L segments —
 * ensuring the rendered path never crosses pixel boundaries diagonally.
 */
export function stairedPathFromSmooth(pathData: string): string {
  const rings = parsePathDataToRings(pathData);
  if (!rings.length) return pathData;

  const parts: string[] = [];

  for (const ring of rings) {
    if (ring.length < 2) continue;

    const segs: string[] = [];
    const x0 = Math.round(ring[0].x);
    const y0 = Math.round(ring[0].y);
    segs.push(`M ${x0} ${y0}`);

    const len = ring.length;
    for (let i = 0; i < len; i++) {
      const next = (i + 1) % len;
      const ax = Math.round(ring[i].x);
      const ay = Math.round(ring[i].y);
      const bx = Math.round(ring[next].x);
      const by = Math.round(ring[next].y);

      if (ax === bx && ay === by) continue;

      if (ay === by) {
        segs.push(`H ${bx}`);
        continue;
      }
      if (ax === bx) {
        segs.push(`V ${by}`);
        continue;
      }

      // Diagonal: Bresenham stair-step decomposition
      _bresenhamSteps(ax, ay, bx, by, segs);
    }

    segs.push('Z');
    parts.push(segs.join(' '));
  }

  return parts.join(' ');
}

/**
 * _bresenhamSteps: Emit H/V steps from (x0,y0) to (x1,y1) using Bresenham's
 * line algorithm. Does NOT emit the starting point (cursor is already there).
 */
function _bresenhamSteps(
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
