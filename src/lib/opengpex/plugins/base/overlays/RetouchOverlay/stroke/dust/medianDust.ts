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
 * Remove Dust core — thresholded disc median (the Dust & Scratches trick):
 * per pixel, per RGB channel, compute the median of the DISC of radius r
 * and replace the pixel only when |pixel − median| exceeds the threshold.
 * Dust specks are local outliers, so the median (computed from clean
 * neighbors) is always a valid fix; real structure survives because the
 * median is edge-preserving and the threshold keeps everything that differs
 * from its neighborhood by less than the threshold.
 *
 * An ISOLATION gate on top prevents the known cost of a plain pass —
 * subject blur: pixels of thin strokes, lines, and texture ridges also
 * deviate from their disc median, but their deviation is a small CONNECTED
 * BLOB only for genuine dust, while a stroke's deviation CONTINUES into its
 * neighbors and runs out of any local window. So a pixel is replaced only
 * when it is a lone outlier (its 4 direct neighbors agree with the median)
 * or its deviating 8-connected cluster stays bounded inside a small window
 * (see the gate at the replacement site below).
 *
 * The disc median runs O(radius) per pixel via a sliding histogram: the
 * disc's sample histogram slides pixel to pixel in serpentine
 * traversal, moving one row/column end per step and tracking the median
 * rank, instead of re-selecting over the whole disc.
 *
 * Alpha is never replaced — only RGB channels participate, and replaced
 * pixels keep their original alpha (the product only ever differs where the
 * source is visible anyway).
 */

import type { RgbaBuffer } from '../heal/healKernel';

// ─── Tuning constants (re-tune against the real scan sample on device) ─────────

/**
 * Median disc radius (px). Dust specks up to ~2×radius are guaranteed
 * outliers; radius also bounds the "always replaced" coverage. Small is
 * cheap and conservative — the heal brush stays the tool for larger damage.
 */
export const DUST_MEDIAN_RADIUS = 4;

/**
 * Replacement threshold band (luma units 0..255) mapped from the sensitivity
 * slider: threshold = THR_AT_ZERO − (THR_AT_ZERO − THR_AT_MAX) × sens/100.
 * Higher threshold = fewer replacements (misses are safe), lower = more
 * aggressive.
 */
export const DUST_THRESHOLD_AT_ZERO = 50;
export const DUST_THRESHOLD_AT_MAX = 8;

/** Maps the panel sensitivity [0,100] to the replacement threshold. */
export function dustThresholdForSensitivity(sensitivity: number): number {
  const s = Math.min(100, Math.max(0, sensitivity));
  return Math.round(DUST_THRESHOLD_AT_ZERO - (DUST_THRESHOLD_AT_ZERO - DUST_THRESHOLD_AT_MAX) * (s / 100));
}

/** The 4 direct neighbors used by the isolation gate's fast path. */
const NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0], [1, 0], [0, -1], [0, 1],
];

/**
 * Largest deviating cluster (px) still classified as a dust speck by the
 * flood path. Above this (or touching the window edge) the deviation is
 * extended structure — strokes, lines, texture ridges — and is kept.
 */
const DUST_MAX_CLUSTER_PX = 30;

/** Half-size of the flood-path window (an 11×11 neighborhood). */
const CLUSTER_WINDOW = 5;

/**
 * True when the 8-connected region of pixels deviating from `median` by more
 * than `thr`, seeded at (x,y), fits entirely inside a small window around the
 * seed (a bounded dust cluster). A component that touches the window edge is
 * extended structure and returns false. Cost is bounded by the window size
 * (≤ 121 pixels) and is paid only for threshold-triggered candidates.
 */
function isSmallDeviationCluster(
  plane: Uint8Array,
  w: number,
  h: number,
  x: number,
  y: number,
  median: number,
  thr: number,
): boolean {
  const x0 = x - CLUSTER_WINDOW;
  const x1 = x + CLUSTER_WINDOW;
  const y0 = y - CLUSTER_WINDOW;
  const y1 = y + CLUSTER_WINDOW;
  const visited = new Uint8Array((2 * CLUSTER_WINDOW + 1) ** 2);
  const stack: number[] = [(y - y0) * (2 * CLUSTER_WINDOW + 1) + (x - x0)];
  visited[(y - y0) * (2 * CLUSTER_WINDOW + 1) + (x - x0)] = 1;
  let area = 0;
  while (stack.length > 0) {
    const li = stack.pop()!;
    const lx = li % (2 * CLUSTER_WINDOW + 1);
    const ly = (li / (2 * CLUSTER_WINDOW + 1)) | 0;
    const gx = x0 + lx;
    const gy = y0 + ly;
    area++;
    if (area > DUST_MAX_CLUSTER_PX) return false;
    // Component must stay strictly inside the window: touching the clipped
    // image border is fine (clamped), touching the WINDOW edge is not —
    // that means the deviation runs out of sight (extended structure).
    if (gx === x0 || gx === x1 || gy === y0 || gy === y1) {
      if (gx < 0 || gx >= w || gy < 0 || gy >= h) continue; // beyond image: treat as outside
      return false;
    }
    for (let dy = -1; dy <= 1; dy++) {
      const ny = gy + dy;
      if (ny < 0 || ny >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = gx + dx;
        if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
        const li2 = (ny - y0) * (2 * CLUSTER_WINDOW + 1) + (nx - x0);
        if (visited[li2] !== 0) continue;
        if (Math.abs(plane[ny * w + nx] - median) > thr) {
          visited[li2] = 1;
          stack.push(li2);
        }
      }
    }
  }
  return true;
}

