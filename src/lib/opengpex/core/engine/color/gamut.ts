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
 * gamut.ts — THE SINGLE SOURCE OF TRUTH for every gamut conversion matrix.
 *
 * A gamut conversion matrix (3×3, linear light) is NOT a primary datum — it is a
 * *conclusion* derived from exactly four physical quantities: the xy chromaticity
 * of the three primaries plus the white point. Any `A → B` matrix is uniquely
 *
 *   M(A→B) = RGB_to_XYZ(B)⁻¹ · Bradford(white_A → white_B) · RGB_to_XYZ(A)
 *
 * So this module holds ONLY those physical quantities ({@link GAMUT_PRIMARIES}) and
 * the colorimetry that turns them into matrices ({@link deriveMatrix}). Downstream,
 * `matrices.ts` (CPU) and `colorspace.ts` (the WGSL string) both consume this one
 * derivation — there are no hand-transcribed matrix literals anywhere, nothing to
 * keep in sync, nothing to drift.
 *
 * (History: when the matrices WERE hand-copied into two files, the two Adobe RGB
 * copies came from different derivations — an "≈sRGB, green-only" approximation vs
 * true Adobe(1998) primaries — and P3↔AdobeRGB round-tripped with ~0.6% error. A
 * single source makes that class of bug structurally impossible.)
 *
 * @module core/engine/color/gamut
 */

import type { GamutId } from '@opengpex/editor/core/types/primitives';
// Deep, type-only imports (not the `core/types` barrel): this module sits below the
// engine and the file layer, and both import it.
import type { WorkingColorSpace } from '@opengpex/editor/core/types/models';

// ════════════════════════════════════════════════════════════════════════════════
// PART 0 — The engine's working gamut (an environment invariant, not colorimetry)
// ════════════════════════════════════════════════════════════════════════════════

/**
 * The gamut EVERY composite lives in — Linear Display-P3.
 *
 * This is a HARD INVARIANT, not a default and not a document property:
 * `GpuDevice.configureSurface` hardcodes the swapchain to `colorSpace:'display-p3'`,
 * and `resolveSourceGamutId` treats display-p3 as gamut id 0 (passthrough). Every
 * source is lifted INTO this space by the sampling shader, so every readback —
 * bake (`CompositeDispatcher`) and egest (`resolveEgestDecision`) alike — is in
 * this gamut and the terminal encode must convert FROM here.
 *
 * It lives in this module because both the engine and the file layer need it and
 * neither owns the other; `gamut.ts` is already the gamut authority. Deriving it
 * from a `Frame` field would cause gamut mistranslation.
 */
export const WORKING_GAMUT: WorkingColorSpace = 'display-p3';

/**
 * Map a working color space / gamut intent to the browser's `PredefinedColorSpace`
 * ('srgb' | 'display-p3') — i.e. what an `OffscreenCanvas`/`ImageData` can actually
 * be tagged with.
 *
 * Accepts the wider `GamutId`: adobe-rgb / prophoto-rgb / rec2020 have no browser
 * `PredefinedColorSpace`, so they fall back to 'srgb' — but a canvas-tagging encoder
 * never actually receives one of those as its egest `targetGamut`
 * (`resolveEgestDecision`'s container clamp routes them onto the 16-bit raw-pixel
 * lane, or clamps them first), so this fallback is defensive only.
 *
 * Sunk here (not `core/files`) because it is pure gamut→canvas-space colorimetry,
 * not a file/format concern — the egest matrix (`strategy/egest.ts`) and the
 * display/bake track (`engine/utils/pixel-utils.ts::toDisplayTrackCanvasColorSpace`)
 * both need it without depending on each other.
 */
export function toCanvasColorSpace(space: WorkingColorSpace | GamutId): PredefinedColorSpace {
  return space === 'display-p3' ? 'display-p3' : 'srgb';
}

/**
 * Map a {@link GamutId} to its CSS Color 4 `color()` space keyword
 * (`display-p3` / `a98-rgb` / `prophoto-rgb` / `rec2020` / `srgb`).
 *
 * The canonical home for this pure gamut→CSS-keyword mapping: {@link ColorValue}'s
 * `toCssColor4` and the sampler read-out both need it without depending on each
 * other. (`ColorSampler/helpers.ts` still carries an identical local copy; that
 * plugin copy should re-export this one when the sampler line is next touched.)
 */
