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
 * filter2d.ts — Engine V2 shared filter algorithm layer.
 *
 * ISOMORPHISM BOUNDARY:
 * This module is imported by BOTH the main thread (`FilterFastTrack`) AND the
 * engine worker (`Canvas2dFilterBackend`). Therefore it MUST NOT import any
 * main-thread singleton, DOM API, or Worker-specific API.
 *
 * It provides pure algorithm functions that operate on typed arrays:
 * - LUT builders (curves, levels, brightness/contrast)
 * - Fused LUT builder + RGBA8 applier
 * - Color matrix builder + RGBA8 applier
 * - Box blur (neighborhood op)
 *
 * Migrated from v1 `engine/filters/backends/Canvas2dFilter.ts` + `engine/filters/lut.ts`.
 */

import type {
  ChannelMixFilter,
  ColorBalanceFilter,
  CurvesFilter,
  CurvesData,
  CurvePoints,
  FilterDescriptor,
  HighResPixelBuffer,
  LevelsData,
  LevelsFilter,
} from '../../protocol/IFilter';
import { classifyFilter } from '../../protocol/IFilter';

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

export type LUTEntries = 256 | 65536;
export type LUTFormat = 'u8' | 'u16' | 'f32';

/**
 * LUT output types:
 * - Uint8ClampedArray:  256 × 1 B = 256 B — Fast Track main-thread preview
 *                                            & Worker 8-bit full-res.
 * - Uint16Array:        65 536 × 2 B = 128 KB — Worker 16-bit export path.
 * - Float32Array:       Internal cascading of multiple ops needing extra
 *                       precision before a single final quantization.
 */
export type LUTOutput = Uint8ClampedArray | Uint16Array | Float32Array;

/**
 * A trio of per-channel LUTs plus an optional master (luminance) LUT.
 * The runtime folds curves + levels + brightness/contrast into these
 * three LUTs so the inner pixel loop only performs a handful of array lookups.
 */
export interface PerChannelLUTs {
  rgb: LUTOutput | null;
  red: LUTOutput;
  green: LUTOutput;
  blue: LUTOutput;
}

export interface ChannelMixData {
  /** [fromR, fromG, fromB] → outputR */
  red: [number, number, number];
  /** [fromR, fromG, fromB] → outputG */
  green: [number, number, number];
  /** [fromR, fromG, fromB] → outputB */
  blue: [number, number, number];
  /** Optional constant offset per output channel */
  constant?: [number, number, number];
}

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

function bitDepthMax(bitDepth: 8 | 16 | 32): number {
  return bitDepth === 8 ? 255 : bitDepth === 16 ? 65535 : 1; // 32-bit stored as [0..1]
}

// ────────────────────────────────────────────────────────────
// Identity LUT
// ────────────────────────────────────────────────────────────

/**
 * Identity LUT — [0, 1, 2, …, entries-1] mapped to itself.
 * Useful as a starting point for cascaded operations.
 */
