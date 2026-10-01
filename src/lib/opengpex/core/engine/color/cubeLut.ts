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
 * cubeLut.ts — Adobe/IRIDAS `.cube` 3D LUT parser.
 *
 * SCOPE (deliberately narrow): this module ONLY turns `.cube` TEXT into a
 * validated, upload-ready cube of RGB samples. It does NO interpolation —
 * trilinear filtering is the GPU's job (`textureSample` on `texture_3d<f32>`,
 * hardware trilinear sampling). Re-deriving interpolation on the CPU would create a
 * second source of truth for the same maths.
 *
 * LAYOUT CONTRACT (the one detail that silently corrupts a LUT if wrong):
 * `.cube` stores samples with **RED varying fastest**, then green, then blue:
 *
 *   index = r + g·N + b·N²      (r,g,b ∈ [0, N-1])
 *
 * A WebGPU `3d` texture is written x-fastest, then y, then z (`writeTexture`
 * walks x → y → z). So (r,g,b) → (x,y,z) is the IDENTITY mapping — the file order
 * IS the texture order and `data` uploads as-is. Do not "helpfully" transpose.
 *
 * DOMAIN: `DOMAIN_MIN`/`DOMAIN_MAX` are parsed and reported, but the sampling
 * side assumes the standard 0..1 domain. A non-default domain is surfaced via
 * {@link CubeLut.domainMin}/{@link CubeLut.domainMax} rather than silently
 * rescaling the samples.
 *
 * ERRORS: a malformed file THROWS ({@link CubeLutParseError}); it never degrades
 * to an identity LUT — a silently-identity "film look" is indistinguishable from
 * a bug and would waste a user's time hunting a no-op.
 *
 * @module core/engine/color/cubeLut
 */

/**
 * Smallest / largest `LUT_3D_SIZE` accepted. The format allows up to 256, but
 * 64³ RGBA16F is already 2 MB of VRAM — beyond that is unreasonable for a colour
 * grade and almost always a malformed file.
 */
export const CUBE_LUT_MIN_SIZE = 2;
export const CUBE_LUT_MAX_SIZE = 64;

/** Thrown for any malformed `.cube` input. */
export class CubeLutParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CubeLutParseError';
  }
}

/** A parsed `.cube` 3D LUT. */
export interface CubeLut {
  /** `TITLE` if present. */
  readonly title?: string;
  /** Edge length N (`LUT_3D_SIZE`); sample count is N³. */
  readonly size: number;
  /** `DOMAIN_MIN` (defaults to [0,0,0]). */
  readonly domainMin: readonly [number, number, number];
  /** `DOMAIN_MAX` (defaults to [1,1,1]). */
  readonly domainMax: readonly [number, number, number];
  /**
   * N³ RGB triples, red-fastest (see LAYOUT CONTRACT). Length = N³ · 3. Values
   * are the file's raw floats (NOT clamped — over-range LUTs exist; the texture
   * format decides the final range).
   */
  readonly data: Float32Array;
}

/** Strip a `#` comment (runs to end-of-line in `.cube`) and trim. */
function stripComment(line: string): string {
  const hash = line.indexOf('#');
  return (hash === -1 ? line : line.slice(0, hash)).trim();
}

/** Parse exactly three finite floats from a keyword's arguments, else throw. */
function parseTriple(parts: readonly string[], keyword: string): [number, number, number] {
  if (parts.length !== 3) {
    throw new CubeLutParseError(`${keyword} expects 3 values, got ${parts.length}`);
  }
  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const v = Number(parts[i]);
    if (!Number.isFinite(v)) {
      throw new CubeLutParseError(`${keyword} has a non-numeric component: "${parts[i]}"`);
    }
    out[i] = v;
  }
  return out;
}

/**
 * Parse `.cube` text into a {@link CubeLut}.
 *
 * Accepts the 3D subset: `TITLE`, `LUT_3D_SIZE`, `DOMAIN_MIN`, `DOMAIN_MAX`, then
 * exactly N³ whitespace-separated RGB rows. `LUT_1D_SIZE` files are rejected
 * explicitly — 1D tone in v2 is curves/levels, a different path.
 *
 * @throws {CubeLutParseError} on a missing/invalid size, wrong sample count, a
 *   non-numeric sample, or an inverted domain.
 */
