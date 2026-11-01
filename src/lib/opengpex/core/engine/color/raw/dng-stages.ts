/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * dng-stages.ts — the reference render pipeline's raw-stage math, rebuilt from
 * the file's own tags so the decode side never trusts the demosaic library's
 * internal scale chain.
 *
 * CALIBRATION CONTEXT (20261031, measured against the vendored reference
 * implementation's Stage1/2/3 dumps — probes/raw/oracle `-stages`):
 *
 *   1. The demosaic library's raw stage delivers the sensor samples BIT-EXACT
 *      (raw == reference Stage1 for CFA files).
 *   2. The reference Stage2 is pure tag math:
 *          stage2 = clip((LUT(raw) − black(r,c,p)) / (white − black)) × 65535
 *      where LUT is the file's LinearizationTable (phone linear-raw writers
 *      ship a real one — a decoder that skips it renders every level wrong),
 *      black is the repeating BlackLevel pattern, and white the per-plane
 *      WhiteLevel.
 *   3. The demosaic library's PROCESSED output cannot be renormalized into
 *      that scale: its 16-bit path bakes a fixed display curve (measured
 *      Rec.709 OETF shape, its gamma/quality parameters ignored) on top of
 *      internal black/gain handling that varies per file.
 *
 * So the calibrated chain takes the raw sensor samples and applies the tag
 * math itself: {@link linearizeStage2} for the level scale, then
 * {@link demosaicBilinearCfa} — a faithful port of the reference pipeline's
 * own bilinear CFA interpolator (per-pattern kernels, 8-bit fixed-point
 * weights, edge-replicated borders) — for the CFA stage, or
 * {@link invertDisplayCurve} to undo the demosaic library's baked curve on
 * already-linear (non-CFA) files.
 *
 * @module core/engine/color/dng-stages
 */

import type { DngLinearizationData } from '@opengpex/editor/core/files/handlers/raw/metadata/dng';

// ═══════════════════════════════════════════════════════════════════════════════
// Stage 2: linearize raw samples into the full-range [0, 65535] scale
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Apply the reference Stage2 formula to a raw-frame plane set and crop it to
 * the active area in the same pass.
 *
 * `raw` holds `planes` interleaved planes over the FULL raw frame
 * (`rawWidth × rawHeight`, row-major, plane-interleaved). The output holds the
 * ACTIVE AREA only (`activeWidth × activeHeight × planes`), uint16, where
 * 65535 corresponds to the file's white level — the exact container the
 * reference pipeline's Stage2 (and Stage3, for non-CFA files) uses. Samples
 * below the black level clip at 0, samples above the white level clip at
 * 65535 — the reference pipeline's forced-clip linearization.
 */
