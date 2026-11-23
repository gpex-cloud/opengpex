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
 * Blur / Sharpen Stamp Kernels (A5 — retouch family convolution stamps).
 *
 * Both modes share ONE separable box blur:
 *
 * - `blurStamp`    output = lerp(src, blur(src), strength)      — local softening;
 * - `sharpenStamp` output = lerp(src, src + k·(src − blur(src)), 1) — unsharp mask
 *   where the strength slider drives the unsharp coefficient k, so one blur
 *   pass serves both kernels and "same radius ⇒ shared intermediate" holds
 *   by construction.
 *
 * Implementation contract (mirrors healKernel.ts):
 * - Pure CPU on plain RGBA buffers (ImageData-shaped), DOM-free, unit
 *   testable without canvas.
 * - Fully deterministic: no RNG; identical inputs produce identical patches.
 * - Reentrant: all working buffers are local to a call.
 * - The convolution runs on a patch square EXPANDED by the blur radius on
 *   every side, so interior stamp pixels see a full kernel even at the stamp
 *   rim (the source sampling contract: the composited source must be trusted
 *   brushRadius + blurRadius beyond every stamp edge — factory documents the
 *   capture-side equivalent of heal's ring margin).
 * - RGB is convolved in premultiplied space (alpha is convolved alongside),
 *   then un-premultiplied, so stamping over transparent regions never smears
 *   invisible black into visible color.
 * - The outer-rim smoothstep feather (opaque inside 0.6r, ramping to exactly
 *   0 at r) matches heal so the session's source-over composite melts stamps
 *   into the backdrop without a hard seam, and the anti-repeat stamp grid in
 *   the session chains overlapping stamps coherently through the working
 *   buffer (the CALLER passes a source that already contains earlier stamps).
 */

import type { RgbaBuffer } from '../heal/healKernel';

/** Alpha stays fully opaque inside this fraction of the brush radius, then smoothsteps to 0 at r. */
const FEATHER_INNER = 0.6;

/** Separable box blur is numerically identical at every radius; hard cap guards pathological slider input. */
export const MAX_BLUR_RADIUS = 64;

export interface ConvStampParams {
  /** Composited source pixels the stamp samples from (may contain earlier stamps). */
  source: RgbaBuffer;
  /** Stamp center, in the SOURCE buffer's coordinate space. */
  cx: number;
  cy: number;
  /** Stamp (brush) radius in source-buffer pixels. */
  radius: number;
  /** Box blur radius in source-buffer pixels (the panel's "Radius" slider, sample-scaled). */
  blurRadius: number;
  /** Effect strength in [0, 1]: blur = mix toward blurred; sharpen = unsharp coefficient. */
  strength: number;
}

export interface ConvStampResult {
  /** Square straight-alpha RGBA patch covering the stamp bounding box, side = size. */
  data: Uint8ClampedArray;
  /** Side length of the square patch in pixels (2 * ceil(radius)). */
  size: number;
}

/** Smoothstep in [0,1] over edge0..edge1 (clamped). Same curve as CSS easing. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * One in-place separable box blur pass over a premultiplied Float32 field
 * (4 channels per cell) on a side×side grid, horizontally then vertically
 * with a running-sum window — O(cells) regardless of radius. Clamped edges
 * keep the window full at borders so energy is conserved on constant input.
 */
function boxBlurPremultiplied(field: Float32Array, side: number, channels: number, radius: number): void {
  if (radius < 1) return;
  const tmp = new Float32Array(field.length);
  const norm = 1 / (2 * radius + 1);
  for (let y = 0; y < side; y++) {
    const row = y * side;
    for (let ch = 0; ch < channels; ch++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = Math.min(side - 1, Math.max(0, k));
        sum += field[(row + xx) * channels + ch];
      }
      for (let x = 0; x < side; x++) {
        tmp[(row + x) * channels + ch] = sum * norm;
        const xOut = Math.min(side - 1, Math.max(0, x - radius));
        const xIn = Math.min(side - 1, Math.max(0, x + radius + 1));
        sum += field[(row + xIn) * channels + ch] - field[(row + xOut) * channels + ch];
      }
    }
  }
  for (let x = 0; x < side; x++) {
    for (let ch = 0; ch < channels; ch++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = Math.min(side - 1, Math.max(0, k));
        sum += tmp[(yy * side + x) * channels + ch];
      }
      for (let y = 0; y < side; y++) {
        field[(y * side + x) * channels + ch] = sum * norm;
        const yOut = Math.min(side - 1, Math.max(0, y - radius));
        const yIn = Math.min(side - 1, Math.max(0, y + radius + 1));
        sum += tmp[(yIn * side + x) * channels + ch] - tmp[(yOut * side + x) * channels + ch];
      }
    }
  }
}