// ─── Disc geometry ─────────────────────────────────────────────────────────────

/**
 * Half-width of the median disc on each row dy in −r..=r: the largest dx
 * with dx² + dy² ≤ r² + r (the +r rounding makes the disc include the
 * axis-aligned corners of small radii, matching a round brush's raster).
 */
function discRows(r: number): number[] {
  const rows: number[] = [];
  for (let dy = -r; dy <= r; dy++) {
    const lim = r * r + r - dy * dy;
    let hw = Math.floor(Math.sqrt(Math.max(0, lim)));
    while (hw * hw > lim) hw--;
    while ((hw + 1) * (hw + 1) <= lim) hw++;
    rows.push(hw);
  }
  return rows;
}

// ─── Core ──────────────────────────────────────────────────────────────────────

/**
 * Thresholded disc median over `source`. Returns a full-size RGBA buffer
 * (same layout) where replaced channels carry the disc median and everything
 * else is byte-identical to the input. Alpha is passed through untouched.
 */
export function dustAndScratchesMedian(
  source: RgbaBuffer,
  options: { radius?: number; threshold?: number } = {},
): Uint8ClampedArray {
  const { width: w, height: h, data } = source;
  const out = new Uint8ClampedArray(data); // start identical; replace in place
  const r = Math.max(1, Math.round(options.radius ?? DUST_MEDIAN_RADIUS));
  const thr = Math.max(0, Math.round(options.threshold ?? dustThresholdForSensitivity(25)));
  if (w <= 0 || h <= 0) return out;

  const rows = discRows(r);
  const hist = new Int32Array(256);

  // Per channel; the sliding histogram state resets between channels (the
  // serpentine restarts at each channel's first output pixel).
  for (let c = 0; c < 3; c++) {
    // Channel plane as 8-bit levels (source is an 8-bit RGBA buffer).
    const plane = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) plane[i] = data[i * 4 + c];

    let median = 0; // current median LEVEL (0..255)
    let below = 0; // histogram samples ranked strictly below `median`
    // Disc sample count is INVARIANT under the slide (one gone, one new per
    // row per step) — computed once, never rescanned per pixel.
    const discCount = rows.reduce((a, hw) => a + 2 * hw + 1, 0);
    const mid = discCount >> 1;
    hist.fill(0);

    for (let oy = 0; oy < h; oy++) {
      const leftToRight = (oy & 1) === 0;
      for (let step = 0; step < w; step++) {
        const ox = leftToRight ? step : w - 1 - step;
        const cx = ox;
        const cy = oy;

        if (oy === 0 && step === 0) {
          // Build the first disc histogram in full (clamped coordinates).
          for (let j = 0; j < rows.length; j++) {
            const dy = j - r;
            const sy = Math.min(h - 1, Math.max(0, dy));
            const hw = rows[j];
            for (let dx = -hw; dx <= hw; dx++) {
              const sx = Math.min(w - 1, Math.max(0, dx));
              hist[plane[sy * w + sx]]++;
            }
          }
          median = 0;
          below = 0;
          while (below + hist[median] <= (discCount >> 1)) {
            below += hist[median];
            median++;
          }
        } else if (leftToRight && step > 0) {
          // Moved right from (cx−1, cy): each disc row loses its left end, gains its right end.
          for (let j = 0; j < rows.length; j++) {
            const dy = j - r;
            const sy = Math.min(h - 1, Math.max(0, cy + dy));
            const hw = rows[j];
            const goneX = Math.min(w - 1, Math.max(0, cx - 1 - hw));
            const newX = Math.min(w - 1, Math.max(0, cx + hw));
            const gone = plane[sy * w + goneX];
            const neu = plane[sy * w + newX];
            if (neu !== gone) {
              hist[gone]--;
              hist[neu]++;
              below += (neu < median ? 1 : 0) - (gone < median ? 1 : 0);
            }
          }
        } else if (!leftToRight && step > 0) {
          // Moved left from (cx+1, cy): each disc row loses its right end, gains its left end.
          for (let j = 0; j < rows.length; j++) {
            const dy = j - r;
            const sy = Math.min(h - 1, Math.max(0, cy + dy));
            const hw = rows[j];
            const goneX = Math.min(w - 1, Math.max(0, cx + 1 + hw));
            const newX = Math.min(w - 1, Math.max(0, cx - hw));
            const gone = plane[sy * w + goneX];
            const neu = plane[sy * w + newX];
            if (neu !== gone) {
              hist[gone]--;
              hist[neu]++;
              below += (neu < median ? 1 : 0) - (gone < median ? 1 : 0);
            }
          }
        } else {
          // Row wrap (first pixel of a new row): the serpentine jumped; the
          // disc shifted by one row — cheapest correct approach is a rebuild.
          hist.fill(0);
          for (let j = 0; j < rows.length; j++) {
            const dy = j - r;
            const sy = Math.min(h - 1, Math.max(0, cy + dy));
            const hw = rows[j];
            for (let dx = -hw; dx <= hw; dx++) {
              const sx = Math.min(w - 1, Math.max(0, cx + dx));
              hist[plane[sy * w + sx]]++;
            }
          }
          median = 0;
          below = 0;
          while (below + hist[median] <= (discCount >> 1)) {
            below += hist[median];
            median++;
          }
        }

        // Median pointer maintenance after histogram moves.
        while (below > mid) {
          median--;
          below -= hist[median];
        }
        while (below + hist[median] <= mid) {
          below += hist[median];
          median++;
        }

        // Threshold gate + ISOLATION gate. The threshold alone would also
        // replace pixels of extended subject structure (thin strokes, 1px
        // lines, high-contrast texture ridges) whose disc median sits on the
        // surrounding background — that is exactly the "subject blurring"
        // cost of a plain Dust & Scratches pass. Dust is ISOLATED: a speck's
        // deviation is a SMALL CONNECTED BLOB; a stroke's deviation CONTINUES
        // into its neighbors and runs out of any local window. Two tiers:
        //   1. Fast path — the pixel deviates from the median AND at least 3
        //      of its 4 direct neighbors agree with the median (lone outlier).
        //   2. Flood path — otherwise, 8-connected flood fill of the
        //      deviating region (|v − median| > thr) inside a small window:
        //      a component that fits the window (≤ DUST_MAX_CLUSTER_PX) is a
        //      dust cluster and is replaced; one that touches the window edge
        //      is extended structure and is kept. Candidates only pay the
        //      flood cost, so clean pixels stay O(1).
        const di = (cy * w + ox) * 4 + c;
        const orig = data[di];
        if (Math.abs(orig - median) > thr) {
          let agreeing = 0;
          for (const [ndx, ndy] of NEIGHBOR_OFFSETS) {
            const nx = Math.min(w - 1, Math.max(0, ox + ndx));
            const ny = Math.min(h - 1, Math.max(0, cy + ndy));
            if (Math.abs(plane[ny * w + nx] - median) <= thr) agreeing++;
          }
          if (agreeing >= 3 || isSmallDeviationCluster(plane, w, h, ox, cy, median, thr)) {
            out[di] = median;
          }
        }
      }
    }
  }
  return out;
}

