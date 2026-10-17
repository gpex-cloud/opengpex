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
 * gainTableMap.ts — pure application math for the DNG `ProfileGainTableMap`.
 *
 * The map is a spatially subsampled bank of tone tables (probe 2026-10-16 on
 * Apple ProRAW: monotone compressors — darks lifted up to ~2.4×, highlights
 * crushed toward ~0.07× — zero chroma content, i.e. a TONE engine, not a
 * saturation table). Applying it per spec tames a file's highlight shoulder
 * with the capture's OWN shaping data instead of a generic curve, which is why
 * the consumer here is the RAW decode (baked pre-anchor), not the render chain.
 *
 * SPEC ORDER (DNG 1.6 §ProfileGainTableMap): per pixel — bilinearly interpolate
 * the four surrounding grid tables at the pixel's relative position
 * (pixel-centred / half-pixel convention, edge-replicated outside the map
 * bounds), fold the linear RGB into `clamp((R,G,B,min,max) · weights, 0, 1)`,
 * linearly interpolate the table at `input × pointsN`, multiply the scalar gain
 * into the pixel. Spec domain is RIMM (linear ProPhoto) after BaselineExposure;
 * this module applies the gain on whatever linear-light buffer the caller hands
 * over — the decode's source-gamut line — a domain swap that only shifts which
 * table entry a pixel reads (the gain itself is a scalar multiply, domain-free).
 *
 * SPATIAL DIMENSION IS DELIBERATELY UNUSED: the gain is sampled at the GRID
 * CENTRE only, so it varies with the pixel's input value but not with its
 * position. Both-field evidence (20261017, two ProRAW files, 8×8 block-mean
 * MAE against the macOS reference render): the map's own spatial field, under
 * EVERY geometric convention (8 EXIF orientations × both table layouts,
 * including the spec-consistent ActiveArea mapping) moves every candidate
 * FARTHER from the reference than a spatially constant application — the
 * grid centre is the best single sampler on both files. Apple's true spatial
 * variation is semantic-mask driven (subject/sky selective tone mapping) and
 * is not recoverable from the grid geometry; baking a misaligned field is
 * worse than baking none. The grid data is kept in the parser for the
 * semantic-mask work and for the render-side Amount control.
 *
 * @module core/files/handlers/raw/gainTableMap
 */

import type { DngGainTableMap } from './metadata/dng';

/**
 * Fold a linear RGB triple into the map's scalar table input:
 * `clamp((R, G, B, min(R,G,B), max(R,G,B)) · weights, 0, 1)`.
 */
