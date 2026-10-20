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
 * rotator.ts — pure arithmetic helpers for rotation gestures and rotated
 * poses.
 *
 * Angle normalization, Shift-snapping, and the screen-space angle of a
 * direction under a layer's pose (flip + rotation) are defined ONLY here.
 * The rotation handlers and handle-cursor resolution (MarkerOverlay /
 * TextOverlay / TransformGizmo) call these; full direction-MATRIX
 * construction stays in `getOrientationMatrix` (transform.ts).
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

/**
 * Screen-space angle of a LOCAL direction angle under the layer's current
 * pose (flip + rotation).
 *
 * A selection box is drawn through the layer's full world matrix, so after a
 * canvas rotation the box self-rotates — but anything keyed to the box's
 * local directions (resize cursors, handle hit semantics) must rotate the
 * LOCAL direction angle by the layer pose manually: mirror by flip first
 * (matching the renderer's R × F convention), then add the layer rotation.
 *
 *   poseScreenAngle(225, 90, { h: true, v: false }) → 315
 *   (a 225° local direction, mirrored horizontally and rotated 90°)
 *
 * Purely mathematical: the result is an angle in degrees — mapping it to any
 * direction-keyed vocabulary (CSS resize cursors, …) is the consumer's concern.
 */
export function poseScreenAngle(
  angleDeg: number,
  rotationDeg: number,
  flip?: { h: boolean; v: boolean },
): number {
  const rad = (angleDeg * Math.PI) / 180;
  let dx = Math.cos(rad);
  let dy = Math.sin(rad);
  if (flip?.h) dx = -dx;
  if (flip?.v) dy = -dy;
  return (Math.atan2(dy, dx) * 180) / Math.PI + rotationDeg;
}
