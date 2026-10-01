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
 * lut3dPlan.ts — Turn a parsed `.cube` LUT into a GPU-upload plan: RGBA pixel
 * data + the capability-adapted texture format (3D LUT precision adaptation).
 *
 * WHY A SEPARATE MODULE: `cubeLut.ts` is pure text→samples (no GPU concepts);
 * `WebGpuEngine.uploadLut3d` is pure GPU plumbing. This module is the policy layer
 * between them — RGB→RGBA expansion, half-float packing, and the format/degradation
 * decision — so all three stay independently testable.
 *
 * FORMAT SELECTION & DEGRADATION (precision adaptive, policy: capability adaptation
 * over arbitrary fallback): a 3D LUT MUST be sampled with hardware trilinear filtering,
 * so its format must be FILTERABLE:
 *
 *   | working format | `float32-filterable` | chosen LUT format | why                        |
 *   |----------------|----------------------|-------------------|----------------------------|
 *   | rgba16float    | (irrelevant)         | rgba16float       | f16 is ALWAYS filterable   |
 *   | rgba32float    | granted              | rgba32float       | full precision, filterable |
 *   | rgba32float    | MISSING              | rgba16float       | DEGRADE: keep hw trilinear |
 *
 * The degradation is a more CONSERVATIVE WebGPU path (a smaller float format),
 * never a CPU/Canvas2D path. Software trilinear in the shader is deliberately NOT
 * implemented: f16 has 10 mantissa bits ≈ 1/1024 quantization, far below the ≤1/255
 * tolerance for an 8-bit-ish grade, so f16 + hardware filtering is both accurate
 * enough and faster than emulating filtering.
 *
 * ⚠️ COLOUR SPACE: `.cube` LUTs are film-emulation looks authored on
 * ENCODED (sRGB) values, so — exactly like curves/levels — the LUT is sampled
 * inside `apply_adjustments`' TRC WRAP: the pipeline's linear light is encoded
 * before the sample and decoded after, so the table sees the values it was authored
 * for while the surrounding pipeline stays linear. `.cube` files
 * authored for a genuinely linear domain remain out of scope (no per-LUT domain
 * declaration exists in the format).
 *
 * @module core/gpu/scene/lut3dPlan
 */

import type { CubeLut } from '@opengpex/editor/core/engine/color/cubeLut';
import { floatToHalf } from '@opengpex/editor/core/engine/color/float16';

/** Texture formats a 3D LUT can occupy (both filterable under their conditions). */
export type Lut3dFormat = 'rgba16float' | 'rgba32float';

/** A ready-to-upload 3D LUT. */
export interface Lut3dUpload {
  /** Deterministic content id — identical id ⟹ identical pixels (deduplication). */
  readonly lutId: string;
  /** Edge length N; the texture is N×N×N. */
  readonly size: number;
  readonly format: Lut3dFormat;
  /**
   * RGBA texels, x-fastest (== `.cube` red-fastest, see cubeLut LAYOUT CONTRACT).
   * `Uint16Array` of half-floats for `rgba16float`, `Float32Array` for
   * `rgba32float`. Alpha is 1 (unused; the shader samples `.rgb`).
   */
  readonly data: Uint16Array | Float32Array;
  /** Bytes per row, for `writeTexture` (`size × 4 channels × bytes-per-channel`). */
  readonly bytesPerRow: number;
}

/** The capability inputs the format decision depends on. */
export interface Lut3dCapabilities {
  readonly workingFormat: 'rgba16float' | 'rgba32float';
  /** Whether the adapter granted `float32-filterable`. */
  readonly float32Filterable: boolean;
}

/**
 * Choose the 3D LUT texture format for the negotiated capabilities.
 *
 * `rgba32float` is used ONLY when the working format is already 32-bit AND
 * `float32-filterable` is granted — otherwise binding a filtering sampler to an
 * unfilterable float texture fails pipeline validation (which would produce
 * a blank canvas). Missing the feature degrades to `rgba16float`,
 * which is unconditionally filterable.
 */
export function selectLut3dFormat(caps: Lut3dCapabilities): Lut3dFormat {
  if (caps.workingFormat === 'rgba32float' && caps.float32Filterable) {
    return 'rgba32float';
  }
  return 'rgba16float';
}

/** True when the chosen format is a DEGRADATION from the working format. */
export function isLut3dDegraded(caps: Lut3dCapabilities): boolean {
  return caps.workingFormat === 'rgba32float' && !caps.float32Filterable;
}

const HALF_ONE = floatToHalf(1);

/**
 * FNV-1a 32-bit over the raw sample floats → base36, prefixed with the edge size.
 *
 * Hashing the PIXELS (not a config object) is what makes the id a true content
 * hash: two different `.cube` files that resolve to the same table dedup to one
 * resident texture, and re-importing the same file never re-uploads. The
 * per-sample `Math.fround` keeps the hash stable across the f32 round-trip that
 * `Float32Array` storage already performs.
 */
export function hashLut3dData(size: number, data: Float32Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    // Quantize to 1e-6 so double-precision jitter in a text parse cannot change
    // the id for visually identical tables.
    const q = Math.round(Math.fround(data[i]) * 1e6);
    h ^= q & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (q >>> 8) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (q >>> 16) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (q >>> 24) & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return `lut3d-${size}-${(h >>> 0).toString(36)}`;
}

/**
 * Build the upload plan for a parsed `.cube` LUT under the given capabilities.
 *
 * RGB→RGBA: WebGPU has no 3-channel float texture format, so each sample is
 * expanded to RGBA with `a = 1`. The shader samples `.rgb`; alpha is inert.
 *
 * The sample ORDER is passed through unchanged — `.cube` is red-fastest and
 * `writeTexture` walks x→y→z, so the file order IS the texture order (see the
 * cubeLut LAYOUT CONTRACT). Do not reorder here.
 */
export function buildLut3dUpload(lut: CubeLut, caps: Lut3dCapabilities): Lut3dUpload {
  const format = selectLut3dFormat(caps);
  const texelCount = lut.size * lut.size * lut.size;
  const bytesPerChannel = format === 'rgba32float' ? 4 : 2;

  let data: Uint16Array | Float32Array;
  if (format === 'rgba32float') {
    const out = new Float32Array(texelCount * 4);
    for (let i = 0; i < texelCount; i++) {
      out[i * 4] = lut.data[i * 3];
      out[i * 4 + 1] = lut.data[i * 3 + 1];
      out[i * 4 + 2] = lut.data[i * 3 + 2];
      out[i * 4 + 3] = 1;
    }
    data = out;
  } else {
    const out = new Uint16Array(texelCount * 4);
    for (let i = 0; i < texelCount; i++) {
      out[i * 4] = floatToHalf(lut.data[i * 3]);
      out[i * 4 + 1] = floatToHalf(lut.data[i * 3 + 1]);
      out[i * 4 + 2] = floatToHalf(lut.data[i * 3 + 2]);
      out[i * 4 + 3] = HALF_ONE;
    }
    data = out;
  }

  return {
    // The id covers the SAMPLES only: the same table degraded to f16 on one
    // adapter and kept at f32 on another is the same LUT conceptually, and a
    // device is never re-negotiated mid-session, so the format cannot alias.
    lutId: hashLut3dData(lut.size, lut.data),
    size: lut.size,
    format,
    data,
    bytesPerRow: lut.size * 4 * bytesPerChannel,
  };
}
