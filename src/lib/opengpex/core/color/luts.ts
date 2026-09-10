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
 * luts.ts — Tone-curve and levels LUT generators (pure math, spec §16.2).
 *
 * Source of truth for 1D LUT table generation in curve/level UI panels
 * and GPU AdjustPass LUT textures.
 *
 * @module core/color/luts
 */

import type { CurvePoints, LevelsData } from '../engine/protocol/IFilter';

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

export type LUTEntries = 256 | 65536;
export type LUTFormat = 'u8' | 'u16' | 'f32';

/**
 * LUT storage formats:
 * - Uint8ClampedArray:  256 × 1 B = 256 B    — 8-bit LUT texture (`r8unorm`).
 * - Uint16Array:        65 536 × 2 B = 128 KB — high-precision LUT (`r16float`).
 * - Float32Array:       full precision       — UI graph sampling; `r32float`.
 */
export type LUTOutput = Uint8ClampedArray | Uint16Array | Float32Array;

// ────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

function defaultFormatFor(entries: LUTEntries): LUTFormat {
  return entries === 256 ? 'u8' : 'u16';
}

function allocLUT(entries: LUTEntries, format: LUTFormat): LUTOutput {
  switch (format) {
    case 'u8':
      return new Uint8ClampedArray(entries);
    case 'u16':
      return new Uint16Array(entries);
    case 'f32':
      return new Float32Array(entries);
  }
}

/** Quantize [0..1] normalized value into the LUT's storage range. */
function writeLUT(
  lut: LUTOutput,
  i: number,
  normalized: number,
  entries: LUTEntries,
  format: LUTFormat,
): void {
  const clamped = clamp01(normalized);
  if (format === 'f32') {
    (lut as Float32Array)[i] = clamped;
  } else {
    const maxOut = entries - 1;
    lut[i] = Math.round(clamped * maxOut);
  }
}

// ────────────────────────────────────────────────────────────
// Curves — Fritsch-Carlson monotonic cubic spline
// ────────────────────────────────────────────────────────────

/**
 * Sort + de-duplicate control points, enforcing endpoints at x=0 and x=1
 * with linear extrapolation from the nearest interior point.
 */
function normalizeControlPoints(points: CurvePoints | undefined): CurvePoints {
  if (!points || points.length === 0) {
    return [
      [0, 0],
      [1, 1],
    ];
  }

  // Copy + clamp to [0, 1]
  const pts: CurvePoints = points.map(
    ([x, y]) => [clamp01(x), clamp01(y)] as [number, number],
  );

  // Sort by x
  pts.sort((a, b) => a[0] - b[0]);

  // De-duplicate on x (keep the last occurrence — Photoshop-style)
  const dedup: CurvePoints = [];
  for (const p of pts) {
    if (dedup.length > 0 && dedup[dedup.length - 1][0] === p[0]) {
      dedup[dedup.length - 1] = p;
    } else {
      dedup.push(p);
    }
  }

  // Enforce endpoints
  if (dedup[0][0] > 0) dedup.unshift([0, dedup[0][1]]);
  if (dedup[dedup.length - 1][0] < 1) dedup.push([1, dedup[dedup.length - 1][1]]);

  return dedup;
}

/** Compute Fritsch-Carlson tangents for the given control points. */
function computeFritschCarlsonTangents(pts: CurvePoints): number[] {
  const n = pts.length;
  const tangents = new Array<number>(n).fill(0);

  if (n < 2) return tangents;

  const h = new Array<number>(n - 1);
  const d = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = pts[i + 1][0] - pts[i][0];
    d[i] = h[i] === 0 ? 0 : (pts[i + 1][1] - pts[i][1]) / h[i];
  }

  // Initialize interior tangents as weighted average of adjacent slopes.
  tangents[0] = d[0];
  tangents[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) {
      tangents[i] = 0;
    } else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      tangents[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }

  // Enforce monotonicity (Fritsch-Carlson step)
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
    } else {
      const a = tangents[i] / d[i];
      const b = tangents[i + 1] / d[i];
      const s = a * a + b * b;
      if (s > 9) {
        const t = 3 / Math.sqrt(s);
        tangents[i] = t * a * d[i];
        tangents[i + 1] = t * b * d[i];
      }
    }
  }
  return tangents;
}

