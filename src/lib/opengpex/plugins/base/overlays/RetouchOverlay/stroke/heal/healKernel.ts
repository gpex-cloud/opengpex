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
 * Spot Heal Kernel — V2 "harmonic fill + texture residual transfer".
 *
 * Fills a circular stamp region (center cx,cy, radius r) in two stages:
 *
 * 1. Harmonic base solve. The pixels inside the disk are solved so that the
 *    Laplacian vanishes (grad-squared I = 0) with Dirichlet boundary values
 *    taken from a thin source ring at d in [r, r+2]. Because the solution is
 *    a smooth interpolation of the surrounding pixels with NO grid, tiling,
 *    or candidate picking involved, the visible tile lattice of the previous
 *    patch-copy synthesizer is eliminated by construction. The solve runs on
 *    a 2-level pyramid of Gauss-Seidel sweeps (coarse first, then full
 *    resolution) which converges the low-frequency error that plain
 *    iterations converge on slowly, while staying well under a millisecond
 *    per channel for stamp radii up to ~32 px.
 *
 * 2. Texture residual transfer. A purely harmonic fill looks plasticky
 *    smooth (zero high-frequency energy), so the high-pass residual of the
 *    surrounding band (band minus its own 3x3 box blur, sampled on the
 *    annulus r..1.4r) is added back inside the disk at a radially mirrored
 *    sample point, scaled by a radial weight that fades to zero at the
 *    center and at the rim. This restores skin-like grain without
 *    re-introducing any lattice.
 *
 * The outer-rim smoothstep feather (opaque inside 0.6r, ramping to exactly 0
 * at r) is unchanged from V1 so the session's source-over composite keeps
 * melting the stamp into its backdrop without a hard seam.
 *
 * Future direction: if band texture quality ever needs to improve further,
 * the documented upgrade path is "Option B" — overlapping candidate patches
 * composited with tent-weight voting — which keeps seams soft while
 * preserving more structured band texture than the mirrored residual.
 *
 * Constraints honored by the implementation:
 * - Fully deterministic: no RNG anywhere; identical inputs produce identical
 *   patches, so undo replay and tests are stable.
 * - Reentrant: no module-level mutable state; all working buffers are local
 *   to a call.
 * - Pure CPU on plain RGBA buffers (ImageData-shaped), unit testable with
 *   no canvas/DOM dependency.
 * - Consecutive stamps chain naturally: the CALLER passes a source buffer
 *   that already contains earlier stamp results (the stroke session's
 *   working composite), so a dragged stroke heals coherently.
 */

// ─── Tuning constants ──────────────────────────────────────────────────────────

/**
 * How much of the band's high-pass residual is added back inside the disk.
 * 0 would give a perfectly smooth (plastic) harmonic fill; ~0.6 keeps a
 * believable skin grain while avoiding double-exposing the noise.
 */
const TEXTURE_STRENGTH = 0.6;

/**
 * Gauss-Seidel sweeps on the half-resolution pyramid level. Coarse grids
 * propagate boundary information across the whole disk in few sweeps, which
 * is what kills the slow low-frequency error; 25 sweeps on a grid of at most
 * (2*ceil(r)/2)^2 = ~32x32 cells cost a few microseconds while being close
 * enough to converged that the fine level only polishes.
 */
const COARSE_GS_ITERATIONS = 25;

/**
 * Gauss-Seidel sweeps at full resolution after upscaling the coarse
 * solution. These only clean up the half-pixel-scale error left by the
 * bilinear upsample, so a small budget (~10 sweeps) keeps the whole solve
 * comfortably under the 1 ms-per-channel target for r <= 32.
 */
const FINE_GS_ITERATIONS = 10;

/**
 * Outer radius of the texture-residual band, as a multiple of r. Mirrored
 * residual samples are clamped to stay inside this annulus, so the defect's
 * own pixels never leak into the fill.
 */
const RESIDUAL_BAND_OUTER = 1.4;

/**
 * Radial mirror factor for residual sampling: an interior pixel at distance
 * d samples its residual at 1.15*d on the opposite side of the center
 * (clamped into the band). The slight over-mirror (>1) keeps sample points
 * clear of the rim where the residual fades, reducing correlation between
 * the added grain and the feather.
 */
