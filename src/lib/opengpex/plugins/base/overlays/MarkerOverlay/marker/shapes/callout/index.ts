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
import { MessageSquare } from 'lucide-react';
import type { CalloutMarkerData } from '../../types';
import { fromHex } from '@opengpex/editor/core/engine/color';
import type { MarkerDefinition } from '../../registry';
import { layoutCallout } from './geometry';
import { createCalloutTailHandler } from './interactions';
import { CalloutTailHandle } from './TailHandle';

/** Default tail length as a fraction of the body height, with absolute bounds. */
const TAIL_LEN_RATIO = 0.45;
const TAIL_LEN_MIN_PX = 16;
const TAIL_LEN_MAX_PX = 80;

/** Where along the bottom edge the default tail leaves the body (fraction of width). */
const TAIL_ANCHOR_X_RATIO = 0.25;


/**
 * CalloutDefinition: speech-bubble body (the dragged rect) with a default tail
 * pointing down-left. The layer bounding is the AABB of body ∪ tip padded by
 * the stroke half-width, so `body` and `tip` are stored explicitly in
 * layer-local coordinates. Shift constrains the body to a square.
 *
 * The tail tip is editable: `renderHandles` adds a knob at the tip in the ACTIVE
 * state and `interactions` contributes the handler that drags it (both live in
 * this directory). Resizes still rescale body and tip proportionally.
 */
export const CalloutDefinition: MarkerDefinition<CalloutMarkerData> = {
  kind: 'callout',
  label: 'Callout',
  icon: React.createElement(MessageSquare, { size: 16 }),
  hasFill: true,
  hasCornerRadius: true,

  // Tail-tip editing: a dedicated knob at the tip plus the handler that drags it.
  interactions: () => [createCalloutTailHandler()],
  renderHandles: (data, bounding) => React.createElement(CalloutTailHandle, { data, bounding }),

  defaults: (): CalloutMarkerData => ({
    kind: 'callout',
    stroke: { color: fromHex('#FF3B30'), width: 3 },
    fill: { color: fromHex('#FFFFFF'), opacity: 0 },
    body: { x: 0, y: 0, w: 0, h: 0 },
    tip: { x: 0, y: 0 },
    cornerRadius: 8,
  }),

  computeFromDrag: (drag, data, options) => {
    let dx = drag.endX - drag.startX;
    let dy = drag.endY - drag.startY;

    if (options.shiftKey) {
      const size = Math.max(Math.abs(dx), Math.abs(dy));
      dx = Math.sign(dx || 1) * size;
      dy = Math.sign(dy || 1) * size;
    }

    // Body rect in canvas-local space.
    const bw = Math.abs(dx);
    const bh = Math.abs(dy);
    const bx = Math.min(drag.startX, drag.startX + dx);
    const by = Math.min(drag.startY, drag.startY + dy);

    // Default tail: leaves the bottom edge near the left, points straight down.
    const tailLen = Math.min(TAIL_LEN_MAX_PX, Math.max(TAIL_LEN_MIN_PX, bh * TAIL_LEN_RATIO));
    const tipX = bx + bw * TAIL_ANCHOR_X_RATIO;
    const tipY = by + bh + tailLen;

    const layout = layoutCallout({ x: bx, y: by, w: bw, h: bh }, { x: tipX, y: tipY }, data.stroke.width);
    return {
      bounding: layout.bounding,
      centerLocal: layout.center,
      patch: { body: layout.body, tip: layout.tip } as Partial<CalloutMarkerData>,
    };
  },
};
