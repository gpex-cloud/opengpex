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

/** Double-arrow render: SVG preview + SDF geometry. Pure — no React. */

import type { DarrowMarkerData } from '../../types';
import type { MarkerBounding, SdfGeometry } from '../../types';
import { svgStroke } from '../shared';
import { arrowHeadSvg } from '../shared';

export function darrowToSvg(data: DarrowMarkerData): string {
  const sw = Math.max(0, data.stroke.width);
  const { a, b } = data;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.hypot(dx, dy) <= 0) return '';

  const angle = Math.atan2(dy, dx);
  const headLen = sw * (data.headScale || 3);
  const color = svgStroke(data);
  const headB = arrowHeadSvg(b, angle, headLen, color);
  const headA = arrowHeadSvg(a, angle + Math.PI, headLen, color);

  return (
    `<line x1="${headA.base.x}" y1="${headA.base.y}" x2="${headB.base.x}" y2="${headB.base.y}" ` +
    `stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" />` +
    headA.polygon +
    headB.polygon
  );
}

export function darrowToSdf(data: DarrowMarkerData, _size: MarkerBounding): SdfGeometry {
  return {
    prim: 'darrow',
    shapeParams: [data.a.x, data.a.y, data.b.x, data.b.y],
    headScale: data.headScale || 3,
  };
}
