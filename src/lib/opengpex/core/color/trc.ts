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
 * trc.ts — sRGB ⇄ linear-light transfer-characteristic scalars (spec §16.2).
 *
 * IEC 61966-2-1 reference formulas for color management and matrix conversions.
 *
 * @module core/color/trc
 */

/**
 * Convert a single sRGB-encoded channel value [0, 1] to linear-light.
 *
 * Formula (IEC 61966-2-1):
 *   C_linear = (C <= 0.04045) ? C / 12.92 : ((C + 0.055) / 1.055)^2.4
 */
export function srgbToLinear(c: number): number {
  return c <= 0.04045
    ? c / 12.92
    : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Convert a single linear-light channel value [0, 1] to sRGB encoding.
 *
 * Formula (IEC 61966-2-1):
 *   C_srgb = (C <= 0.0031308) ? C * 12.92 : 1.055 * C^(1/2.4) - 0.055
 */
export function linearToSrgb(c: number): number {
  return c <= 0.0031308
    ? c * 12.92
    : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