export function parseCubeLut(text: string): CubeLut {
  let title: string | undefined;
  let size = 0;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];

  // Samples collect into a plain array first: the expected count is only known
  // once LUT_3D_SIZE is seen, and the format does not REQUIRE the size to precede
  // the data (in practice it always does; we simply do not depend on it).
  const samples: number[] = [];

  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]);
    if (line.length === 0) continue;

    const parts = line.split(/\s+/);
    const keyword = parts[0].toUpperCase();

    if (keyword === 'TITLE') {
      // TITLE "My Look" — a quoted string that may contain spaces.
      const m = line.match(/^TITLE\s+"?(.*?)"?\s*$/i);
      title = m ? m[1] : undefined;
      continue;
    }
    if (keyword === 'LUT_3D_SIZE') {
      const n = Number(parts[1]);
      if (!Number.isInteger(n) || n < CUBE_LUT_MIN_SIZE || n > CUBE_LUT_MAX_SIZE) {
        throw new CubeLutParseError(
          `LUT_3D_SIZE must be an integer in [${CUBE_LUT_MIN_SIZE}, ${CUBE_LUT_MAX_SIZE}], got "${parts[1]}"`,
        );
      }
      size = n;
      continue;
    }
    if (keyword === 'LUT_1D_SIZE') {
      throw new CubeLutParseError(
        '1D .cube LUTs are not supported (v2 1D tone is curves/levels)',
      );
    }
    if (keyword === 'DOMAIN_MIN') {
      domainMin = parseTriple(parts.slice(1), 'DOMAIN_MIN');
      continue;
    }
    if (keyword === 'DOMAIN_MAX') {
      domainMax = parseTriple(parts.slice(1), 'DOMAIN_MAX');
      continue;
    }

    // Otherwise: a data row — exactly 3 numeric components.
    if (parts.length !== 3) {
      throw new CubeLutParseError(
        `line ${i + 1}: expected 3 sample components or a known keyword, got "${line}"`,
      );
    }
    for (let c = 0; c < 3; c++) {
      const v = Number(parts[c]);
      if (!Number.isFinite(v)) {
        throw new CubeLutParseError(`line ${i + 1}: non-numeric sample component "${parts[c]}"`);
      }
      samples.push(v);
    }
  }

  if (size === 0) {
    throw new CubeLutParseError('missing LUT_3D_SIZE');
  }
  const expected = size * size * size * 3;
  if (samples.length !== expected) {
    throw new CubeLutParseError(
      `expected ${expected / 3} RGB samples for LUT_3D_SIZE ${size}, got ${samples.length / 3}`,
    );
  }
  for (let c = 0; c < 3; c++) {
    if (domainMax[c] <= domainMin[c]) {
      throw new CubeLutParseError(
        `DOMAIN_MAX must exceed DOMAIN_MIN per component (component ${c}: ${domainMin[c]}..${domainMax[c]})`,
      );
    }
  }

  return { title, size, domainMin, domainMax, data: new Float32Array(samples) };
}

/**
 * Build an identity `.cube` LUT of edge length `size` — the analytic no-op
 * `sample(r,g,b) = (r,g,b)/(N-1)`. Used by tests and as the reference for the
 * identity invariant (an identity 3D LUT must leave pixels unchanged up to the
 * LUT's own quantization).
 */
export function identityCubeLut(size: number): CubeLut {
  if (!Number.isInteger(size) || size < CUBE_LUT_MIN_SIZE || size > CUBE_LUT_MAX_SIZE) {
    throw new CubeLutParseError(
      `identity LUT size must be an integer in [${CUBE_LUT_MIN_SIZE}, ${CUBE_LUT_MAX_SIZE}]`,
    );
  }
  const data = new Float32Array(size * size * size * 3);
  const denom = size - 1;
  let i = 0;
  // Red fastest — matches the LAYOUT CONTRACT above.
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        data[i++] = r / denom;
        data[i++] = g / denom;
        data[i++] = b / denom;
      }
    }
  }
  return { size, domainMin: [0, 0, 0], domainMax: [1, 1, 1], data };
}
