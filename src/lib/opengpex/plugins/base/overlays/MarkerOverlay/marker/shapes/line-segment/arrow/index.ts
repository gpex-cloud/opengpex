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
import { fromHex } from '@opengpex/editor/core/engine/color';
import type { ArrowMarkerData } from '../../../types';
import { defineLineSegmentKind } from '../definition';

/**
 * ArrowDefinition: straight arrow from the drag start to the drag end, head at
 * the drag-end end. A family preset — the shared drag→tight-bounding model
 * comes from `defineLineSegmentKind`.
 */
export const ArrowDefinition = defineLineSegmentKind<ArrowMarkerData>({
  kind: 'arrow',
  label: 'Arrow',
  icon: React.createElement(ArrowUpRight, { size: 16 }),
  headA: false,
  headB: true,

  defaults: (): ArrowMarkerData => ({
    kind: 'arrow',
    stroke: { color: fromHex('#0A84FF'), width: 6 },
    fill: { color: fromHex('#000000'), opacity: 0 },
    a: { x: 0, y: 0 },
    b: { x: 0, y: 0 },
    headScale: 3,
  }),
});
