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
 * shared.ts — cross-family helpers used by several marker shapes: SVG paint
 * attribute strings and corner-radius clamping. Shape-FAMILY-specific logic
 * lives in its own directory (see `line-segment/geometry.ts`); nothing kind-
 * or family-private belongs here. Render-side: this module must stay free of
 * React (checked by render-purity.test.ts).
 */

import type { MarkerData } from '../types';
import { toCssColor4 } from '@opengpex/editor/core/engine/color';

export function clampRadius(radius: number, w: number, h: number): number {
  const max = Math.min(w, h) / 2;
  return Math.max(0, Math.min(radius || 0, max));
}

/** SVG `fill` / `fill-opacity` attribute values for a marker's fill ("none" when off). */
export function svgFillAttrs(data: MarkerData): string {
  const on = data.fill.opacity > 0;
  const fill = on ? toCssColor4(data.fill.color) : 'none';
  return `fill="${fill}" fill-opacity="${on ? data.fill.opacity : 0}"`;
}

/** SVG stroke colour attribute value. */
export function svgStroke(data: MarkerData): string {
  return toCssColor4(data.stroke.color);
}

