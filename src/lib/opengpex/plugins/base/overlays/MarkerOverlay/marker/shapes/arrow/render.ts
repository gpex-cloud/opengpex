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

/** Arrow render: SVG preview + SDF geometry. Pure — no React. */

import type { ArrowMarkerData } from '../../types';
import type { MarkerBounding, SdfGeometry } from '../../types';
import { svgStroke } from '../shared';
import { arrowHeadSvg } from '../shared';

export function arrowToSvg(data: ArrowMarkerData): string {
  const sw = Math.max(0, data.stroke.width);
  const { tail, head } = data;
  const dx = head.x - tail.x;
  const dy = head.y - tail.y;
  if (Math.hypot(dx, dy) <= 0) return '';

  const angle = Math.atan2(dy, dx);
  const color = svgStroke(data);
  const headPart = arrowHeadSvg(head, angle, sw * (data.headScale || 3), color);

  return (
    `<line x1="${tail.x}" y1="${tail.y}" x2="${headPart.base.x}" y2="${headPart.base.y}" ` +
    `stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" />` +
    headPart.polygon
  );
}

/**
 * tail/head are the same layer-local endpoints the SVG uses (arbitrary direction);
 * the head length is derived in-shader as strokeWidth × headScale — ONE formula.
 */
export function arrowToSdf(data: ArrowMarkerData, _size: MarkerBounding): SdfGeometry {
  return {
    prim: 'arrow',
    shapeParams: [data.tail.x, data.tail.y, data.head.x, data.head.y],
    headScale: data.headScale || 3,
  };
}