export function gainTableMapInput(
  r: number,
  g: number,
  b: number,
  weights: DngGainTableMap['weights'],
): number {
  const mn = Math.min(r, g, b);
  const mx = Math.max(r, g, b);
  const v =
    weights[0] * r + weights[1] * g + weights[2] * b + weights[3] * mn + weights[4] * mx;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Interpolated gain at a grid position. `fx`/`fy` are table-space coordinates
 * (pixel relative position minus origin, divided by spacing); outside the grid
 * the edge tables replicate (spec: "outside the gain map bounds, values are
 * replicated from the edges").
 */
export function gainTableMapGainAt(
  map: DngGainTableMap,
  fx: number,
  fy: number,
  input: number,
): number {
  const h0 = Math.max(0, Math.min(map.pointsH - 1, Math.floor(fx)));
  const v0 = Math.max(0, Math.min(map.pointsV - 1, Math.floor(fy)));
  const h1 = Math.min(map.pointsH - 1, h0 + 1);
  const v1 = Math.min(map.pointsV - 1, v0 + 1);
  const th = fx < 0 ? 0 : fx > map.pointsH - 1 ? 1 : fx - Math.floor(fx);
  const tv = fy < 0 ? 0 : fy > map.pointsV - 1 ? 1 : fy - Math.floor(fy);
  const idx = Math.max(0, Math.min(map.pointsN - 1, input * map.pointsN));
  const i0 = Math.min(map.pointsN - 1, Math.floor(idx));
  const i1 = Math.min(map.pointsN - 1, i0 + 1);
  const tt = idx - i0;
  const lut = (t: Float32Array) => t[i0] + (t[i1] - t[i0]) * tt;
  const g00 = lut(map.tables[v0 * map.pointsH + h0]);
  const g10 = lut(map.tables[v0 * map.pointsH + h1]);
  const g01 = lut(map.tables[v1 * map.pointsH + h0]);
  const g11 = lut(map.tables[v1 * map.pointsH + h1]);
  return (g00 * (1 - th) + g10 * th) * (1 - tv) + (g01 * (1 - th) + g11 * th) * tv;
}

/**
 * Table-space coordinates of the grid centre — the single sampler position
 * for the spatially constant application (see the module-header rationale:
 * every position-aware convention misaligns the field against the reference
 * render, so the gain varies only through the input value).
 */
export function gainTableMapCentreCoords(map: DngGainTableMap): { fx: number; fy: number } {
  return { fx: (map.pointsH - 1) / 2, fy: (map.pointsV - 1) / 2 };
}

/**
 * Apply the map in place to an RGBA Uint16 LINEAR-light buffer (0..65535),
 * spatially constant (grid-centre sample — see the module header).
 *
 * `baselineExposure` (stops, from `parseDngBaselineExposure`) shifts the TABLE
 * INPUT, not the pixels: the spec applies the map AFTER BaselineExposure, so
 * the input weights assume BE'd values — skipping it reads the table's steep
 * low-input region and bakes luminance plates into bright content (20261016
 * device finding: the sunny ProRAW's clouds turned into hard-edged patches).
 */
export function applyGainTableMapRgba16(
  rgba: Uint16Array,
  width: number,
  height: number,
  map: DngGainTableMap,
  baselineExposure = 0,
): void {
  const INV = 1 / 65535;
  const beGain = Math.pow(2, baselineExposure);
  const { fx, fy } = gainTableMapCentreCoords(map);
  const px = width * height;
  for (let p = 0; p < px; p++) {
    const j = p * 4;
    const r = rgba[j] * INV;
    const g = rgba[j + 1] * INV;
    const b = rgba[j + 2] * INV;
    const input = gainTableMapInput(
      Math.min(1, r * beGain),
      Math.min(1, g * beGain),
      Math.min(1, b * beGain),
      map.weights,
    );
    const gain = gainTableMapGainAt(map, fx, fy, input);
    // The 16-bit uint container is a hard [0, 1] ceiling (unlike the spec's
    // f32 RIMM staging, where readers "are encouraged to preserve the
    // overrange values"): clamp rather than wrap — a Uint16 assignment of a
    // value > 65535 would wrap modulo and corrupt the pixel. Specular pixels
    // lose their overrange headroom here; the downstream knee re-places them.
    rgba[j] = Math.min(65535, r * gain * 65535);
    rgba[j + 1] = Math.min(65535, g * gain * 65535);
    rgba[j + 2] = Math.min(65535, b * gain * 65535);
  }
}

/**
 * Apply the map in place to a FLOAT RGBA LINEAR-light buffer (values normally
 * in [0, 1] but NOT clamped — the spec stages the map in f32 RIMM and
 * "encourages readers to preserve the overrange values", which is exactly why
 * this float path replaced the uint16 bake: clamping bright content
 * asymmetrically squashed chroma, measured at sky encoded b−r 60 → 28). Input
 * semantics identical to {@link applyGainTableMapRgba16} (BE-shifted table
 * lookup, gain × value), spatially constant (grid-centre sample).
 */
export function applyGainTableMapF32(
  rgba: Float32Array,
  width: number,
  height: number,
  map: DngGainTableMap,
  baselineExposure = 0,
): void {
  const beGain = Math.pow(2, baselineExposure);
  const { fx, fy } = gainTableMapCentreCoords(map);
  const px = width * height;
  for (let p = 0; p < px; p++) {
    const j = p * 4;
    const r = rgba[j], g = rgba[j + 1], b = rgba[j + 2];
    const input = gainTableMapInput(
      Math.min(1, r * beGain),
      Math.min(1, g * beGain),
      Math.min(1, b * beGain),
      map.weights,
    );
    const gain = gainTableMapGainAt(map, fx, fy, input);
    rgba[j] = r * gain;
    rgba[j + 1] = g * gain;
    rgba[j + 2] = b * gain;
  }
}
