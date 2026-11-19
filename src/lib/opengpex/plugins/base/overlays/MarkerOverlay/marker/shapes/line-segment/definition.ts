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

/**
 * definition.ts — the shared DEFINITION SKELETON for the straight-line
 * marker family (line / arrow / darrow). The three kinds differ ONLY in their
 * panel metadata, default style and head flags; the drag→geometry model is
 * identical: endpoints in canvas-local space, Shift = 45° direction snap, and
 * the bounding is the TIGHT painted AABB (round caps + head triangles +
 * `SEGMENT_AA_MARGIN_PX` AA headroom) from the single-source geometry in
 * `geometry.ts`. Engine translation and the SVG preview live there too
 * (`segmentToSdf` / `segmentToSvg`), so the whole family has exactly ONE
 * geometry path from drag to GPU.
 */

'use client';

import type { InteractionHandler } from '@opengpex/editor/core/types';
import type React from 'react';
import type { SegmentMarkerData } from '../../types';
import type { MarkerDefinition } from '../../registry';
import { effectiveHeadLen, snapDirection45, segmentTightBounding } from './geometry';

/** Per-kind preset: everything the skeleton cannot derive on its own. */
export interface SegmentKindConfig<T extends SegmentMarkerData> {
  kind: T['kind'];
  label: string;
  icon: React.ReactNode;
  /** Head at the drag-start end. */
  headA: boolean;
  /** Head at the drag-end end. */
  headB: boolean;
  /** Default marker data (full payload, endpoints zeroed). */
  defaults: () => T;
  /** Optional per-kind extras (interaction handlers etc.). */
  interactions?: () => InteractionHandler[];
}

/**
 * Build a family member's MarkerDefinition. `computeFromDrag` is THE shared
 * drag model: snap under Shift, then tight painted bounding with the kind's
 * head flags; the endpoints come back layer-local (relative to the tight box's
 * top-left) and the caller converts `centerLocal` to world.
 */
export function defineLineSegmentKind<T extends SegmentMarkerData>(cfg: SegmentKindConfig<T>): MarkerDefinition<T> {
  return {
    kind: cfg.kind,
    label: cfg.label,
    icon: cfg.icon,
    hasFill: false,
    hasCornerRadius: false,
    defaults: cfg.defaults,
    interactions: cfg.interactions,

    computeFromDrag: (drag, data, options) => {
      const end = options.shiftKey
        ? snapDirection45(drag.startX, drag.startY, drag.endX, drag.endY)
        : { x: drag.endX, y: drag.endY };
      const sw = Math.max(0, data.stroke.width);
      // Headed kinds carry headScale; the line preset never reaches this path
      // (both head flags off → headLen 0). The length clamp keeps a short
      // drag's heads from crossing (the shaft must not invert).
      const headScale = (data as Partial<{ headScale: number }>).headScale || 3;
      const headLen = effectiveHeadLen(
        Math.hypot(end.x - drag.startX, end.y - drag.startY),
        sw, headScale, cfg.headA, cfg.headB,
      );
      const { bounding, centerLocal, a, b } = segmentTightBounding(
        { x: drag.startX, y: drag.startY },
        end,
        sw / 2,
        headLen,
        cfg.headA,
        cfg.headB,
      );
      return { bounding, centerLocal, patch: { a, b } as Partial<T> };
    },
  };
}
