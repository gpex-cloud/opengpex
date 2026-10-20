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
import { MoveDiagonal2 } from 'lucide-react';
import type { DarrowMarkerData } from '../../types';
import { fromHex } from '@opengpex/editor/core/engine/color';
import type { MarkerDefinition } from '../../registry';
import { snapDirection45, segmentBounding } from '../shared';

/**
 * DarrowDefinition: straight arrow with a head at both ends (dimension /
 * relation marker). Bounding is padded by the head length on every side so
 * both heads stay inside the layer.
 */
export const DarrowDefinition: MarkerDefinition<DarrowMarkerData> = {
  kind: 'darrow',
  label: 'Double Arrow',
  icon: React.createElement(MoveDiagonal2, { size: 16 }),
  hasFill: false,
  hasCornerRadius: false,

  defaults: (): DarrowMarkerData => ({
    kind: 'darrow',
    stroke: { color: fromHex('#0A84FF'), width: 6 },
    fill: { color: fromHex('#000000'), opacity: 0 },
    a: { x: 0, y: 0 },
    b: { x: 0, y: 0 },
    headScale: 3,
  }),

  computeFromDrag: (drag, data, options) => {
    const end = options.shiftKey
      ? snapDirection45(drag.startX, drag.startY, drag.endX, drag.endY)
      : { x: drag.endX, y: drag.endY };
    const sw = Math.max(0, data.stroke.width);
    const headScale = data.headScale || 3;
    const pad = sw * headScale + sw / 2 + 1;
    const { bounding, centerLocal, a, b } = segmentBounding(
      { x: drag.startX, y: drag.startY },
      end,
      pad,
    );
    return { bounding, centerLocal, patch: { a, b } as Partial<DarrowMarkerData> };
  },
};
