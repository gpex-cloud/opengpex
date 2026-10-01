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
 * BuiltinColorEngine — 3×3 Linear Color Space Conversion Matrices.
 *
 * Provides exact conversion between built-in RGB color spaces (sRGB, Display P3,
 * Adobe RGB, ProPhoto RGB) via 3×3 matrices operating in linear-light (gamma 1.0) domain.
 *
 * Architecture:
 * - Pure TypeScript, zero external dependencies
 * - Matrices are DERIVED at module load from the single source of truth in
 *   `primaries.ts` (xy primaries + white point) via `deriveMatrix.ts` — Bradford
 *   chromatic adaptation is applied automatically for cross-white-point pairs.
 *   Nothing here is a hand-transcribed literal, so no copy can drift.
 * - Renderer-agnostic: usable by CPU (this module), WebGL (upload as uniform mat3),
 *   or WebGPU (compute shader uniform — see `gpu/shaders/colorspace.ts`, which
 *   formats the SAME derivation into its WGSL string)
 *
 * Usage:
 *   1. Linearize source pixels (srgbToLinear per-channel)
 *   2. Apply matrix: [R_out, G_out, B_out] = M × [R_in, G_in, B_in]
 *   3. Apply target TRC encoding (linearToSrgb per-channel)
 *
 * Matrix layout: Row-major, 3×3 (9 elements).
 *   Index mapping: [m00, m01, m02, m10, m11, m12, m20, m21, m22]
 *   Output_R = m00*In_R + m01*In_G + m02*In_B
 *   Output_G = m10*In_R + m11*In_G + m12*In_B
 *   Output_B = m20*In_R + m21*In_G + m22*In_B
 *
 * Reference sources:
 * - CSS Color Level 4 specification (matrix values for sRGB ↔ Display P3)
 * - ICC.1:2004 (chromaticity-based matrix derivation)
 * - Bruce Lindbloom's chromatic adaptation math
 *
 * @module core/engine/color/matrices
 */

import type { WorkingColorSpace } from '@opengpex/editor/core/types';
import { srgbToLinear, linearToSrgb } from './trc';
import { deriveMatrix } from './gamut';

// ────────────────────────────────────────────────────────────────────────────────
// 3×3 Conversion Matrices (row-major, linear-light domain)
//
// All matrices are DERIVED from `primaries.ts` at module load — never hand-typed.
// `deriveMatrix(A, B)` = RGB_to_XYZ(B)⁻¹ · Bradford(white_A→white_B) · RGB_to_XYZ(A),
// so every A→B and its inverse B→A come from the SAME physical primaries and are
// mutually inverse to machine precision (see tests/.../gamutMatrices.test.ts). The
// values are gated against published references (CSS Color 4, Rec.709 D65) there.
// ────────────────────────────────────────────────────────────────────────────────

/** sRGB (linear) → Display P3 (linear). */
export const SRGB_TO_P3 = deriveMatrix('srgb', 'display-p3');

/** Display P3 (linear) → sRGB (linear). */
export const P3_TO_SRGB = deriveMatrix('display-p3', 'srgb');

/** sRGB (linear) → Adobe RGB (1998) (linear). TRC handled separately. */
export const SRGB_TO_ADOBE_RGB = deriveMatrix('srgb', 'adobe-rgb');

/** Adobe RGB (1998) (linear) → sRGB (linear). */
export const ADOBE_RGB_TO_SRGB = deriveMatrix('adobe-rgb', 'srgb');

/** Display P3 (linear) → Adobe RGB (1998) (linear). */
export const P3_TO_ADOBE_RGB = deriveMatrix('display-p3', 'adobe-rgb');

/** Adobe RGB (1998) (linear) → Display P3 (linear). */
export const ADOBE_RGB_TO_P3 = deriveMatrix('adobe-rgb', 'display-p3');

