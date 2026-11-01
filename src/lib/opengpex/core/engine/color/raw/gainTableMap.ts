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
 * gainTableMap.ts — application math for the DNG `ProfileGainTableMap`.
 *
 * The map is a spatially subsampled bank of per-cell tone tables baked into
 * the file by the capture device's local tone mapping. Per the DNG 1.6
 * specification it is applied AFTER the BaselineExposure adjustment, in a
 * linear rendering domain (RIMM — here, the pipeline's ProPhoto-linear
 * working line), as a per-pixel scalar gain.
 *
 * Two application modes exist:
 *
 *  - {@link applyGainTableMapSpatialF32} — the specification application.
 *    The grid is positioned over the image by origin/spacing (relative
 *    coordinates); each pixel bilinearly blends the four surrounding grid
 *    tables by its POSITION and indexes the blended table by its folded
 *    input value. This is the mode the DNG color pipeline uses.
 *
 *  - {@link applyGainTableMapF32} — the legacy grid-centre sampler, kept as
 *    a fallback switch: one fixed table sampled at the grid centre, so the
 *    gain varies only with the input value. The earlier decode pipeline used
 *    this because its target function (matching a specific vendor render)
 *    was better served without a possibly misaligned spatial field; under the
 *    first-principles pipeline the specification application is authoritative.
 *
 * The gain is a scalar multiply — domain-free — but the TABLE INPUT must read
 * the value the capture device's own rendering staged (the BE-adjusted linear
 * value), which is why every application shifts the input by 2^BE.
 *
 * @module core/engine/color/gainTableMap
 */

/**
 * A parsed DNG `ProfileGainTableMap`: a `pointsV × pointsH` grid of
 * `pointsN`-entry FLOAT gain tables, positioned over the image in relative
 * coordinates, plus the five `MapInputWeights` that fold a pixel's RGB into a
 * scalar table input.
 */
export interface DngGainTableMap {
  pointsV: number;
  pointsH: number;
  pointsN: number;
  /** Vertical/horizontal grid spacing, relative to image height/width. */
  spacingV: number;
  spacingH: number;
  /** Grid origin, relative to image height/width (may be negative). */
  originV: number;
  originH: number;
  /** The five `MapInputWeights` floats: `[R, G, B, min(R,G,B), max(R,G,B)]`. */
  weights: readonly [number, number, number, number, number];
  /** `tables[v * pointsH + h][n]` — one gain table per grid point. */
  tables: readonly Float32Array[];
}

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
 * for the fallback spatially-constant application.
 */
export function gainTableMapCentreCoords(map: DngGainTableMap): { fx: number; fy: number } {
  return { fx: (map.pointsH - 1) / 2, fy: (map.pointsV - 1) / 2 };
}

/**
 * Apply the map in place to a FLOAT RGBA LINEAR-light buffer (values normally
 * in [0, 1] but NOT clamped — the spec stages the map in f32 and encourages
 * readers to preserve overrange values), spatially CONSTANT at the grid
 * centre: the gain varies only through the input value. Fallback mode.
 *
 * `baselineExposure` (stops) shifts the TABLE INPUT, not the pixels: the spec
 * applies the map AFTER BaselineExposure, so the input weights assume BE'd
 * values — skipping it reads the table's steep low-input region and bakes
 * luminance plates into bright content.
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

/**
 * Apply the map in place to a FLOAT RGBA LINEAR-light buffer with the FULL
 * specification application: per-pixel POSITION selects and bilinearly blends
 * the four surrounding grid tables (pixel-centred relative coordinates against
 * the origin/spacing geometry, edge replication outside the grid), and the
 * folded BE-shifted input indexes the blended table. The gain is a scalar
 * multiply and never clamps — overrange values survive.
 *
 * Exact and slow (the per-pixel four-table blend dominates); prefer
 * {@link bakeGainTableMapSpatial} + {@link applyBakedGainTableMap} for real
 * images — see the bake notes for the accuracy trade it makes.
 */
