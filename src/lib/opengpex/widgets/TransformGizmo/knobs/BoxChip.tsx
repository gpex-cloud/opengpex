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
import { CORNER_ANCHORS, EDGE_ANCHORS, MARK_STROKE_W, markBoxStyle } from '../geometry';

/** Diameter of each round mark (screen px). */
export const CHIP_MARK_PX = 8;

/**
 * BoxChip: visual-only round marks at the 4 corners and 4 edge midpoints of
 * the host box — the "chip" handle look of TransformGizmo. Same black-underlay
 * + white-core dual stroke as BoxCorners for contrast on any background; the
 * marks sit flush on the box border (no outset) so a 1:1 hit zone can be
 * centred on exactly the same anchors. Pointer-events none throughout: the
 * gizmo overlays its own hit zones.
 */
export const BoxChip = React.memo(function BoxChip() {
  const c = CHIP_MARK_PX / 2;
  const r = c - MARK_STROKE_W;
  return (
    <div className="absolute inset-0 pointer-events-none" data-box-chip>
      {[...CORNER_ANCHORS, ...EDGE_ANCHORS].map(({ dir, style }) => (
        <div key={dir} style={markBoxStyle(CHIP_MARK_PX, style)}>
          <svg
            width={CHIP_MARK_PX}
            height={CHIP_MARK_PX}
            viewBox={`0 0 ${CHIP_MARK_PX} ${CHIP_MARK_PX}`}
            style={{ width: '100%', height: '100%', display: 'block', overflow: 'visible' }}
          >
            <circle cx={c} cy={c} r={r} fill="#ffffff" stroke="#000000" strokeWidth={MARK_STROKE_W + 2} />
            <circle cx={c} cy={c} r={r} fill="none" stroke="#ffffff" strokeWidth={MARK_STROKE_W} />
          </svg>
        </div>
      ))}
    </div>
  );
});
