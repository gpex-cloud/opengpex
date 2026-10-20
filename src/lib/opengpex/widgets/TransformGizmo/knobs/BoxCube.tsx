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

/** Side of each square mark (screen px). */
export const CUBE_MARK_PX = 8;

/**
 * BoxCube: visual-only square marks at the 4 corners and 4 edge midpoints of
 * the host box — the "cube" handle look of TransformGizmo. Same black-underlay
 * + white-core dual stroke as BoxCorners for contrast on any background; the
 * marks sit flush on the box border (no outset) so a 1:1 hit zone can be
 * centred on exactly the same anchors. Pointer-events none throughout: the
 * gizmo overlays its own hit zones.
 */
export const BoxCube = React.memo(function BoxCube() {
  const inset = MARK_STROKE_W;
  const side = CUBE_MARK_PX - inset * 2;
  return (
    <div className="absolute inset-0 pointer-events-none" data-box-cube>
      {[...CORNER_ANCHORS, ...EDGE_ANCHORS].map(({ dir, style }) => (
        <div key={dir} style={markBoxStyle(CUBE_MARK_PX, style)}>
          <svg
            width={CUBE_MARK_PX}
            height={CUBE_MARK_PX}
            viewBox={`0 0 ${CUBE_MARK_PX} ${CUBE_MARK_PX}`}
            style={{ width: '100%', height: '100%', display: 'block', overflow: 'visible' }}
          >
            <rect x={inset} y={inset} width={side} height={side} fill="#ffffff" stroke="#000000" strokeWidth={MARK_STROKE_W + 2} />
            <rect x={inset} y={inset} width={side} height={side} fill="none" stroke="#ffffff" strokeWidth={MARK_STROKE_W} />
          </svg>
        </div>
      ))}
    </div>
  );
});
