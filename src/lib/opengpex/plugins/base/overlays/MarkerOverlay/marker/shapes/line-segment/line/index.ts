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
import { fromHex } from '@opengpex/editor/core/engine/color';
import type { LineMarkerData } from '../../../types';
import { defineLineSegmentKind } from '../definition';

/**
 * LineDefinition: plain straight stroke from drag start to drag end, no heads.
 * A family preset — the shared drag→tight-bounding model comes from
 * `defineLineSegmentKind` (with both head flags off the tight box is just the
 * endpoints' round caps plus the AA margin).
 */
export const LineDefinition = defineLineSegmentKind<LineMarkerData>({
  kind: 'line',
  label: 'Line',
  icon: React.createElement(Slash, { size: 16 }),
  headA: false,
  headB: false,

  defaults: (): LineMarkerData => ({
    kind: 'line',
    stroke: { color: fromHex('#0A84FF'), width: 6 },
    fill: { color: fromHex('#000000'), opacity: 0 },
    a: { x: 0, y: 0 },
    b: { x: 0, y: 0 },
  }),
});