/**
 * ProPhoto RGB (ROMM RGB, D50) (linear) → Display P3 (D65) (linear).
 * Carries Bradford D50→D65 adaptation. ProPhoto is much larger than P3
 * (~30% of ProPhoto colors fall outside P3); out-of-gamut values are clamped
 * to [0,1] by applyMatrix3x3().
 */
export const PROPHOTO_TO_P3 = deriveMatrix('prophoto-rgb', 'display-p3');

/** Display P3 (D65) (linear) → ProPhoto RGB (ROMM RGB, D50) (linear). Bradford D65→D50. */
export const P3_TO_PROPHOTO = deriveMatrix('display-p3', 'prophoto-rgb');

/** ProPhoto RGB (D50) (linear) → sRGB (D65) (linear). Bradford D50→D65; heavy clamping expected. */
export const PROPHOTO_TO_SRGB = deriveMatrix('prophoto-rgb', 'srgb');

/** sRGB (D65) (linear) → ProPhoto RGB (D50) (linear). Bradford D65→D50. */
export const SRGB_TO_PROPHOTO = deriveMatrix('srgb', 'prophoto-rgb');

/** Adobe RGB (D65) (linear) → ProPhoto RGB (D50) (linear). Bradford D65→D50. */
export const ADOBE_RGB_TO_PROPHOTO = deriveMatrix('adobe-rgb', 'prophoto-rgb');

/** ProPhoto RGB (D50) (linear) → Adobe RGB (D65) (linear). Bradford D50→D65. */
export const PROPHOTO_TO_ADOBE_RGB = deriveMatrix('prophoto-rgb', 'adobe-rgb');

// ────────────────────────────────────────────────────────────────────────────────
// Matrix Registry (lookup by source → target pair)
// ────────────────────────────────────────────────────────────────────────────────

/** Identity matrix (no conversion needed). */
const IDENTITY = new Float32Array([
  1, 0, 0,
  0, 1, 0,
  0, 0, 1,
]);

type MatrixKey = `${WorkingColorSpace}→${WorkingColorSpace}`;

/**
 * Registry of all supported direct conversion matrices.
 * Key format: "source→target". Complete: all 12 ordered pairs among the four
 * working spaces (every pair is a free derivation from primaries.ts).
 */
const MATRIX_REGISTRY: Record<string, Float32Array> = {
  'srgb→display-p3':         SRGB_TO_P3,
  'display-p3→srgb':         P3_TO_SRGB,
  'srgb→adobe-rgb':          SRGB_TO_ADOBE_RGB,
  'adobe-rgb→srgb':          ADOBE_RGB_TO_SRGB,
  'display-p3→adobe-rgb':    P3_TO_ADOBE_RGB,
  'adobe-rgb→display-p3':    ADOBE_RGB_TO_P3,
  'prophoto-rgb→display-p3': PROPHOTO_TO_P3,
  'display-p3→prophoto-rgb': P3_TO_PROPHOTO,
  'prophoto-rgb→srgb':       PROPHOTO_TO_SRGB,
  'srgb→prophoto-rgb':       SRGB_TO_PROPHOTO,
  'adobe-rgb→prophoto-rgb':  ADOBE_RGB_TO_PROPHOTO,
  'prophoto-rgb→adobe-rgb':  PROPHOTO_TO_ADOBE_RGB,
};

/**
 * Get the 3×3 linear conversion matrix for a source→target pair.
 *
 * Returns the identity matrix if source === target.
 * Returns null if no matrix exists for the pair.
 *
 * All pairs between sRGB, Display P3, Adobe RGB, and ProPhoto RGB are supported.
 *
 * @param source - Source color space (linear domain)
 * @param target - Target color space (linear domain)
 * @returns 9-element Float32Array (row-major) or null if unsupported
 */
export function getConversionMatrix(
  source: WorkingColorSpace,
  target: WorkingColorSpace,
): Float32Array | null {
  if (source === target) return IDENTITY;
  const key: MatrixKey = `${source}→${target}`;
  return MATRIX_REGISTRY[key] ?? null;
}

