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
 * Brush Stroke Smoothing Module
 *
 * Implements Catmull-Rom spline interpolation algorithm to smooth raw mouse samples into smooth curves.
 *
 * Algorithm points:
 * - Catmull-Rom spline: guarantees passing through all raw points (C1 continuous)
 * - 4-point sliding window: interpolates between the center two points of the window each time a new point is received
 * - Adaptive interpolation density: dynamically adjusts number of interpolation points based on distance between two points
 */

export interface Point2D {
  x: number;
  y: number;
}

/**
 * catmullRomInterpolate: Centripetal Catmull-Rom spline interpolation between P1 and P2
 *
 * Given 4 control points (P0, P1, P2, P3), generates a smooth point sequence between P1->P2.
 * Tension parameter alpha=0.5 (centripetal Catmull-Rom, avoids loops and self-intersections)
 *
 * @param p0 Leading point
 * @param p1 Starting point
 * @param p2 Ending point
 * @param p3 Subsequent point
 * @param segments Number of interpolation segments (default adaptive based on distance)
 * @returns Array of interpolated points (excluding p1, including p2)
 */
export function catmullRomInterpolate(
  p0: Point2D,
  p1: Point2D,
  p2: Point2D,
  p3: Point2D,
  segments?: number,
): Point2D[] {
  // Adaptive segment count: based on P1-P2 distance (denser = smoother)
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  // Minimum 4 segments, one interpolation point per 2px, maximum 32 segments
  const numSegments = segments ?? Math.max(4, Math.min(Math.ceil(dist / 2), 32));

  const result: Point2D[] = [];

  for (let i = 1; i <= numSegments; i++) {
    const t = i / numSegments;
    const t2 = t * t;
    const t3 = t2 * t;

    // Catmull-Rom matrix coefficients (standard tension 0.5)
    const x =
      0.5 * (
        (2 * p1.x) +
        (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
      );

    const y =
      0.5 * (
        (2 * p1.y) +
        (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
      );

    result.push({ x, y });
  }

  return result;
}

/**
 * StrokeSmoother: Stroke smoother
 *
 * Maintains a 4-point sliding window, returning smooth interpolated path segments on adding each raw sample point.
 * Usage:
 * 1. begin(startPoint) — initialization
 * 2. addPoint(point) — add sample point, returns smooth segment to be drawn
 * 3. finish() — complete stroke, returns completion path of the final segment
 */
export class StrokeSmoother {
  private window: Point2D[] = [];

  /**
   * begin: Initialize smoother
   */
  begin(startPoint: Point2D): void {
    this.window = [startPoint];
  }

  /**
   * addPoint: Add new raw sample point
   *
   * @returns Smooth interpolated point sequence to draw (may be empty as it requires 4 points to start interpolation)
   */
  addPoint(point: Point2D): Point2D[] {
    this.window.push(point);

    // Requires at least 4 points to perform Catmull-Rom interpolation
    if (this.window.length < 4) {
      return [];
    }

    // Take latest 4 points for interpolation
    const len = this.window.length;
    const p0 = this.window[len - 4];
    const p1 = this.window[len - 3];
    const p2 = this.window[len - 2];
    const p3 = this.window[len - 1]; // = point

    // Interpolate for P1->P2 segment (Note: P2 is the second-to-last point, not the latest)
    const interpolated = catmullRomInterpolate(p0, p1, p2, p3);

    // Keep window size within 8 points (saves memory)
    if (this.window.length > 8) {
      this.window = this.window.slice(-6);
    }

    return interpolated;
  }

  /**
   * finish: Complete stroke
   *
   * Completes the final segment (since addPoint always outputs P1->P2, the final P2->P3 segment needs completion)
   *
   * @returns Smooth points of the final segment
   */
  finish(): Point2D[] {
    const len = this.window.length;
    if (len < 3) {
      // Insufficient points, return remaining points directly
      return len >= 2 ? [this.window[len - 1]] : [];
    }

    // Use the last point as virtual P3 (maintain extension direction)
    const p0 = this.window[len - 3];
    const p1 = this.window[len - 2];
    const p2 = this.window[len - 1];
    // Virtual P3 = P2 + (P2 - P1) (linear extrapolation)
    const p3: Point2D = {
      x: p2.x + (p2.x - p1.x),
      y: p2.y + (p2.y - p1.y),
    };

    return catmullRomInterpolate(p0, p1, p2, p3);
  }

  /**
   * getLastPoint: Get last raw point in window
   */
  getLastPoint(): Point2D | null {
    return this.window.length > 0 ? this.window[this.window.length - 1] : null;
  }

  /**
   * getPointCount: Get count of collected raw points
   */
  getPointCount(): number {
    return this.window.length;
  }
}

/**
 * drawSmoothSegment: Draws smooth interpolated points to Canvas context
 *
 * Connects interpolation points using lineTo (since Catmull-Rom already generated sufficiently dense points,
 * quadraticCurveTo is not needed)
 *
 * @param ctx 2D rendering context
 * @param from Starting point
 * @param smoothPoints Smooth interpolation point sequence
 */
export function drawSmoothSegment(
  ctx: OffscreenCanvasRenderingContext2D,
  from: Point2D,
  smoothPoints: Point2D[],
): void {
  if (smoothPoints.length === 0) return;

  ctx.beginPath();
  ctx.moveTo(from.x, from.y);

  for (const pt of smoothPoints) {
    ctx.lineTo(pt.x, pt.y);
  }

  ctx.stroke();
}
