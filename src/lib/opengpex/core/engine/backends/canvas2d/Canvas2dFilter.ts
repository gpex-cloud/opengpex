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
 * Canvas2dFilter — CPU-side IFilter implementation using ImageData loops.
 *
 * This is the *default* filter runtime delivered in Step 2 of the filter
 * pipeline plan. It is designed to run inside `processor.worker.ts` where
 * `OffscreenCanvas` is available; every helper degrades gracefully to plain
 * typed-array processing when no canvas is provided (for the 16-bit /
 * `HighResPixelBuffer` path used by export).
 *
 * Correctness principles:
 * 1. **Point operations are LUT-driven** — curves, levels, brightness and
 *    contrast all collapse into a single `Uint8ClampedArray[256]` (or
 *    `Uint16Array[65536]`) query per component. This is the fastest CPU
 *    inner-loop shape the JS engine can generate.
 * 2. **Neighborhood ops (blur) run on a whole-layer buffer** — matches spec
 *    §5.4 (avoids tile-seam artefacts for v1; v2 can add padding).
 * 3. **No blocking APIs** — every `apply()` returns a `Promise` so the caller
 *    (Worker handler or main-thread preview) can `await` and hand the result
 *    back through a transferable object.
 */

import type {
  ChannelMixFilter,
  CurvesFilter,
  FilterApplyOptions,
  FilterDescriptor,
  FilterInput,
  FilterType,
  HighResPixelBuffer,
  IFilter,
  LevelsFilter,
} from '@opengpex/editor/core/engine/protocol/IFilter';
import { classifyFilter } from '@opengpex/editor/core/engine/protocol/IFilter';
import {
  DEFAULT_LEVELS,
  IDENTITY_CHANNEL_MIX,
  expandCurvesLUTs,
  generateBrightnessContrastLUT,
  generateLevelsLUT,
  normalizeChannelMatrix,
  type LUTEntries,
  type LUTFormat,
  type LUTOutput,
} from '@opengpex/editor/core/engine/filters/lut';

// ────────────────────────────────────────────────────────────
// Perf timing
// ────────────────────────────────────────────────────────────

interface PerfGlobal {
  __FILTER_PERF__?: boolean;
}

function perfEnabled(): boolean {
  const g = globalThis as unknown as PerfGlobal;
  return g.__FILTER_PERF__ === true;
}

function perfLog(label: string, elapsedMs: number, extra?: string): void {
  if (!perfEnabled()) return;
  const line = extra ? `[filter-perf] ${label} ${elapsedMs.toFixed(2)}ms ${extra}` : `[filter-perf] ${label} ${elapsedMs.toFixed(2)}ms`;

  console.debug(line);
}

// ────────────────────────────────────────────────────────────
// Small utilities
// ────────────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

function isHighRes(input: FilterInput): input is HighResPixelBuffer {
  return typeof (input as HighResPixelBuffer).data !== 'undefined';
}

function bitDepthMax(bitDepth: 8 | 16 | 32): number {
  return bitDepth === 8 ? 255 : bitDepth === 16 ? 65535 : 1; // 32-bit stored as [0..1]
}

function lutEntriesFor(bitDepth: 8 | 16 | 32): LUTEntries {
  return bitDepth === 8 ? 256 : 65536;
}

function lutFormatFor(bitDepth: 8 | 16 | 32): LUTFormat {
  if (bitDepth === 8) return 'u8';
  if (bitDepth === 16) return 'u16';
  return 'f32';
}

// ────────────────────────────────────────────────────────────
// Fused point-op LUT builder
// ────────────────────────────────────────────────────────────

/**
 * A trio of per-channel LUTs plus an optional master (luminance) LUT. The
 * runtime folds curves + levels + brightness/contrast into these three LUTs
 * so the inner pixel loop only performs a handful of array lookups.
 */
interface PerChannelLUTs {
  rgb: LUTOutput | null;
  red: LUTOutput;
  green: LUTOutput;
  blue: LUTOutput;
}

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
 * The returned LUTs are self-composed — the caller writes:
 *   r = lut.red[srcR]     (u8)
 * or
 *   r = Math.round(lut.red[srcR] / lutMax * 255)   (mixed precision).
 */
