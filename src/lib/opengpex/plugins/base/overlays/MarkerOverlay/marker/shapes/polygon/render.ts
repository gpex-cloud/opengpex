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

/** Polygon render: SVG preview + SDF geometry. Pure — no React. */

import type { PolygonMarkerData } from '../../types';
import type { MarkerBounding, SdfGeometry } from '../../types';
import { svgFillAttrs, svgStroke } from '../shared';
import { radialPolygonPoints } from '../star/render';

export function polygonToSvg(data: PolygonMarkerData, bounding: MarkerBounding): string {
  const sw = Math.max(0, data.stroke.width);
  if (bounding.w - sw <= 0 || bounding.h - sw <= 0) return '';
  const pts = radialPolygonPoints(bounding, sw, Math.max(3, Math.round(data.sides)));
  return (
    `<polygon points="${pts.join(' ')}" ` +
    `${svgFillAttrs(data)} stroke="${svgStroke(data)}" stroke-width="${sw}" stroke-linejoin="miter" />`
  );
}

/** A regular n-gon is the n-point star at sharpness 2 (the polygon end of its range). */
export function polygonToSdf(data: PolygonMarkerData, _size: MarkerBounding): SdfGeometry {
  return { prim: 'star', shapeParams: [Math.max(3, Math.round(data.sides)), 2] };
}