const RESIDUAL_MIRROR_SCALE = 1.15;

/** Alpha stays fully opaque inside this fraction of r, then smoothsteps to 0 at r. */
const FEATHER_INNER = 0.6;

// ─── Types ─────────────────────────────────────────────────────────────────────

/** RGBA pixel buffer view (structurally identical to ImageData, DOM-free). */
export interface RgbaBuffer {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export interface HealStampParams {
  /** Composited source pixels the stamp samples from (may contain earlier stamps). */
  source: RgbaBuffer;
  /** Stamp center, in the SOURCE buffer's coordinate space. */
  cx: number;
  cy: number;
  /** Stamp radius in source-buffer pixels. */
  radius: number;
}

export interface HealStampResult {
  /** Square straight-alpha RGBA patch covering the stamp bounding box, side = size. */
  data: Uint8ClampedArray;
  /** Side length of the square patch in pixels (2 * ceil(radius)). */
  size: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Smoothstep in [0,1] over edge0..edge1 (clamped). Same curve as CSS easing. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * One in-place Gauss-Seidel relaxation sweep set over a Laplace grid.
 * `fixed[i]` pixels are Dirichlet boundary values and are never touched;
 * every other pixel is repeatedly replaced by the average of its 4
 * neighbors, which is the discrete form of grad-squared I = 0. Border grid
 * cells use clamped neighbors so the sweep stays branch-cheap; the disk's
 * fixed boundary ring always lies well inside the grid, so clamped corners
 * never influence the interior solution.
 */
function relaxLaplace(values: Float32Array, fixed: Uint8Array, side: number, iterations: number): void {
  for (let it = 0; it < iterations; it++) {
    for (let y = 0; y < side; y++) {
      const row = y * side;
      for (let x = 0; x < side; x++) {
        const i = row + x;
        if (fixed[i] !== 0) continue;
        const l = x > 0 ? i - 1 : i;
        const r = x < side - 1 ? i + 1 : i;
        const u = y > 0 ? i - side : i;
        const d = y < side - 1 ? i + side : i;
        const b = i * 3;
        values[b] = (values[l * 3] + values[r * 3] + values[u * 3] + values[d * 3]) * 0.25;
        values[b + 1] = (values[l * 3 + 1] + values[r * 3 + 1] + values[u * 3 + 1] + values[d * 3 + 1]) * 0.25;
        values[b + 2] = (values[l * 3 + 2] + values[r * 3 + 2] + values[u * 3 + 2] + values[d * 3 + 2]) * 0.25;
      }
    }
  }
}

/**
 * Bilinear sample of a 3-channel field on a `side`x`side` grid at floating
 * point coordinates. Out-of-range coordinates are clamped to the edge, so
 * sampling near the patch rim never reads unallocated memory.
 */
function bilinearSample3(field: Float32Array, side: number, fx: number, fy: number, out: Float32Array): void {
  const cx = Math.min(side - 1, Math.max(0, fx));
  const cy = Math.min(side - 1, Math.max(0, fy));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(side - 1, x0 + 1);
  const y1 = Math.min(side - 1, y0 + 1);
  const tx = cx - x0;
  const ty = cy - y0;
  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;
  for (let ch = 0; ch < 3; ch++) {
    out[ch] =
      w00 * field[(y0 * side + x0) * 3 + ch] +
      w10 * field[(y0 * side + x1) * 3 + ch] +
      w01 * field[(y1 * side + x0) * 3 + ch] +
      w11 * field[(y1 * side + x1) * 3 + ch];
  }
}

// ─── healStamp ─────────────────────────────────────────────────────────────────

/**
 * Synthesizes one heal stamp. See module doc for the algorithm contract.
 * Returns the square RGBA patch (straight alpha); the caller composites it
 * onto its working buffer with source-over so the feather ramp blends.
 */
export function healStamp(params: HealStampParams): HealStampResult {
  const { source, cx, cy, radius } = params;
  const half = Math.ceil(radius);
  const size = half * 2;
  const out = new Uint8ClampedArray(size * size * 4);

  // Degenerate stamps (zero/negative radius, sub-pixel disk) produce a fully
  // transparent patch so the caller's composite stays untouched.
  if (!(radius > 0.5) || size <= 0) {
    return { data: out, size };
  }

  const sW = source.width;
  const sH = source.height;
  const c = size / 2; // patch-space center; patch pixel (x,y) maps to source (cx - half + x, cy - half + y)

  // ── 0. Ambient color: mean RGB over the opaque ring band r..1.5r ──
  // Used to seed the interior solve and as the fallback wherever the source
  // is transparent or out of bounds, guaranteeing the whole pipeline is
  // NaN-free even on mostly-transparent input.
  let meanR = 0, meanG = 0, meanB = 0;
  {
    let totalR = 0, totalG = 0, totalB = 0, count = 0;
    let allR = 0, allG = 0, allB = 0, allCount = 0;
    const bx0 = Math.max(0, Math.floor(cx - radius * 1.5));
    const bx1 = Math.min(sW - 1, Math.ceil(cx + radius * 1.5));
    const by0 = Math.max(0, Math.floor(cy - radius * 1.5));
    const by1 = Math.min(sH - 1, Math.ceil(cy + radius * 1.5));
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d < radius || d > radius * 1.5) continue;
        const i = (y * sW + x) * 4;
        allR += source.data[i];
        allG += source.data[i + 1];
        allB += source.data[i + 2];
        allCount++;
        if (source.data[i + 3] === 0) continue;
        totalR += source.data[i];
        totalG += source.data[i + 1];
        totalB += source.data[i + 2];
        count++;
      }
    }
    if (count > 0) {
      meanR = totalR / count;
      meanG = totalG / count;
      meanB = totalB / count;
    } else if (allCount > 0) {
      // Fully transparent band: fall back to every sampled band pixel
      // (black) rather than fabricating color, keeping the output sane.
      meanR = allR / allCount;
      meanG = allG / allCount;
      meanB = allB / allCount;
    }
  }

  // ── 1. Source sampling grid over the patch square ──
  // srcRGB holds the band/boundary colors the solve reads; for patch pixels
  // whose source sample is transparent or out of bounds the ambient mean is
  // substituted so the Dirichlet ring never carries holes.
  const n = size * size;
  const srcRGB = new Float32Array(n * 3);
  const dist = new Float32Array(n);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      dist[i] = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      const sx = Math.min(sW - 1, Math.max(0, Math.round(cx - half + x)));
      const sy = Math.min(sH - 1, Math.max(0, Math.round(cy - half + y)));
      const si = (sy * sW + sx) * 4;
      const b = i * 3;
      if (source.data[si + 3] === 0) {
        srcRGB[b] = meanR;
        srcRGB[b + 1] = meanG;
        srcRGB[b + 2] = meanB;
      } else {
        srcRGB[b] = source.data[si];
        srcRGB[b + 1] = source.data[si + 1];
        srcRGB[b + 2] = source.data[si + 2];
      }
    }
  }

  // ── 2. Harmonic base solve (2-level pyramid Gauss-Seidel) ──
  // Fine grid: pixels at d >= r are Dirichlet (fixed) boundary values read
  // from the source; pixels inside the disk are the unknowns, seeded with
  // the ambient mean. The interior's neighbors reach at most d < r + 1, so
  // only the thin [r, r+2] ring actually influences the solution.
  const values = new Float32Array(n * 3);
  const fixed = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const b = i * 3;
    if (dist[i] >= radius) {
      fixed[i] = 1;
      values[b] = srcRGB[b];
      values[b + 1] = srcRGB[b + 1];
      values[b + 2] = srcRGB[b + 2];
    } else {
      values[b] = meanR;
      values[b + 1] = meanG;
      values[b + 2] = meanB;
    }
  }

  // Coarse level: each coarse cell copies the fine cell at its top-left
  // corner (value + fixed flag). The Dirichlet ring survives downsampling
  // because every ring pixel's 2x2 block shares its fixed status closely
  // enough; the coarse solve only needs a good smooth seed, not exactness.
  const cs = Math.ceil(size / 2);
  const cValues = new Float32Array(cs * cs * 3);
  const cFixed = new Uint8Array(cs * cs);
  for (let y = 0; y < cs; y++) {
    for (let x = 0; x < cs; x++) {
      const fi = Math.min(size - 1, y * 2) * size + Math.min(size - 1, x * 2);
      const ci = y * cs + x;
      cFixed[ci] = fixed[fi];
      cValues[ci * 3] = values[fi * 3];
      cValues[ci * 3 + 1] = values[fi * 3 + 1];
      cValues[ci * 3 + 2] = values[fi * 3 + 2];
    }
  }
  relaxLaplace(cValues, cFixed, cs, COARSE_GS_ITERATIONS);

  // Upsample the coarse solve into the fine interior (fixed pixels keep
  // their exact boundary values), then polish at full resolution.
  for (let i = 0; i < n; i++) {
    if (fixed[i] !== 0) continue;
    const x = i % size;
    const y = (i / size) | 0;
    const ci = (Math.min(cs - 1, y >> 1) * cs + Math.min(cs - 1, x >> 1)) * 3;
    const b = i * 3;
    values[b] = cValues[ci];
    values[b + 1] = cValues[ci + 1];
    values[b + 2] = cValues[ci + 2];
  }
  relaxLaplace(values, fixed, size, FINE_GS_ITERATIONS);

  // ── 3. Texture residual transfer ──
  // High-pass residual of the source over the patch square: H = src - blur3.
  // H is zeroed strictly outside the band r..1.4r so that bilinear sampling
  // near the band edges fades in instead of bleeding the defect's own
  // (removed) pixels back into the fill.
  const residual = new Float32Array(n * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const d = dist[i];
      if (d < radius || d > radius * RESIDUAL_BAND_OUTER) continue;
      const b = i * 3;
      // 3x3 box blur of the sampled source colors, clamped at patch edges.
      let sumR = 0, sumG = 0, sumB = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(size - 1, Math.max(0, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(size - 1, Math.max(0, x + dx));
          const nb = (yy * size + xx) * 3;
          sumR += srcRGB[nb];
          sumG += srcRGB[nb + 1];
          sumB += srcRGB[nb + 2];
        }
      }
      residual[b] = srcRGB[b] - sumR / 9;
      residual[b + 1] = srcRGB[b + 1] - sumG / 9;
      residual[b + 2] = srcRGB[b + 2] - sumB / 9;
    }
  }

  // Add the mirrored residual inside the disk. Sample point: center minus
  // 1.15x the offset (radially mirrored, slightly over-mirrored), with the
  // sample radius clamped into [r, 1.4r] so it always lands on valid band
  // residual; degenerate center pixels use the +x direction as direction is
  // undefined at d = 0.
  const sample = new Float32Array(3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const d = dist[i];
      if (d >= radius) continue;
      const ox = x + 0.5 - c;
      const oy = y + 0.5 - c;
      let mx: number, my: number;
      if (d < 0.5) {
        mx = c + radius;
        my = c;
      } else {
        const target = Math.min(radius * RESIDUAL_BAND_OUTER, Math.max(radius, d * RESIDUAL_MIRROR_SCALE));
        const k = -target / d;
        mx = c + ox * k;
        my = c + oy * k;
      }
      bilinearSample3(residual, size, mx - 0.5, my - 0.5, sample);
      const w = 1 - (d / radius) * (d / radius);
      const b = i * 3;
      values[b] += sample[0] * w * TEXTURE_STRENGTH;
      values[b + 1] += sample[1] * w * TEXTURE_STRENGTH;
      values[b + 2] += sample[2] * w * TEXTURE_STRENGTH;
    }
  }

  // ── 4. Emit patch with the unchanged outer-rim smoothstep feather ──
  // alpha = 255 inside 0.6r, smoothsteps to exactly 0 at r; pixels at and
  // beyond r stay fully transparent so the caller's source-over composite
  // melts the stamp into the backdrop without a hard seam.
  const inner = radius * FEATHER_INNER;
  for (let i = 0; i < n; i++) {
    const d = dist[i];
    const a = d >= radius ? 0 : 255 * (1 - smoothstep(inner, radius, d));
    const oi = i * 4;
    if (a <= 0) continue; // leave RGB at 0 where alpha is 0
    out[oi] = values[i * 3];
    out[oi + 1] = values[i * 3 + 1];
    out[oi + 2] = values[i * 3 + 2];
    out[oi + 3] = a;
  }

  return { data: out, size };
}
