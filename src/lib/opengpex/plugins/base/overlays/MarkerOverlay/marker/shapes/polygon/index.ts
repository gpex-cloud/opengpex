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
import type { PolygonMarkerData } from '../../types';
import { fromHex } from '@opengpex/editor/core/engine/color';
import type { MarkerDefinition } from '../../registry';

/** Default side count (triangle). */
export const POLYGON_DEFAULT_SIDES = 3;

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
 * PolygonDefinition: regular polygon inscribed in the layer bounding (same drag
 * model as the ellipse; Shift constrains to a square so the polygon is
 * undistorted). Rendered through the engine's star primitive at the polygon
 * end of its sharpness range — a regular n-gon IS the degenerate n-point star.
 */
export const PolygonDefinition: MarkerDefinition<PolygonMarkerData> = {
  kind: 'polygon',
  label: 'Polygon',
  icon: React.createElement(Triangle, { size: 16 }),
  hasFill: true,
  hasCornerRadius: false,
  layerName: (data) => polygonLayerName(data.sides),

  defaults: (): PolygonMarkerData => ({
    kind: 'polygon',
    stroke: { color: fromHex('#FF3B30'), width: 3 },
    fill: { color: fromHex('#FF3B30'), opacity: 0 },
    sides: POLYGON_DEFAULT_SIDES,
  }),

  computeFromDrag: (drag, _data, options) => {
    let dx = drag.endX - drag.startX;
    let dy = drag.endY - drag.startY;

    if (options.shiftKey) {
      const size = Math.max(Math.abs(dx), Math.abs(dy));
      dx = Math.sign(dx || 1) * size;
      dy = Math.sign(dy || 1) * size;
    }

    const w = Math.abs(dx);
    const h = Math.abs(dy);
    const x = Math.min(drag.startX, drag.startX + dx);
    const y = Math.min(drag.startY, drag.startY + dy);

    return {
      bounding: { w, h },
      centerLocal: { x: x + w / 2, y: y + h / 2 },
      patch: {},
    };
  },
};
