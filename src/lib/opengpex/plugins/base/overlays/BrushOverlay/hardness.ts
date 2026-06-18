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
 * Brush Hardness & Stamp Engine
 *
 * Implements brush Hardness parameter and Stamp rendering engine.
 *
 * Core idea:
 * - Brush no longer draws continuous segments using ctx.stroke(), but stamps circles along the path at fixed intervals
 * - Hardness controls edge attenuation of each stamp:
 *     - 100%: solid color circle (only Canvas native 1px anti-aliasing)
 *     - 0%: full radial gradient from center to edge (softest stroke)
 *     - Middle values: solid from center to innerRadius, gradient from innerRadius to outerRadius
 *
 * Algorithm refers to Photoshop/Krita's stamp-based brush engine.
 */

import { Point2D } from './smoothing';

/**
 * Stamp spacing state: tracks rendering progress along the path
 */
export interface StampState {
  lastStampX: number;
  lastStampY: number;
  accDistance: number;
  stampSpacing: number;
  brushSize: number;
  brushHardness: number;
  brushColor: string;
  brushOpacity: number;
}

/**
 * Calculates recommended stamp spacing
 *
 * Spacing = brushSize * ratio, smaller means denser (higher quality, lower performance)
 * Defaults to 15% of brush diameter, which is the default in Photoshop
 */
export function computeStampSpacing(brushSize: number, ratio = 0.15): number {
  return Math.max(brushSize * ratio, 1);
}

/**
 * Parses hex color to rgba string (with specified alpha)
 *
 * Used to create correct radial gradient (avoids color shift of transparent -> black)
 */
export function colorWithAlpha(hexColor: string, alpha: number): string {
  const hex = hexColor.startsWith('#') ? hexColor.slice(1) : hexColor;
  const r = parseInt(hex.slice(0, 2), 16) || 0;
  const g = parseInt(hex.slice(2, 4), 16) || 0;
  const b = parseInt(hex.slice(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * stampBrush: Draws a stamp with Hardness at a specified position
 *
 * Hardness controls edge attenuation:
 * - ≥99: completely opaque inside the circle (only Canvas native 1px anti-aliasing) — fast path
 * - 0: linear gradient from center to edge to transparent (softest stroke)
 * - Middle values: opaque from center to innerRadius, gradient from innerRadius to outerRadius
 *
 * @param ctx Target drawing context
 * @param x Circle center X
 * @param y Circle center Y
 * @param size Brush diameter (pixels)
 * @param hardness Hardness 0~100
 * @param color Brush color (hex format, e.g. '#FF0000')
 * @param opacity Opacity 0~1
 */
export function stampBrush(
  ctx: OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  hardness: number,
  color: string,
  opacity: number,
): void {
  const radius = size / 2;
  if (radius <= 0) return;

  ctx.save();
  ctx.globalAlpha = opacity;

  if (hardness >= 99) {
    // Hard-edged brush: solid color filled circle (fast path, no gradient object needed)
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Soft-edged brush: radial gradient
    // innerRadius = hardness% of radius (completely opaque within this radius)
    const innerRadius = Math.max(radius * (hardness / 100), 0.1);
    const gradient = ctx.createRadialGradient(x, y, innerRadius, x, y, radius);
    gradient.addColorStop(0, colorWithAlpha(color, 1));
    gradient.addColorStop(1, colorWithAlpha(color, 0));

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

/**
 * stampAlongPath: Stamps along a smooth path at intervals
 *
 * Starts from state.lastStampX/Y, placing stamps along points path at spacing intervals.
 * Directly modifies lastStampX/Y and accDistance in state (avoids allocating new objects).
 *
 * @param ctx Target drawing context
 * @param points Smooth path point sequence (from Catmull-Rom interpolation)
 * @param state Mutable stamp state (will be modified directly)
 */
export function stampAlongPath(
  ctx: OffscreenCanvasRenderingContext2D,
  points: Point2D[],
  state: StampState,
): void {
  const { brushSize, brushHardness, brushColor, brushOpacity, stampSpacing } = state;
  let { lastStampX, lastStampY, accDistance } = state;
  const opacity = brushOpacity / 100;

  for (const pt of points) {
    const dx = pt.x - lastStampX;
    const dy = pt.y - lastStampY;
    const segDist = Math.sqrt(dx * dx + dy * dy);

    if (segDist < 0.001) continue;

    // Unit vector along the segment direction
    const ux = dx / segDist;
    const uy = dy / segDist;

    let remaining = segDist;
    // Distance needed to travel to the next stamp
    let distToNext = stampSpacing - accDistance;

    while (remaining >= distToNext) {
      // Advance to the next stamp position
      lastStampX += ux * distToNext;
      lastStampY += uy * distToNext;
      remaining -= distToNext;

      stampBrush(ctx, lastStampX, lastStampY, brushSize, brushHardness, brushColor, opacity);

      accDistance = 0;
      distToNext = stampSpacing;
    }

    // Consume remaining distance (less than spacing, accumulated to next time)
    lastStampX += ux * remaining;
    lastStampY += uy * remaining;
    accDistance += remaining;
  }

  // Write back state
  state.lastStampX = lastStampX;
  state.lastStampY = lastStampY;
  state.accDistance = accDistance;
}
