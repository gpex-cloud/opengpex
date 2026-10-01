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
 * lutPlan.ts — Build the RGBA16F 1D-LUT pixel data for curves/levels,
 * reusing the LUT MATH single-source-of-truth.
 *
 * HARD CONSTRAINT: the tone tables come EXCLUSIVELY from
 * `generateCurveLUT` / `generateLevelsLUT` (`core/engine/color/luts.ts`) — the same
 * functions the curve/levels UI panels sample. This module only (a) composes the
 * per-channel curve tables the way v1 `buildFusedLUTs` did (index composition,
 * NOT curve re-derivation) and (b) packs the normalized results into half-float
 * RGBA so `adjust.wgsl` can sample them at working precision. Re-deriving any
 * curve/level math here would silently diverge the render from the stored curve.
 *
 * LAYOUT: `LUT_ENTRIES` texels, RGBA16F. R/G/B hold the per-channel mapping; A is
 * unused (set to 1). `adjust.wgsl` samples `.r/.g/.b` for the matching channel.
 *   • levels — ONE table applied to all three channels (v1: one LUT, all chans).
 *   • curves — per channel = `perChannel(master(x))` (v1 composition order:
 *     master rgb first, then the channel-specific curve).
 *
 * @module core/gpu/scene/lutPlan
 */

import type { CurvesState, LevelsState } from '@opengpex/editor/core/types';
import { generateCurveLUT, generateLevelsLUT } from '@opengpex/editor/core/engine/color/luts';
import { floatToHalf } from '@opengpex/editor/core/engine/color/float16';

/** LUT resolution — matches generateCurveLUT/generateLevelsLUT default + v1. */
export const LUT_ENTRIES = 256;

const HALF_ONE = floatToHalf(1);

/** Pack three normalized per-channel tables into RGBA16F (A = 1, unused). */
function packRgbaHalf(r: Float32Array, g: Float32Array, b: Float32Array): Uint16Array {
  const out = new Uint16Array(LUT_ENTRIES * 4);
  for (let i = 0; i < LUT_ENTRIES; i++) {
    out[i * 4] = floatToHalf(r[i]);
    out[i * 4 + 1] = floatToHalf(g[i]);
    out[i * 4 + 2] = floatToHalf(b[i]);
    out[i * 4 + 3] = HALF_ONE;
  }
  return out;
}

/**
 * Build the levels 1D-LUT data: `generateLevelsLUT` (f32, normalized) replicated
 * across R/G/B. `config` is the SAME object hashed into the `lutId`.
 */
export function buildLevelsLutData(config: LevelsState): Uint16Array {
  const table = generateLevelsLUT(config, LUT_ENTRIES, 'f32') as Float32Array;
  return packRgbaHalf(table, table, table);
}

/**
 * Build the curves 1D-LUT data: per channel = `perChannel(master(x))`, matching
 * v1 `buildFusedLUTs` composition (index composition of the master rgb table and
 * the channel table, both from `generateCurveLUT`). `curves` is the SAME object
 * hashed into the `lutId`.
 */
export function buildCurvesLutData(curves: CurvesState): Uint16Array {
  const master = curves.rgb ? (generateCurveLUT(curves.rgb, LUT_ENTRIES, 'f32') as Float32Array) : null;
  const red = curves.red ? (generateCurveLUT(curves.red, LUT_ENTRIES, 'f32') as Float32Array) : null;
  const green = curves.green ? (generateCurveLUT(curves.green, LUT_ENTRIES, 'f32') as Float32Array) : null;
  const blue = curves.blue ? (generateCurveLUT(curves.blue, LUT_ENTRIES, 'f32') as Float32Array) : null;
  const maxIn = LUT_ENTRIES - 1;

  // final[i] = per( round(master(i/maxIn) · maxIn) ), each step normalized —
  // exactly v1 composeInto (result[i] = additional[readLUTIndex(target, i)]).
  const channel = (per: Float32Array | null): Float32Array => {
    const out = new Float32Array(LUT_ENTRIES);
    for (let i = 0; i < LUT_ENTRIES; i++) {
      const afterMaster = master ? master[i] : i / maxIn;
      if (per) {
        const idx = Math.round(afterMaster * maxIn);
        out[i] = per[idx];
      } else {
        out[i] = afterMaster;
      }
    }
    return out;
  };

  return packRgbaHalf(channel(red), channel(green), channel(blue));
}