export function generateIdentityLUT(
  entries: LUTEntries = 256,
  format?: LUTFormat,
): LUTOutput {
  const fmt = format ?? defaultFormatFor(entries);
  const lut = allocLUT(entries, fmt);
  const maxIn = entries - 1;
  for (let i = 0; i < entries; i++) {
    writeLUT(lut, i, i / maxIn, entries, fmt);
  }
  return lut;
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

// ────────────────────────────────────────────────────────────
// Brightness (non-legacy midtone-weighted quadratic curve)
// ────────────────────────────────────────────────────────────

/**
 * Build a brightness LUT using midtone-weighted quadratic curve.
 *
 * Unlike the legacy linear model (y = x * b), this curve lifts midtones
 * preferentially while protecting shadows and highlights from clipping:
 *   y = x + t × 4 × x × (1 - x)
 * where t = (brightness - 100) / 100, range [-1, +1].
 *
 * At t=0 (identity), y=x. At t=+1 (max bright), midtones lift by +1.0
 * while endpoints stay pinned (x=0→0, x=1→1). Negative t darkens midtones.
 *
 * Curve properties:
 * - x=0 → y=0 (black preserved)
 * - x=1 → y=1 (white preserved)
 * - Midtones shift proportionally to t × 4 × x × (1-x)
 *   which peaks at x=0.5 with magnitude t
 */
export function generateBrightnessLUT(
  brightness: number = 100,
  entries: LUTEntries = 256,
  format?: LUTFormat,
): LUTOutput {
  const fmt = format ?? defaultFormatFor(entries);
  const t = (clamp(brightness, 0, 200) - 100) / 100; // [-1, +1]
  const lut = allocLUT(entries, fmt);
  const maxIn = entries - 1;
  for (let i = 0; i < entries; i++) {
    const x = i / maxIn;
    const y = clamp01(x + t * 4 * x * (1 - x));
    writeLUT(lut, i, y, entries, fmt);
  }
  return lut;
}

// ────────────────────────────────────────────────────────────
// Contrast (non-legacy tanh S-curve)
// ────────────────────────────────────────────────────────────

/**
 * Build a contrast LUT using a tanh-based S-curve.
 *
 * At c=0 (identity): y=x.
 * At c>0: S-curve steepens around midpoint=0.5, expanding midtone range
 * while compressing (not clipping) shadows and highlights.
 * At c<0: inverse — compresses toward midpoint (reduces contrast).
 *
 * The tanh function is normalized so that (0→0, 1→1) always holds,
 * unlike the legacy linear model which clips aggressively.
 *
 * Curve properties:
 * - f(0)=0, f(1)=1 always (endpoints never move)
 * - f(0.5)=0.5 always (midpoint is fixed)
 * - Positive contrast: S-curve steepens, midtone slope > 1
 * - Negative contrast: compression toward midpoint, all slopes < 1
 */
export function generateContrastLUT(
  contrast: number = 100,
  entries: LUTEntries = 256,
  format?: LUTFormat,
): LUTOutput {
  const fmt = format ?? defaultFormatFor(entries);
  const c = (clamp(contrast, 0, 200) - 100) / 100; // [-1, +1]
  const lut = allocLUT(entries, fmt);
  const maxIn = entries - 1;

  if (Math.abs(c) < 0.001) {
    // Identity fast path
    for (let i = 0; i < entries; i++) {
      writeLUT(lut, i, i / maxIn, entries, fmt);
    }
    return lut;
  }

  if (c > 0) {
    // S-curve: steepness grows with contrast
    // factor maps [0, 1] → [1, 5] for visually appropriate range
    const factor = 1 + c * 4;
    const normDenom = Math.tanh(factor * 0.5);
    for (let i = 0; i < entries; i++) {
      const x = i / maxIn;
      const y = 0.5 + 0.5 * Math.tanh(factor * (x - 0.5)) / normDenom;
      writeLUT(lut, i, clamp01(y), entries, fmt);
    }
  } else {
    // Reducing contrast: linear compression toward midpoint
    const strength = 1 + c; // [0, 1] where 0 = flat gray, 1 = identity
    for (let i = 0; i < entries; i++) {
      const x = i / maxIn;
      const y = 0.5 + (x - 0.5) * strength;
      writeLUT(lut, i, clamp01(y), entries, fmt);
    }
  }
  return lut;
}

// ────────────────────────────────────────────────────────────
// Channel mixer helpers
// ────────────────────────────────────────────────────────────

/** Identity channel-mixer matrix (RGB unchanged). */
export const IDENTITY_CHANNEL_MIX: ChannelMixData = {
  red: [1, 0, 0],
  green: [0, 1, 0],
  blue: [0, 0, 1],
  constant: [0, 0, 0],
};

/**
 * Normalize a channel-mix descriptor into a `[R, G, B]` row list.
 */
export function normalizeChannelMatrix(data: ChannelMixData): {
  matrix: [number, number, number][];
  constant: [number, number, number];
} {
  return {
    matrix: [
      [data.red[0], data.red[1], data.red[2]],
      [data.green[0], data.green[1], data.green[2]],
      [data.blue[0], data.blue[1], data.blue[2]],
    ],
    constant: [
      data.constant?.[0] ?? 0,
      data.constant?.[1] ?? 0,
      data.constant?.[2] ?? 0,
    ],
  };
}

// ────────────────────────────────────────────────────────────
// Curves per-channel expansion
// ────────────────────────────────────────────────────────────

/**
 * Given a CurvesData descriptor, produce (up to) four LUTs — the master
 * RGB curve plus per-channel Red / Green / Blue curves.
 */
export function expandCurvesLUTs(
  curves: CurvesData | undefined,
  entries: LUTEntries = 256,
  format?: LUTFormat,
): {
  rgb: LUTOutput | null;
  red: LUTOutput | null;
  green: LUTOutput | null;
  blue: LUTOutput | null;
} {
  if (!curves) {
    return { rgb: null, red: null, green: null, blue: null };
  }
  return {
    rgb: curves.rgb ? generateCurveLUT(curves.rgb, entries, format) : null,
    red: curves.red ? generateCurveLUT(curves.red, entries, format) : null,
    green: curves.green ? generateCurveLUT(curves.green, entries, format) : null,
    blue: curves.blue ? generateCurveLUT(curves.blue, entries, format) : null,
  };
}

// ────────────────────────────────────────────────────────────
// LUT composition
// ────────────────────────────────────────────────────────────

/**
 * Compose two LUTs — `result[i] = second[first[i]]` (function composition).
 */
export function composeLUTs(
  first: LUTOutput,
  second: LUTOutput,
  entries: LUTEntries = 256,
  format?: LUTFormat,
): LUTOutput {
  if (first.length !== entries || second.length !== entries) {
    throw new Error(
      `[composeLUTs] length mismatch: first=${first.length} second=${second.length} entries=${entries}`,
    );
  }
  const fmt = format ?? defaultFormatFor(entries);
  const out = allocLUT(entries, fmt);
  const maxIn = entries - 1;

  const readNormalized = (lut: LUTOutput, i: number): number => {
    const v = lut[i];
    return lut instanceof Float32Array ? v : v / maxIn;
  };

  for (let i = 0; i < entries; i++) {
    const midNormalized = readNormalized(first, i);
    const midIndex = Math.round(midNormalized * maxIn);
    const finalNormalized = readNormalized(second, midIndex);
    writeLUT(out, i, finalNormalized, entries, fmt);
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// Fused point-op LUT builder
// ────────────────────────────────────────────────────────────

function copyLUT(src: LUTOutput): LUTOutput {
  if (src instanceof Uint8ClampedArray) return new Uint8ClampedArray(src);
  if (src instanceof Uint16Array) return new Uint16Array(src);
  return new Float32Array(src);
}

function identityLUT(entries: LUTEntries, format: LUTFormat): LUTOutput {
  if (format === 'u8') {
    const arr = new Uint8ClampedArray(entries);
    const maxOut = entries - 1;
    for (let i = 0; i < entries; i++) arr[i] = Math.round((i / maxOut) * 255);
    return arr;
  }
  if (format === 'u16') {
    const arr = new Uint16Array(entries);
    const maxOut = entries - 1;
    for (let i = 0; i < entries; i++) arr[i] = Math.round((i / maxOut) * 65535);
    return arr;
  }
  const arr = new Float32Array(entries);
  const maxOut = entries - 1;
  for (let i = 0; i < entries; i++) arr[i] = i / maxOut;
  return arr;
}

/**
 * Compose per-channel LUTs from a filter chain, collapsing brightness /
 * contrast / levels / curves point-ops in the order they appear.
 *
 * Returns `null` if no point-op filters are active.
 */
export function buildFusedLUTs(
  filters: FilterDescriptor[],
  entries: LUTEntries,
  format: LUTFormat,
): PerChannelLUTs | null {
  const maxOut = entries - 1;

  // Start with identity per channel.
  let red = identityLUT(entries, format);
  let green = copyLUT(red);
  let blue = copyLUT(red);
  let touched = false;

  const readLUTIndex = (lut: LUTOutput, i: number): number => {
    if (lut instanceof Float32Array) {
      return Math.round(clamp(lut[i], 0, 1) * maxOut);
    }
    const nativeMax = lut instanceof Uint8ClampedArray ? 255 : 65535;
    if (nativeMax === maxOut) return lut[i];
    return Math.round((lut[i] / nativeMax) * maxOut);
  };

  const composeInto = (
    target: LUTOutput,
    additional: LUTOutput,
  ): LUTOutput => {
    const out =
      target instanceof Uint8ClampedArray
        ? new Uint8ClampedArray(entries)
        : target instanceof Uint16Array
          ? new Uint16Array(entries)
          : new Float32Array(entries);
    for (let i = 0; i < entries; i++) {
      const mid = readLUTIndex(target, i);
      out[i] = additional[mid];
    }
    return out;
  };

  for (const f of filters) {
    switch (f.type) {
      case 'brightness': {
        const lut = generateBrightnessLUT(f.value, entries, format);
        red = composeInto(red, lut);
        green = composeInto(green, lut);
        blue = composeInto(blue, lut);
        touched = true;
        break;
      }
      case 'contrast': {
        const lut = generateContrastLUT(f.value, entries, format);
        red = composeInto(red, lut);
        green = composeInto(green, lut);
        blue = composeInto(blue, lut);
        touched = true;
        break;
      }
      case 'levels': {
        const cfg = { ...DEFAULT_LEVELS, ...(f as LevelsFilter).config };
        const lut = generateLevelsLUT(cfg, entries, format);
        red = composeInto(red, lut);
        green = composeInto(green, lut);
        blue = composeInto(blue, lut);
        touched = true;
        break;
      }
      case 'curves': {
        const cf = (f as CurvesFilter).channels;
        const { rgb, red: rL, green: gL, blue: bL } = expandCurvesLUTs(
          cf,
          entries,
          format,
        );
        if (rgb) {
          red = composeInto(red, rgb);
          green = composeInto(green, rgb);
          blue = composeInto(blue, rgb);
        }
        if (rL) red = composeInto(red, rL);
        if (gL) green = composeInto(green, gL);
        if (bL) blue = composeInto(blue, bL);
        touched = true;
        break;
      }
      default:
        break;
    }
  }

  if (!touched) return null;
  return { rgb: null, red, green, blue };
}

// ────────────────────────────────────────────────────────────
// Pixel pass: RGBA Uint8 LUT (8-bit path)
// ────────────────────────────────────────────────────────────

export function applyLUTsRGBA8(
  data: Uint8ClampedArray,
  luts: PerChannelLUTs,
): void {
  const { red, green, blue } = luts;
  const r = red as Uint8ClampedArray;
  const g = green as Uint8ClampedArray;
  const b = blue as Uint8ClampedArray;
  const len = data.length;
  for (let i = 0; i < len; i += 4) {
    data[i] = r[data[i]];
    data[i + 1] = g[data[i + 1]];
    data[i + 2] = b[data[i + 2]];
    // alpha untouched
  }
}

// ────────────────────────────────────────────────────────────
// Pixel pass: high-res (Uint16 / Float32) LUT
// ────────────────────────────────────────────────────────────

export function applyLUTsHighRes(
  buf: HighResPixelBuffer,
  luts: PerChannelLUTs,
): void {
  const stride = buf.channels;
  const len = buf.data.length;
  const r = luts.red;
  const g = luts.green;
  const b = luts.blue;
  const dst = buf.data;

  if (buf.bitDepth === 16 && r instanceof Uint16Array && g instanceof Uint16Array && b instanceof Uint16Array) {
    for (let i = 0; i < len; i += stride) {
      dst[i] = r[dst[i]];
      dst[i + 1] = g[dst[i + 1]];
      dst[i + 2] = b[dst[i + 2]];
    }
    return;
  }

  // Float32 fallback path.
  const maxIn = r.length - 1;
  const readF = (lut: LUTOutput, idx: number): number => {
    if (lut instanceof Float32Array) return lut[idx];
    const nativeMax = lut instanceof Uint8ClampedArray ? 255 : 65535;
    return lut[idx] / nativeMax;
  };
  for (let i = 0; i < len; i += stride) {
    const rv = clamp(dst[i], 0, 1);
    const gv = clamp(dst[i + 1], 0, 1);
    const bv = clamp(dst[i + 2], 0, 1);
    dst[i] = readF(r, Math.round(rv * maxIn));
    dst[i + 1] = readF(g, Math.round(gv * maxIn));
    dst[i + 2] = readF(b, Math.round(bv * maxIn));
  }
}

// ────────────────────────────────────────────────────────────
// Saturation / hue-rotate — 3×3 matrix (Rec.709 luma-preserving)
// ────────────────────────────────────────────────────────────

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

function buildSaturationMatrix(saturation: number): number[] {
  const s = clamp(saturation, 0, 200) / 100; // 0..2, 1 = identity
  const invR = (1 - s) * LUMA_R;
  const invG = (1 - s) * LUMA_G;
  const invB = (1 - s) * LUMA_B;
  return [
    invR + s, invG,     invB,
    invR,     invG + s, invB,
    invR,     invG,     invB + s,
  ];
}

function buildHueRotationMatrix(hueDegrees: number): number[] {
  const rad = (hueDegrees % 360) * (Math.PI / 180);
  const cosH = Math.cos(rad);
  const sinH = Math.sin(rad);
  return [
    LUMA_R + cosH * (1 - LUMA_R) - sinH * LUMA_R,
    LUMA_G - cosH * LUMA_G - sinH * LUMA_G,
    LUMA_B - cosH * LUMA_B + sinH * (1 - LUMA_B),

    LUMA_R - cosH * LUMA_R + sinH * 0.143,
    LUMA_G + cosH * (1 - LUMA_G) + sinH * 0.14,
    LUMA_B - cosH * LUMA_B - sinH * 0.283,

    LUMA_R - cosH * LUMA_R - sinH * (1 - LUMA_R),
    LUMA_G - cosH * LUMA_G + sinH * LUMA_G,
    LUMA_B + cosH * (1 - LUMA_B) + sinH * LUMA_B,
  ];
}

/** Multiply two 3×3 matrices (flat row-major). */
function multiplyMatrix3(a: number[], b: number[]): number[] {
  const out = new Array<number>(9);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      out[row * 3 + col] =
        a[row * 3] * b[col] +
        a[row * 3 + 1] * b[3 + col] +
        a[row * 3 + 2] * b[6 + col];
    }
  }
  return out;
}

/**
 * Consolidate every color-matrix op (saturation + hueRotate + channelMix)
 * into ONE 3×3 matrix and ONE constant offset. Returns `null` if all
 * matrix ops collapse to identity (no work to do).
 */
export function buildFusedColorMatrix(
  filters: FilterDescriptor[],
): { matrix: number[]; constant: [number, number, number] } | null {
  let m: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let offset: [number, number, number] = [0, 0, 0];
  let touched = false;

  for (const f of filters) {
    switch (f.type) {
      case 'saturation': {
        if (f.value === 100) break;
        m = multiplyMatrix3(buildSaturationMatrix(f.value), m);
        touched = true;
        break;
      }
      case 'hueRotate': {
        if (f.value === 0) break;
        m = multiplyMatrix3(buildHueRotationMatrix(f.value), m);
        touched = true;
        break;
      }
      case 'channelMix': {
        const data = { ...IDENTITY_CHANNEL_MIX, ...(f as ChannelMixFilter).data };
        const { matrix, constant } = normalizeChannelMatrix(data);
        const flat = [
          matrix[0][0], matrix[0][1], matrix[0][2],
          matrix[1][0], matrix[1][1], matrix[1][2],
          matrix[2][0], matrix[2][1], matrix[2][2],
        ];
        m = multiplyMatrix3(flat, m);
        offset = [offset[0] + constant[0], offset[1] + constant[1], offset[2] + constant[2]];
        touched = true;
        break;
      }
      default:
        break;
    }
  }

  if (!touched) return null;
  return { matrix: m, constant: offset };
}

// ────────────────────────────────────────────────────────────
// Pixel pass: RGBA8 color matrix
// ────────────────────────────────────────────────────────────

export function applyMatrixRGBA8(
  data: Uint8ClampedArray,
  matrix: number[],
  constant: [number, number, number],
): void {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = matrix;
  const [c0, c1, c2] = constant;
  const co0 = c0 * 255;
  const co1 = c1 * 255;
  const co2 = c2 * 255;
  const len = data.length;
  for (let i = 0; i < len; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const nr = m00 * r + m01 * g + m02 * b + co0;
    const ng = m10 * r + m11 * g + m12 * b + co1;
    const nb = m20 * r + m21 * g + m22 * b + co2;
    data[i] = nr;
    data[i + 1] = ng;
    data[i + 2] = nb;
  }
}

// ────────────────────────────────────────────────────────────
// Pixel pass: high-res color matrix
// ────────────────────────────────────────────────────────────

export function applyMatrixHighRes(
  buf: HighResPixelBuffer,
  matrix: number[],
  constant: [number, number, number],
): void {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = matrix;
  const maxVal = bitDepthMax(buf.bitDepth);
  const co0 = constant[0] * maxVal;
  const co1 = constant[1] * maxVal;
  const co2 = constant[2] * maxVal;
  const stride = buf.channels;
  const dst = buf.data;
  const len = dst.length;
  const isInt = buf.bitDepth === 16;

  for (let i = 0; i < len; i += stride) {
    const r = dst[i];
    const g = dst[i + 1];
    const b = dst[i + 2];
    let nr = m00 * r + m01 * g + m02 * b + co0;
    let ng = m10 * r + m11 * g + m12 * b + co1;
    let nb = m20 * r + m21 * g + m22 * b + co2;
    if (isInt) {
      nr = clamp(nr, 0, maxVal);
      ng = clamp(ng, 0, maxVal);
      nb = clamp(nb, 0, maxVal);
    } else {
      nr = clamp(nr, 0, 1);
      ng = clamp(ng, 0, 1);
      nb = clamp(nb, 0, 1);
    }
    dst[i] = nr;
    dst[i + 1] = ng;
    dst[i + 2] = nb;
  }
}

// ────────────────────────────────────────────────────────────
// Color Balance (Photoshop-compatible — HSL lightness weighted)
// Algorithm inspired by GIMP 3.2.4's approach but independently
// implemented with different design choices. See spec:
// docs/opengpex/03-plugins/20260729_filters_color_balance_spec.md
// ────────────────────────────────────────────────────────────

/**
 * Color Balance — Photoshop-compatible implementation.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DESIGN DECISIONS & LESSONS LEARNED (for future refactoring reference):
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. WEIGHT CURVES: Smooth quadratic (not GIMP's narrow linear ramps)
 *    ─────────────────────────────────────────────────────────────────
 *    GIMP 3.2.4 uses linear ramps with a=0.25, b=0.333. These create a
 *    very narrow transition zone (~12.5% of lightness range) causing visible
 *    "color patches" at the shadow/midtone boundary. Photoshop uses much
 *    wider, smoother transitions.
 *
 *    Solution: Quadratic curves that overlap extensively:
 *      Shadow:    (1 - L)²     — peaks at L=0, reaches 0 only at L=1
 *      Midtone:   4·L·(1-L)   — parabola peaking at L=0.5
 *      Highlight: L²           — peaks at L=1, reaches 0 only at L=0
 *
 * 2. INTENSITY SCALE: 0.25 (not GIMP's 0.7)
 *    ────────────────────────────────────────
 *    GIMP's scale=0.7 produces offsets ~3x stronger than Photoshop at the
 *    same slider value. At slider=±100, maximum offset ≈ ±0.25 (≈64/255
 *    levels) matches Photoshop's observed behavior.
 *
 * 3. PRESERVE LUMINOSITY: Additive Rec.709 correction (NOT HSL, NOT ratio)
 *    ─────────────────────────────────────────────────────────────────────
 *    Three approaches were evaluated and two produced visible artifacts:
 *
 *    ❌ HSL L-channel replacement (GIMP method):
 *       HSL L = (max+min)/2 only depends on the max and min channels.
 *       When the adjusted channel crosses the max/min boundary (e.g., G
 *       goes from being the max to not being the max), preserveLuminosity
 *       activates DISCONTINUOUSLY — it either does nothing or applies a
 *       full correction depending on which side of the boundary you are.
 *       This creates clearly visible "color patches" at content boundaries.
 *       GIMP avoids this because it works in 32-bit float with babl's
 *       optimized HSL conversion that handles boundary cases.
 *
 *    ❌ Rec.709 ratio scaling (origLum / newLum):
 *       When reducing G (magenta shift), G has 71.5% of luminance weight,
 *       so the ratio grows exponentially in dark pixels (can reach 1.4x+).
 *       This non-linear amplification creates strong color patches at
 *       luminance boundaries.
 *
 *    ✅ Additive uniform correction (current):
 *       lumDelta = origLum - newLum; R += delta; G += delta; B += delta
 *       - Smooth: Rec.709 lum is a linear function of all channels (no
 *         max/min discontinuity)
 *       - Linear: additive not multiplicative (no ratio amplification)
 *       - Exact: since luma coefficients sum to 1.0, adding the same delta
 *         to all channels exactly restores original luminance
 *       - Trade-off: slight hue shift (uniform add ≠ hue-preserving), but
 *         imperceptible at CB_SCALE=0.25
 *
 * 4. FUTURE: When Engine V2 Phase 5 (HighDepth) is complete and all filter
 *    operations run in float32 space, the HSL L-replacement method could be
 *    reconsidered since the max/min boundary discontinuity becomes negligible
 *    in continuous float space (no 8-bit quantization to amplify it).
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Color balance global attenuation (PS-matched intensity) */
const CB_SCALE = 0.25;
const CB_STRENGTH = 1.0 / 100.0; // slider [-100,+100] → [-1,+1]

// ─── HSL utility functions (for color balance) ───

/** HSL Lightness = (max + min) / 2, computed in gamma-encoded space */
function hslLightness(r: number, g: number, b: number): number {
  return (Math.max(r, g, b) + Math.min(r, g, b)) * 0.5;
}


/**
 * Apply color balance to RGBA8 data in-place.
 *
 * Algorithm (per pixel):
 * 1. Compute HSL Lightness (unified tone region classifier)
 * 2. Compute shadow / midtone / highlight weights via smooth quadratic curves
 * 3. Compute per-channel offset = Σ(weight[range] × slider[range][ch])
 * 4. Add offset to each channel, clamp to [0,1]
 * 5. If preserveLuminosity: scale RGB uniformly to restore original Rec.709 lum
 */
export function applyColorBalanceRGBA8(
  data: Uint8ClampedArray,
  shadows: readonly [number, number, number],
  midtones: readonly [number, number, number],
  highlights: readonly [number, number, number],
  preserveLuminosity: boolean,
): void {
  const len = data.length;

  // Pre-scale slider values: [-100..+100] → [-1..+1]
  const sR = shadows[0] * CB_STRENGTH;
  const sG = shadows[1] * CB_STRENGTH;
  const sB = shadows[2] * CB_STRENGTH;
  const mR = midtones[0] * CB_STRENGTH;
  const mG = midtones[1] * CB_STRENGTH;
  const mB = midtones[2] * CB_STRENGTH;
  const hR = highlights[0] * CB_STRENGTH;
  const hG = highlights[1] * CB_STRENGTH;
  const hB = highlights[2] * CB_STRENGTH;

  for (let i = 0; i < len; i += 4) {
    // Normalize to [0, 1]
    const rn = data[i] / 255;
    const gn = data[i + 1] / 255;
    const bn = data[i + 2] / 255;

    // HSL Lightness — unified tone region classifier
    const L = hslLightness(rn, gn, bn);

    // Smooth quadratic weight curves (wide overlap, no banding)
    const oneMinusL = 1 - L;
    const wS = oneMinusL * oneMinusL * CB_SCALE;  // (1-L)² — shadow
    const wM = 4 * L * oneMinusL * CB_SCALE;      // 4·L·(1-L) — midtone
    const wH = L * L * CB_SCALE;                   // L² — highlight

    // Additive offsets (in normalized [0,1] space)
    let nr = clamp01(rn + sR * wS + mR * wM + hR * wH);
    let ng = clamp01(gn + sG * wS + mG * wM + hG * wH);
    let nb = clamp01(bn + sB * wS + mB * wM + hB * wH);

    // Preserve luminosity: additive Rec.709 luminance correction.
    // Computes the luminance delta introduced by the color offset and adds it
    // back uniformly to all channels. This is:
    //   - Smooth: no max/min discontinuity (unlike HSL L-replacement)
    //   - Linear: no ratio amplification (unlike Rec.709 ratio scaling)
    //   - Exact: since luma weights sum to 1, uniform add restores original lum
    if (preserveLuminosity) {
      const origLum = LUMA_R * rn + LUMA_G * gn + LUMA_B * bn;
      const newLum = LUMA_R * nr + LUMA_G * ng + LUMA_B * nb;
      const lumDelta = origLum - newLum;
      nr = clamp01(nr + lumDelta);
      ng = clamp01(ng + lumDelta);
      nb = clamp01(nb + lumDelta);
    }

    data[i] = Math.round(nr * 255);
    data[i + 1] = Math.round(ng * 255);
    data[i + 2] = Math.round(nb * 255);
  }
}

/**
 * Apply color balance to a high-res (16-bit / 32-bit) pixel buffer in-place.
 * Same algorithm as the RGBA8 version.
 */
export function applyColorBalanceHighRes(
  buf: HighResPixelBuffer,
  shadows: readonly [number, number, number],
  midtones: readonly [number, number, number],
  highlights: readonly [number, number, number],
  preserveLuminosity: boolean,
): void {
  const stride = buf.channels;
  const dst = buf.data;
  const len = dst.length;
  const maxVal = bitDepthMax(buf.bitDepth);
  const isInt = buf.bitDepth === 16;

  const sR = shadows[0] * CB_STRENGTH;
  const sG = shadows[1] * CB_STRENGTH;
  const sB = shadows[2] * CB_STRENGTH;
  const mR = midtones[0] * CB_STRENGTH;
  const mG = midtones[1] * CB_STRENGTH;
  const mB = midtones[2] * CB_STRENGTH;
  const hR = highlights[0] * CB_STRENGTH;
  const hG = highlights[1] * CB_STRENGTH;
  const hB = highlights[2] * CB_STRENGTH;

  for (let i = 0; i < len; i += stride) {
    // Normalize to [0, 1]
    const rn = isInt ? dst[i] / maxVal : dst[i];
    const gn = isInt ? dst[i + 1] / maxVal : dst[i + 1];
    const bn = isInt ? dst[i + 2] / maxVal : dst[i + 2];

    // HSL Lightness
    const L = hslLightness(rn, gn, bn);

    // Smooth quadratic weight curves (wide overlap, no banding)
    const oneMinusL = 1 - L;
    const wS = oneMinusL * oneMinusL * CB_SCALE;
    const wM = 4 * L * oneMinusL * CB_SCALE;
    const wH = L * L * CB_SCALE;

    let nr = clamp01(rn + sR * wS + mR * wM + hR * wH);
    let ng = clamp01(gn + sG * wS + mG * wM + hG * wH);
    let nb = clamp01(bn + sB * wS + mB * wM + hB * wH);

    // Preserve luminosity: additive Rec.709 luminance correction
    if (preserveLuminosity) {
      const origLum = LUMA_R * rn + LUMA_G * gn + LUMA_B * bn;
      const newLum = LUMA_R * nr + LUMA_G * ng + LUMA_B * nb;
      const lumDelta = origLum - newLum;
      nr = clamp01(nr + lumDelta);
      ng = clamp01(ng + lumDelta);
      nb = clamp01(nb + lumDelta);
    }

    if (isInt) {
      dst[i] = Math.round(nr * maxVal);
      dst[i + 1] = Math.round(ng * maxVal);
      dst[i + 2] = Math.round(nb * maxVal);
    } else {
      dst[i] = nr;
      dst[i + 1] = ng;
      dst[i + 2] = nb;
    }
  }
}

/**
 * Extract the first colorBalance descriptor from a filter chain.
 * Returns null if none found.
 */
export function extractColorBalance(filters: FilterDescriptor[]): ColorBalanceFilter | null {
  for (const f of filters) {
    if (f.type === 'colorBalance') return f as ColorBalanceFilter;
  }
  return null;
}

// ────────────────────────────────────────────────────────────
// Blur (neighborhood op) — 3-pass box blur ≈ Gaussian
// ────────────────────────────────────────────────────────────

/**
 * Compute the box-blur radii for three consecutive passes that approximate a
 * Gaussian blur with the requested sigma. Reference: Wells (1986).
 */
function computeBoxBlurRadii(sigma: number, passes = 3): number[] {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / passes + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal =
    (12 * sigma * sigma - passes * wl * wl - 4 * passes * wl - 3 * passes) /
    (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const radii: number[] = [];
  for (let i = 0; i < passes; i++) {
    radii.push(((i < m ? wl : wu) - 1) / 2);
  }
  return radii;
}

function horizontalBoxBlurRGBA(
  src: Uint8ClampedArray,
  dst: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.floor(radius));
  if (r === 0) {
    dst.set(src);
    return;
  }
  const invArea = 1 / (r + r + 1);
  for (let y = 0; y < height; y++) {
    const rowStart = y * width * 4;
    let sumR = 0, sumG = 0, sumB = 0, sumA = 0;
    for (let x = -r; x <= r; x++) {
      const xc = clamp(x, 0, width - 1);
      const p = rowStart + xc * 4;
      sumR += src[p];
      sumG += src[p + 1];
      sumB += src[p + 2];
      sumA += src[p + 3];
    }
    for (let x = 0; x < width; x++) {
      const p = rowStart + x * 4;
      dst[p] = sumR * invArea;
      dst[p + 1] = sumG * invArea;
      dst[p + 2] = sumB * invArea;
      dst[p + 3] = sumA * invArea;
      const removeX = clamp(x - r, 0, width - 1);
      const addX = clamp(x + r + 1, 0, width - 1);
      const rp = rowStart + removeX * 4;
      const ap = rowStart + addX * 4;
      sumR += src[ap] - src[rp];
      sumG += src[ap + 1] - src[rp + 1];
      sumB += src[ap + 2] - src[rp + 2];
      sumA += src[ap + 3] - src[rp + 3];
    }
  }
}

function verticalBoxBlurRGBA(
  src: Uint8ClampedArray,
  dst: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.floor(radius));
  if (r === 0) {
    dst.set(src);
    return;
  }
  const invArea = 1 / (r + r + 1);
  const rowSize = width * 4;
  for (let x = 0; x < width; x++) {
    const colStart = x * 4;
    let sumR = 0, sumG = 0, sumB = 0, sumA = 0;
    for (let y = -r; y <= r; y++) {
      const yc = clamp(y, 0, height - 1);
      const p = colStart + yc * rowSize;
      sumR += src[p];
      sumG += src[p + 1];
      sumB += src[p + 2];
      sumA += src[p + 3];
    }
    for (let y = 0; y < height; y++) {
      const p = colStart + y * rowSize;
      dst[p] = sumR * invArea;
      dst[p + 1] = sumG * invArea;
      dst[p + 2] = sumB * invArea;
      dst[p + 3] = sumA * invArea;
      const removeY = clamp(y - r, 0, height - 1);
      const addY = clamp(y + r + 1, 0, height - 1);
      const rp = colStart + removeY * rowSize;
      const ap = colStart + addY * rowSize;
      sumR += src[ap] - src[rp];
      sumG += src[ap + 1] - src[rp + 1];
      sumB += src[ap + 2] - src[rp + 2];
      sumA += src[ap + 3] - src[rp + 3];
    }
  }
}

