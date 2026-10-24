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
 * maskRings.ts — Binary mask → polygon rings with HOLES, shared by the AI
 * tool workers (bgremover, segmentation).
 *
 * The previous per-worker `traceContour` only traced the first foreground
 * boundary it met: holes (the gap between an arm and the torso, a handle's
 * cutout) were silently absorbed into the outer ring. Consumers (the clip
 * selection slots, the pen tool's import) are all evenodd-capable, so the
 * fix is to emit every boundary:
 *
 *   1. Foreground connected components (4-connectivity flood fill) — each
 *      contributes one outer ring (Moore-neighborhood boundary trace).
 *   2. Background components NOT touching the image border are holes; each
 *      hole region's boundary is traced with the same Moore walk and emitted
 *      as an additional ring.
 *
 * Ring winding is whatever the walk produces; downstream masking is evenodd
 * and does not care. Coordinates are in the mask's own pixel grid; callers
 * scale to image space before simplification (as before).
 */

// ─── Moore-neighborhood boundary walk ─────────────────────────────────────────

type Pt = { x: number; y: number };

const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];

/**
 * Traces the boundary of the connected region containing (startX, startY),
 * where `inside(x, y)` tells whether a pixel belongs to the region. Classic
 * Moore tracing with a bounded iteration count (2× the pixel count is a
 * generous safety ceiling that the original single-ring tracer also used).
 */
export function traceRegionBoundary(
  startX: number,
  startY: number,
  width: number,
  height: number,
  inside: (x: number, y: number) => boolean,
): Pt[] {
  const points: Pt[] = [];
  let cx = startX;
  let cy = startY;
  let dir = 7;
  const maxIter = width * height * 2;

  for (let iter = 0; iter < maxIter; iter++) {
    points.push({ x: cx, y: cy });

    let found = false;
    const searchStart = (dir + 6) % 8;
    for (let i = 0; i < 8; i++) {
      const d = (searchStart + i) % 8;
      const nx = cx + DX[d];
      const ny = cy + DY[d];
      if (inside(nx, ny)) {
        cx = nx;
        cy = ny;
        dir = d;
        found = true;
        break;
      }
    }

    if (!found) break;
    if (cx === startX && cy === startY && points.length > 2) break;
  }

  return points;
}

// ─── Component labeling (iterative flood fill, no recursion) ──────────────────

/**
 * Labels connected components of `match(x, y)` with component ids 1..n
 * (0 = no match). Returns the label buffer plus the per-component seed pixel
 * (the first-scanned member — its boundary walk starts top-left, same as the
 * old single-ring behaviour).
 */
function labelComponents(
  width: number,
  height: number,
  match: (x: number, y: number) => boolean,
): { labels: Int32Array; seeds: Pt[]; count: number } {
  const labels = new Int32Array(width * height);
  const seeds: Pt[] = [];
  const stack: number[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (labels[idx] !== 0 || !match(x, y)) continue;

      const id = seeds.length + 1;
      seeds.push({ x, y });
      labels[idx] = id;
      stack.length = 0;
      stack.push(idx);

      while (stack.length > 0) {
        const cur = stack.pop()!;
        const cx2 = cur % width;
        const cy2 = (cur - cx2) / width;
        // 4-connectivity keeps diagonal touches as separate regions, which
        // matches the Moore walk's diagonal ambiguity resolution.
        if (cx2 > 0) tryLabel(cur - 1, id);
        if (cx2 < width - 1) tryLabel(cur + 1, id);
        if (cy2 > 0) tryLabel(cur - width, id);
        if (cy2 < height - 1) tryLabel(cur + width, id);
      }

      function tryLabel(idx2: number, id2: number): void {
        if (labels[idx2] === 0 && match(idx2 % width, Math.floor(idx2 / width))) {
          labels[idx2] = id2;
          stack.push(idx2);
        }
      }
    }
  }

  return { labels, seeds, count: seeds.length };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Extracts all boundary rings of a binary mask (truthy = foreground):
 * one outer ring per foreground component plus one ring per enclosed
 * background component (hole). Rings with fewer than 3 points are dropped.
 */
export function traceMaskRings(
  mask: Uint8Array | Float32Array,
  width: number,
  height: number,
): Pt[][] {
  const isFg = (x: number, y: number): boolean =>
    x >= 0 && x < width && y >= 0 && y < height && mask[y * width + x] > 0;

  const rings: Pt[][] = [];

  // 1. Foreground components → outer rings.
  const fg = labelComponents(width, height, isFg);
  for (const seed of fg.seeds) {
    rings.push(traceRegionBoundary(seed.x, seed.y, width, height, isFg));
  }

  // 2. Background components not reachable from the border → holes.
  //    Mark border-connected background first (label 0 stays "unvisited bg").
  const BG_BORDER = -1;
  const bgLabels = new Int32Array(width * height);
  const stack: number[] = [];
  const pushBg = (idx: number): void => {
    const x = idx % width;
    const y = (idx - x) / width;
    if (bgLabels[idx] === 0 && !isFg(x, y)) {
      bgLabels[idx] = BG_BORDER;
      stack.push(idx);
    }
  };
  for (let x = 0; x < width; x++) {
    pushBg(x);
    pushBg((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    pushBg(y * width);
    pushBg(y * width + width - 1);
  }
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const cx = cur % width;
    const cy = (cur - cx) / width;
    if (cx > 0) pushBg(cur - 1);
    if (cx < width - 1) pushBg(cur + 1);
    if (cy > 0) pushBg(cur - width);
    if (cy < height - 1) pushBg(cur + width);
  }

  // Any still-unvisited background pixel belongs to an enclosed hole.
  const isHole = (x: number, y: number): boolean =>
    x >= 0 && x < width && y >= 0 && y < height && bgLabels[y * width + x] === 0 && !isFg(x, y);
  const holes = labelComponents(width, height, isHole);
  for (const seed of holes.seeds) {
    rings.push(traceRegionBoundary(seed.x, seed.y, width, height, isHole));
  }

  return rings.filter((r) => r.length >= 3);
}