// ────────────────────────────────────────────────────────────────────────────────
// Pixel-level conversion utilities (CPU path)
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Apply a 3×3 color matrix to a single RGB pixel (linear domain).
 *
 * @param r - Linear red [0, 1]
 * @param g - Linear green [0, 1]
 * @param b - Linear blue [0, 1]
 * @param m - 9-element row-major matrix
 * @returns [r, g, b] in target linear space (clamped to [0, 1])
 */
export function applyMatrix3x3(
  r: number, g: number, b: number,
  m: Float32Array,
): [number, number, number] {
  return [
    Math.max(0, Math.min(1, m[0] * r + m[1] * g + m[2] * b)),
    Math.max(0, Math.min(1, m[3] * r + m[4] * g + m[5] * b)),
    Math.max(0, Math.min(1, m[6] * r + m[7] * g + m[8] * b)),
  ];
}

/**
 * Convert an 8-bit RGBA ImageData buffer between two working color spaces in-place.
 *
 * Full pipeline: sRGB-TRC decode → linearize → matrix → re-encode to sRGB-TRC.
 * Alpha channel is preserved unchanged.
 *
 * Performance: ~4ms for a 1920×1080 image on modern hardware (single-threaded).
 *
 * @param data   - Uint8ClampedArray of RGBA pixel data (ImageData.data)
 * @param source - Source color space of the pixel values
 * @param target - Target color space for the output
 */
export function convertImageDataColorSpace(
  data: Uint8ClampedArray,
  source: WorkingColorSpace,
  target: WorkingColorSpace,
): void {
  if (source === target) return;

  const matrix = getConversionMatrix(source, target);
  if (!matrix) {
    console.warn(`[ColorMgmt] No conversion matrix for ${source}→${target}, skipping`);
    return;
  }

  // Extract matrix elements to local variables for tight inner loop.
  // Avoids per-pixel function call overhead + tuple allocation of applyMatrix3x3.
  const m0 = matrix[0], m1 = matrix[1], m2 = matrix[2];
  const m3 = matrix[3], m4 = matrix[4], m5 = matrix[5];
  const m6 = matrix[6], m7 = matrix[7], m8 = matrix[8];

  const len = data.length;
  for (let i = 0; i < len; i += 4) {
    // 1. Linearize (sRGB TRC → linear)
    const lr = srgbToLinear(data[i] / 255);
    const lg = srgbToLinear(data[i + 1] / 255);
    const lb = srgbToLinear(data[i + 2] / 255);

    // 2. Apply conversion matrix (inlined, no tuple allocation)
    const outR = Math.max(0, Math.min(1, m0 * lr + m1 * lg + m2 * lb));
    const outG = Math.max(0, Math.min(1, m3 * lr + m4 * lg + m5 * lb));
    const outB = Math.max(0, Math.min(1, m6 * lr + m7 * lg + m8 * lb));

    // 3. Re-encode to sRGB TRC
    data[i]     = Math.round(linearToSrgb(outR) * 255);
    data[i + 1] = Math.round(linearToSrgb(outG) * 255);
    data[i + 2] = Math.round(linearToSrgb(outB) * 255);
    // data[i + 3] — alpha unchanged
  }
}

/**
 * Convert a 16-bit RGBA `Uint16Array` buffer between two working color spaces
 * in-place (used for RAW 16-bit ingest, ProPhoto→working gamut on CPU).
 *
 * This is the 16-bit sibling of {@link convertImageDataColorSpace}. Identical
 * math (linearize → 3×3 matrix → re-encode), but the channel range is 0..65535
 * and ALL intermediate arithmetic runs in `number` (f64) precision — the matrix
 * is NEVER applied to the integer directly. Rounding to the 16-bit grid happens
 * ONCE, at the very end, so a wide ProPhoto→P3 conversion keeps its precision
 * (the whole point of the 16-bit path vs the 8-bit one).
 *
 * TRC assumption: pixels are sRGB-TRC encoded (matches libraw's `gamm:[2.4,12.92]`
 * output). Alpha (channel 3) is preserved unchanged. Out-of-gamut linear values
 * are clamped to [0,1] before re-encode (same as the 8-bit path / applyMatrix3x3).
 *
 * @param data   - Uint16Array of RGBA pixels (length multiple of 4), 0..65535
 * @param source - Source working color space of the pixel values
 * @param target - Target working color space
 */
