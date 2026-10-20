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

/** Star render: SVG preview + SDF geometry. Pure — no React. */

import type { StarMarkerData } from '../../types';
import type { MarkerBounding, SdfGeometry } from '../../types';
import { svgFillAttrs, svgStroke } from '../shared';

/**
 * Inner-vertex radius of the regular star as a fraction of the outer radius,
 * derived from the same (points, sharpness) parametrisation the GPU SDF uses:
 * the spike edge leaves the tip at angle π/sharpness and meets the sector
 * boundary (angle π/points from the tip) at the inner vertex. Sharpness 2 gives
 * cos(π/n) — the edge midpoint of a regular polygon; sharpness n gives 0.
 */
export function starInnerRadiusRatio(points: number, sharpness: number): number {
  const n = Math.max(3, Math.round(points));
  const m = Math.min(Math.max(sharpness, 2), n);
  const an = Math.PI / n;
  const en = Math.PI / m;
  return Math.max(0, Math.cos(an) - Math.sin(an) / Math.tan(en));
}

/**
 * Vertices of a regular n-gon / 2n-vertex star inscribed in the inset box, first
 * vertex pointing up (-y on screen) to match the GPU orientation. `inner` < 1
 * alternates outer/inner radii (star); `inner` undefined emits only the n outer
 * vertices (polygon).
 */
export function radialPolygonPoints(
  bounding: MarkerBounding,
  strokeWidth: number,
  n: number,
  inner?: number,
): string[] {
  const half = strokeWidth / 2;
  const w = Math.max(0, bounding.w - strokeWidth);
  const h = Math.max(0, bounding.h - strokeWidth);
  const cx = half + w / 2;
  const cy = half + h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const count = inner === undefined ? n : n * 2;
  const step = inner === undefined ? (2 * Math.PI) / n : Math.PI / n;
  const pts: string[] = [];
  for (let i = 0; i < count; i++) {
    const r = inner === undefined || i % 2 === 0 ? 1 : inner;
    const theta = -Math.PI / 2 + i * step;
    pts.push(`${cx + Math.cos(theta) * rx * r},${cy + Math.sin(theta) * ry * r}`);
  }
  return pts;
}

export function starToSvg(data: StarMarkerData, bounding: MarkerBounding): string {
  const sw = Math.max(0, data.stroke.width);
  if (bounding.w - sw <= 0 || bounding.h - sw <= 0) return '';
  const n = Math.max(3, Math.round(data.points));
  const pts = radialPolygonPoints(bounding, sw, n, starInnerRadiusRatio(data.points, data.sharpness));
  return (
    `<polygon points="${pts.join(' ')}" ` +
    `${svgFillAttrs(data)} stroke="${svgStroke(data)}" stroke-width="${sw}" stroke-linejoin="miter" />`
  );
}

export function starToSdf(data: StarMarkerData, _size: MarkerBounding): SdfGeometry {
  return { prim: 'star', shapeParams: [Math.max(3, Math.round(data.points)), data.sharpness] };
}
