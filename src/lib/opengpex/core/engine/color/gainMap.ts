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
 * gainMap.ts — the gain-map HDR rebuild math (ultrawide phase C1, presentation
 * slice).
 *
 * A gain-map file (Apple `hdrgainmap` in HEIC / ISO 21496-1) ships TWO
 * renditions: an SDR base image plus a low-resolution log2 gain map. The HDR
 * rendition is RECONSTRUCTED, never stored:
 *
 *   hdr_linear = sdr_linear × 2^gain
 *   gain       = gainMin + (byte/255)^(1/γ) × (gainMax − gainMin)
 *
 * The map stores the base-2 logarithm of the HDR/SDR ratio, quantized affinely
 * onto [0, 255] between `gainMin` and `gainMax`; γ (≈1.15 on Apple captures)
 * shapes the quantization curve and is 1 for log2-linear payloads. `gainMin`
 * may be NEGATIVE (legal per ISO 21496-1): those samples darken in HDR — Apple
 * writes e.g. [-0.7749 .. 1.9743], where the negative tail keeps saturated
 * highlights from blowing out.
 *
 * ARCHITECTURE (C1): the master image is the SDR base lifted to linear f16 —
 * the gain is NEVER baked into it. The engine renders both HDR-ON and HDR-OFF
 * from that one resident line; a baked master would make OFF the CLAMPED HDR
 * rendition instead of the file's authoritative SDR base (a 2× sky clamps its
 * blue channel at white and hue-skews — real-device falsification). The
 * application therefore lives at the view pass, computed per pixel in WGSL from
 * the sampled map byte. THIS module holds the CPU statement of that math —
 * `decodeGainSample` is the single authority for the affine decode, golden-tested
 * bit-exactly, and the WGSL fragment mirrors it operation-for-operation
 * (`pow(s, 1/γ)` → affine → `exp2`). Presentation eligibility, texture caching
 * and the shader wiring live in the engine's gain-map source cache / view pass.
 *
 * Export-side pair quantization: `applyGainToF32` builds the HDR rendition
 * from the SDR readback + a decoded map, and `quantizeGainMapPair` runs the
 * inverse direction — from an (SDR, HDR) linear pair to a quantized map whose
 * ratio is measured against the REAL base (log2(hdr/sdr) per cell, never a
 * derived stand-in: a highlight-shouldered base is identity below white, which
 * zeroes every ratio and ships a dead map).
 *
 * @module core/engine/color/gainMap
 */

import type { GainMapSource } from '../sources/GainMapSource';

/** Straight linear values at or below this are black for ratio purposes: the
 * log2 ratio diverges at 0 and both renditions are (near-)identical there, so
 * those pixels carry no gain information and are excluded from a cell's mean. */
const BLACK_EPSILON = 1e-6;

/** The subsystem-wide cap for a gain map's longest edge — the HEIC carrier's
 * decode-time re-encode and the export-time quantization share ONE resolution
 * contract. */
export const QUANTIZE_MAX_DIM = 1024;

/**
 * Cap a gain map to `maxDim` on its longest edge (box average). The map's
 * ONLY consumers sample it as a smooth low-frequency scalar field — the view
 * pass through a bilinearly-filtered r8unorm texture, the export lane through
 * the same CPU sampler — so resolution beyond the cap is visually void while
 * memory is not: an uncapped Apple capture is a ~12 MB plane. Box averaging
 * (area-weighted mean per output cell) integrates instead of point-sampling,
 * so no aliasing on the gradient field. Parameters ride along unchanged —
 * the affine span is resolution-independent. Maps already within the cap
 * return as-is.
 */
export function downscaleGainMap(
  data: GainMapSource,
  maxDim: number = QUANTIZE_MAX_DIM,
): GainMapSource {
  const longest = Math.max(data.width, data.height);
  if (longest <= maxDim) return data;
  const scale = maxDim / longest;
  const outW = Math.max(1, Math.round(data.width * scale));
  const outH = Math.max(1, Math.round(data.height * scale));
  const map = new Uint8Array(outW * outH);
  for (let oy = 0; oy < outH; oy++) {
    const y0 = Math.floor((oy * data.height) / outH);
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * data.height) / outH));
    for (let ox = 0; ox < outW; ox++) {
      const x0 = Math.floor((ox * data.width) / outW);
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * data.width) / outW));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * data.width;
        for (let x = x0; x < x1; x++) {
          sum += data.map[row + x];
          count++;
        }
      }
      map[oy * outW + ox] = Math.round(sum / count);
    }
  }
  return {
    map,
    width: outW,
    height: outH,
    gainMin: data.gainMin,
    gainMax: data.gainMax,
    gamma: data.gamma,
  };
}

/**
 * Sample the quantized map at a unit-space position with bilinear
 * interpolation — the CPU twin of the view shader's filtered r8unorm sample
 * (interpolation happens in normalized-byte space, BEFORE the gamma decode,
 * exactly like hardware texture filtering).
 */
function sampleMapBilinear(
  map: GainMapSource,
  u: number,
  v: number,
): number {
  const fx = Math.min(Math.max(u * map.width - 0.5, 0), map.width - 1);
  const fy = Math.min(Math.max(v * map.height - 0.5, 0), map.height - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, map.width - 1);
  const y1 = Math.min(y0 + 1, map.height - 1);
  const ax = fx - x0;
  const ay = fy - y0;
  const row0 = y0 * map.width;
  const row1 = y1 * map.width;
  const top = map.map[row0 + x0] * (1 - ax) + map.map[row0 + x1] * ax;
  const bottom = map.map[row1 + x0] * (1 - ax) + map.map[row1 + x1] * ax;
  return top * (1 - ay) + bottom * ay;
}

