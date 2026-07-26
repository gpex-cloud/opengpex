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
// Brightness / Contrast (combined LUT)
// ────────────────────────────────────────────────────────────

/**
 * Build a LUT combining brightness and contrast (both expressed on a 0..200
 * scale where 100 = identity — same convention as `AdjustmentState`).
 */
export function generateBrightnessContrastLUT(
  brightness: number = 100,
  contrast: number = 100,
  entries: LUTEntries = 256,
  format?: LUTFormat,
): LUTOutput {
  const fmt = format ?? defaultFormatFor(entries);
  const b = clamp(brightness, 0, 200) / 100;
  const c = clamp(contrast, 0, 200) / 100;
  const lut = allocLUT(entries, fmt);
  const maxIn = entries - 1;
  for (let i = 0; i < entries; i++) {
    const x = i / maxIn;
    const y = clamp01((x * b - 0.5) * c + 0.5);
    writeLUT(lut, i, y, entries, fmt);
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
      case 'brightness':
      case 'contrast': {
        const brightness = f.type === 'brightness' ? f.value : 100;
        const contrast = f.type === 'contrast' ? f.value : 100;
        const lut = generateBrightnessContrastLUT(brightness, contrast, entries, format);
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