/**
 * Apply a box-blur approximation of Gaussian blur in-place on RGBA8 data.
 */
export function boxBlurRGBAInPlace(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): void {
  if (radius <= 0) return;
  const radii = computeBoxBlurRadii(radius);
  const scratch = new Uint8ClampedArray(data.length);
  for (const r of radii) {
    horizontalBoxBlurRGBA(data, scratch, width, height, r);
    verticalBoxBlurRGBA(scratch, data, width, height, r);
  }
}

// ────────────────────────────────────────────────────────────
// Convenience: apply all filters to an RGBA8 frame
// ────────────────────────────────────────────────────────────

/**
 * Apply a full filter chain to an RGBA8 buffer in-place.
 * Applies point-ops (LUT), matrix ops, then neighborhood ops in order.
 */
export function applyFilterChainRGBA8(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  filters: FilterDescriptor[],
): void {
  if (!filters || filters.length === 0) return;

  // Point-ops: fuse into LUT
  const luts = buildFusedLUTs(filters, 256, 'u8');
  if (luts) applyLUTsRGBA8(data, luts);

  // Color balance: luminance-aware per-pixel pass (Plan B)
  // Must run BEFORE matrix ops because it reads per-pixel luminance which
  // would be distorted by saturation/hueRotate matrix multiplication.
  const cb = extractColorBalance(filters);
  if (cb) {
    applyColorBalanceRGBA8(
      data,
      cb.data.shadows,
      cb.data.midtones,
      cb.data.highlights,
      cb.data.preserveLuminosity,
    );
  }

  // Matrix ops: fuse into single 3×3 matrix
  const mtx = buildFusedColorMatrix(filters);
  if (mtx) applyMatrixRGBA8(data, mtx.matrix, mtx.constant);

  // Neighborhood ops
  for (const f of filters) {
    if (classifyFilter(f) !== 'neighborhood') continue;
    if (f.type === 'blur') {
      boxBlurRGBAInPlace(data, width, height, f.value);
    }
  }
}

// ────────────────────────────────────────────────────────────
// LUT format helpers (exported for backends)
// ────────────────────────────────────────────────────────────

export function lutEntriesFor(bitDepth: 8 | 16 | 32): LUTEntries {
  return bitDepth === 8 ? 256 : 65536;
}

export function lutFormatFor(bitDepth: 8 | 16 | 32): LUTFormat {
  if (bitDepth === 8) return 'u8';
  if (bitDepth === 16) return 'u16';
  return 'f32';
}
