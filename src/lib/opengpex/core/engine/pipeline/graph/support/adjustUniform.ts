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
 * of v1 `shared/filter2d.ts`; the matrices themselves now live in the shared
 * pure module `engine/color/adjustMatrices.ts` so CPU graders (filter-preset
 * thumbnails) reuse the identical math. brightness/contrast/colorBalance are
 * evaluated IN-SHADER (adjust.wgsl); this packer only forwards their
 * scalars/offsets.
 *
 * ⚠️ MATRIX STORAGE — ROW-MAJOR (v1) → COLUMN-MAJOR (WGSL). v1's
 * `applyMatrixRGBA8` is row-major: `out_i = Σ_j M[i][j]·v_j`. WGSL `mat3x3<f32>`
 * is column-major and `M * v` computes `out_i = Σ_j col_j[i]·v_j`. To make the
 * shader's `M * v` equal v1's row-major product, we store v1 ROW i as WGSL
 * COLUMN i's data transposed — i.e. `col_j[i] = rowMajor[i][j]`. Packing writes
 * each WGSL column as `(m[0][col], m[1][col], m[2][col])`.
 *
 * IDENTITY: an all-identity `AdjustmentDesc[]` yields `flags = 0` and an
 * identity matrix, so `apply_stage` returns its input bit-exactly.
 *
 * @module core/engine/pipeline/graph/support/adjustUniform
 */

import type { AdjustmentDesc, AdjustStageDesc } from '@opengpex/editor/core/engine/pipeline/scene/Scene';
import {
  ADJUST_STAGE_FLOATS,
  ADJUST_UNIFORM_FLOATS,
  ADJUST_HEADER_BYTES,
  ADJUST_MAX_STAGES,
  ADJUST_FLAG_BASIC,
  ADJUST_FLAG_MATRIX,
  ADJUST_FLAG_COLOR_BALANCE,
  ADJUST_FLAG_LEVELS,
  ADJUST_FLAG_CURVES,
  ADJUST_FLAG_LUT3D,
  ADJUST_FLAG_FULL_COVERAGE,
  ADJUST_SLOT_LUT3D_STRENGTH,
  ADJUST_SLOT_COVERAGE_LAYER,
  ADJUST_SLOT_FLAGS,
} from '@opengpex/editor/core/engine/gpu/shaders/adjust';
import {
  ADJUST_IDENTITY_M9,
  adjustHueMatrix,
  adjustSaturationMatrix,
  mulAdjustMat3,
  type Mat9,
} from '@opengpex/editor/core/engine/color/adjustMatrices';

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
  const out = new Float32Array(ADJUST_STAGE_FLOATS);
  const uints = new Uint32Array(out.buffer);
  let flags = 0;

  // Fused colour matrix (row-major) + channelMix constant offset, built in v1
  // order: saturation → hueRotate → channelMix, each left-multiplied.
  let matrix: Mat9 = ADJUST_IDENTITY_M9;
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
          matrix = mulAdjustMat3(adjustSaturationMatrix(a.saturation), matrix);
          matrixTouched = true;
        }
        if (a.hueRotate !== 0) {
          matrix = mulAdjustMat3(adjustHueMatrix(a.hueRotate), matrix);
          matrixTouched = true;
        }
      } else if (a.kind === 'channelMix') {
        const m = a.matrix;
        matrix = mulAdjustMat3([m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]] as Mat9, matrix);
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

  uints[ADJUST_SLOT_FLAGS] = flags >>> 0;
  return out;
}

/** What the bind site knows about resident textures when packing a chain. */
export interface PackAdjustChainOptions {
  /** The per-layer LUT atlas is resident — levels/curves stages may set their sampling flag. */
  readonly atlasResident: boolean;
  /** Whether a stage's 3D LUT is resident (by lutId). */
  readonly lut3dResident?: (lutId: string) => boolean;
  /**
   * Coverage window of the layer's baked coverage array, in content-unit
   * fractions (x0, y0, w, h); `undefined` when no stage is confined. Confined
   * stages are assigned array layers in chain order (0, 1, 2, …), matching the
   * bake order in `prepareAdjustCoverage`.
   */
  readonly coverageWindow?: readonly [number, number, number, number];
}

/**
 * Pack a layer's whole grade chain into the `AdjustChain` uniform layout
 * (`ADJUST_UNIFORM_FLOATS` slots): header (stage_count, window) followed by
 * one packed `AdjustStage` per stage. Stages past `ADJUST_MAX_STAGES` are not
 * packed (the translation already caps them).
 *
 * A stage that samples a table but whose atlas is NOT resident yet keeps that
 * flag CLEARED (correct-but-ungraded rather than sampling a placeholder); the
 * same applies to a not-yet-resident 3D LUT. A stage without `coverage` gets the
 * FULL_COVERAGE bit so the shader skips the array sample.
 *
 * Returns the packed buffer and the number of stages that ended up with ANY
 * flag set (0 ⇒ the chain is an identity and the caller may bind the shared
 * identity group instead).
 */
export function packAdjustChain(
  stages: readonly AdjustStageDesc[] | undefined,
  options: PackAdjustChainOptions,
): { readonly packed: Float32Array; readonly activeStages: number } {
  const out = new Float32Array(ADJUST_UNIFORM_FLOATS);
  const uints = new Uint32Array(out.buffer);
  const headerFloats = ADJUST_HEADER_BYTES / 4;
  const win = options.coverageWindow ?? [0, 0, 1, 1];
  out[4] = win[0];
  out[5] = win[1];
  out[6] = win[2];
  out[7] = win[3];

  let count = 0;
  let active = 0;
  let coverageLayer = 0;
  if (stages) {
    for (const stage of stages) {
      if (count >= ADJUST_MAX_STAGES) break;
      const packed = packAdjustUniform(stage.adjustments);
      const pu = new Uint32Array(packed.buffer);
      let flags = pu[ADJUST_SLOT_FLAGS];
      const hasLevels = stage.adjustments.some((a) => a.kind === 'levels');
      const hasCurves = stage.adjustments.some((a) => a.kind === 'curves');
      const lut3d = stage.adjustments.find((a) => a.kind === 'lut3d') as
        | { kind: 'lut3d'; lutId: string }
        | undefined;
      if (options.atlasResident) {
        if (hasLevels) flags |= ADJUST_FLAG_LEVELS;
        if (hasCurves) flags |= ADJUST_FLAG_CURVES;
      }
      if (lut3d && options.lut3dResident?.(lut3d.lutId)) flags |= ADJUST_FLAG_LUT3D;
      if (stage.coverage && options.coverageWindow) {
        packed[ADJUST_SLOT_COVERAGE_LAYER] = coverageLayer++;
      } else {
        flags |= ADJUST_FLAG_FULL_COVERAGE;
      }
      pu[ADJUST_SLOT_FLAGS] = flags >>> 0;
      if ((flags & ~ADJUST_FLAG_FULL_COVERAGE) !== 0) active++;
      out.set(packed, headerFloats + count * ADJUST_STAGE_FLOATS);
      count++;
    }
  }
  uints[0] = count >>> 0;
  return { packed: out, activeStages: active };
}