/**
 * Reconstruct the HDR rendition from the SDR base in linear light:
 * `hdr = sdr × 2^gain`, the gain sampled bilinearly from the decoded map and
 * decoded affinely exactly as the view shader does (`decodeGainSample`). The
 * input is STRAIGHT (un-premultiplied) linear RGBA; alpha passes through
 * untouched (a gain map recolours, never re-covers).
 */
export function applyGainToF32(
  sdrLinear: Float32Array,
  width: number,
  height: number,
  map: GainMapSource,
): Float32Array {
  const out = new Float32Array(sdrLinear.length);
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const byte = sampleMapBilinear(map, u, v);
      const factor = gainSampleToFactor(byte, map.gainMin, map.gainMax, map.gamma);
      const i = (y * width + x) * 4;
      out[i] = sdrLinear[i] * factor;
      out[i + 1] = sdrLinear[i + 1] * factor;
      out[i + 2] = sdrLinear[i + 2] * factor;
      out[i + 3] = sdrLinear[i + 3];
    }
  }
  return out;
}

/**
 * Quantize an (SDR base, HDR rendition) linear pair into a gain map — the
 * export-side inverse of {@link applyGainToF32}. Per output cell (box-downsampled
 * to at most `maxDim` on the longest edge) the cell ratio is the mean of
 * log2(hdr/sdr) over non-black pixels — the K4 pair semantics: the ratio is
 * measured against the REAL base, never a derived stand-in.
 *
 * The payload is log2-linear (gamma 1). `gainMin`/`gainMax` are the observed
 * ratio extremes (negative tails legal); a flat map (every cell the same
 * ratio r) is expressed as min=max=r — every byte decodes to r, so the map
 * stays valid. Returns null when NO cell carries ratio information (an
 * all-black pair) — the caller then ships an honest plain image instead of a
 * dead gain map.
 */
export function quantizeGainMapPair(
  sdrLinear: Float32Array,
  hdrLinear: Float32Array,
  width: number,
  height: number,
  maxDim: number = QUANTIZE_MAX_DIM,
): GainMapSource | null {
  if (width <= 0 || height <= 0) return null;
  const scale = Math.min(1, maxDim / Math.max(width, height));
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));

  // Box accumulate: per-cell sum of log2 ratios over non-black pixels.
  const sum = new Float64Array(outW * outH);
  const count = new Uint32Array(outW * outH);
  for (let y = 0; y < height; y++) {
    const cy = Math.min(outH - 1, Math.floor((y * outH) / height));
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // Single-channel map: the luminance-axis ratio of the GREEN plane is the
      // convention every writer agrees on (the channels share one factor).
      const sdr = sdrLinear[i + 1];
      if (sdr <= BLACK_EPSILON) continue;
      const cell = cy * outW + Math.min(outW - 1, Math.floor((x * outW) / width));
      sum[cell] += Math.log2(hdrLinear[i + 1] / sdr);
      count[cell]++;
    }
  }

  let gainMin = Infinity;
  let gainMax = -Infinity;
  for (let c = 0; c < sum.length; c++) {
    if (count[c] === 0) continue;
    const r = sum[c] / count[c];
    if (r < gainMin) gainMin = r;
    if (r > gainMax) gainMax = r;
  }
  if (gainMin === Infinity) return null; // no cell carried information

  const range = gainMax - gainMin;
  const map = new Uint8Array(outW * outH);
  if (range > 0) {
    for (let c = 0; c < sum.length; c++) {
      if (count[c] === 0) continue;
      const t = (sum[c] / count[c] - gainMin) / range;
      map[c] = Math.round(255 * Math.min(1, Math.max(0, t)));
    }
  }
  // Flat map (range == 0): every byte decodes to gainMin — leave zeros.

  return { map, width: outW, height: outH, gainMin, gainMax, gamma: 1 };
}

/**
 * Decode one quantized gain-map byte to its log2 HDR/SDR ratio — the whole
 * affine space in one place. Exported for the golden tests and for any
 * CPU-side consumer; the view-pass WGSL mirrors this exact operation order.
 *
 * @param byte quantized map sample, 0..255
 * @param gainMin map value at byte 0 (log2 ratio; may be negative)
 * @param gainMax map value at byte 255 (log2 ratio)
 * @param gamma payload gamma (1 = log2-linear; the convention Apple writes)
 */
export function decodeGainSample(
  byte: number,
  gainMin: number,
  gainMax: number,
  gamma: number,
): number {
  const s = byte / 255;
  const linear = gamma === 1 ? s : Math.pow(s, 1 / gamma);
  return gainMin + linear * (gainMax - gainMin);
}

/**
 * The HDR/SDR multiplier for one map byte: `2^decodeGainSample(...)`. Kept as a
 * named helper (not inlined by callers) so the "log2 ratio" semantics have one
 * exponentiation site; golden tests pin it against the Apple truth parameters
 * (headroom 2^1.974342 ≈ 3.93× — the value Finder reports for the same file).
 */
export function gainSampleToFactor(
  byte: number,
  gainMin: number,
  gainMax: number,
  gamma: number,
): number {
  return Math.pow(2, decodeGainSample(byte, gainMin, gainMax, gamma));
}
