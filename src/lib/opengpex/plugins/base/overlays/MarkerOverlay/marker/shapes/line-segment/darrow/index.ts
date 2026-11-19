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
import { fromHex } from '@opengpex/editor/core/engine/color';
import type { DarrowMarkerData } from '../../../types';
import { defineLineSegmentKind } from '../definition';

/**
 * DarrowDefinition: straight arrow with a head at BOTH ends (dimension /
 * relation marker). A family preset — the shared drag→tight-bounding model
 * comes from `defineLineSegmentKind`, both head flags on.
 */
export const DarrowDefinition = defineLineSegmentKind<DarrowMarkerData>({
  kind: 'darrow',
  label: 'Double Arrow',
  icon: React.createElement(MoveDiagonal2, { size: 16 }),
  headA: true,
  headB: true,

  defaults: (): DarrowMarkerData => ({
    kind: 'darrow',
    stroke: { color: fromHex('#0A84FF'), width: 6 },
    fill: { color: fromHex('#000000'), opacity: 0 },
    a: { x: 0, y: 0 },
    b: { x: 0, y: 0 },
    headScale: 3,
  }),
});