export function gamutToCssSpace(gamut: GamutId): string {
  switch (gamut) {
    case 'display-p3': return 'display-p3';
    case 'adobe-rgb': return 'a98-rgb';
    case 'prophoto-rgb': return 'prophoto-rgb';
    case 'rec2020': return 'rec2020';
    default: return 'srgb';
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// PART 1 — The physical truth: primaries + white points (the only real data here)
// ════════════════════════════════════════════════════════════════════════════════

/** CIE xy chromaticity coordinate. */
export type Chromaticity = readonly [x: number, y: number];

/** The four physical quantities that fully define an RGB color space. */
export interface GamutPrimaries {
  readonly R: Chromaticity;
  readonly G: Chromaticity;
  readonly B: Chromaticity;
  /** Reference white chromaticity (the illuminant the primaries are stated against). */
  readonly white: Chromaticity;
}

/** D65 — the reference white of sRGB, Display P3, Adobe RGB, Rec.2020. */
export const D65: Chromaticity = [0.3127, 0.3290];

/** D50 — the reference white of ProPhoto (ROMM) RGB. */
export const D50: Chromaticity = [0.3457, 0.3585];

/**
 * The primaries + white point for every {@link GamutId}. This is the ONLY place
 * these numbers appear. Sources:
 *  - sRGB / Rec.709 — IEC 61966-2-1 / ITU-R BT.709
 *  - Display P3     — SMPTE RP 431-2 primaries, D65 white (Apple/CSS Color 4)
 *  - Adobe RGB      — Adobe RGB (1998) specification
 *  - ProPhoto RGB   — ISO 22028-2 ROMM RGB (D50)
 *  - Rec.2020       — ITU-R BT.2020
 */
export const GAMUT_PRIMARIES: Readonly<Record<GamutId, GamutPrimaries>> = {
  srgb: {
    R: [0.640, 0.330],
    G: [0.300, 0.600],
    B: [0.150, 0.060],
    white: D65,
  },
  'display-p3': {
    R: [0.680, 0.320],
    G: [0.265, 0.690],
    B: [0.150, 0.060],
    white: D65,
  },
  'adobe-rgb': {
    R: [0.640, 0.330],
    G: [0.210, 0.710],
    B: [0.150, 0.060],
    white: D65,
  },
  'prophoto-rgb': {
    R: [0.7347, 0.2653],
    G: [0.1596, 0.8404],
    B: [0.0366, 0.0001],
    white: D50,
  },
  rec2020: {
    R: [0.708, 0.292],
    G: [0.170, 0.797],
    B: [0.131, 0.046],
    white: D65,
  },
};

/**
 * Bradford chromatic-adaptation cone-response matrix (row-major).
 * Maps CIE XYZ into a sharpened "cone" space for von Kries–style white adaptation.
 * The industry-standard Bradford values (Bruce Lindbloom / CSS Color 4).
 */
export const BRADFORD = [
   0.8951000,  0.2664000, -0.1614000,
  -0.7502000,  1.7135000,  0.0367000,
   0.0389000, -0.0685000,  1.0296000,
] as const;

// ════════════════════════════════════════════════════════════════════════════════
// PART 2 — 3×3 linear algebra (row-major, plain number[9], f64)
// ════════════════════════════════════════════════════════════════════════════════

/** Row-major 3×3 matrix as a 9-element array. */
export type Mat3 = readonly number[];

/** Matrix × matrix (row-major). */
export function mat3Mul(a: Mat3, b: Mat3): number[] {
  const o = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return o;
}

/** Matrix × column vector (row-major). */
export function mat3MulVec(m: Mat3, v: readonly [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** Inverse of a 3×3 matrix (row-major) via the adjugate / determinant. */
export function mat3Inverse(m: Mat3): number[] {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) {
    throw new Error('[gamut] singular matrix — check primaries');
  }
  const id = 1 / det;
  return [
    A * id, (c * h - b * i) * id, (b * f - c * e) * id,
    B * id, (a * i - c * g) * id, (c * d - a * f) * id,
    C * id, (b * g - a * h) * id, (a * e - b * d) * id,
  ];
}

// ════════════════════════════════════════════════════════════════════════════════
// PART 3 — Colorimetry: derive matrices from the primaries above
// ════════════════════════════════════════════════════════════════════════════════

/** CIE xy → XYZ at unit luminance (Y = 1). */
function xyToXYZ([x, y]: Chromaticity): [number, number, number] {
  return [x / y, 1, (1 - x - y) / y];
}

/**
 * RGB → XYZ matrix (row-major) for a set of primaries + white point.
 * Standard Lindbloom construction: scale each primary's XYZ so the RGB white
 * (1,1,1) maps exactly to the space's reference white.
 */
export function rgbToXYZ(p: GamutPrimaries): number[] {
  const R = xyToXYZ(p.R);
  const G = xyToXYZ(p.G);
  const B = xyToXYZ(p.B);
  const M = [R[0], G[0], B[0], R[1], G[1], B[1], R[2], G[2], B[2]];
  const S = mat3MulVec(mat3Inverse(M), xyToXYZ(p.white));
  return [
    R[0] * S[0], G[0] * S[1], B[0] * S[2],
    R[1] * S[0], G[1] * S[1], B[1] * S[2],
    R[2] * S[0], G[2] * S[1], B[2] * S[2],
  ];
}

/**
 * Bradford chromatic-adaptation matrix (row-major) mapping XYZ under `srcWhite`
 * to XYZ under `dstWhite`. Identity when the white points coincide.
 */
export function bradfordAdaptation(srcWhite: Chromaticity, dstWhite: Chromaticity): number[] {
  if (srcWhite[0] === dstWhite[0] && srcWhite[1] === dstWhite[1]) {
    return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  }
  const cs = mat3MulVec(BRADFORD, xyToXYZ(srcWhite));
  const cd = mat3MulVec(BRADFORD, xyToXYZ(dstWhite));
  const diag = [cd[0] / cs[0], 0, 0, 0, cd[1] / cs[1], 0, 0, 0, cd[2] / cs[2]];
  return mat3Mul(mat3Inverse(BRADFORD), mat3Mul(diag, BRADFORD));
}

/**
 * Derive the `A → B` 3×3 linear-light conversion matrix (row-major, f64) between
 * two arbitrary sets of primaries — the colorimetric core of {@link deriveMatrix64}.
 * Includes Bradford adaptation when the two white points differ.
 *
 * Exposed for working spaces that are NOT source {@link GamutId}s — e.g. the
 * ACEScg (AP1) tone-mapping space, whose primaries live in the shader module, not
 * the ingest `GAMUT_PRIMARIES` registry.
 */
export function deriveMatrixBetween(A: GamutPrimaries, B: GamutPrimaries): number[] {
  const adapt = bradfordAdaptation(A.white, B.white);
  return mat3Mul(mat3Inverse(rgbToXYZ(B)), mat3Mul(adapt, rgbToXYZ(A)));
}

/**
 * Derive the `from → to` 3×3 linear-light conversion matrix (row-major) as f64.
 * Includes Bradford adaptation when the two gamuts differ in white point.
 *
 * @returns row-major `number[9]` in f64 precision (see {@link deriveMatrix} for f32)
 */
export function deriveMatrix64(from: GamutId, to: GamutId): number[] {
  return deriveMatrixBetween(GAMUT_PRIMARIES[from], GAMUT_PRIMARIES[to]);
}

/**
 * Derive the `from → to` 3×3 linear-light conversion matrix (row-major),
 * narrowed to `Float32Array` for the CPU pixel path.
 *
 * Index mapping: [m00, m01, m02, m10, m11, m12, m20, m21, m22]
 *   Out_R = m00*In_R + m01*In_G + m02*In_B  (etc.)
 */
export function deriveMatrix(from: GamutId, to: GamutId): Float32Array {
  return new Float32Array(deriveMatrix64(from, to));
}
