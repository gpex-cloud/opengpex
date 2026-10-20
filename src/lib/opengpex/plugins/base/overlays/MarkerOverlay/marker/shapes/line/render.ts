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

/** Line render: SVG preview + SDF geometry. Pure — no React. */

import type { LineMarkerData } from '../../types';
import type { MarkerBounding, SdfGeometry } from '../../types';
import { svgStroke } from '../shared';

export function lineToSvg(data: LineMarkerData): string {
  const sw = Math.max(0, data.stroke.width);
  const { a, b } = data;
  if (Math.hypot(b.x - a.x, b.y - a.y) <= 0) return '';
  return (
    `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" ` +
    `stroke="${svgStroke(data)}" stroke-width="${sw}" stroke-linecap="round" />`
  );
}

export function lineToSdf(data: LineMarkerData, _size: MarkerBounding): SdfGeometry {
  return { prim: 'line', shapeParams: [data.a.x, data.a.y, data.b.x, data.b.y] };
}