/**
 * Samples the source patch square (side = 2*(half + ext)) into a premultiplied
 * Float32 field (RGBA per cell). Out-of-bounds and transparent pixels enter the
 * convolution at zero premultiplied weight; the un-premultiply step below
 * removes their color influence where alpha survives.
 */
function samplePremultiplied(source: RgbaBuffer, cx: number, cy: number, half: number, ext: number): { field: Float32Array; side: number } {
  const side = (half + ext) * 2;
  const field = new Float32Array(side * side * 4);
  const x0 = Math.round(cx) - half - ext;
  const y0 = Math.round(cy) - half - ext;
  for (let y = 0; y < side; y++) {
    const sy = Math.min(source.height - 1, Math.max(0, y0 + y));
    for (let x = 0; x < side; x++) {
      const sx = Math.min(source.width - 1, Math.max(0, x0 + x));
      const si = (sy * source.width + sx) * 4;
      const a = source.data[si + 3] / 255;
      const b = (y * side + x) * 4;
      field[b] = source.data[si] * a;
      field[b + 1] = source.data[si + 1] * a;
      field[b + 2] = source.data[si + 2] * a;
      field[b + 3] = source.data[si + 3];
    }
  }
  return { field, side };
}

/** Shared pipeline: sample expanded patch → blur → per-mode combine → feathered emit. */
function convStamp(params: ConvStampParams, mode: 'blur' | 'sharpen'): ConvStampResult {
  const { source, cx, cy, radius } = params;
  const half = Math.ceil(radius);
  const size = half * 2;
  const out = new Uint8ClampedArray(size * size * 4);

  // Degenerate stamps produce a fully transparent patch (same contract as heal).
  const blurRadius = Math.min(MAX_BLUR_RADIUS, Math.max(0, Math.round(params.blurRadius)));
  const strength = Math.min(1, Math.max(0, params.strength));
  if (!(radius > 0.5) || size <= 0) {
    return { data: out, size };
  }

  // The blur needs a full kernel window around every stamp pixel, so sample
  // the source expanded by the blur radius on all sides. The ORIGINAL stays
  // alongside the blurred copy: both modes combine src with blur(src).
  const { field, side } = samplePremultiplied(source, cx, cy, half, blurRadius);
  const original = field.slice();
  boxBlurPremultiplied(field, side, 4, blurRadius);

  // The output patch square maps to the CENTER of the expanded field.
  const off = blurRadius;
  const c = size / 2;
  const inner = radius * FEATHER_INNER;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      const a = d >= radius ? 0 : 255 * (1 - smoothstep(inner, radius, d));
      const oi = (y * size + x) * 4;
      if (a <= 0) continue; // leave RGB at 0 where alpha is 0

      // Straight (un-premultiplied) source and blurred colors at this pixel.
      const fi = ((y + off) * side + (x + off)) * 4;
      const ab = field[fi + 3] / 255;
      const inv = ab > 1 / 255 ? 1 / ab : 0;
      const srcR = original[fi] * inv;
      const srcG = original[fi + 1] * inv;
      const srcB = original[fi + 2] * inv;
      const blurR = field[fi] * inv;
      const blurG = field[fi + 1] * inv;
      const blurB = field[fi + 2] * inv;

      let outR: number, outG: number, outB: number;
      if (mode === 'blur') {
        // lerp(src, blurred, strength): strength 0 leaves the pixel untouched.
        outR = srcR + (blurR - srcR) * strength;
        outG = srcG + (blurG - srcG) * strength;
        outB = srcB + (blurB - srcB) * strength;
      } else {
        // Unsharp mask: src + k·(src − blurred), clamped; strength IS k.
        outR = srcR + (srcR - blurR) * strength;
        outG = srcG + (srcG - blurG) * strength;
        outB = srcB + (srcB - blurB) * strength;
      }

      // Emit STRAIGHT alpha RGBA (the session composites the patch with
      // drawImage, which blends straight-alpha correctly) — same contract as
      // the heal kernel's patch output.
      out[oi] = outR;
      out[oi + 1] = outG;
      out[oi + 2] = outB;
      out[oi + 3] = a;
    }
  }

  return { data: out, size };
}

/**
 * Synthesizes one blur stamp: the brush disk's pixels mixed toward their box
 * blur by `strength`. See module doc for the algorithm contract.
 */
export function blurStamp(params: ConvStampParams): ConvStampResult {
  return convStamp(params, 'blur');
}

/**
 * Synthesizes one sharpen stamp: unsharp mask `src + strength·(src − blur(src))`
 * with the same shared blur pass. See module doc for the algorithm contract.
 */
export function sharpenStamp(params: ConvStampParams): ConvStampResult {
  return convStamp(params, 'sharpen');
}
