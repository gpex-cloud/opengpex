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

/** Ellipse render: SVG preview + SDF geometry. Pure — no React. */

import type { EllipseMarkerData } from '../../types';
import type { MarkerBounding, SdfGeometry } from '../../types';
import { svgFillAttrs, svgStroke } from '../shared';

export function ellipseToSvg(data: EllipseMarkerData, bounding: MarkerBounding): string {
  const sw = Math.max(0, data.stroke.width);
  const half = sw / 2;
  const w = Math.max(0, bounding.w - sw);
  const h = Math.max(0, bounding.h - sw);
  if (w <= 0 || h <= 0) return '';
  return (
    `<ellipse cx="${half + w / 2}" cy="${half + h / 2}" rx="${w / 2}" ry="${h / 2}" ` +
    `${svgFillAttrs(data)} stroke="${svgStroke(data)}" stroke-width="${sw}" />`
  );
}

/** Geometry fully implied by `size`. */
export function ellipseToSdf(_data: EllipseMarkerData, _size: MarkerBounding): SdfGeometry {
  return { prim: 'ellipse', shapeParams: [] };
}