export function linearizeStage2(
  raw: Uint16Array,
  rawWidth: number,
  rawHeight: number,
  planes: number,
  lin: DngLinearizationData,
): { data: Uint16Array; width: number; height: number } {
  const [top, left, bottom, right] = lin.activeArea ?? [0, 0, rawHeight, rawWidth];
  const width = right - left;
  const height = bottom - top;
  const out = new Uint16Array(width * height * planes);

  const lut = lin.linearizationTable;
  const lutMax = lut ? lut.length - 1 : 0;
  const { rows: repRows, cols: repCols, values: black } = lin.blackLevel;
  const white = lin.whiteLevel;

  for (let y = 0; y < height; y++) {
    const srcRow = (y + top) * rawWidth;
    const br = (y + top) % repRows;
    for (let x = 0; x < width; x++) {
      const srcIdx = (srcRow + x + left) * planes;
      const bc = (x + left) % repCols;
      for (let p = 0; p < planes; p++) {
        let v = raw[srcIdx + p];
        if (lut) {
          v = lut[Math.min(lutMax, v)];
        }
        const b = black[(br * repCols + bc) * planes + p] ?? black[0] ?? 0;
        const w = white[p] ?? white[0] ?? 65535;
        const range = w - b;
        let o = range > 0 ? ((v - b) / range) * 65535 : 0;
        if (o < 0) o = 0; else if (o > 65535) o = 65535;
        out[(y * width + x) * planes + p] = o;
      }
    }
  }
  return { data: out, width, height };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CFA bilinear interpolation (port of the reference pipeline's interpolator)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * One per-pattern-position interpolation kernel: a list of (rowDelta, colDelta,
 * weight) taps. Weights are 8-bit fixed point (sum exactly 256) — the same
 * quantization the reference pipeline uses so results match it more closely
 * than float math would.
 */
interface BilinearKernel {
  /** Packed (rowDelta + 8) << 8 | (colDelta + 8) → weight/256. Deltas ∈ [-8, 8]. */
  taps: number[];
}

const MAX_KERNEL_TAPS = 8;

/**
 * Build the per-pattern-position kernels for a rectangular CFA layout from the
 * 2-D pattern of plane-color indices. This is the reference bilinear pattern
 * builder: each pattern position either samples itself (when it already holds
 * the plane's color) or walks a cascade of common-neighborhood shortcuts and
 * falls back to a double-bilinear search over the nearest same-color rows and
 * columns. Returns one kernel per pattern position (row-major).
 */
function buildBilinearKernels(
  pattern: Uint8Array,
  patRows: number,
  patCols: number,
  planeColor: number,
): BilinearKernel[] {
  const map = new Array<boolean>(patRows * patCols);
  for (let j = 0; j < patRows; j++) {
    for (let k = 0; k < patCols; k++) {
      map[j * patCols + k] = pattern[j * patCols + k] === planeColor;
    }
  }

  // Rows/columns that contain this plane's color at all.
  const mapV = new Array<boolean>(patRows).fill(false);
  const mapH = new Array<boolean>(patCols).fill(false);
  for (let j = 0; j < patRows; j++) {
    for (let k = 0; k < patCols; k++) {
      if (map[j * patCols + k]) {
        mapV[j] = true;
        mapH[k] = true;
      }
    }
  }

  const deltaRow = (row: number, d: number): number =>
    (((row + patRows) + d) % patRows + patRows) % patRows;
  const deltaCol = (col: number, d: number): number =>
    (((col + patCols) + d) % patCols + patCols) % patCols;

  const deltas: number[] = []; // packed (dr+8)<<8 | (dc+8)
  const weights: number[] = [];
  const add = (dr: number, dc: number, w: number): void => {
    if (w <= 0) return;
    const key = ((dr + 8) << 8) | (dc + 8);
    const existing = deltas.indexOf(key);
    if (existing >= 0) {
      weights[existing] += w;
    } else if (deltas.length < MAX_KERNEL_TAPS) {
      deltas.push(key);
      weights.push(w);
    }
  };
  const linearWeight1 = (d1: number, d2: number): number => (d1 === d2 ? 1 : d2 / (d2 - d1));
  const linearWeight2 = (d1: number, d2: number): number => (d1 === d2 ? 0 : -d1 / (d2 - d1));

  // One kernel per pattern position (rectangular layout: positions are pixels).
  const kernelFor = (patRow: number, patCol: number): BilinearKernel => {
    deltas.length = 0;
    weights.length = 0;

    if (map[patRow * patCols + patCol]) {
      add(0, 0, 1);
      return finalizeKernels(deltas, weights);
    }

    const n = deltaRow(patRow, -1);
    const s = deltaRow(patRow, 1);
    const w = deltaCol(patCol, -1);
    const e = deltaCol(patCol, 1);
    const mapNW = map[n * patCols + w];
    const mapN = map[n * patCols + patCol];
    const mapNE = map[n * patCols + e];
    const mapW = map[patRow * patCols + w];
    const mapE = map[patRow * patCols + e];
    const mapSW = map[s * patCols + w];
    const mapS = map[s * patCols + patCol];
    const mapSE = map[s * patCols + e];

    // Cascade of common-neighborhood shortcuts, then the general case.
    if (mapN && mapS && mapW && mapE) {
      add(-1, 0, 0.25); add(0, -1, 0.25); add(0, 1, 0.25); add(1, 0, 0.25);
    } else if (mapN && mapS) {
      add(-1, 0, 0.5); add(1, 0, 0.5);
    } else if (mapW && mapE) {
      add(0, -1, 0.5); add(0, 1, 0.5);
    } else if (mapN && mapSW && mapSE) {
      add(-1, 0, 0.5); add(1, -1, 0.25); add(1, 1, 0.25);
    } else if (mapS && mapNW && mapNE) {
      add(-1, -1, 0.25); add(-1, 1, 0.25); add(1, 0, 0.5);
    } else if (mapW && mapNE && mapSE) {
      add(-1, 1, 0.25); add(0, -1, 0.5); add(1, 1, 0.25);
    } else if (mapE && mapNW && mapSW) {
      add(-1, -1, 0.25); add(0, 1, 0.5); add(1, -1, 0.25);
    } else if (mapNW && mapNE && mapSE && mapSW) {
      add(-1, -1, 0.25); add(-1, 1, 0.25); add(1, -1, 0.25); add(1, 1, 0.25);
    } else if (mapNW && mapSE) {
      add(-1, -1, 0.5); add(1, 1, 0.5);
    } else if (mapNE && mapSW) {
      add(-1, 1, 0.5); add(1, -1, 0.5);
    } else {
      // Double-bilinear: walk to the nearest rows (then columns within them)
      // that carry this color, and vice versa; blend the two projections.
      let dv1 = 0;
      let dv2 = 0;
      while (!mapV[deltaRow(patRow, dv1)]) dv1--;
      while (!mapV[deltaRow(patRow, dv2)]) dv2++;
      let w1 = linearWeight1(dv1, dv2) * 0.5;
      let w2 = linearWeight2(dv1, dv2) * 0.5;
      const v1 = deltaRow(patRow, dv1);
      const v2 = deltaRow(patRow, dv2);

      let dh1 = 0;
      let dh2 = 0;
      while (!map[v1 * patCols + deltaCol(patCol, dh1)]) dh1--;
      while (!map[v1 * patCols + deltaCol(patCol, dh2)]) dh2++;
      add(dv1, dh1, linearWeight1(dh1, dh2) * w1);
      add(dv1, dh2, linearWeight2(dh1, dh2) * w1);

      dh1 = 0;
      dh2 = 0;
      while (!map[v2 * patCols + deltaCol(patCol, dh1)]) dh1--;
      while (!map[v2 * patCols + deltaCol(patCol, dh2)]) dh2++;
      add(dv2, dh1, linearWeight1(dh1, dh2) * w2);
      add(dv2, dh2, linearWeight2(dh1, dh2) * w2);

      dh1 = 0;
      dh2 = 0;
      while (!mapH[deltaCol(patCol, dh1)]) dh1--;
      while (!mapH[deltaCol(patCol, dh2)]) dh2++;
      w1 = linearWeight1(dh1, dh2) * 0.5;
      w2 = linearWeight2(dh1, dh2) * 0.5;
      const h1 = deltaCol(patCol, dh1);
      const h2 = deltaCol(patCol, dh2);

      dv1 = 0;
      dv2 = 0;
      while (!map[deltaRow(patRow, dv1) * patCols + h1]) dv1--;
      while (!map[deltaRow(patRow, dv2) * patCols + h1]) dv2++;
      add(dv1, dh1, linearWeight1(dv1, dv2) * w1);
      add(dv2, dh1, linearWeight2(dv1, dv2) * w1);

      dv1 = 0;
      dv2 = 0;
      while (!map[deltaRow(patRow, dv1) * patCols + h2]) dv1--;
      while (!map[deltaRow(patRow, dv2) * patCols + h2]) dv2++;
      add(dv1, dh2, linearWeight1(dv1, dv2) * w2);
      add(dv2, dh2, linearWeight2(dv1, dv2) * w2);
    }
    return finalizeKernels(deltas, weights);
  };

  const kernels: BilinearKernel[] = new Array(patRows * patCols);
  for (let j = 0; j < patRows; j++) {
    for (let k = 0; k < patCols; k++) {
      kernels[j * patCols + k] = kernelFor(j, k);
    }
  }
  return kernels;
}

/** Quantize weights to 8 fractional bits (largest tap absorbs the rounding). */
function finalizeKernels(deltas: number[], weights: number[]): BilinearKernel {
  const taps: number[] = [];
  const n = deltas.length;
  if (n === 0) return { taps: [((0 + 8) << 8) | (0 + 8), 256] };
  const w16 = weights.map((v) => Math.round(v * 256));
  let total = 0;
  let biggest = 0;
  for (let j = 0; j < n; j++) {
    total += w16[j];
    if (w16[j] > w16[biggest]) biggest = j;
  }
  w16[biggest] += 256 - total;
  for (let j = 0; j < n; j++) {
    taps.push(deltas[j], w16[j]);
  }
  return { taps };
}

/** Resolved kernel set + pattern geometry for one CFA file. */
interface BilinearPlan {
  kernels: BilinearKernel[];
  patRows: number;
  patCols: number;
}

/**
 * Demosaic a single-plane CFA Stage2 buffer into interleaved RGB f32
 * (`[0, 65535]` scale, edge-replicated borders), using the same per-pattern
 * bilinear kernels the reference pipeline builds. `pattern` is the 2-D CFA
 * color-index pattern (0=R, 1=G, 2=B for a standard Bayer file); only the
 * rectangular layout (`CFALayout = 1`) is supported.
 */
export function demosaicBilinearCfa(
  stage2: Uint16Array,
  width: number,
  height: number,
  pattern: Uint8Array,
  patRows: number,
  patCols: number,
): { rgb: Float32Array; width: number; height: number } {
  const colorPlanes = 3;
  // The plane colors present in the pattern define how many output planes;
  // a standard Bayer pattern carries exactly 3 distinct colors.
  const distinct = new Set<number>(pattern);
  if (distinct.size !== colorPlanes) {
    throw new Error(`dng-stages: unsupported CFA pattern with ${distinct.size} colors`);
  }
  const planeColors = [...distinct].sort((a, b) => a - b) as number[];

  // Per OUTPUT plane, the kernels of every pattern position.
  const plans: BilinearPlan[] = planeColors.map((color) => ({
    kernels: buildBilinearKernels(pattern, patRows, patCols, color),
    patRows,
    patCols,
  }));

  const rgb = new Float32Array(width * height * 3);
  const clampi = (v: number, max: number): number => (v < 0 ? 0 : v > max ? max : v);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pat = (y % patRows) * patCols + (x % patCols);
      const srcIdx = y * width + x;
      for (let p = 0; p < 3; p++) {
        const kernel = plans[p].kernels[pat];
        let acc = 0;
        for (let t = 0; t < kernel.taps.length; t += 2) {
          const packed = kernel.taps[t];
          const dr = (packed >> 8) - 8;
          const dc = (packed & 0xff) - 8;
          const w = kernel.taps[t + 1] / 256;
          const sy = clampi(y + dr, height - 1);
          const sx = clampi(x + dc, width - 1);
          acc += stage2[sy * width + sx] * w;
        }
        rgb[srcIdx * 3 + planeColors[p]] = acc;
      }
    }
  }
  return { rgb, width, height };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Display-curve inversion (the demosaic library's baked 16-bit output curve)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Invert the demosaic library's baked output curve on an already-linear
 * (non-CFA) DNG: the library's 16-bit path runs every sample through a fixed
 * Rec.709-shaped OETF before delivery (its own gamma parameter is ignored),
 * so `linear = oetfInverse(processed / 65535)` recovers the linear values the
 * file's LUT + white level produced. `v` is in [0, 1]; the output is the
 * linear [0, 1] value the stage had before encoding.
 */
export function invertDisplayCurve(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  // Rec.709 OETF: linear < 0.018 → linear = encoded / 4.5; else the power arm.
  if (v < 4.5 * 0.018) {
    return v / 4.5;
  }
  return Math.pow((v + 0.099) / 1.099, 1 / 0.45);
}
