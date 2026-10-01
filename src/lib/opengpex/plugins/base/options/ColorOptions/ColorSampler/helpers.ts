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

import { GRID_LINE_MARGIN, GRID_LINE_DEVICE_PX, SAMPLER_CHROME_ATTR } from "./constants";
import type { GridInk } from "./types";

/** Is this event target inside opted-out chrome (see {@link SAMPLER_CHROME_ATTR})? */
export function inSamplerChrome(target: EventTarget | null): boolean {
  const el = target as Element | null;
  return !!el?.closest?.(`[${SAMPLER_CHROME_ATTR}]`);
}

/** Divider thickness in CSS px on this display (1px at DPR 2, 2px at DPR 1). */
export function gridLineWidth(): number {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  return GRID_LINE_DEVICE_PX / dpr;
}

/** Derive the two divider greys from the block's luminance range. */
export function gridInkFor(minLum: number, maxLum: number): GridInk {
  const lo = Math.max(0, Math.round(minLum) - GRID_LINE_MARGIN);
  const hi = Math.min(255, Math.round(maxLum) + GRID_LINE_MARGIN);
  return { lo: `rgb(${lo},${lo},${lo})`, hi: `rgb(${hi},${hi},${hi})` };
}

export function rgbToHex(r: number, g: number, b: number): string {
  return (
    "#" +
    [r, g, b]
      .map((x) => {
        const hex = x.toString(16);
        return hex.length === 1 ? "0" + hex : hex;
      })
      .join("")
  );
}
