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
 * adjustUniform.ts — Pack `AdjustmentDesc[]` → the `AdjustUniforms` GPU buffer.
 *
 * SINGLE SOURCE OF ADJUST-UNIFORM MATH. `CompositePass` / `BlendPass` call
 * {@link packAdjustUniform}; this module is where the scalar/matrix adjustment
 * state becomes the 128-byte `AdjustUniforms` layout that `adjust.wgsl` reads.
 *
 * MATH PROVENANCE (do NOT re-derive): the saturation / hueRotate 3×3 matrices,
 * the Rec.709 luma weights, the channelMix fusion and the fusion ORDER
 * (saturation → hueRotate → channelMix, left-multiplied) are line-for-line ports
 * of v1 `shared/filter2d.ts` (`buildSaturationMatrix` / `buildHueRotationMatrix`
 * / `buildFusedColorMatrix`). brightness/contrast/colorBalance are evaluated
 * IN-SHADER (adjust.wgsl); this packer only forwards their scalars/offsets.
 *
 * ⚠️ MATRIX STORAGE — ROW-MAJOR (v1) → COLUMN-MAJOR (WGSL). v1's
 * `applyMatrixRGBA8` is row-major: `out_i = Σ_j M[i][j]·v_j`. WGSL `mat3x3<f32>`
 * is column-major and `M * v` computes `out_i = Σ_j col_j[i]·v_j`. To make the
 * shader's `M * v` equal v1's row-major product, we store v1 ROW i as WGSL
 * COLUMN i's data transposed — i.e. `col_j[i] = rowMajor[i][j]`. Packing writes
 * each WGSL column as `(m[0][col], m[1][col], m[2][col])`.
 *
 * IDENTITY: an all-identity `AdjustmentDesc[]` yields `flags = 0` and an
 * identity matrix, so `apply_adjustments` returns its input bit-exactly.
 *
 * @module core/gpu/scene/adjustUniform
 */

import type { AdjustmentDesc } from './Scene';
import {
  ADJUST_UNIFORM_FLOATS,
  ADJUST_FLAG_BASIC,
  ADJUST_FLAG_MATRIX,
  ADJUST_FLAG_COLOR_BALANCE,
  ADJUST_SLOT_LUT3D_STRENGTH,
} from '@opengpex/editor/core/engine/gpu/shaders/adjust';

// Rec.709 luma weights — MUST match v1 filter2d LUMA_R/G/B and adjust.wgsl.
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/** Row-major 3×3 identity. */
type Mat9 = [number, number, number, number, number, number, number, number, number];
const IDENTITY_M9: Mat9 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** v1 `buildSaturationMatrix` — Rec.709 luminance-preserving, s = sat/100. */
function saturationMatrix(saturation: number): Mat9 {
  const s = clamp(saturation, 0, 200) / 100;
  const invR = (1 - s) * LUMA_R;
  const invG = (1 - s) * LUMA_G;
  const invB = (1 - s) * LUMA_B;
  return [
    invR + s, invG, invB,
    invR, invG + s, invB,
    invR, invG, invB + s,
  ];
}

/** v1 `buildHueRotationMatrix` — the exact CSS/SVG hue-rotate coefficients. */
function hueMatrix(hueDegrees: number): Mat9 {
  const rad = (hueDegrees % 360) * (Math.PI / 180);
  const cosH = Math.cos(rad);
  const sinH = Math.sin(rad);
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

/** Multiply two row-major 3×3 matrices (v1 `multiplyMatrix3`). */
function mul3(a: Mat9, b: Mat9): Mat9 {
  const out = new Array<number>(9) as Mat9;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      out[row * 3 + col] =
        a[row * 3] * b[col] + a[row * 3 + 1] * b[3 + col] + a[row * 3 + 2] * b[6 + col];
    }
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}


/** colorBalance slider pre-scale — v1 CB_STRENGTH = 1/100 ([-100,100]→[-1,1]). */
const CB_STRENGTH = 1 / 100;

