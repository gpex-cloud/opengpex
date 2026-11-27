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

/** Callout render: SDF geometry. Pure — no React. */

import type { CalloutMarkerData } from '../../types';
import type { MarkerBounding, SdfGeometry } from '../../types';
import { calloutTailHalfBase } from './geometry';

/** `callout`: [body.x, body.y, body.w, body.h, tip.x, tip.y, cornerRadius, tailHalfBase]. */
function calloutShapeParams(data: CalloutMarkerData): readonly number[] {
  const { body, tip } = data;
  const maxR = Math.min(body.w, body.h) / 2;
  const r = Math.min(Math.max(0, data.cornerRadius ?? 0), maxR);
  return [body.x, body.y, body.w, body.h, tip.x, tip.y, r, calloutTailHalfBase(body, tip, data.stroke.width)];
}

/** `callout`: [body.x, body.y, body.w, body.h, tip.x, tip.y, cornerRadius, tailHalfBase]. */
export function calloutToSdf(data: CalloutMarkerData, _size: MarkerBounding): SdfGeometry {
  return {
    prim: 'callout',
    shapeParams: calloutShapeParams(data),
  };
}
