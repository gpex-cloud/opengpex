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
 * ArcLengthFollower — even-spacing stamp placement along the pointer path.
 *
 * The professional (Photoshop Spacing) model: stamps are placed at EXACT arc
 * length intervals along the gesture path, carrying the leftover distance of
 * each pointermove segment into the next. Pointer event coalescing (events
 * arriving with wildly varying deltas) then cannot change stamp density, so
 * the stroke outline stays smooth regardless of input jitter.
 *
 * This replaces the previous hash-grid dedupe (floor(cx/step) cells), which
 * quantized stamp positions to cell entry points and made neighboring stamp
 * distances swing between ~0.2r and ~1.2r — the direct cause of the scalloped
 * ("wavy") stroke edges on clone/heal strokes.
 *
 * Contract:
 * - `reset(origin)` starts a stroke: the CALLER stamps the origin itself; the
 *   follower treats it as the first path point (remainder = 0).
 * - `feed(point)` returns every stamp position crossed since the previous
 *   feed, spaced exactly `spacing` apart; a trailing partial segment is kept
 *   as remainder for the next feed (never dropped, never double-counted).
 * - Pure geometry: no kernels, no canvas, deterministic.
 */

import type { Point2D } from './types';

export class ArcLengthFollower {
  private readonly spacing: number;
  /** Previous PATH point (the per-segment distance reference). */
  private prev: Point2D | null = null;
  /** Distance traveled since the last emission (carried across feeds). */
  private pending = 0;

  constructor(spacing: number) {
    this.spacing = Math.max(0.0001, spacing);
  }

  /** Starts a new stroke at `origin`; the caller stamps the origin itself. */
  reset(origin: Point2D): void {
    this.prev = { x: origin.x, y: origin.y };
    this.pending = 0;
  }

  /**
   * Feeds one path point; returns the evenly spaced stamp positions between
   * the previous path point and this one (possibly none for sub-spacing
   * moves).
   *
   * `pending` accumulates the distance traveled since the last emission —
   * it is NEVER reset by a no-emit feed (dropping it would let pointer event
   * timing shift stamp positions, the exact wavy-edge bug this class kills).
   * Segment distance is measured from the PREVIOUS PATH POINT (not the last
   * emission): the two coincide only right after an emission, and conflating
   * them silently re-measures no-emit segments from stale anchors.
   */
  feed(point: Point2D): Point2D[] {
    const out: Point2D[] = [];
    if (!this.prev) {
      this.prev = { x: point.x, y: point.y };
      return out;
    }
    const dx = point.x - this.prev.x;
    const dy = point.y - this.prev.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return out;
    const ux = dx / dist;
    const uy = dy / dist;
    this.pending += dist;
    while (this.pending >= this.spacing) {
      // Each emission sits exactly `spacing` back along the path direction
      // from the current point; the overshoot carries to the next feed.
      const overshoot = this.pending - this.spacing;
      out.push({ x: point.x - ux * overshoot, y: point.y - uy * overshoot });
      this.pending = overshoot;
    }
    this.prev = { x: point.x, y: point.y };
    return out;
  }
}
