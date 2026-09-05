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
import { Square } from 'lucide-react';
import type { RectMarkerData } from '@opengpex/editor/core/types';
import type { MarkerDefinition } from '../registry';

/**
 * RectDefinition: rectangle highlight box.
 *
 * Geometry is fully implied by the layer bounding (the rect always fills it),
 * so `computeFromDrag` only needs to turn the drag into an axis-aligned box.
 * Shift constrains to a square. No extra data patch is needed.
 */
export const RectDefinition: MarkerDefinition<RectMarkerData> = {
  kind: 'rect',
  label: 'Rectangle',
  icon: React.createElement(Square, { size: 16 }),
  hasFill: true,
  hasCornerRadius: true,

  defaults: (): RectMarkerData => ({
    kind: 'rect',
    stroke: { color: '#FF3B30', width: 3 },
    fill: { color: '#FF3B30', opacity: 0 },
    cornerRadius: 0,
  }),

  computeFromDrag: (drag, _data, options) => {
    let dx = drag.endX - drag.startX;
    let dy = drag.endY - drag.startY;

    // Shift → square: use the larger extent for both sides, preserving direction.
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
