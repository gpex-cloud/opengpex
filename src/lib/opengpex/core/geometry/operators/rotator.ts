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
 * rotator.ts — pure arithmetic helpers for the free-rotation gesture.
 *
 * These are the ONLY place rotation angle normalization and snapping are
 * defined.  The rotation handler (MarkerOverlay / TextOverlay) calls them;
 * no sin/cos or direction-matrix construction happens here — that stays in
 * `getOrientationMatrix` (transform.ts), per the §5.4 iron rule.
 */

/**
 * Normalise an angle into the half-open range [0, 360).
 *
 * Handles negative values and values > 360 correctly:
 *   normalizeAngle(-90)  → 270
 *   normalizeAngle(450)  → 90
 *   normalizeAngle(0)    → 0
 *   normalizeAngle(360)  → 0
 */
export function normalizeAngle(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * Snap an angle to the nearest multiple of `step` degrees.
 *
 * Used with Shift-key snapping (step = 15 for the industry-standard
 * 0/15/30/45/60/75/90… grid).
 *
 *   snapAngle(47, 15) → 45
 *   snapAngle(53, 15) → 60
 *   snapAngle(-8, 15) → 0
 */
export function snapAngle(deg: number, step: number): number {
  return Math.round(deg / step) * step;
}
