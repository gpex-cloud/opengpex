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
 * bresenham.ts — Standalone integer Bresenham line rasterization.
 *
 * A pure, dependency-free algorithm (no types, no DOM). Shared by the No-AA
 * (hard-edge) stair-stepping engines that convert diagonal polygon segments
 * into purely horizontal (H) / vertical (V) SVG path steps.
 *
 * Previously duplicated verbatim in:
 *   - `operators/point2d.ts::smoothToStairedPath` (was helpers/path2d.ts::stairedPathFromSmooth)
 *   - `operators/polygon.ts::polygonToStairedPathD`
 */

/**
 * bresenhamSteps: Emit H/V steps from (x0,y0) to (x1,y1) using Bresenham's
 * integer line algorithm. Does NOT emit the starting point (assumes the SVG
 * cursor is already at the start). H-priority: when both axes advance, the
 * horizontal step is emitted first.
 *
 * @param x0 - Start x (integer)
 * @param y0 - Start y (integer)
 * @param x1 - End x (integer)
 * @param y1 - End y (integer)
 * @param segs - Output accumulator; `H <x>` / `V <y>` command strings are pushed.
 */
export function bresenhamSteps(
  x0: number, y0: number,
  x1: number, y1: number,
  segs: string[]
): void {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  let cx = x0;
  let cy = y0;

  while (cx !== x1 || cy !== y1) {
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      cx += sx;
      segs.push(`H ${cx}`);
    }
    if (e2 < dx) {
      err += dx;
      cy += sy;
      segs.push(`V ${cy}`);
    }
  }
}
