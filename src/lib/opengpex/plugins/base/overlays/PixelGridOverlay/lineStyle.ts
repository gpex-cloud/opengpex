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
 * lineStyle.ts — Pure stroke-pass plan for the pixel grid overlay.
 *
 * Split out of the render loop so the dpr-degradation decision is a plain
 * function testable without a canvas: the dual-tone pair (dark casing + light
 * core) only fits when a line has ≥2 device pixels; on a DPR=1 display both
 * tones would collapse into ONE twice-as-wide device pixel — the thick-grid
 * artifact. Below the floor 'dual' presents as the single light hairline
 * (PS/GIMP model); the user preference itself is never rewritten, so dragging
 * the window back to a high-dpi screen restores the full pair.
 */

import type { GridLineStyle } from './protocols';
import { DUAL_TONE_MIN_DPR } from './protocols';

/** Which strokes the overlay paints for this frame. */
export interface GridStrokePlan {
  /** Draw the dark casing pass underneath the core pass. */
  readonly casing: boolean;
  /** Which configured color the final (core) pass uses. */
  readonly core: 'dark' | 'light';
}

/**
 * Resolve the stroke passes for one frame from the user's line style and the
 * live devicePixelRatio. Pure.
 */
export function resolveGridStrokePlan(style: GridLineStyle, dpr: number): GridStrokePlan {
  if (style === 'dark') return { casing: false, core: 'dark' };
  if (style === 'light') return { casing: false, core: 'light' };
  // 'dual': the casing only fits when the line owns ≥2 device pixels.
  return { casing: dpr >= DUAL_TONE_MIN_DPR, core: 'light' };
}