function buildFusedLUTs(
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
    // Return an index into the same-length LUT (0..entries-1).
    if (lut instanceof Float32Array) {
      return Math.round(clamp(lut[i], 0, 1) * maxOut);
    }
    // u8: values 0..255 → scale to entries-1
    // u16: values 0..65535 → scale to entries-1
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
        // Fuse the brightness and/or contrast — collect both in one pass.
        // We look ahead if the very next descriptor is the counterpart.
        const brightness =
          f.type === 'brightness' ? f.value : 100;
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
        // brightness/contrast/curves/levels only — other ops handled elsewhere.
        break;
    }
  }

  if (!touched) return null;
  return { rgb: null, red, green, blue };
}

// ────────────────────────────────────────────────────────────
// Pixel pass: RGBA Uint8 LUT (8-bit path)
// ────────────────────────────────────────────────────────────

function applyLUTsRGBA8(
  data: Uint8ClampedArray,
  luts: PerChannelLUTs,
): void {
  const { red, green, blue } = luts;
  // We hoist Uint8ClampedArray reference for the JIT.
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

function applyLUTsHighRes(
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
  // Standard hue-rotation matrix (SVG feColorMatrix).
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
 * into ONE 3×3 matrix and ONE constant offset for the pixel loop. Returns
 * `null` if all matrix ops collapse to identity (no work to do).
 */
function buildFusedColorMatrix(
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

function applyMatrixRGBA8(
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
    // Uint8ClampedArray auto-clamps, but rounding avoids drift.
    data[i] = nr;
    data[i + 1] = ng;
    data[i + 2] = nb;
  }
}

function applyMatrixHighRes(
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
    // Prime the window.
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
      // Slide window: remove x-r, add x+r+1.
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

function boxBlurRGBAInPlace(
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
// Canvas2dFilter
// ────────────────────────────────────────────────────────────

interface RgbaFrame {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

async function bitmapToRgba(source: ImageBitmap): Promise<RgbaFrame> {
  // Prefer OffscreenCanvas (works in workers). Falls back to document.canvas.
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(source.width, source.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('[Canvas2dFilter] failed to acquire 2d context');
    ctx.drawImage(source, 0, 0);
    const img = ctx.getImageData(0, 0, source.width, source.height);
    return { data: img.data, width: source.width, height: source.height };
  }
  // Main-thread fallback (used in tests / SSR contexts should not reach here).
  const canvas = (globalThis as unknown as { document?: Document }).document?.createElement('canvas');
  if (!canvas) {
    throw new Error(
      '[Canvas2dFilter] no OffscreenCanvas or DOM canvas available in this context',
    );
  }
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('[Canvas2dFilter] failed to acquire 2d context (DOM)');
  ctx.drawImage(source, 0, 0);
  const img = ctx.getImageData(0, 0, source.width, source.height);
  return { data: img.data, width: source.width, height: source.height };
}

async function rgbaToBitmap(frame: RgbaFrame): Promise<ImageBitmap> {
  // ImageData requires the backing buffer to be a real ArrayBuffer, not a
  // possibly-shared ArrayBufferLike. Rewrap defensively to keep TypeScript's
  // structural checks happy and to guarantee ownership semantics for the
  // transferable-object path downstream.
  const rebound = new Uint8ClampedArray(new ArrayBuffer(frame.data.byteLength));
  rebound.set(frame.data);
  const imageData = new ImageData(rebound, frame.width, frame.height);
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(frame.width, frame.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('[Canvas2dFilter] failed to acquire 2d context');
    ctx.putImageData(imageData, 0, 0);
    return await createImageBitmap(canvas);
  }
  return await createImageBitmap(imageData);
}


export class Canvas2dFilter implements IFilter {
  async apply(
    source: FilterInput,
    filters: FilterDescriptor[],
    options?: FilterApplyOptions,
  ): Promise<FilterInput> {
    if (options?.signal?.aborted) {
      throw new Error('[Canvas2dFilter] aborted before start');
    }

    // No-op fast path — return source unchanged.
    if (!filters || filters.length === 0) return source;

    if (isHighRes(source)) {
      return this.applyHighRes(source, filters, options);
    }
    return this.applyBitmap(source, filters, options);
  }

  supports(type: FilterType): boolean {
    // Every documented FilterType is implemented by this backend.
    return (
      type === 'brightness' ||
      type === 'contrast' ||
      type === 'saturation' ||
      type === 'hueRotate' ||
      type === 'blur' ||
      type === 'curves' ||
      type === 'levels' ||
      type === 'channelMix' ||
      type === 'custom'
    );
  }

  maxBitDepth(): 8 | 16 | 32 {
    return 16;
  }

  dispose(): void {
    // No persistent GPU/worker resources yet — reserved for future GL backends.
  }

  // ────────────────────────────────────────
  // 8-bit ImageBitmap path
  // ────────────────────────────────────────

  private async applyBitmap(
    source: ImageBitmap,
    filters: FilterDescriptor[],
    options?: FilterApplyOptions,
  ): Promise<ImageBitmap> {
    const t0 = performance.now();
    const frame = await bitmapToRgba(source);
    perfLog('decode', performance.now() - t0, `${frame.width}x${frame.height}`);

    const t1 = performance.now();

    const luts = buildFusedLUTs(filters, 256, 'u8');
    if (luts) applyLUTsRGBA8(frame.data, luts);
    perfLog('lut', performance.now() - t1);

    const t2 = performance.now();
    const mtx = buildFusedColorMatrix(filters);
    if (mtx) applyMatrixRGBA8(frame.data, mtx.matrix, mtx.constant);
    perfLog('matrix', performance.now() - t2);

    // Neighborhood ops — spec §5.4: always applied to the whole-layer buffer.
    const t3 = performance.now();
    for (const f of filters) {
      if (classifyFilter(f) !== 'neighborhood') continue;
      if (f.type === 'blur') {
        boxBlurRGBAInPlace(frame.data, frame.width, frame.height, f.value);
      }
    }
    perfLog('neighborhood', performance.now() - t3);

    if (options?.signal?.aborted) throw new Error('[Canvas2dFilter] aborted');

    const t4 = performance.now();
    const out = await rgbaToBitmap(frame);
    perfLog('encode', performance.now() - t4);
    perfLog('total-8bit', performance.now() - t0, `${filters.length} filters`);
    return out;
  }

  // ────────────────────────────────────────
  // High-res (16 / 32-bit) path
  // ────────────────────────────────────────

  private async applyHighRes(
    source: HighResPixelBuffer,
    filters: FilterDescriptor[],
    options?: FilterApplyOptions,
  ): Promise<HighResPixelBuffer> {
    const t0 = performance.now();
    const targetBitDepth: 8 | 16 | 32 =
      options?.bitDepth ?? source.bitDepth;

    // Work directly on the incoming buffer (already contiguous typed array).
    const target = source;

    const entries = lutEntriesFor(target.bitDepth);
    const format = lutFormatFor(target.bitDepth);
    const luts = buildFusedLUTs(filters, entries, format);

    const t1 = performance.now();
    if (luts) applyLUTsHighRes(target, luts);
    perfLog('lut-highres', performance.now() - t1, `bd=${target.bitDepth}`);

    const t2 = performance.now();
    const mtx = buildFusedColorMatrix(filters);
    if (mtx) applyMatrixHighRes(target, mtx.matrix, mtx.constant);
    perfLog('matrix-highres', performance.now() - t2);

    if (filters.some(f => classifyFilter(f) === 'neighborhood')) {
      // Neighborhood ops on high-res buffers are TODO (Step 8 upgrade —
      // requires a Float32 box-blur pass). For now we skip and log a warning.
      // Callers that need blur in the 16-bit export path should either

      // downcast first or wait for the neighborhood-on-highres implementation.
      console.warn(
        '[Canvas2dFilter] neighborhood filters on high-res buffers are not implemented; skipping (Step 8).',
      );
    }

    if (options?.signal?.aborted) throw new Error('[Canvas2dFilter] aborted');

    // If the caller asked for a different bit depth than the source, defer to
    // Step 3 (WorkerBridge) which owns cross-precision conversion. For Step 2
    // we simply preserve the buffer's precision and let vips handle the final
    // encode.
    if (targetBitDepth !== target.bitDepth) {
      console.warn(
        `[Canvas2dFilter] requested bitDepth=${targetBitDepth} but source is ${target.bitDepth}; returning source precision (bit-depth conversion is Step 3).`,
      );
    }

    perfLog('total-highres', performance.now() - t0, `${filters.length} filters`);
    return target;
  }
}