/**
 * Builds the straight-alpha PATCH buffer (canvas-sized) carrying only the
 * replaced pixels (full opacity, median RGB), plus their bounding box.
 * This is what bakes onto the heal layer — unchanged pixels stay out of the
 * product, so the layer only holds the actual dust fixes and erasing works
 * dab by dab.
 */
export function buildReplacementPatch(
  original: RgbaBuffer,
  filtered: Uint8ClampedArray,
): { patch: Uint8ClampedArray; dirtyRect: { x: number; y: number; w: number; h: number } | null } {
  const { width: w, height: h, data } = original;
  const patch = new Uint8ClampedArray(w * h * 4);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    let changed = false;
    for (let c = 0; c < 3; c++) {
      if (data[p + c] !== filtered[p + c]) {
        changed = true;
        break;
      }
    }
    if (!changed) continue;
    patch[p] = filtered[p];
    patch[p + 1] = filtered[p + 1];
    patch[p + 2] = filtered[p + 2];
    patch[p + 3] = 255;
    const x = i % w;
    const y = (i / w) | 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (maxX < minX) return { patch, dirtyRect: null };
  return {
    patch,
    dirtyRect: {
      x: minX,
      y: minY,
      w: maxX - minX + 1,
      h: maxY - minY + 1,
    },
  };
}
