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

import React from 'react';
import { Triangle } from 'lucide-react';
import { fromHex } from '@opengpex/editor/core/engine/color';
import type { PolygonMarkerData } from '../../../types';
import { defineRadialKind } from '../definition';

/** Default side count (triangle). */
export const POLYGON_DEFAULT_SIDES = 3;

/**
 * The ONLY side counts the product offers — a fixed preset set, no free
 * numeric range (mirrors STAR_POINTS_PRESETS). Legacy documents may still hold
 * off-preset counts: they render exactly as stored and the panel simply shows
 * no active preset for them.
 */
export const POLYGON_SIDES_PRESETS: readonly number[] = [3, 5, 6, 8, 10];

/** Conventional names for regular polygons by side count (4 is a diamond: first vertex points up). */
const POLYGON_NAMES: Record<number, string> = {
  3: 'Triangle',
  4: 'Diamond',
  5: 'Pentagon',
  6: 'Hexagon',
  7: 'Heptagon',
  8: 'Octagon',
  9: 'Nonagon',
  10: 'Decagon',
  11: 'Hendecagon',
  12: 'Dodecagon',
};

export function polygonLayerName(sides: number): string {
  const n = Math.max(3, Math.round(sides));
  return POLYGON_NAMES[n] ?? `${n}-gon`;
}

/**
 * PolygonDefinition: regular polygon inscribed in the layer bounding. A family
 * preset — the shared inscribed-box drag model comes from `defineRadialKind`;
 * the sharpness spectrum is pinned at 2, the exact regular n-gon end (a
 * regular n-gon IS the n-point star at sharpness 2), so no extra engine
 * primitive exists for it.
 */
export const PolygonDefinition = defineRadialKind<PolygonMarkerData>({
  kind: 'polygon',
  label: 'Polygon',
  icon: React.createElement(Triangle, { size: 16 }),
  layerName: (data) => polygonLayerName(data.sides),

  defaults: (): PolygonMarkerData => ({
    kind: 'polygon',
    stroke: { color: fromHex('#FF3B30'), width: 3 },
    fill: { color: fromHex('#FF3B30'), opacity: 0 },
    sides: POLYGON_DEFAULT_SIDES,
    // Content-bounding semantics from birth (the same convention as rect /
    // line-segment / star): the dragged box IS the painted n-gon's AABB.
    bounding: true,
  }),
});
