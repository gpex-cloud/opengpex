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
 * Stamp Engine — Pre-rendered Dab Bitmap Approach
 *
 * Core optimization: instead of creating a RadialGradient + arc + fill for EVERY stamp
 * (50-200+ per pointermove), we pre-render the brush "dab" once at stroke start,
 * then stamp via a single drawImage() call per point.
 *
 * Performance comparison (soft brush, 100 stamps per segment):
 * - Old: 100× (save + createRadialGradient + 2×addColorStop + beginPath + arc + fill + restore)
 * - New: 100× drawImage(dab, x, y) — single blit, GPU-accelerated
 *
 * This is the same approach used by Krita, Photoshop, and other professional brush engines.
 */

import type { Point2D } from './smoothing';

// ─── StampEngine ───────────────────────────────────────────────────────────────

/**
 * StampEngine: Encapsulates a pre-rendered brush dab and provides stamping along paths.
 *
 * Usage:
 * 1. Create at stroke start with brush parameters
 * 2. Call stampAt() for the initial point
 * 3. Call stampAlongPath() for smooth segments (handles spacing automatically)
 */
export class StampEngine {
  /** Pre-rendered brush dab (full opacity, gradient baked in) */
  private readonly dab: OffscreenCanvas;
  private readonly radius: number;
  private readonly opacity: number;

  /** Stamp spacing state (mutable, updated by stampAlongPath) */
  lastStampX = 0;
  lastStampY = 0;
  accDistance = 0;
  readonly stampSpacing: number;

  /** Dirty rect tracking — tracks the bounding box of all stamped pixels */
  dirtyMinX = Infinity;
  dirtyMinY = Infinity;
  dirtyMaxX = -Infinity;
  dirtyMaxY = -Infinity;

  /**
   * @param brushSize Brush diameter in pixels
   * @param hardness Hardness 0-100
   * @param color Brush color (hex format, e.g. '#FF0000')
   * @param brushOpacity Opacity 0-100
   */
  constructor(brushSize: number, hardness: number, color: string, brushOpacity: number) {
    this.radius = brushSize / 2;
    this.opacity = brushOpacity / 100;
    this.stampSpacing = Math.max(brushSize * 0.15, 1);
    this.dab = createDab(brushSize, hardness, color);
  }

  /**
   * Returns the dirty rect (bounding box of all stamps placed so far).
   * Returns null if no stamps have been placed.
   */
  getDirtyRect(): { x: number; y: number; w: number; h: number } | null {
    if (this.dirtyMinX > this.dirtyMaxX) return null;
    return {
      x: Math.floor(this.dirtyMinX),
      y: Math.floor(this.dirtyMinY),
      w: Math.ceil(this.dirtyMaxX) - Math.floor(this.dirtyMinX),
      h: Math.ceil(this.dirtyMaxY) - Math.floor(this.dirtyMinY),
    };
  }

  /**
   * Stamps the pre-rendered dab at a single position.
   *
   * Caller is responsible for setting globalCompositeOperation before calling.
   * This method only sets globalAlpha.
   */
  stampAt(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number): void {
    ctx.globalAlpha = this.opacity;
    ctx.drawImage(this.dab, x - this.radius, y - this.radius);
    this.expandDirty(x, y);
  }

