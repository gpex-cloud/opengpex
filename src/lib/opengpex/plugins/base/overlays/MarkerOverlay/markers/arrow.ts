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
import { ArrowUpRight } from 'lucide-react';
import type { ArrowMarkerData } from '@opengpex/editor/core/types';
import type { MarkerDefinition } from '../registry';

/** 45° angle snap step (radians) applied when Shift is held. */
const SNAP_STEP = Math.PI / 4;

/**
 * ArrowDefinition: straight arrow from tail (drag start) to head (drag end).
 *
 * The bounding box is the AABB of the two endpoints, padded by the stroke
 * width + arrowhead length so neither the barbs nor the round line cap get
 * clipped. Endpoints are stored layer-local (relative to bounding top-left)
 * so `paintMarker` / `markerToSvg` can draw without needing world context.
 */
export const ArrowDefinition: MarkerDefinition<ArrowMarkerData> = {
  kind: 'arrow',
  label: 'Arrow',
  icon: React.createElement(ArrowUpRight, { size: 16 }),
  hasFill: false,
  hasCornerRadius: false,

  defaults: (): ArrowMarkerData => ({
    kind: 'arrow',
    stroke: { color: '#0A84FF', width: 6 },
    fill: { color: '#000000', opacity: 0 },
    tail: { x: 0, y: 0 },
    head: { x: 0, y: 0 },
    headScale: 3,
  }),

  computeFromDrag: (drag, data, options) => {
    let endX = drag.endX;
    let endY = drag.endY;

    // Shift → snap the direction to the nearest 45°, preserving length.
    if (options.shiftKey) {
      const dx = endX - drag.startX;
      const dy = endY - drag.startY;
      const len = Math.hypot(dx, dy);
      const snapped = Math.round(Math.atan2(dy, dx) / SNAP_STEP) * SNAP_STEP;
      endX = drag.startX + Math.cos(snapped) * len;
      endY = drag.startY + Math.sin(snapped) * len;
    }

    // Padding: arrowhead length + a stroke half-width margin for the round cap.
    const sw = Math.max(0, data.stroke.width);
    const headScale = data.headScale || 3;
    const pad = sw * headScale + sw / 2 + 1;

    const minX = Math.min(drag.startX, endX) - pad;
    const minY = Math.min(drag.startY, endY) - pad;
    const maxX = Math.max(drag.startX, endX) + pad;
    const maxY = Math.max(drag.startY, endY) + pad;

    const w = maxX - minX;
    const h = maxY - minY;

    // Endpoints relative to the padded bounding box top-left (layer-local).
    const tail = { x: drag.startX - minX, y: drag.startY - minY };
    const head = { x: endX - minX, y: endY - minY };

    return {
      bounding: { w, h },
      centerLocal: { x: minX + w / 2, y: minY + h / 2 },
      patch: { tail, head } as Partial<ArrowMarkerData>,
    };
  },
};
