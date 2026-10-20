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
import type { CalloutMarkerData } from '../../types';

/** Knob diameter (screen px) and dual-stroke core width. */
const KNOB_PX = 10;
const STROKE_W = 2;

/** DOM marker the tail handler's `test` looks for. */
export const CALLOUT_TAIL_HANDLE_ATTR = 'data-marker-tail-handle';

/**
 * CalloutTailHandle: the tail-tip control point, drawn at the tip's position
 * inside the (screen-space) selection box. A round dual-stroke knob — deliberately
 * NOT a corner bracket, so it reads as "a point you move" rather than a resize
 * handle. Positioned in bounding percentages so it follows the box's fast-sync
 * without its own subscription.
 */
export const CalloutTailHandle = React.memo(function CalloutTailHandle({
  data,
  bounding,
}: {
  data: CalloutMarkerData;
  bounding: { w: number; h: number };
}) {
  const left = bounding.w > 0 ? `${(data.tip.x / bounding.w) * 100}%` : '0%';
  const top = bounding.h > 0 ? `${(data.tip.y / bounding.h) * 100}%` : '0%';
  const c = KNOB_PX / 2;
  const r = c - STROKE_W;
  return (
    <div
      {...{ [CALLOUT_TAIL_HANDLE_ATTR]: 'true' }}
      className="absolute pointer-events-auto hover:scale-125 transition-transform duration-150"
      style={{
        left,
        top,
        width: KNOB_PX,
        height: KNOB_PX,
        transform: 'translate(-50%, -50%)',
        cursor: 'move',
        overflow: 'visible',
      }}
    >
      <svg width={KNOB_PX} height={KNOB_PX} viewBox={`0 0 ${KNOB_PX} ${KNOB_PX}`} style={{ display: 'block', overflow: 'visible' }}>
        <circle cx={c} cy={c} r={r} fill="#ffffff" stroke="#000000" strokeWidth={STROKE_W + 2} />
        <circle cx={c} cy={c} r={r} fill="none" stroke="#ffffff" strokeWidth={STROKE_W} />
      </svg>
    </div>
  );
});
