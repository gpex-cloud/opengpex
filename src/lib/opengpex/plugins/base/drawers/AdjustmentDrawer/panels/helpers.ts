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
 * helpers.ts — shared pure helpers for the AdjustmentDrawer panels.
 *
 * Home for functions consumed by MORE THAN ONE panel (levels / curves /
 * basic / mixer / balance). Panel-private helpers stay inside their panel
 * module (`panels/curves/geometry.ts`, `panels/levels/geometry.ts`); move a
 * function here only when a second panel actually needs it.
 */

// ─── Math ──────────────────────────────────────────────────────────────────────

/** Clamp `v` into `[lo, hi]`. */
export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/** Clamp `v` into [0, 1]. */
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ─── Histogram rendering ───────────────────────────────────────────────────────

/** Number of bins in the histograms the panels display. */
export const HISTOGRAM_BINS = 256;

/**
 * Build the SVG path `d` for a filled histogram polygon. We normalize by the
 * MAX-of-non-endpoint-bins so a single spike at 0 or 255 (very common on
 * masked or clipped layers) doesn't crush the rest of the graph into
 * invisibility. The endpoints are then re-scaled independently so they
 * still show up as bars, but capped at graph height.
 *
 * Each call normalizes INDEPENDENTLY — passing per-channel histograms yields
 * per-channel normalization (a single-channel spike doesn't flatten the
 * others), which is what the RGB display modes rely on. Shared by the
 * Levels panel (composite / per-channel modes) and the Curves panel
 * (background layer).
 */
export function histogramToPathD(
  hist: Uint32Array | null,
  vbW: number,
  vbH: number,
): string {
  if (!hist || hist.length === 0) return "";
  // Ignore the two extreme bins when finding the display maximum so a common
  // "all-zero-alpha corners" spike doesn't dominate. We still draw them,
  // just clamped to the height ceiling.
  let interiorMax = 0;
  for (let i = 1; i < hist.length - 1; i++) {
    if (hist[i] > interiorMax) interiorMax = hist[i];
  }
  if (interiorMax === 0) {
    // Nothing interior — fall back to the true max so single-value images
    // still render *something*.
    for (let i = 0; i < hist.length; i++) {
      if (hist[i] > interiorMax) interiorMax = hist[i];
    }
  }
  if (interiorMax === 0) return "";

  // We render as a filled polygon (baseline → bars → baseline) which reads
  // better than 256 individual `<rect>`s and stays cheap to diff.
  const parts: string[] = [`M 0 ${vbH}`];
  const step = vbW / hist.length;
  for (let i = 0; i < hist.length; i++) {
    const h = Math.min(vbH, (hist[i] / interiorMax) * vbH);
    const x = i * step;
    parts.push(`L ${x.toFixed(2)} ${(vbH - h).toFixed(2)}`);
    parts.push(`L ${(x + step).toFixed(2)} ${(vbH - h).toFixed(2)}`);
  }
  parts.push(`L ${vbW} ${vbH} Z`);
  return parts.join(" ");
}