/**
 * Pack an `AdjustmentDesc[]` into the `AdjustUniforms` buffer layout that
 * `adjust.wgsl` reads (128 bytes / 32 f32-u32 slots). Returns the packed
 * `Float32Array` (its `Uint32Array` view carries the `flags` word at slot 31).
 *
 * Only the scalar/matrix arms are consumed here (`basic`, `channelMix`,
 * `colorBalance`) plus the `lut3d` STRENGTH scalar; the `curves`/`levels`/`lut3d`
 * TEXTURE arms are resolved by lutId at bind time and their
 * sampling flags are set there. An input with no scalar/matrix arm yields
 * `flags = 0` + an identity matrix, so the shader returns its input bit-exactly
 * (identity pass-through).
 *
 * Layout (std140, matches AdjustUniforms):
 *   [0..11]  color_matrix mat3x3 — 3 columns × vec3 padded to 16 B
 *   [12..14] cb_shadows.xyz, [15] pad
 *   [16..18] cb_midtones.xyz, [19] pad
 *   [20..22] cb_highlights.xyz, [23] pad
 *   [24..26] mat_constant.xyz, [27] pad
 *   [28] brightness_t, [29] contrast_c, [30] cb_preserve, [31] flags (u32)
 *   [32] lut3d_strength, [33..35] pad (tail padding)
 */
export function packAdjustUniform(
  adjustments: readonly AdjustmentDesc[] | undefined,
): Float32Array {
  const out = new Float32Array(ADJUST_UNIFORM_FLOATS);
  const uints = new Uint32Array(out.buffer);
  let flags = 0;

  // Fused colour matrix (row-major) + channelMix constant offset, built in v1
  // order: saturation → hueRotate → channelMix, each left-multiplied.
  let matrix: Mat9 = IDENTITY_M9;
  let constant: [number, number, number] = [0, 0, 0];
  let matrixTouched = false;

  if (adjustments) {
    for (const a of adjustments) {
      if (a.kind === 'basic') {
        // brightness/contrast → shader scalars; saturation/hue → fused matrix.
        out[28] = (clamp(a.brightness, 0, 200) - 100) / 100;
        out[29] = (clamp(a.contrast, 0, 200) - 100) / 100;
        flags |= ADJUST_FLAG_BASIC;
        if (a.saturation !== 100) {
          matrix = mul3(saturationMatrix(a.saturation), matrix);
          matrixTouched = true;
        }
        if (a.hueRotate !== 0) {
          matrix = mul3(hueMatrix(a.hueRotate), matrix);
          matrixTouched = true;
        }
      } else if (a.kind === 'channelMix') {
        const m = a.matrix;
        matrix = mul3([m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]] as Mat9, matrix);
        constant = [
          constant[0] + a.constant[0],
          constant[1] + a.constant[1],
          constant[2] + a.constant[2],
        ];
        matrixTouched = true;
      } else if (a.kind === 'colorBalance') {
        out[12] = a.shadows[0] * CB_STRENGTH;
        out[13] = a.shadows[1] * CB_STRENGTH;
        out[14] = a.shadows[2] * CB_STRENGTH;
        out[16] = a.midtones[0] * CB_STRENGTH;
        out[17] = a.midtones[1] * CB_STRENGTH;
        out[18] = a.midtones[2] * CB_STRENGTH;
        out[20] = a.highlights[0] * CB_STRENGTH;
        out[21] = a.highlights[1] * CB_STRENGTH;
        out[22] = a.highlights[2] * CB_STRENGTH;
        out[30] = a.preserveLuminosity ? 1 : 0;
        flags |= ADJUST_FLAG_COLOR_BALANCE;
      } else if (a.kind === 'lut3d') {
        // Only the STRENGTH is a uniform; the table itself is a resident 3D
        // texture resolved by lutId at bind time (like curves/levels).
        // The ADJUST_FLAG_LUT3D bit is set by the BIND site once the texture is
        // confirmed resident — a referenced-but-not-yet-uploaded LUT must stay
        // un-flagged so the frame is correct-but-ungraded rather than sampling
        // the identity placeholder as if it were the look.
        out[ADJUST_SLOT_LUT3D_STRENGTH] = clamp(a.strength, 0, 1);
      }
      // 'curves' / 'levels' → LUT path, not packed here.
    }
  }

  // Write the fused matrix as WGSL COLUMN-MAJOR (col_j[i] = rowMajor[i][j]).
  out[0] = matrix[0]; out[1] = matrix[3]; out[2] = matrix[6]; out[3] = 0; // Column 0
  out[4] = matrix[1]; out[5] = matrix[4]; out[6] = matrix[7]; out[7] = 0; // Column 1
  out[8] = matrix[2]; out[9] = matrix[5]; out[10] = matrix[8]; out[11] = 0; // Column 2

  out[24] = constant[0];
  out[25] = constant[1];
  out[26] = constant[2];

  if (matrixTouched) flags |= ADJUST_FLAG_MATRIX;

  uints[31] = flags >>> 0;
  return out;
}
