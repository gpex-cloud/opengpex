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
 * histograms.ts — 256-bin tone histogram operators (pure, DOM-free).
 *
 * Same domain layer as `luts.ts`. Two concerns:
 *
 * 1. COUNTING — `countLayerHistograms` walks raw RGBA-8 pixels once and
 *    produces the five histograms the AdjustmentDrawer displays:
 *      r / g / b   per-channel counts
 *      luma        per-pixel Rec.601 luma (integer 77/150/29 ÷ 256 weights)
 *      composite   per-bin r+g+b sum (Photoshop Levels "RGB" composite)
 *    `packLayerHistogramBuffer` / `unpackLayerHistogramBuffer` define the
 *    single-ArrayBuffer wire format shared by the Worker handler (pack +
 *    transfer) and the main-thread facade (unpack into five views):
 *    five contiguous 256 × 4 B segments, 5120 B total.
 *
 * 2. DERIVATION — `deriveChannelHistogram` / `deriveLayerHistogram` scatter a
 *    SOURCE histogram through the levels→curves LUT chain to obtain the
 *    OUTPUT histogram without touching a single pixel (microsecond-scale, so
 *    the panels re-derive on every slider frame with zero Worker traffic).
 *    The chain consumes the SAME f32 tables the GPU samples
 *    (`generateLevelsLUT` + `buildCurvesChannelTablesF32`), keeping the
 *    histogram display and the canvas on one evaluator.
 *
 * @module core/engine/color/histograms
 */

import type { CurvesState, LevelsState } from '@opengpex/editor/core/types/models';
import { buildCurvesChannelTablesF32, generateLevelsLUT } from './luts';

// ─── Wire format ───────────────────────────────────────────────────────────────

/** Bin count per histogram. PS displays 16-bit files at 256 bins too. */
export const HISTOGRAM_BINS = 256;

const SEGMENT_BYTES = HISTOGRAM_BINS * 4; // one Uint32 segment = 1024 B

/**
 * Byte offset of each segment inside the transferred ArrayBuffer
 * (r | g | b | luma | composite contiguous, 5 × 1024 B = 5120 B total).
 */
const SEGMENT_BYTE_OFFSETS = {
  r: 0,
  g: SEGMENT_BYTES,
  b: SEGMENT_BYTES * 2,
  luma: SEGMENT_BYTES * 3,
  composite: SEGMENT_BYTES * 4,
} as const;

/** The five histograms for one layer, 256 bins each. */
export interface LayerHistogramData {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  /** Per-pixel Rec.601 luma counts. */
  luma: Uint32Array;
  /** Per-bin r+g+b sum (Photoshop Levels "RGB" composite). */
  composite: Uint32Array;
}

// ─── Counting (Worker side) ────────────────────────────────────────────────────

/**
 * Count the five histograms from raw RGBA-8 pixel data in a single pass.
 *
 * Fully-transparent pixels (a === 0) are skipped so alpha-padded borders
 * don't inflate the black bin. Luma uses the integer Rec.601 approximation
 * `(77·r + 150·g + 29·b) >> 8` — the weights sum to exactly 256, so the
 * output never exceeds bin 255, and the deviation from float Rec.601 stays
 * within ±1 bin.
 *
 * `composite` is the per-bin sum of the three channels (NOT a per-pixel
 * operation), matching Photoshop's Levels dialog "RGB" channel histogram.
 */
export function countLayerHistograms(data: Uint8ClampedArray): LayerHistogramData {
  const r = new Uint32Array(HISTOGRAM_BINS);
  const g = new Uint32Array(HISTOGRAM_BINS);
  const b = new Uint32Array(HISTOGRAM_BINS);
  const luma = new Uint32Array(HISTOGRAM_BINS);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const rv = data[i];
    const gv = data[i + 1];
    const bv = data[i + 2];
    r[rv]++;
    g[gv]++;
    b[bv]++;
    luma[(77 * rv + 150 * gv + 29 * bv) >> 8]++;
  }
  const composite = new Uint32Array(HISTOGRAM_BINS);
  for (let i = 0; i < HISTOGRAM_BINS; i++) {
    composite[i] = r[i] + g[i] + b[i];
  }
  return { r, g, b, luma, composite };
}

