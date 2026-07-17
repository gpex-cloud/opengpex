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

'use client';

import type { LocalShape, LocalSpatial, LocalPolygon } from '@opengpex/editor/core/types';
import * as P from './protocols';

/**
 * clipBoxToExportShape — converts the unified `LocalSpatial` (from `getClipBox`)
 * into a `LocalShape` suitable for `pixels.render.shapeToBlob`.
 *
 * - Regular selections (rect/ellipse): returns the shape as-is.
 * - Irregular selections (lasso/wand polygon): creates a `LocalShape{type:'path'}`
 *   with pathData in bounds-relative coordinates. This is required because
 *   `mergeLayersWithShape` internally zeros the rect to {0,0,w,h} and shifts
 *   layer matrices by (-rect.x, -rect.y).
 *
 * @param polygonToPathD  Optional path generator (from geometry.polygon.polygonToSvgPathD).
 *   When provided, routes to Bresenham stair-stepped path for antiAliased=false polygons.
 *   When omitted, falls back to smooth M/L/Z (legacy behaviour).
 */
export function clipBoxToExportShape(
  box: LocalSpatial,
  polygonToPathD?: (poly: LocalPolygon) => string
): LocalShape {
  if (box.regular) {
    return box.spatial;
  }

  // Irregular polygon → LocalShape{type:'path'} with bounds-relative coordinates.
  // When polygonToPathD is provided (geometry service), it routes to Bresenham
  // stair-stepped path when antiAliased === false, ensuring export respects AA.
  const poly = box.spatial;
  let pathData: string;
  if (polygonToPathD) {
    pathData = polygonToPathD(poly);
  } else {
    // Fallback: simple M/L/Z (smooth, does not respect AA=false)
    const parts: string[] = [];
    for (const ring of poly.rings) {
      if (ring.length < 2) continue;
      const segs: string[] = [];
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i];
        segs.push(`${i === 0 ? 'M' : 'L'} ${p.x - poly.rect.x} ${p.y - poly.rect.y}`);
      }
      segs.push('Z');
      parts.push(segs.join(' '));
    }
    pathData = parts.join(' ');
  }

  return {
    type: 'path',
    rect: poly.rect,
    hardEdge: false,
    antiAliased: poly.antiAliased !== false,
    pathData,
    __brand: 'local',
  } as LocalShape;
}

/**
 * Calculates the final physical dimensions for export or canvas resizing
 * based on the absolute pixels in config.
 */
export function calcFinalDims(baseW: number, baseH: number, config: P.ExportConfig) {
 const w = config.pixels?.w || baseW;
 const h = config.pixels?.h || baseH;
 
 return { w: Math.round(w), h: Math.round(h) };
}

/**
 * Derives the current width, height, and scale percentage based on the config.
 */
export function deriveResizeState(baseW: number, baseH: number, pixels?: { w: number, h: number }) {
 const currentW = pixels?.w || baseW;
 const currentH = pixels?.h || baseH;
 const currentPercent = baseW ? Math.round((currentW / baseW) * 100) : 100;
 return { currentW, currentH, currentPercent };
}

/**
 * Calculates the next pixels when width is manually changed.
 */
export function calculateNextPixelsByWidth(newW: number, baseW: number, baseH: number, currentH: number, lockAspect: boolean) {
 const nextW = newW || 0;
 const nextH = lockAspect && baseW > 0 ? Math.round(nextW / (baseW / baseH)) : currentH;
 return { w: nextW, h: nextH };
}

/**
 * Calculates the next pixels when height is manually changed.
 */
export function calculateNextPixelsByHeight(newH: number, baseW: number, baseH: number, currentW: number, lockAspect: boolean) {
 const nextH = newH || 0;
 const nextW = lockAspect && baseH > 0 ? Math.round(nextH * (baseW / baseH)) : currentW;
 return { w: nextW, h: nextH };
}

/**
 * Calculates the next pixels when percentage slider is dragged, with snapping.
 */
export function calculateNextPixelsByPercent(val: number, baseW: number, baseH: number) {
 let finalPercent = val;
 const snapPoints = [25, 50, 100, 200, 400];
 const threshold = 4;
 for (const p of snapPoints) {
 if (Math.abs(val - p) <= threshold) {
 finalPercent = p;
 break;
 }
 }
 const nextW = Math.max(1, Math.round(baseW * (finalPercent / 100)));
 const nextH = Math.max(1, Math.round(baseH * (finalPercent / 100)));
 return { w: nextW, h: nextH, percent: finalPercent };
}

