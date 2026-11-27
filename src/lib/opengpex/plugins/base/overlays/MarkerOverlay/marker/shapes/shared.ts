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
 * shared.ts — cross-family helpers used by several marker shapes.
 * Shape-FAMILY-specific logic lives in its own directory (see
 * `line-segment/geometry.ts`); nothing kind- or family-private belongs here.
 * Render-side: this module must stay free of React (checked by render-purity.test.ts).
 */

import type { MarkerData } from '../types';

export function clampRadius(radius: number, w: number, h: number): number {
  const max = Math.min(w, h) / 2;
  return Math.max(0, Math.min(radius || 0, max));
}


/**
 * Rescale the layer-local geometry a marker stores (segment endpoints, callout
 * body + tip) by the bounding box's resize factors so the shape keeps tracking
 * the box. Kinds whose geometry is fully implied by the bounding (rect /
 * ellipse / radial families) pass through. Shared by the live resize gesture
 * and the regularize (squareize) fit — one contract, one implementation.
 */
export function rescaleLocalGeometry(data: MarkerData, sx: number, sy: number): MarkerData {
  const pt = (p: { x: number; y: number }) => ({ x: p.x * sx, y: p.y * sy });
  switch (data.kind) {
    case 'arrow':
    case 'line':
    case 'darrow':
      // One shared endpoint model for the whole segment family.
      return { ...data, a: pt(data.a), b: pt(data.b) };
    case 'callout':
      return {
        ...data,
        body: { x: data.body.x * sx, y: data.body.y * sy, w: data.body.w * sx, h: data.body.h * sy },
        tip: pt(data.tip),
      };
    default:
      return data;
  }
}