/** Pack the five histograms into one contiguous ArrayBuffer for transfer. */
export function packLayerHistogramBuffer(h: LayerHistogramData): ArrayBuffer {
  const buf = new ArrayBuffer(SEGMENT_BYTE_OFFSETS.composite + SEGMENT_BYTES);
  const out = new Uint32Array(buf);
  out.set(h.r, 0);
  out.set(h.g, HISTOGRAM_BINS);
  out.set(h.b, HISTOGRAM_BINS * 2);
  out.set(h.luma, HISTOGRAM_BINS * 3);
  out.set(h.composite, HISTOGRAM_BINS * 4);
  return buf;
}

/**
 * Rebuild the five segment views on the main thread after the transfer.
 * The views alias `buf` (zero-copy) — the buffer is owned by the returned
 * object and must not be detached afterwards.
 */
export function unpackLayerHistogramBuffer(buf: ArrayBuffer): LayerHistogramData {
  return {
    r: new Uint32Array(buf, SEGMENT_BYTE_OFFSETS.r, HISTOGRAM_BINS),
    g: new Uint32Array(buf, SEGMENT_BYTE_OFFSETS.g, HISTOGRAM_BINS),
    b: new Uint32Array(buf, SEGMENT_BYTE_OFFSETS.b, HISTOGRAM_BINS),
    luma: new Uint32Array(buf, SEGMENT_BYTE_OFFSETS.luma, HISTOGRAM_BINS),
    composite: new Uint32Array(buf, SEGMENT_BYTE_OFFSETS.composite, HISTOGRAM_BINS),
  };
}

// ─── Derivation (main thread, per slider frame) ────────────────────────────────

/**
 * Scatter one channel's source histogram through a normalized f32 LUT.
 *
 * `lut[v] ∈ [0,1]` maps source bin v to an output bin; the source count is
 * scattered (not interpolated), mirroring how the GPU quantizes each pixel's
 * sampled LUT result back to 8-bit output. Invariants:
 *   • identity LUT (`lut[v] = v/255`) ⇒ out ≡ src (bit-exact);
 *   • Σout ≡ Σsrc always (scattering never drops counts).
 */
export function deriveChannelHistogram(src: Uint32Array, lut: Float32Array): Uint32Array {
  const out = new Uint32Array(HISTOGRAM_BINS);
  for (let v = 0; v < HISTOGRAM_BINS; v++) {
    const count = src[v];
    if (count === 0) continue;
    out[Math.round(lut[v] * (HISTOGRAM_BINS - 1))] += count;
  }
  return out;
}

/**
 * Derive the OUTPUT r/g/b/composite histograms for the levels→curves chain,
 * applied in the same order as the GPU (`apply_adjustments` in adjust.ts:
 * levels LUT first, then the per-channel curves table).
 *
 * Luma is deliberately absent from the result: per-pixel luma cannot be
 * recovered from per-channel marginals (it needs the joint RGB distribution).
 * Callers wanting a luma display must use the source `luma` segment as-is.
 */
export function deriveLayerHistogram(
  src: LayerHistogramData,
  levels: LevelsState | undefined,
  curves: CurvesState | undefined,
): { r: Uint32Array; g: Uint32Array; b: Uint32Array; composite: Uint32Array } {
  const levelsLut = generateLevelsLUT(levels, HISTOGRAM_BINS, 'f32') as Float32Array;
  const [curvesR, curvesG, curvesB] = buildCurvesChannelTablesF32(curves, HISTOGRAM_BINS);

  // Combined per-bin mapping: levels first, curves second — index composition
  // mirrors the GPU's two texture samples (and lutPlan's baking).
  const combined = (curvesTable: Float32Array): Float32Array => {
    const out = new Float32Array(HISTOGRAM_BINS);
    for (let v = 0; v < HISTOGRAM_BINS; v++) {
      out[v] = curvesTable[Math.round(levelsLut[v] * (HISTOGRAM_BINS - 1))];
    }
    return out;
  };

  const r = deriveChannelHistogram(src.r, combined(curvesR));
  const g = deriveChannelHistogram(src.g, combined(curvesG));
  const b = deriveChannelHistogram(src.b, combined(curvesB));
  const composite = new Uint32Array(HISTOGRAM_BINS);
  for (let i = 0; i < HISTOGRAM_BINS; i++) {
    composite[i] = r[i] + g[i] + b[i];
  }
  return { r, g, b, composite };
}