export function applyGainTableMapSpatialF32(
  rgba: Float32Array,
  width: number,
  height: number,
  map: DngGainTableMap,
  baselineExposure = 0,
): void {
  const beGain = Math.pow(2, baselineExposure);
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
    // Pixel-centred relative coordinates → table-space grid coordinates.
    const row = Math.floor(p / width);
    const col = p - row * width;
    const relV = (row + 0.5) / height;
    const relH = (col + 0.5) / width;
    const fx = (relH - map.originH) / map.spacingH;
    const fy = (relV - map.originV) / map.spacingV;
    const gain = gainTableMapGainAt(map, fx, fy, input);
    rgba[j] = r * gain;
    rgba[j + 1] = g * gain;
    rgba[j + 2] = b * gain;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Baked spatial application (the production path)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A per-grid-CELL blended gain table set — the bake product that makes the
 * spatial application affordable.
 *
 * WHY CELL-BAKED: the exact application blends four tables per pixel with
 * weights that vary linearly across each grid cell. Because the table
 * interpolation is itself linear in the table entries, the whole lookup is a
 * trilinear blend — but doing it per pixel costs ~200ns/px in JS (10s at
 * 48MP). Instead, each grid cell's four corner tables are pre-blended ONCE at
 * the cell centre into a single table (bake: a few ms for thousands of
 * cells); the per-pixel cost collapses to one table lookup. The trade: the
 * linear within-cell weight ramp is replaced by its centre value — a
 * sub-percent gain deviation for smooth vendor look tables on ~100px cells,
 * the same discretization class as the 33³ display LUT bake.
 */
export interface BakedGainTableMap {
  /** Blended table per grid cell: `tables[cellV * cellsH + cellH][n]`. */
  tables: Float32Array[];
  /** Grid cells across = pointsH − 1 (≥ 1; single-row grids replicate). */
  cellsH: number;
  cellsV: number;
  pointsN: number;
  /** Geometry needed to map pixel-relative coordinates to cell indices. */
  originH: number;
  originV: number;
  spacingH: number;
  spacingV: number;
  /** pointsH/V − 1 in TABLE space — the outer edge replicate boundary. */
  maxFx: number;
  maxFy: number;
  /** The five input fold weights, copied for the tight apply loop. */
  weights: readonly [number, number, number, number, number];
}

/**
 * Bake the per-cell blended tables. The input fold's BE shift is deliberately
 * NOT baked in: the bake is value-domain-free (pure table blending), so one
 * baked map serves any baselineExposure.
 */
export function bakeGainTableMapSpatial(map: DngGainTableMap): BakedGainTableMap {
  const cellsH = Math.max(1, map.pointsH - 1);
  const cellsV = Math.max(1, map.pointsV - 1);
  const tables: Float32Array[] = new Array(cellsH * cellsV);
  for (let cv = 0; cv < cellsV; cv++) {
    const v1 = Math.min(cv + 1, map.pointsV - 1);
    for (let ch = 0; ch < cellsH; ch++) {
      const h1 = Math.min(ch + 1, map.pointsH - 1);
      const t00 = map.tables[cv * map.pointsH + ch];
      const t01 = map.tables[cv * map.pointsH + h1];
      const t10 = map.tables[v1 * map.pointsH + ch];
      const t11 = map.tables[v1 * map.pointsH + h1];
      const baked = new Float32Array(map.pointsN);
      for (let n = 0; n < map.pointsN; n++) {
        baked[n] =
          0.25 * (t00[n] + t01[n] + t10[n] + t11[n]);
      }
      tables[cv * cellsH + ch] = baked;
    }
  }
  return {
    tables,
    cellsH,
    cellsV,
    pointsN: map.pointsN,
    originH: map.originH,
    originV: map.originV,
    spacingH: map.spacingH,
    spacingV: map.spacingV,
    maxFx: map.pointsH - 1,
    maxFy: map.pointsV - 1,
    weights: map.weights,
  };
}

/**
 * Apply a baked spatial map in place (tight loop: inline input fold, one
 * table lookup per pixel, edge-replicated cell indices).
 *
 * SEMANTICS (the reference render's exact order): the pixel fold reads the
 * UNCLAMPED linear pixel, the folded scalar is then scaled by 2^BaselineExposure
 * (the reference stages the map before the exposure ramp and shifts the map
 * input by BE instead of the pixels), pinned to [0, 1], and indexes the blended
 * table. The scalar gain multiplies the original pixel; the SDR result is
 * clamped to [0, 1] (the reference render's non-overrange gain-table step).
 */
export function applyBakedGainTableMap(
  rgba: Float32Array,
  width: number,
  height: number,
  baked: BakedGainTableMap,
  baselineExposure = 0,
): void {
  const beGain = Math.pow(2, baselineExposure);
  const w = baked.weights;
  const w0 = w[0], w1 = w[1], w2 = w[2], w3 = w[3], w4 = w[4];
  const lastN = baked.pointsN - 1;
  const px = width * height;

  for (let p = 0; p < px; p++) {
    const j = p * 4;
    const r = rgba[j];
    const g = rgba[j + 1];
    const b = rgba[j + 2];
    const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
    let input = (w0 * r + w1 * g + w2 * b + w3 * mn + w4 * mx) * beGain;
    if (input < 0) input = 0; else if (input > 1) input = 1;

    const row = (p / width) | 0;
    const col = p - row * width;
    const fx = ((col + 0.5) / width - baked.originH) / baked.spacingH;
    const fy = ((row + 0.5) / height - baked.originV) / baked.spacingV;
    // Table-space to cell index: cell k spans [k, k+1); replicate outside.
    let ch = fx | 0;
    let cv = fy | 0;
    if (ch > baked.cellsH - 1) ch = baked.cellsH - 1; else if (ch < 0) ch = 0;
    if (cv > baked.cellsV - 1) cv = baked.cellsV - 1; else if (cv < 0) cv = 0;

    const t = baked.tables[cv * baked.cellsH + ch];
    // Same index mapping as gainTableMapGainAt (input × pointsN, upper end
    // clamped so input 1.0 reads the last entry exactly).
    const idx = input * baked.pointsN;
    let i0 = idx | 0;
    if (i0 > lastN) i0 = lastN;
    const i1 = i0 < lastN ? i0 + 1 : lastN;
    const gain = t[i0] + (t[i1] - t[i0]) * (idx - i0);

    let or = r * gain;
    let og = g * gain;
    let ob = b * gain;
    if (or < 0) or = 0; else if (or > 1) or = 1;
    if (og < 0) og = 0; else if (og > 1) og = 1;
    if (ob < 0) ob = 0; else if (ob > 1) ob = 1;
    rgba[j] = or;
    rgba[j + 1] = og;
    rgba[j + 2] = ob;
  }
}
