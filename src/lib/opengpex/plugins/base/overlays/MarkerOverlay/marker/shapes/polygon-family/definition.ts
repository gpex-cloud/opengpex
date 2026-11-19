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
 * definition.ts — the shared DEFINITION SKELETON for the polygon-family marker family (star / polygon)
 * (star / polygon). Both kinds are inscribed in the layer bounding with the
 * same drag model (drag = the circumscribed box, Shift constrains to a square
 * so the shape is undistorted) and carry no per-drag geometry patch — the
 * shape's only free parameters (points/sides, sharpness) live in the panel,
 * not in the gesture. Engine translation and the SVG preview live in
 * `geometry.ts` (`radialToSdf` / `radialToSvg`), so the family has exactly ONE
 * geometry path from drag to GPU.
 */

'use client';

import type { InteractionHandler } from '@opengpex/editor/core/types';
import type React from 'react';
import type { MarkerData } from '../../types';
import type { MarkerDefinition } from '../../registry';

/** Per-kind preset: everything the skeleton cannot derive on its own. */
export interface RadialKindConfig<T extends MarkerData> {
  kind: T['kind'];
  label: string;
  icon: React.ReactNode;
  /** Default marker data (full payload). */
  defaults: () => T;
  /** Data-driven layer name (e.g. "Pentagon", "6-Point Star"); omitted = label. */
  layerName?: (data: T) => string;
  /** Optional per-kind extras (interaction handlers etc.). */
  interactions?: () => InteractionHandler[];
}

/**
 * Build a family member's MarkerDefinition. `computeFromDrag` is THE shared
 * drag model: the dragged box is the shape's circumscribed box (Shift = square
 * constraint); no geometry patch — everything else lives in markerData.
 */
export function defineRadialKind<T extends MarkerData>(cfg: RadialKindConfig<T>): MarkerDefinition<T> {
  return {
    kind: cfg.kind,
    label: cfg.label,
    icon: cfg.icon,
    hasFill: true,
    hasCornerRadius: false,
    defaults: cfg.defaults,
    layerName: cfg.layerName,
    interactions: cfg.interactions,

    computeFromDrag: (drag, _data, options) => {
      let dx = drag.endX - drag.startX;
      let dy = drag.endY - drag.startY;

      if (options.shiftKey) {
        const size = Math.max(Math.abs(dx), Math.abs(dy));
        dx = Math.sign(dx || 1) * size;
        dy = Math.sign(dy || 1) * size;
      }

      const w = Math.abs(dx);
      const h = Math.abs(dy);
      const x = Math.min(drag.startX, drag.startX + dx);
      const y = Math.min(drag.startY, drag.startY + dy);

      return {
        bounding: { w, h },
        centerLocal: { x: x + w / 2, y: y + h / 2 },
        patch: {},
      };
    },
  };
}
