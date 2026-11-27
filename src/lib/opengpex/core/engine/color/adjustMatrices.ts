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
 * adjustMatrices.ts — pure 3x3 colour-matrix math for the adjustment chain.
 *
 * SINGLE SOURCE OF the saturation / hueRotate 3x3 matrices, their Rec.709
 * luma weights and the row-major multiply. The GPU packer
 * (`pipeline/graph/support/adjustUniform.ts`) fuses these into the `color_matrix`
 * uniform that `adjust.wgsl` samples; CPU-side graders that must mirror the
 * GPU's colour-matrix arm (e.g. the filter-preset thumbnail renderer) import
 * the SAME functions, so the two stay mathematically identical by
 * construction rather than by copied constant blocks.
 *
 * MATH PROVENANCE (do NOT re-derive): the matrices are line-for-line ports
 * of v1 `shared/filter2d.ts` (`buildSaturationMatrix` /
 * `buildHueRotationMatrix` / `multiplyMatrix3`). The hue matrix uses the
 * exact CSS/SVG `hue-rotate()` coefficients. Fusion ORDER is
 * saturation -> hueRotate -> channelMix, each LEFT-multiplied
 * (`matrix = mul3(newOp, matrix)`), matching v1's operator sequence.
 *
 * NOTE ON SPACE: these matrices operate on whatever domain the caller feeds
 * them. The GPU adjust chain applies them in the ENCODED (display sRGB)
 * domain (see adjust.wgsl's TRC wrap); CPU callers grading display-space
 * pixels use them as-is.
 */

/** Row-major 3x3 matrix: `out_i = sum_j M[i][j] * v_j`. */
export type Mat9 = [number, number, number, number, number, number, number, number, number];

/** Rec.709 luma weights — shared by the saturation and hue matrices. */
export const ADJUST_LUMA_R = 0.2126;
export const ADJUST_LUMA_G = 0.7152;
export const ADJUST_LUMA_B = 0.0722;

/** Row-major 3x3 identity. */
export const ADJUST_IDENTITY_M9: Mat9 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * Saturation matrix — Rec.709 luminance-preserving desaturation axis,
 * `s` = saturation percent clamped to [0, 200] then normalised by 100
 * (100% = identity).
 */
export function adjustSaturationMatrix(saturationPercent: number): Mat9 {
  const s = Math.min(200, Math.max(0, saturationPercent)) / 100;
  const invR = (1 - s) * ADJUST_LUMA_R;
  const invG = (1 - s) * ADJUST_LUMA_G;
  const invB = (1 - s) * ADJUST_LUMA_B;
  return [
    invR + s, invG, invB,
    invR, invG + s, invB,
    invR, invG, invB + s,
  ];
}

/** Hue-rotation matrix with the exact CSS/SVG `hue-rotate()` coefficients. */
export function adjustHueMatrix(hueDegrees: number): Mat9 {
  const rad = (hueDegrees % 360) * (Math.PI / 180);
  const cosH = Math.cos(rad);
  const sinH = Math.sin(rad);
  const R = ADJUST_LUMA_R;
  const G = ADJUST_LUMA_G;
  const B = ADJUST_LUMA_B;
  return [
    R + cosH * (1 - R) - sinH * R,
    G - cosH * G - sinH * G,
    B - cosH * B + sinH * (1 - B),

    R - cosH * R + sinH * 0.143,
    G + cosH * (1 - G) + sinH * 0.14,
    B - cosH * B - sinH * 0.283,

    R - cosH * R - sinH * (1 - R),
    G - cosH * G + sinH * G,
    B + cosH * (1 - B) + sinH * B,
  ];
}

/** Multiply two row-major 3x3 matrices (`a * b`). */
export function mulAdjustMat3(a: Mat9, b: Mat9): Mat9 {
  const out = new Array<number>(9) as Mat9;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      out[row * 3 + col] =
        a[row * 3] * b[col] + a[row * 3 + 1] * b[3 + col] + a[row * 3 + 2] * b[6 + col];
    }
  }
  return out;
}
