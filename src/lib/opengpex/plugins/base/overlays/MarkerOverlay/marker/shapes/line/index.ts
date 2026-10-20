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
import { Slash } from 'lucide-react';
import type { LineMarkerData } from '../../types';
import { fromHex } from '@opengpex/editor/core/engine/color';
import type { MarkerDefinition } from '../../registry';
import { snapDirection45, segmentBounding } from '../shared';

/**
 * LineDefinition: plain straight stroke from drag start to drag end.
 *
 * Same endpoint model as the arrow (layer-local `a`/`b` inside a bounding box
 * padded by the stroke half-width for the round caps), minus the head.
 */
export const LineDefinition: MarkerDefinition<LineMarkerData> = {
  kind: 'line',
  label: 'Line',
  icon: React.createElement(Slash, { size: 16 }),
  hasFill: false,
  hasCornerRadius: false,

  defaults: (): LineMarkerData => ({
    kind: 'line',
    stroke: { color: fromHex('#0A84FF'), width: 6 },
    fill: { color: fromHex('#000000'), opacity: 0 },
    a: { x: 0, y: 0 },
    b: { x: 0, y: 0 },
  }),

  computeFromDrag: (drag, data, options) => {
    const end = options.shiftKey
      ? snapDirection45(drag.startX, drag.startY, drag.endX, drag.endY)
      : { x: drag.endX, y: drag.endY };
    const pad = Math.max(0, data.stroke.width) / 2 + 1;
    const { bounding, centerLocal, a, b } = segmentBounding(
      { x: drag.startX, y: drag.startY },
      end,
      pad,
    );
    return { bounding, centerLocal, patch: { a, b } as Partial<LineMarkerData> };
  },
};