/** Evaluate the monotonic cubic Hermite spline at input x ∈ [0, 1]. */
function evalMonotonicSpline(
  pts: CurvePoints,
  tangents: number[],
  x: number,
): number {
  const n = pts.length;
  if (n === 0) return x;
  if (n === 1) return pts[0][1];
  if (x <= pts[0][0]) return pts[0][1];
  if (x >= pts[n - 1][0]) return pts[n - 1][1];

  // Locate segment via binary search
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (pts[mid][0] <= x) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const x0 = pts[lo][0];
  const x1 = pts[hi][0];
  const y0 = pts[lo][1];
  const y1 = pts[hi][1];
  const hSeg = x1 - x0;
  if (hSeg === 0) return y0;

  const t = (x - x0) / hSeg;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * y0 + h10 * hSeg * tangents[lo] + h01 * y1 + h11 * hSeg * tangents[hi];
}

/**
 * Build an N-entry LUT from curve control points.
 * Uses a Fritsch-Carlson monotonic cubic spline.
 */
export function generateCurveLUT(
  points: CurvePoints | undefined,
  entries: LUTEntries = 256,
  format?: LUTFormat,
): LUTOutput {
  const fmt = format ?? defaultFormatFor(entries);
  const pts = normalizeControlPoints(points);
  const tangents = computeFritschCarlsonTangents(pts);
  const lut = allocLUT(entries, fmt);
  const maxIn = entries - 1;
  for (let i = 0; i < entries; i++) {
    const x = i / maxIn;
    const y = evalMonotonicSpline(pts, tangents, x);
    writeLUT(lut, i, y, entries, fmt);
  }
  return lut;
}

// ────────────────────────────────────────────────────────────
// Levels
// ────────────────────────────────────────────────────────────

/** Default (identity) levels configuration. */
export const DEFAULT_LEVELS: LevelsData = {
  inputBlack: 0,
  inputWhite: 255,
  gamma: 1.0,
  outputBlack: 0,
  outputWhite: 255,
};

/**
 * Build a levels LUT.
 *
 * Formula (per channel, x is normalized to 0..1):
 *   n = clamp01((x - inBlack/255) / ((inWhite - inBlack)/255))
 *   y = (outBlack + n^(1/gamma) * (outWhite - outBlack)) / 255
 */
export function generateLevelsLUT(
  config: LevelsData | undefined,
  entries: LUTEntries = 256,
  format?: LUTFormat,
): LUTOutput {
  const fmt = format ?? defaultFormatFor(entries);
  const c = { ...DEFAULT_LEVELS, ...(config ?? {}) };

  const inBlack = clamp(c.inputBlack, 0, 255) / 255;
  const inWhite = clamp(c.inputWhite, 0, 255) / 255;
  const outBlack = clamp(c.outputBlack, 0, 255) / 255;
  const outWhite = clamp(c.outputWhite, 0, 255) / 255;
  const gamma = clamp(c.gamma, 0.01, 100);
  const range = inWhite - inBlack;
  const invGamma = 1 / gamma;
  const outRange = outWhite - outBlack;

  const lut = allocLUT(entries, fmt);
  const maxIn = entries - 1;

  if (range <= 0) {
    for (let i = 0; i < entries; i++) {
      const x = i / maxIn;
      const y = x < inBlack ? outBlack : outWhite;
      writeLUT(lut, i, y, entries, fmt);
    }
    return lut;
  }

  for (let i = 0; i < entries; i++) {
    const x = i / maxIn;
    const n = clamp01((x - inBlack) / range);
    const g = Math.pow(n, invGamma);
    const y = outBlack + g * outRange;
    writeLUT(lut, i, y, entries, fmt);
  }
  return lut;
}
