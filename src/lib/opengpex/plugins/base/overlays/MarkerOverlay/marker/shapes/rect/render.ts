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

/** Rect render: SVG preview + SDF geometry. Pure — no React. */

import type { RectMarkerData } from '../../types';
import type { MarkerBounding, SdfGeometry } from '../../types';
import { clampRadius, svgFillAttrs, svgStroke } from '../shared';

export function rectToSvg(data: RectMarkerData, bounding: MarkerBounding): string {
  const sw = Math.max(0, data.stroke.width);
  const half = sw / 2;
  const w = Math.max(0, bounding.w - sw);
  const h = Math.max(0, bounding.h - sw);
  if (w <= 0 || h <= 0) return '';
  const radius = clampRadius(data.cornerRadius, w, h);
  return (
    `<rect x="${half}" y="${half}" width="${w}" height="${h}" rx="${radius}" ry="${radius}" ` +
    `${svgFillAttrs(data)} stroke="${svgStroke(data)}" stroke-width="${sw}" stroke-linejoin="miter" />`
  );
}

/** `rounded_rect` with the corner radius clamped to half the short side. */
export function rectToSdf(data: RectMarkerData, size: MarkerBounding): SdfGeometry {
  const maxR = Math.min(size.w, size.h) / 2;
  return { prim: 'rounded_rect', shapeParams: [Math.min(Math.max(0, data.cornerRadius ?? 0), maxR)] };
}
