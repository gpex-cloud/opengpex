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
import { Star } from 'lucide-react';
import type { StarMarkerData } from '../../types';
import { fromHex } from '@opengpex/editor/core/engine/color';
import type { MarkerDefinition } from '../../registry';

/**
 * Default spike count and sharpness (2 = regular polygon, points = spikes to the
 * centre). 3.2 on a 5-point star puts the inner vertices at ~0.41 of the outer
 * radius — close to the classic pentagram's 0.38.
 */
export const STAR_DEFAULT_POINTS = 5;
export const STAR_DEFAULT_SHARPNESS = 3.2;

/**
 * StarDefinition: regular star inscribed in the layer bounding (same drag model
 * as the ellipse; Shift constrains to a square so the star is undistorted).
 */
export const StarDefinition: MarkerDefinition<StarMarkerData> = {
  kind: 'star',
  label: 'Star',
  icon: React.createElement(Star, { size: 16 }),
  hasFill: true,
  hasCornerRadius: false,
  layerName: (data) => `${Math.max(3, Math.round(data.points))}-Point Star`,

  defaults: (): StarMarkerData => ({
    kind: 'star',
    stroke: { color: fromHex('#FFCC00'), width: 3 },
    fill: { color: fromHex('#FFCC00'), opacity: 0 },
    points: STAR_DEFAULT_POINTS,
    sharpness: STAR_DEFAULT_SHARPNESS,
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