export function convertImageDataColorSpace16(
  data: Uint16Array,
  source: WorkingColorSpace,
  target: WorkingColorSpace,
): void {
  if (source === target) return;

  const matrix = getConversionMatrix(source, target);
  if (!matrix) {
    console.warn(`[ColorMgmt] No 16-bit conversion matrix for ${source}→${target}, skipping`);
    return;
  }

  const m0 = matrix[0], m1 = matrix[1], m2 = matrix[2];
  const m3 = matrix[3], m4 = matrix[4], m5 = matrix[5];
  const m6 = matrix[6], m7 = matrix[7], m8 = matrix[8];

  const INV = 1 / 65535;
  const len = data.length;
  for (let i = 0; i < len; i += 4) {
    // 1. Normalize to [0,1] then linearize (sRGB TRC → linear), all in f64.
    const lr = srgbToLinear(data[i] * INV);
    const lg = srgbToLinear(data[i + 1] * INV);
    const lb = srgbToLinear(data[i + 2] * INV);

    // 2. Apply conversion matrix in linear light (f64 accumulation).
    const outR = Math.max(0, Math.min(1, m0 * lr + m1 * lg + m2 * lb));
    const outG = Math.max(0, Math.min(1, m3 * lr + m4 * lg + m5 * lb));
    const outB = Math.max(0, Math.min(1, m6 * lr + m7 * lg + m8 * lb));

    // 3. Re-encode to sRGB TRC, then quantize to the 16-bit grid ONCE.
    data[i]     = Math.round(linearToSrgb(outR) * 65535);
    data[i + 1] = Math.round(linearToSrgb(outG) * 65535);
    data[i + 2] = Math.round(linearToSrgb(outB) * 65535);
    // data[i + 3] — alpha unchanged
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// Built-in color space detection helper
// ────────────────────────────────────────────────────────────────────────────────
/** The set of built-in working color spaces that can be handled via matrix conversion. */
const BUILTIN_WORKING_SPACES: ReadonlySet<string> = new Set([
  'srgb',
  'display-p3',
  'adobe-rgb',
  'prophoto-rgb',
]);

/**
 * Check if a ColorSpaceId is a supported built-in working space
 * (i.e., can be represented natively in the pixel pipeline without ICC engine).
 *
 * @param cs - Color space identifier (from file metadata)
 * @returns true if the space is supported as a working space
 */
export function isBuiltinColorSpace(cs: string | undefined): cs is WorkingColorSpace {
  if (!cs) return false;
  return BUILTIN_WORKING_SPACES.has(cs);
}

// ────────────────────────────────────────────────────────────────────────────────
// Display P3 hardware detection (cached)
// ────────────────────────────────────────────────────────────────────────────────

let _displaySupportsP3: boolean | null = null;

/**
 * Detect whether the current display supports the P3 wide gamut.
 * Uses CSS `color-gamut: p3` media query. Result is cached.
 *
 * @returns true if the display can render P3 colors natively
 */
export function displaySupportsP3(): boolean {
  if (_displaySupportsP3 !== null) return _displaySupportsP3;
  if (typeof window === 'undefined' || !window.matchMedia) {
    _displaySupportsP3 = false;
    return false;
  }
  _displaySupportsP3 = window.matchMedia('(color-gamut: p3)').matches;
  return _displaySupportsP3;
}