  /**
   * Stamps along a smooth path at spacing intervals.
   *
   * Starts from lastStampX/Y, placing stamps along points path at spacing intervals.
   * Updates lastStampX/Y and accDistance (mutable state).
   *
   * Caller is responsible for setting globalCompositeOperation + globalAlpha context.
   *
   * @param ctx Target drawing context
   * @param points Smooth path point sequence (from Catmull-Rom interpolation)
   */
  stampAlongPath(ctx: OffscreenCanvasRenderingContext2D, points: Point2D[]): void {
    const { stampSpacing, radius, opacity } = this;
    let { lastStampX, lastStampY, accDistance } = this;

    // Local dirty tracking (batch-expand at end to avoid per-stamp method call overhead)
    let localMinX = this.dirtyMinX;
    let localMinY = this.dirtyMinY;
    let localMaxX = this.dirtyMaxX;
    let localMaxY = this.dirtyMaxY;

    // Set alpha once for the entire batch (avoids per-stamp overhead)
    ctx.globalAlpha = opacity;

    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      const dx = pt.x - lastStampX;
      const dy = pt.y - lastStampY;
      const segDist = Math.sqrt(dx * dx + dy * dy);

      if (segDist < 0.001) continue;

      // Unit vector along the segment direction
      const invDist = 1 / segDist;
      const ux = dx * invDist;
      const uy = dy * invDist;

      let remaining = segDist;
      let distToNext = stampSpacing - accDistance;

      while (remaining >= distToNext) {
        // Advance to the next stamp position
        lastStampX += ux * distToNext;
        lastStampY += uy * distToNext;
        remaining -= distToNext;

        // Single drawImage — the hot path
        ctx.drawImage(this.dab, lastStampX - radius, lastStampY - radius);

        // Expand dirty rect (inlined for hot path performance)
        const left = lastStampX - radius;
        const top = lastStampY - radius;
        const right = lastStampX + radius;
        const bottom = lastStampY + radius;
        if (left < localMinX) localMinX = left;
        if (top < localMinY) localMinY = top;
        if (right > localMaxX) localMaxX = right;
        if (bottom > localMaxY) localMaxY = bottom;

        accDistance = 0;
        distToNext = stampSpacing;
      }

      // Consume remaining distance (less than spacing, accumulated to next time)
      lastStampX += ux * remaining;
      lastStampY += uy * remaining;
      accDistance += remaining;
    }

    // Write back mutable state
    this.lastStampX = lastStampX;
    this.lastStampY = lastStampY;
    this.accDistance = accDistance;
    this.dirtyMinX = localMinX;
    this.dirtyMinY = localMinY;
    this.dirtyMaxX = localMaxX;
    this.dirtyMaxY = localMaxY;
  }

  // ─── Private ─────────────────────────────────────────────────────────────────

  /** Expand dirty rect to include a stamp centered at (x, y). */
  private expandDirty(x: number, y: number): void {
    const r = this.radius;
    const left = x - r;
    const top = y - r;
    const right = x + r;
    const bottom = y + r;
    if (left < this.dirtyMinX) this.dirtyMinX = left;
    if (top < this.dirtyMinY) this.dirtyMinY = top;
    if (right > this.dirtyMaxX) this.dirtyMaxX = right;
    if (bottom > this.dirtyMaxY) this.dirtyMaxY = bottom;
  }
}

// ─── Dab Creation ──────────────────────────────────────────────────────────────

/**
 * Creates a pre-rendered brush dab (stamp shape) as an OffscreenCanvas.
 *
 * The dab is rendered at full alpha (opacity = 1). Actual brush opacity is applied
 * via ctx.globalAlpha during stamping. This allows the same dab to be reused
 * if only opacity changes (not currently exploited but ready for future use).
 *
 * @param size Brush diameter in pixels
 * @param hardness Hardness 0-100
 * @param color Brush color hex
 * @returns OffscreenCanvas containing the dab (size × size pixels)
 */
function createDab(size: number, hardness: number, color: string): OffscreenCanvas {
  // Ensure minimum size of 1px (avoid 0-size canvas)
  const canvasSize = Math.max(Math.ceil(size), 1);
  const canvas = new OffscreenCanvas(canvasSize, canvasSize);
  const ctx = canvas.getContext('2d')!;
  const radius = size / 2;
  const cx = canvasSize / 2;
  const cy = canvasSize / 2;

  if (hardness >= 99) {
    // Hard brush: solid circle (fast path)
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Soft brush: radial gradient
    const innerRadius = Math.max(radius * (hardness / 100), 0.1);
    const gradient = ctx.createRadialGradient(cx, cy, innerRadius, cx, cy, radius);
    gradient.addColorStop(0, colorWithAlpha(color, 1));
    gradient.addColorStop(1, colorWithAlpha(color, 0));

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  return canvas;
}

/**
 * Parses hex color to rgba string (with specified alpha).
 * Used to create correct radial gradient stops.
 */
function colorWithAlpha(hexColor: string, alpha: number): string {
  const hex = hexColor.startsWith('#') ? hexColor.slice(1) : hexColor;
  const r = parseInt(hex.slice(0, 2), 16) || 0;
  const g = parseInt(hex.slice(2, 4), 16) || 0;
  const b = parseInt(hex.slice(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
