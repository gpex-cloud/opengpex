/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * dng-spec.ts — the DNG camera color-profile rendering chain, in pure TS.
 *
 * Implements the specification's reference color pipeline for DNG files that
 * carry a camera color profile: camera-RGB linear pixels → working space
 * (ProPhoto linear), with every profile stage the file declares applied in the
 * specification's order. This is what replaces the demosaic library's built-in
 * single-matrix color path for DNG sources.
 *
 * THE PIXEL INPUT CONTRACT (probe-verified 20261030): incoming pixels are
 * LINEAR camera RGB whose neutral axis is (1, 1, 1) — the decode stage has
 * already applied the file's white-balance gains and normalized sensor white
 * to 1.0 with no headroom. All matrix construction therefore treats the camera
 * neutral as (1, 1, 1). Applying any further AsShotNeutral-style gain here
 * would double-white-balance and shift every hue.
 *
 * Pipeline order (per the reference render order):
 *   1. camera RGB → PCS XYZ (D50) — the camera-to-PCS matrix, built from the
 *      profile's color matrices, calibration, analog balance, and (when both
 *      exist) forward matrices, interpolated across the calibration illuminants
 *      on the color-temperature axis;
 *   2. PCS XYZ (D50) → ProPhoto linear — direct (ProPhoto's reference white IS
 *      D50; no chromatic adaptation);
 *   3. BaselineExposure gain (2^BE, linear multiply);
 *   4. ProfileGainTableMap (spatial, in this module's linear domain — see
 *      gainTableMap.ts; its TABLE INPUT reads the BE-adjusted values);
 *   5. ProfileHueSatMap (3D hue/sat/val grid, HSV domain);
 *   6. ProfileLookTable (same grid structure, creative look);
 *   7. ProfileToneCurve (per-channel monotone 1D map).
 *
 * The math is a faithful port of the DNG specification's reference pipeline
 * (color-matrix interpolation on the inverse-temperature axis, Bradford white
 * adaptation, forward-matrix branch, XYZ-adapt fallback). The vendored
 * reference implementation under gpex-assets probes (dev-machine only, never
 * shipped) provides the golden-test oracle: tests spawn its CLI and compare
 * this module's white point and camera-to-PCS matrix digit for digit.
 *
 * @module core/engine/color/dng-spec
 */

import type { DngCameraProfileData } from '@opengpex/editor/core/files/handlers/raw/metadata/dng';
import { GAMUT_PRIMARIES, mat3Inverse } from '../gamut';

// ═══════════════════════════════════════════════════════════════════════════════
// Standard illuminants (xy chromaticity) and EXIF light-source codes
// ═══════════════════════════════════════════════════════════════════════════════

/** xy chroma pair. */
export type XY = readonly [number, number];

/** ICC profile connection space white — D50. */
const PCS_WHITE: XY = [0.3457, 0.3585];

/** EXIF light-source codes used by the calibration-illuminant tags. */
const LS_UNKNOWN = 0;
const LS_DAYLIGHT = 1;
const LS_FLUORESCENT = 2;
const LS_TUNGSTEN = 3;
const LS_FLASH = 4;
const LS_FINE_WEATHER = 9;
const LS_CLOUDY = 10;
const LS_SHADE = 11;
const LS_DAYLIGHT_FLUORESCENT = 12; // D 5700–7100 K
const LS_DAY_WHITE_FLUORESCENT = 13; // N 4600–5500 K
const LS_COOL_WHITE_FLUORESCENT = 14; // W 3800–4500 K
const LS_WHITE_FLUORESCENT = 15; // WW 3250–3800 K
const LS_WARM_WHITE_FLUORESCENT = 16; // L 2600–3250 K
const LS_STD_A = 17;
const LS_STD_B = 18;
const LS_STD_C = 19;
const LS_D55 = 20;
const LS_D65 = 21;
const LS_D75 = 22;
const LS_D50 = 23;
const LS_ISO_STUDIO_TUNGSTEN = 24;

/**
 * Resolve a calibration-illuminant EXIF code to its nominal color temperature
 * (Kelvin). This is the interpolation axis for dual-illuminant profiles —
 * deliberately the nominal code temperature, NOT a Planckian fit of the xy
 * (some fluorescent codes sit off the Planckian locus).
 */
function illuminantToTemperature(light: number | undefined): number {
  switch (light) {
    case LS_STD_A:
    case LS_TUNGSTEN:
      return 2850;
    case LS_ISO_STUDIO_TUNGSTEN:
      return 3200;
    case LS_D50:
      return 5000;
    case LS_D55:
    case LS_DAYLIGHT:
    case LS_FINE_WEATHER:
    case LS_FLASH:
    case LS_STD_B:
      return 5500;
    case LS_D65:
    case LS_STD_C:
    case LS_CLOUDY:
      return 6500;
    case LS_D75:
    case LS_SHADE:
      return 7500;
    case LS_DAYLIGHT_FLUORESCENT:
      return (5700.0 + 7100.0) * 0.5;
    case LS_DAY_WHITE_FLUORESCENT:
      return (4600.0 + 5500.0) * 0.5;
    case LS_COOL_WHITE_FLUORESCENT:
    case LS_FLUORESCENT:
      return (3800.0 + 4500.0) * 0.5;
    case LS_WHITE_FLUORESCENT:
      return (3250.0 + 3800.0) * 0.5;
    case LS_WARM_WHITE_FLUORESCENT:
      return (2600.0 + 3250.0) * 0.5;
    case LS_UNKNOWN:
    default:
      // 0 means "absent": the single-illuminant path never consults it, and
      // a stray dual candidate fails the temp1≠temp2 guard downstream.
      return 0.0;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Planckian locus table (Wyszecki & Stiles, "Color Science", 2nd ed., p. 228)
// ═══════════════════════════════════════════════════════════════════════════════

/** One row of the reciprocal-temperature locus table: (r = 10⁶/T, u, v, slope t). */
interface RuvT {
  readonly r: number;
  readonly u: number;
  readonly v: number;
  readonly t: number;
}

const TEMP_TABLE: readonly RuvT[] = [
  { r: 0, u: 0.18006, v: 0.26352, t: -0.24341 },
  { r: 10, u: 0.18066, v: 0.26589, t: -0.25479 },
  { r: 20, u: 0.18133, v: 0.26846, t: -0.26876 },
  { r: 30, u: 0.18208, v: 0.27119, t: -0.28539 },
  { r: 40, u: 0.18293, v: 0.27407, t: -0.30470 },
  { r: 50, u: 0.18388, v: 0.27709, t: -0.32675 },
  { r: 60, u: 0.18494, v: 0.28021, t: -0.35156 },
  { r: 70, u: 0.18611, v: 0.28342, t: -0.37915 },
  { r: 80, u: 0.18740, v: 0.28668, t: -0.40955 },
  { r: 90, u: 0.18880, v: 0.28997, t: -0.44278 },
  { r: 100, u: 0.19032, v: 0.29326, t: -0.47888 },
  { r: 125, u: 0.19462, v: 0.30141, t: -0.58204 },
  { r: 150, u: 0.19962, v: 0.30921, t: -0.70471 },
  { r: 175, u: 0.20525, v: 0.31647, t: -0.84901 },
  { r: 200, u: 0.21142, v: 0.32312, t: -1.0182 },
  { r: 225, u: 0.21807, v: 0.32909, t: -1.2168 },
  { r: 250, u: 0.22511, v: 0.33439, t: -1.4512 },
  { r: 275, u: 0.23247, v: 0.33904, t: -1.7298 },
  { r: 300, u: 0.24010, v: 0.34308, t: -2.0637 },
  { r: 325, u: 0.24702, v: 0.34655, t: -2.4681 },
  { r: 350, u: 0.25591, v: 0.34951, t: -2.9641 },
  { r: 375, u: 0.26400, v: 0.35200, t: -3.5814 },
  { r: 400, u: 0.27218, v: 0.35407, t: -4.3633 },
  { r: 425, u: 0.28039, v: 0.35577, t: -5.3762 },
  { r: 450, u: 0.28863, v: 0.35714, t: -6.7262 },
  { r: 475, u: 0.29685, v: 0.35823, t: -8.5955 },
  { r: 500, u: 0.30505, v: 0.35907, t: -11.324 },
  { r: 525, u: 0.31320, v: 0.35968, t: -15.628 },
  { r: 550, u: 0.32129, v: 0.36011, t: -23.325 },
  { r: 575, u: 0.32931, v: 0.36038, t: -40.770 },
  { r: 600, u: 0.33724, v: 0.36051, t: -116.45 },
];

/** CIE 1960 UCS uv chroma from xy. */
function xyToUV([x, y]: XY): [number, number] {
  const den = 1.5 - x + 6.0 * y;
  return [(2.0 * x) / den, (3.0 * y) / den];
}

/** xy chroma from CIE 1960 UCS uv. */
function uvToXY(u: number, v: number): XY {
  const den = u - 4.0 * v + 2.0;
  return [(1.5 * u) / den, v / den];
}

/**
 * Color temperature of the Planckian-locus point nearest an xy chroma
 * (uniform-uv distance). Tint (the off-locus offset) is deliberately not
 * computed — the interpolation axis here is temperature only.
 */
export function xyToTemperature(xy: XY): number {
  const [u, v] = xyToUV(xy);

  let lastDt = 0.0;

  for (let index = 1; index <= 30; index++) {
    // Convert the line slope to a unit (du, dv) direction vector.
    let du = 1.0;
    let dv = TEMP_TABLE[index].t;
    const len = Math.sqrt(1.0 + dv * dv);
    du /= len;
    dv /= len;

    // Distance from the blackbody point to the test coordinate, signed by side.
    const uu = u - TEMP_TABLE[index].u;
    const vv = v - TEMP_TABLE[index].v;
    let dt = -uu * dv + vv * du;

    // Below this line pair's line, interpolate between it and the previous one.
    if (dt <= 0.0 || index === 30) {
      if (dt > 0.0) dt = 0.0;
      dt = -dt;

      let f: number;
      if (index === 1) {
        f = 0.0;
      } else {
        f = dt / (lastDt + dt);
      }

      // Interpolated reciprocal temperature → temperature.
      const r = TEMP_TABLE[index - 1].r * f + TEMP_TABLE[index].r * (1.0 - f);
      return r === 0 ? Number.POSITIVE_INFINITY : 1.0e6 / r;
    }

    lastDt = dt;
  }

  return 5000; // unreachable — the loop returns on index 30
}

/**
 * xy chroma of the Planckian locus at a color temperature (tint 0 — exactly
 * on the locus). Inverse of the table walk in {@link xyToTemperature}.
 */
export function temperatureToXY(temperature: number): XY {
  const r = 1.0e6 / temperature;

  for (let index = 0; index <= 29; index++) {
    if (r < TEMP_TABLE[index + 1].r || index === 29) {
      // Relative weight of the two bracketing locus lines.
      const f =
        (TEMP_TABLE[index + 1].r - r) / (TEMP_TABLE[index + 1].r - TEMP_TABLE[index].r);

      // Interpolated blackbody uv.
      const u = TEMP_TABLE[index].u * f + TEMP_TABLE[index + 1].u * (1.0 - f);
      const v = TEMP_TABLE[index].v * f + TEMP_TABLE[index + 1].v * (1.0 - f);

      // With tint 0 the coordinate sits exactly on the interpolated point.
      return uvToXY(u, v);
    }
  }

  return uvToXY(TEMP_TABLE[30].u, TEMP_TABLE[30].v);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Small colorimetry helpers (f64 row-major 3×3, plain arrays)
// ═══════════════════════════════════════════════════════════════════════════════

type Mat = readonly number[];

/** XYZ (unit Y) from xy chroma. */
function xyToXYZ([x, y]: XY): [number, number, number] {
  return [x / y, 1.0, (1.0 - x - y) / y];
}

/** xy chroma from XYZ (any scale). */
function xyzToXY([X, Y, Z]: readonly [number, number, number]): XY {
  const sum = X + Y + Z;
  return [X / sum, Y / sum];
}

/**
 * Linearized Bradford chromatic adaptation: a 3×3 mapping white1 → white2 in
 * XYZ space, built as Mb⁻¹ · diag(scale) · Mb. Cone-response ratios are pinned
 * to [0.1, 10] and cone responses to ≥ 0 (degenerate whites stay finite).
 */
export function mapWhiteMatrix(white1: XY, white2: XY): number[] {
  const Mb = [
    0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296,
  ];

  const mul = (m: Mat, v: readonly number[]): [number, number, number] => [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];

  const w1 = mul(Mb, xyToXYZ(white1));
  const w2 = mul(Mb, xyToXYZ(white2));

  const pinScale = (a: number, b: number): number => {
    if (a <= 0.0) return 10.0;
    return Math.min(10.0, Math.max(0.1, b / a));
  };

  const A = [
    pinScale(w1[0], w2[0]), 0, 0,
    0, pinScale(w1[1], w2[1]), 0,
    0, 0, pinScale(w1[2], w2[2]),
  ];

  // B = Mb⁻¹ · A · Mb
  const invMb = mat3Inverse(Mb);
  const AMb = mulMat(A, Mb);
  return mulMat(invMb, AMb);
}

/** Row-major 3×3 multiply. */
function mulMat(a: Mat, b: Mat): number[] {
  const o = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return o;
}

/** Matrix × column vector. */
function mulVec(m: Mat, v: readonly number[]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** Diagonal matrix from a 3-vector. */
function diag(v: readonly number[]): number[] {
  return [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]];
}

/**
 * Scale a color matrix so its largest response to PCS white is exactly 1, then
 * quantize to four decimal places — the parse-time normalization shipped
 * profiles carry. The quantization is part of the canonical profile state
 * (writers emit SRATIONAL over 10⁴), so skipping it would drift every
 * downstream number away from the reference pipeline.
 */
function normalizeColorMatrix(m: number[]): number[] {
  const coord = mulVec(m, xyToXYZ(PCS_WHITE));
  const maxCoord = Math.max(coord[0], coord[1], coord[2]);
  const scaled =
    maxCoord > 0.0 && (maxCoord < 0.99 || maxCoord > 1.01)
      ? m.map((v) => v / maxCoord)
      : [...m];
  return scaled.map((v) => Math.round(v * 10000) / 10000);
}

/**
 * PCS XYZ (D50) → working space (ProPhoto linear). ProPhoto's reference white
 * IS D50, so this is the plain inverse primary matrix with NO chromatic
 * adaptation. Derived from the same primaries table every other gamut
 * conversion in the engine uses — never a hand-typed literal.
 */
const XYZ_D50_TO_WORKING: Mat = (() => {
  const p = GAMUT_PRIMARIES['prophoto-rgb'];
  const rgbToXyz = buildRgbToXyz(p.R, p.G, p.B, p.white);
  return mat3Inverse(rgbToXyz);
})();

/** RGB→XYZ primary matrix from xy primaries + white (unit Y). */
function buildRgbToXyz(
  R: readonly [number, number],
  G: readonly [number, number],
  B: readonly [number, number],
  white: readonly [number, number],
): number[] {
  const Sr = xyToXYZ(R);
  const Sg = xyToXYZ(G);
  const Sb = xyToXYZ(B);
  // Row-major matrix whose COLUMNS are the primary XYZ vectors:
  //   [Sr.x Sg.x Sb.x / Sr.y Sg.y Sb.y / Sr.z Sg.z Sb.z]
  const m = [
    Sr[0], Sg[0], Sb[0],
    Sr[1], Sg[1], Sb[1],
    Sr[2], Sg[2], Sb[2],
  ];
  // Per-primary scale factors that map the white point to XYZ(white).
  const s = solve3(m, xyToXYZ(white));
  return [
    Sr[0] * s[0], Sg[0] * s[1], Sb[0] * s[2],
    Sr[1] * s[0], Sg[1] * s[1], Sb[1] * s[2],
    Sr[2] * s[0], Sg[2] * s[1], Sb[2] * s[2],
  ];
}

/** Solve a 3×3 linear system (row-major M · x = b). */
function solve3(m: Mat, b: readonly [number, number, number]): [number, number, number] {
  const inv = mat3Inverse(m);
  return mulVec(inv, b);
}

// ═══════════════════════════════════════════════════════════════════════════════
// The camera → working pipeline
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Everything the decode stage needs to render one DNG's pixels, precomputed
 * per file: the camera→working matrix and the decoded profile's look tables
 * (consumed by the apply functions further down this module).
 */
export interface DngColorPipeline {
  /** Resolved scene white chromaticity (from the (1,1,1) camera neutral). */
  whiteXY: XY;
  /** Camera RGB (linear, white-balanced) → ProPhoto linear. Row-major f64. */
  cameraToWorking: number[];
  /** BaselineExposure gain 2^BE (linear multiply, applied after the matrix). */
  baselineExposureGain: number;
  /**
   * The per-channel scene-white gain the reference render applies to RAW
   * (unbalanced) camera pixels before the matrix — the normalized response of
   * the interpolated color matrix to the solved scene white, pinned to
   * [0.001, 1]. The calibrated chain feeds UNBALANCED Stage3-equivalent pixels
   * and multiplies by this; the legacy contract (already white-balanced input)
   * does not.
   */
  cameraWhite: readonly [number, number, number];
}

/**
 * Interpolated per-white-point camera matrices (the reference pipeline's
 * FindXYZtoCamera products), used internally while solving for the white.
 */
interface InterpolatedMatrices {
  colorMatrix: number[];
  forwardMatrix: number[] | null;
  cameraCalibration: number[];
}

/**
 * Build the complete camera→working pipeline for a parsed DNG camera profile.
 *
 * `cameraNeutral` defaults to (1, 1, 1) — the decode contract above — and is
 * only exposed as a parameter so the golden tests can drive arbitrary neutrals
 * against the reference CLI. Returns null when the profile cannot support a
 * first-principles render (no ColorMatrix1).
 */
export function buildDngColorPipeline(
  profile: DngCameraProfileData,
  cameraNeutral: readonly [number, number, number] = [1, 1, 1],
): DngColorPipeline | null {
  const cm1 = profile.colorMatrix1;
  if (!cm1) return null;

  const ab = profile.analogBalance ?? [1, 1, 1];
  const cc1 = profile.cameraCalibration1 ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const cc2 = profile.cameraCalibration2 ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];

  // Parse-time normalization (max response to PCS white == 1), then compose
  // analog balance and per-camera calibration into each color matrix.
  const norm1 = normalizeColorMatrix([...cm1]);
  let colorMatrix1 = mulMat(mulMat(diag(ab), cc1), norm1);

  const temp1 = illuminantToTemperature(profile.calibrationIlluminant1);
  const temp2Raw = illuminantToTemperature(profile.calibrationIlluminant2);
  const hasDual =
    profile.colorMatrix2 !== undefined &&
    profile.calibrationIlluminant2 !== undefined &&
    temp1 > 0 &&
    temp2Raw > 0 &&
    temp1 !== temp2Raw;

  let colorMatrix2: number[];
  let forwardMatrix1: number[] | null = null;
  let forwardMatrix2: number[] | null = null;
  let t1 = temp1;
  let t2 = temp1;

  if (!hasDual) {
    // Single-illuminant model: every interpolation degenerates to set 1.
    colorMatrix2 = colorMatrix1;
    forwardMatrix1 = profile.forwardMatrix1 ? normalizeForwardMatrix([...profile.forwardMatrix1]) : null;
    forwardMatrix2 = forwardMatrix1;
    t1 = 5000;
    t2 = 5000;
  } else {
    const norm2 = normalizeColorMatrix([...profile.colorMatrix2!]);
    colorMatrix2 = mulMat(mulMat(diag(ab), cc2), norm2);
    forwardMatrix1 = profile.forwardMatrix1 ? normalizeForwardMatrix([...profile.forwardMatrix1]) : null;
    forwardMatrix2 = profile.forwardMatrix2 ? normalizeForwardMatrix([...profile.forwardMatrix2]) : null;
    t1 = temp1;
    t2 = temp2Raw;
    // Swap so t1 < t2 (the weights assume an ordered axis).
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      [colorMatrix1, colorMatrix2] = [colorMatrix2, colorMatrix1];
      [forwardMatrix1, forwardMatrix2] = [forwardMatrix2, forwardMatrix1];
    }
  }

  const interp = (white: XY): InterpolatedMatrices => {
    const t = xyToTemperature(white);
    // Weight of set 1 on the INVERSE temperature axis (the reference model's
    // interpolation domain — linear-in-temperature weights skew warm scenes).
    let g: number;
    if (t <= t1) {
      g = 1.0;
    } else if (t >= t2) {
      g = 0.0;
    } else {
      const invT = 1.0 / t;
      g = (invT - 1.0 / t2) / (1.0 / t1 - 1.0 / t2);
    }

    const lerp = (a: number, b: number): number => a * g + b * (1.0 - g);
    const colorMatrix = colorMatrix1.map((v, i) => lerp(v, colorMatrix2[i]));

    let forwardMatrix: number[] | null = null;
    if (forwardMatrix1 && forwardMatrix2) {
      forwardMatrix = forwardMatrix1.map((v, i) => lerp(v, forwardMatrix2![i]));
    } else if (forwardMatrix1) {
      forwardMatrix = forwardMatrix1;
    } else if (forwardMatrix2) {
      forwardMatrix = forwardMatrix2;
    }

    const cameraCalibration = cc1.map((v, i) => lerp(v, cc2[i]));
    return { colorMatrix, forwardMatrix, cameraCalibration };
  };

  // Solve for the scene white: find the white whose predicted camera neutral
  // (through the interpolated color matrix) reproduces the actual neutral.
  // Fixed-point iteration from PCS white, 30 passes, converging on 1e-7 xy
  // distance; a non-converged oscillation degrades to the midpoint estimate.
  let last: XY = PCS_WHITE;
  let white: XY = last;
  for (let pass = 0; pass < 30; pass++) {
    const { colorMatrix } = interp(last);
    const inv = mat3Inverse(colorMatrix);
    const predictedXYZ = mulVec(inv, [cameraNeutral[0], cameraNeutral[1], cameraNeutral[2]]);
    const next = xyzToXY(predictedXYZ);
    white = next;
    if (Math.abs(next[0] - last[0]) + Math.abs(next[1] - last[1]) < 0.0000001) {
      break;
    }
    if (pass === 29) {
      white = [(last[0] + next[0]) * 0.5, (last[1] + next[1]) * 0.5];
    }
    last = next;
  }

  // Build camera→PCS at the resolved white.
  const { colorMatrix, forwardMatrix, cameraCalibration } = interp(white);

  // Camera white: the interpolated matrix's response to scene white, pinned
  // to (0.001, 1] per channel after full-scale normalization.
  const cameraWhiteRaw = mulVec(colorMatrix, xyToXYZ(white));
  const cameraWhiteMax = Math.max(...cameraWhiteRaw);
  if (cameraWhiteMax === 0) return null;
  const cameraWhite = cameraWhiteRaw.map((v) =>
    Math.min(1.0, Math.max(0.001, v / cameraWhiteMax)),
  );

  let cameraToPCS: number[];
  if (forwardMatrix) {
    // Forward-matrix branch: FM maps the reference camera white (after
    // removing analog balance and calibration) to PCS white.
    const individualToReference = mat3Inverse(mulMat(diag(ab), cameraCalibration));
    const refCameraWhite = mulVec(individualToReference, cameraWhite);
    if (refCameraWhite.some((v) => v === 0)) return null;
    cameraToPCS = mulMat(
      mulMat(forwardMatrix, mat3Inverse(diag(refCameraWhite))),
      individualToReference,
    );
  } else {
    // XYZ-adapt branch: invert the PCS→camera matrix, which the reference
    // pipeline scales so PCS white saturates the largest camera channel.
    const pcsToCamera = mulMat(colorMatrix, mapWhiteMatrix(PCS_WHITE, white));
    const pcsResponse = mulVec(pcsToCamera, xyToXYZ(PCS_WHITE));
    const scale = Math.max(pcsResponse[0], pcsResponse[1], pcsResponse[2]);
    if (scale === 0) return null;
    const scaled = pcsToCamera.map((v) => v / scale);
    cameraToPCS = mat3Inverse(scaled);
  }

  const cameraToWorking = mulMat(XYZ_D50_TO_WORKING, cameraToPCS);

  return {
    whiteXY: white,
    cameraToWorking,
    baselineExposureGain: Math.pow(2, profile.baselineExposure ?? 0),
    cameraWhite: cameraWhite as [number, number, number],
  };
}

/**
 * Scale a forward matrix so it maps the unit cube corner (1,1,1) — the
 * reference camera white — to PCS XYZ exactly:
 * FM' = diag(PCS_XYZ) · diag(FM·(1,1,1))⁻¹ · FM. The decode path composes
 * FM with diag(1/refCameraWhite), so this normalization is what makes
 * camera white land on PCS white.
 */
function normalizeForwardMatrix(m: number[]): number[] {
  const mapped = mulVec(m, [1, 1, 1]);
  const pcs = xyToXYZ(PCS_WHITE);
  return [
    (pcs[0] * m[0]) / mapped[0], (pcs[0] * m[1]) / mapped[0], (pcs[0] * m[2]) / mapped[0],
    (pcs[1] * m[3]) / mapped[1], (pcs[1] * m[4]) / mapped[1], (pcs[1] * m[5]) / mapped[1],
    (pcs[2] * m[6]) / mapped[2], (pcs[2] * m[7]) / mapped[2], (pcs[2] * m[8]) / mapped[2],
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Profile look tables: HueSatMap / LookTable application
// ═══════════════════════════════════════════════════════════════════════════════

/** A resolved hue/sat/val grid (either the HueSatMap pair or a LookTable). */
export interface HueSatGrid {
  hueDivisions: number;
  satDivisions: number;
  valDivisions: number;
  /** `data[v * hueDivisions * satDivisions + h * satDivisions + s]` → (hueShift°, satScale, valScale). */
  deltas: ReadonlyArray<readonly [number, number, number]>;
}

/**
 * Blend a dual-illuminant HueSatMap pair into ONE grid for the pipeline's
 * resolved white, using the same inverse-temperature weights as the matrices.
 * The illuminant codes come from the profile (the grid pair's own calibration
 * tags). Single-table profiles pass straight through. Returns null when
 * neither table is usable.
 */
export function interpolateHueSatGridForProfile(
  data1: HueSatGrid | undefined,
  data2: HueSatGrid | undefined,
  profile: DngCameraProfileData,
  whiteXY: XY,
): HueSatGrid | null {
  if (!data2) return data1 ?? null;
  return interpolateHueSatGrid(
    data1,
    data2,
    whiteXY,
    illuminantToTemperature(profile.calibrationIlluminant1),
    illuminantToTemperature(profile.calibrationIlluminant2),
  );
}

/**
 * Blend a dual-illuminant HueSatMap pair into ONE grid for the pipeline's
 * resolved white, using the same inverse-temperature weights as the matrices.
 * Single-table profiles pass straight through. Returns null when neither
 * table is usable.
 */
export function interpolateHueSatGrid(
  data1: HueSatGrid | undefined,
  data2: HueSatGrid | undefined,
  whiteXY: XY,
  temp1: number,
  temp2: number,
): HueSatGrid | null {
  if (!data1 && !data2) return null;
  if (!data2 || data1 === data2) return data1 ?? null;
  if (!data1) return data2;
  if (data1.hueDivisions !== data2.hueDivisions ||
      data1.satDivisions !== data2.satDivisions ||
      data1.valDivisions !== data2.valDivisions) {
    return data1; // mismatched grids: the first (mandatory) table wins
  }

  const t = xyToTemperature(whiteXY);
  let g: number;
  if (t <= temp1) {
    g = 1.0;
  } else if (t >= temp2) {
    g = 0.0;
  } else {
    const invT = 1.0 / t;
    g = (invT - 1.0 / temp2) / (1.0 / temp1 - 1.0 / temp2);
  }

  const deltas = data1.deltas.map((d, i) => {
    const e = data2.deltas[i];
    return [
      d[0] * g + e[0] * (1.0 - g),
      d[1] * g + e[1] * (1.0 - g),
      d[2] * g + e[2] * (1.0 - g),
    ] as [number, number, number];
  });
  return { ...data1, deltas };
}

/** RGB (≥0, linear) → HSV with hue in [0, 6) turns, s/v in [0, 1]. */
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const v = Math.max(r, g, b);
  const gap = v - Math.min(r, g, b);
  if (gap <= 0.0) return [0, 0, v];
  let h: number;
  if (r === v) {
    h = (g - b) / gap;
    if (h < 0.0) h += 6.0;
  } else if (g === v) {
    h = 2.0 + (b - r) / gap;
  } else {
    h = 4.0 + (r - g) / gap;
  }
  return [h, gap / v, v];
}

/** HSV (hue in [0, 6) turns) → RGB. */
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  if (s <= 0.0) return [v, v, v];
  h = h % 6.0;
  if (h < 0.0) h += 6.0;
  const i = Math.floor(h);
  const f = h - i;
  const p = v * (1.0 - s);
  const q = v * (1.0 - s * f);
  const t = v * (1.0 - s * (1.0 - f));
  switch (i) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q]; // 5, and the i==6 wrap edge
  }
}

/**
 * Apply one hue/sat/val grid to an RGB triple (linear light, ≥ 0). This is
 * the reference lookup exactly: hue wraps circularly, saturation/value clamp
 * at the last division, hueShift arrives in degrees and converts to the
 * internal [0, 6) turn scale, and the resulting saturation is re-pinned ≤ 1.
 */
export function applyHueSatGrid(
  grid: HueSatGrid,
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const { hueDivisions, satDivisions, valDivisions } = grid;
  const hScale = hueDivisions < 2 ? 0.0 : hueDivisions * (1.0 / 6.0);
  const sScale = satDivisions - 1;
  const vScale = valDivisions - 1;

  // Pin negatives (the reference's overrange path only engages for non-linear
  // value encodings, which no current writer uses).
  r = Math.max(0, r);
  g = Math.max(0, g);
  b = Math.max(0, b);

  let [h, s, v] = rgbToHsv(r, g, b);

  const maxHueIndex0 = hueDivisions - 1;
  const maxSatIndex0 = satDivisions - 2;
  const maxValIndex0 = valDivisions - 2;

  const hueStep = satDivisions;
  const valStep = hueDivisions * hueStep;

  const hScaled = h * hScale;
  const sScaled = s * sScale;
  const vScaled = v * vScale;

  let hIndex0 = Math.floor(hScaled);
  let sIndex0 = Math.max(0, Math.floor(sScaled));
  let vIndex0 = Math.max(0, Math.floor(vScaled));

  sIndex0 = Math.min(sIndex0, Math.max(0, maxSatIndex0));
  vIndex0 = Math.min(vIndex0, Math.max(0, maxValIndex0));

  let hIndex1 = hIndex0 + 1;
  if (hIndex0 >= maxHueIndex0) {
    hIndex0 = maxHueIndex0;
    hIndex1 = 0;
  }

  const hFrac1 = hScaled - hIndex0;
  const sFrac1 = sScaled - sIndex0;
  const vFrac1 = vScaled - vIndex0;
  const hFrac0 = 1.0 - hFrac1;
  const sFrac0 = 1.0 - sFrac1;
  // "2.5D" tables (valDivisions == 1) have no value axis to blend.
  const hasVal = valDivisions >= 2;
  const vFrac0 = hasVal ? 1.0 - vFrac1 : 1.0;
  const vFrac1b = hasVal ? vFrac1 : 0.0;

  const idx = (vv: number, hh: number, ss: number): number =>
    vv * valStep + hh * hueStep + ss;

  // The value axis reads the (v, v+1) row pair unclamped (+1 row exists
  // whenever valDivisions ≥ 2 — see the reference clamp analysis).
  const vRow0 = vIndex0;
  const vRow1 = hasVal ? vIndex0 + 1 : 0;

  // Saturation axis blends the (s, s+1) column pair.
  const sNext = Math.min(sIndex0 + 1, satDivisions - 1);

  // Two-axis blend inside one value row: hue × saturation bilinear.
  const rowBlend = (vv: number): [number, number, number] => {
    const a = grid.deltas[idx(vv, hIndex0, sIndex0)];
    const b = grid.deltas[idx(vv, hIndex1, sIndex0)];
    const c = grid.deltas[idx(vv, hIndex0, sNext)];
    const d = grid.deltas[idx(vv, hIndex1, sNext)];
    const blend = (k: number): number =>
      (hFrac0 * a[k] + hFrac1 * b[k]) * sFrac0 + (hFrac0 * c[k] + hFrac1 * d[k]) * sFrac1;
    return [blend(0), blend(1), blend(2)];
  };

  const row0 = rowBlend(vRow0);
  const row1 = hasVal ? rowBlend(vRow1) : row0;
  const hueShift = row0[0] * vFrac0 + row1[0] * vFrac1b;
  const satScale = row0[1] * vFrac0 + row1[1] * vFrac1b;
  const valScale = row0[2] * vFrac0 + row1[2] * vFrac1b;

  h += hueShift * (6.0 / 360.0); // degrees → internal turns
  s = Math.min(s * satScale, 1.0);
  let vOut = v * valScale;
  if (vOut < 0) vOut = 0; else if (vOut > 1) vOut = 1;
  v = vOut;

  return hsvToRgb(h, s, v);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ProfileToneCurve (1D monotone map, per channel)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Apply a profile tone curve (monotone (input, output) pairs, both in [0, 1])
 * to one channel value. Values outside [0, 1] pass through unclamped when they
 * are outside the curve's stated domain (the curve only owns its own range);
 * inside, linear interpolation between control points.
 */
export function applyToneCurve1d(
  points: ReadonlyArray<readonly [number, number]>,
  v: number,
): number {
  if (points.length === 0) return v;
  if (v < points[0][0] || v > points[points.length - 1][0]) return v;
  for (let i = 1; i < points.length; i++) {
    if (v <= points[i][0]) {
      const [x0, y0] = points[i - 1];
      const [x1, y1] = points[i];
      const span = x1 - x0;
      if (span <= 0) return y1;
      return y0 + ((v - x0) / span) * (y1 - y0);
    }
  }
  return points[points.length - 1][1];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Default render tone: exposure ramp + exposure tone + default contrast curve
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The specification reference render's DEFAULT tone curve (the "ACR3-style"
 * 1025-entry monotone table shipped as the host default in the reference
 * implementation): a film-like contrast curve that darkens midtones
 * (0.5 → 0.24) and carries a long highlight shoulder (0.9 → 0.66, 1.0 → 1.0).
 * This shoulder is what turns the scene-linear matrix output into a
 * display-referred render — without it, a +EV BaselineExposure pushes most of
 * a high-key capture above display white and the image blows out.
 *
 * The table is stated verbatim from the reference implementation (dev-machine
 * vendored copy, golden-verified) rather than re-derived: its shape IS the
 * rendering intent.
 */
/**
 * The reference render's DEFAULT tone curve — the 1025-entry monotone table
 * the reference renderer installs when the profile carries no ProfileToneCurve:
 * a film-like contrast curve that lifts midtones (0.5 → 0.80) with a long
 * highlight shoulder (1.0 → 1.0). Stated verbatim from the reference
 * implementation and pixel-verified against its own render output.
 */
const ACR3_TONE_CURVE = new Float32Array([
  0.00000, 0.00078, 0.00160, 0.00242, 0.00314, 0.00385, 0.00460, 0.00539,
  0.00623, 0.00712, 0.00806, 0.00906, 0.01012, 0.01122, 0.01238, 0.01359,
  0.01485, 0.01616, 0.01751, 0.01890, 0.02033, 0.02180, 0.02331, 0.02485,
  0.02643, 0.02804, 0.02967, 0.03134, 0.03303, 0.03475, 0.03648, 0.03824,
  0.04002, 0.04181, 0.04362, 0.04545, 0.04730, 0.04916, 0.05103, 0.05292,
  0.05483, 0.05675, 0.05868, 0.06063, 0.06259, 0.06457, 0.06655, 0.06856,
  0.07057, 0.07259, 0.07463, 0.07668, 0.07874, 0.08081, 0.08290, 0.08499,
  0.08710, 0.08921, 0.09134, 0.09348, 0.09563, 0.09779, 0.09996, 0.10214,
  0.10433, 0.10652, 0.10873, 0.11095, 0.11318, 0.11541, 0.11766, 0.11991,
  0.12218, 0.12445, 0.12673, 0.12902, 0.13132, 0.13363, 0.13595, 0.13827,
  0.14061, 0.14295, 0.14530, 0.14765, 0.15002, 0.15239, 0.15477, 0.15716,
  0.15956, 0.16197, 0.16438, 0.16680, 0.16923, 0.17166, 0.17410, 0.17655,
  0.17901, 0.18148, 0.18395, 0.18643, 0.18891, 0.19141, 0.19391, 0.19641,
  0.19893, 0.20145, 0.20398, 0.20651, 0.20905, 0.21160, 0.21416, 0.21672,
  0.21929, 0.22185, 0.22440, 0.22696, 0.22950, 0.23204, 0.23458, 0.23711,
  0.23963, 0.24215, 0.24466, 0.24717, 0.24967, 0.25216, 0.25465, 0.25713,
  0.25961, 0.26208, 0.26454, 0.26700, 0.26945, 0.27189, 0.27433, 0.27676,
  0.27918, 0.28160, 0.28401, 0.28641, 0.28881, 0.29120, 0.29358, 0.29596,
  0.29833, 0.30069, 0.30305, 0.30540, 0.30774, 0.31008, 0.31241, 0.31473,
  0.31704, 0.31935, 0.32165, 0.32395, 0.32623, 0.32851, 0.33079, 0.33305,
  0.33531, 0.33756, 0.33981, 0.34205, 0.34428, 0.34650, 0.34872, 0.35093,
  0.35313, 0.35532, 0.35751, 0.35969, 0.36187, 0.36404, 0.36620, 0.36835,
  0.37050, 0.37264, 0.37477, 0.37689, 0.37901, 0.38112, 0.38323, 0.38533,
  0.38742, 0.38950, 0.39158, 0.39365, 0.39571, 0.39777, 0.39982, 0.40186,
  0.40389, 0.40592, 0.40794, 0.40996, 0.41197, 0.41397, 0.41596, 0.41795,
  0.41993, 0.42191, 0.42388, 0.42584, 0.42779, 0.42974, 0.43168, 0.43362,
  0.43554, 0.43747, 0.43938, 0.44129, 0.44319, 0.44509, 0.44698, 0.44886,
  0.45073, 0.45260, 0.45447, 0.45632, 0.45817, 0.46002, 0.46186, 0.46369,
  0.46551, 0.46733, 0.46914, 0.47095, 0.47275, 0.47454, 0.47633, 0.47811,
  0.47989, 0.48166, 0.48342, 0.48518, 0.48693, 0.48867, 0.49041, 0.49214,
  0.49387, 0.49559, 0.49730, 0.49901, 0.50072, 0.50241, 0.50410, 0.50579,
  0.50747, 0.50914, 0.51081, 0.51247, 0.51413, 0.51578, 0.51742, 0.51906,
  0.52069, 0.52232, 0.52394, 0.52556, 0.52717, 0.52878, 0.53038, 0.53197,
  0.53356, 0.53514, 0.53672, 0.53829, 0.53986, 0.54142, 0.54297, 0.54452,
  0.54607, 0.54761, 0.54914, 0.55067, 0.55220, 0.55371, 0.55523, 0.55673,
  0.55824, 0.55973, 0.56123, 0.56271, 0.56420, 0.56567, 0.56715, 0.56861,
  0.57007, 0.57153, 0.57298, 0.57443, 0.57587, 0.57731, 0.57874, 0.58017,
  0.58159, 0.58301, 0.58443, 0.58583, 0.58724, 0.58864, 0.59003, 0.59142,
  0.59281, 0.59419, 0.59556, 0.59694, 0.59830, 0.59966, 0.60102, 0.60238,
  0.60373, 0.60507, 0.60641, 0.60775, 0.60908, 0.61040, 0.61173, 0.61305,
  0.61436, 0.61567, 0.61698, 0.61828, 0.61957, 0.62087, 0.62216, 0.62344,
  0.62472, 0.62600, 0.62727, 0.62854, 0.62980, 0.63106, 0.63232, 0.63357,
  0.63482, 0.63606, 0.63730, 0.63854, 0.63977, 0.64100, 0.64222, 0.64344,
  0.64466, 0.64587, 0.64708, 0.64829, 0.64949, 0.65069, 0.65188, 0.65307,
  0.65426, 0.65544, 0.65662, 0.65779, 0.65897, 0.66013, 0.66130, 0.66246,
  0.66362, 0.66477, 0.66592, 0.66707, 0.66821, 0.66935, 0.67048, 0.67162,
  0.67275, 0.67387, 0.67499, 0.67611, 0.67723, 0.67834, 0.67945, 0.68055,
  0.68165, 0.68275, 0.68385, 0.68494, 0.68603, 0.68711, 0.68819, 0.68927,
  0.69035, 0.69142, 0.69249, 0.69355, 0.69461, 0.69567, 0.69673, 0.69778,
  0.69883, 0.69988, 0.70092, 0.70196, 0.70300, 0.70403, 0.70506, 0.70609,
  0.70711, 0.70813, 0.70915, 0.71017, 0.71118, 0.71219, 0.71319, 0.71420,
  0.71520, 0.71620, 0.71719, 0.71818, 0.71917, 0.72016, 0.72114, 0.72212,
  0.72309, 0.72407, 0.72504, 0.72601, 0.72697, 0.72794, 0.72890, 0.72985,
  0.73081, 0.73176, 0.73271, 0.73365, 0.73460, 0.73554, 0.73647, 0.73741,
  0.73834, 0.73927, 0.74020, 0.74112, 0.74204, 0.74296, 0.74388, 0.74479,
  0.74570, 0.74661, 0.74751, 0.74842, 0.74932, 0.75021, 0.75111, 0.75200,
  0.75289, 0.75378, 0.75466, 0.75555, 0.75643, 0.75730, 0.75818, 0.75905,
  0.75992, 0.76079, 0.76165, 0.76251, 0.76337, 0.76423, 0.76508, 0.76594,
  0.76679, 0.76763, 0.76848, 0.76932, 0.77016, 0.77100, 0.77183, 0.77267,
  0.77350, 0.77432, 0.77515, 0.77597, 0.77680, 0.77761, 0.77843, 0.77924,
  0.78006, 0.78087, 0.78167, 0.78248, 0.78328, 0.78408, 0.78488, 0.78568,
  0.78647, 0.78726, 0.78805, 0.78884, 0.78962, 0.79040, 0.79118, 0.79196,
  0.79274, 0.79351, 0.79428, 0.79505, 0.79582, 0.79658, 0.79735, 0.79811,
  0.79887, 0.79962, 0.80038, 0.80113, 0.80188, 0.80263, 0.80337, 0.80412,
  0.80486, 0.80560, 0.80634, 0.80707, 0.80780, 0.80854, 0.80926, 0.80999,
  0.81072, 0.81144, 0.81216, 0.81288, 0.81360, 0.81431, 0.81503, 0.81574,
  0.81645, 0.81715, 0.81786, 0.81856, 0.81926, 0.81996, 0.82066, 0.82135,
  0.82205, 0.82274, 0.82343, 0.82412, 0.82480, 0.82549, 0.82617, 0.82685,
  0.82753, 0.82820, 0.82888, 0.82955, 0.83022, 0.83089, 0.83155, 0.83222,
  0.83288, 0.83354, 0.83420, 0.83486, 0.83552, 0.83617, 0.83682, 0.83747,
  0.83812, 0.83877, 0.83941, 0.84005, 0.84069, 0.84133, 0.84197, 0.84261,
  0.84324, 0.84387, 0.84450, 0.84513, 0.84576, 0.84639, 0.84701, 0.84763,
  0.84825, 0.84887, 0.84949, 0.85010, 0.85071, 0.85132, 0.85193, 0.85254,
  0.85315, 0.85375, 0.85436, 0.85496, 0.85556, 0.85615, 0.85675, 0.85735,
  0.85794, 0.85853, 0.85912, 0.85971, 0.86029, 0.86088, 0.86146, 0.86204,
  0.86262, 0.86320, 0.86378, 0.86435, 0.86493, 0.86550, 0.86607, 0.86664,
  0.86720, 0.86777, 0.86833, 0.86889, 0.86945, 0.87001, 0.87057, 0.87113,
  0.87168, 0.87223, 0.87278, 0.87333, 0.87388, 0.87443, 0.87497, 0.87552,
  0.87606, 0.87660, 0.87714, 0.87768, 0.87821, 0.87875, 0.87928, 0.87981,
  0.88034, 0.88087, 0.88140, 0.88192, 0.88244, 0.88297, 0.88349, 0.88401,
  0.88453, 0.88504, 0.88556, 0.88607, 0.88658, 0.88709, 0.88760, 0.88811,
  0.88862, 0.88912, 0.88963, 0.89013, 0.89063, 0.89113, 0.89163, 0.89212,
  0.89262, 0.89311, 0.89360, 0.89409, 0.89458, 0.89507, 0.89556, 0.89604,
  0.89653, 0.89701, 0.89749, 0.89797, 0.89845, 0.89892, 0.89940, 0.89987,
  0.90035, 0.90082, 0.90129, 0.90176, 0.90222, 0.90269, 0.90316, 0.90362,
  0.90408, 0.90454, 0.90500, 0.90546, 0.90592, 0.90637, 0.90683, 0.90728,
  0.90773, 0.90818, 0.90863, 0.90908, 0.90952, 0.90997, 0.91041, 0.91085,
  0.91130, 0.91173, 0.91217, 0.91261, 0.91305, 0.91348, 0.91392, 0.91435,
  0.91478, 0.91521, 0.91564, 0.91606, 0.91649, 0.91691, 0.91734, 0.91776,
  0.91818, 0.91860, 0.91902, 0.91944, 0.91985, 0.92027, 0.92068, 0.92109,
  0.92150, 0.92191, 0.92232, 0.92273, 0.92314, 0.92354, 0.92395, 0.92435,
  0.92475, 0.92515, 0.92555, 0.92595, 0.92634, 0.92674, 0.92713, 0.92753,
  0.92792, 0.92831, 0.92870, 0.92909, 0.92947, 0.92986, 0.93025, 0.93063,
  0.93101, 0.93139, 0.93177, 0.93215, 0.93253, 0.93291, 0.93328, 0.93366,
  0.93403, 0.93440, 0.93478, 0.93515, 0.93551, 0.93588, 0.93625, 0.93661,
  0.93698, 0.93734, 0.93770, 0.93807, 0.93843, 0.93878, 0.93914, 0.93950,
  0.93986, 0.94021, 0.94056, 0.94092, 0.94127, 0.94162, 0.94197, 0.94231,
  0.94266, 0.94301, 0.94335, 0.94369, 0.94404, 0.94438, 0.94472, 0.94506,
  0.94540, 0.94573, 0.94607, 0.94641, 0.94674, 0.94707, 0.94740, 0.94774,
  0.94807, 0.94839, 0.94872, 0.94905, 0.94937, 0.94970, 0.95002, 0.95035,
  0.95067, 0.95099, 0.95131, 0.95163, 0.95194, 0.95226, 0.95257, 0.95289,
  0.95320, 0.95351, 0.95383, 0.95414, 0.95445, 0.95475, 0.95506, 0.95537,
  0.95567, 0.95598, 0.95628, 0.95658, 0.95688, 0.95718, 0.95748, 0.95778,
  0.95808, 0.95838, 0.95867, 0.95897, 0.95926, 0.95955, 0.95984, 0.96013,
  0.96042, 0.96071, 0.96100, 0.96129, 0.96157, 0.96186, 0.96214, 0.96242,
  0.96271, 0.96299, 0.96327, 0.96355, 0.96382, 0.96410, 0.96438, 0.96465,
  0.96493, 0.96520, 0.96547, 0.96574, 0.96602, 0.96629, 0.96655, 0.96682,
  0.96709, 0.96735, 0.96762, 0.96788, 0.96815, 0.96841, 0.96867, 0.96893,
  0.96919, 0.96945, 0.96971, 0.96996, 0.97022, 0.97047, 0.97073, 0.97098,
  0.97123, 0.97149, 0.97174, 0.97199, 0.97223, 0.97248, 0.97273, 0.97297,
  0.97322, 0.97346, 0.97371, 0.97395, 0.97419, 0.97443, 0.97467, 0.97491,
  0.97515, 0.97539, 0.97562, 0.97586, 0.97609, 0.97633, 0.97656, 0.97679,
  0.97702, 0.97725, 0.97748, 0.97771, 0.97794, 0.97817, 0.97839, 0.97862,
  0.97884, 0.97907, 0.97929, 0.97951, 0.97973, 0.97995, 0.98017, 0.98039,
  0.98061, 0.98082, 0.98104, 0.98125, 0.98147, 0.98168, 0.98189, 0.98211,
  0.98232, 0.98253, 0.98274, 0.98295, 0.98315, 0.98336, 0.98357, 0.98377,
  0.98398, 0.98418, 0.98438, 0.98458, 0.98478, 0.98498, 0.98518, 0.98538,
  0.98558, 0.98578, 0.98597, 0.98617, 0.98636, 0.98656, 0.98675, 0.98694,
  0.98714, 0.98733, 0.98752, 0.98771, 0.98789, 0.98808, 0.98827, 0.98845,
  0.98864, 0.98882, 0.98901, 0.98919, 0.98937, 0.98955, 0.98973, 0.98991,
  0.99009, 0.99027, 0.99045, 0.99063, 0.99080, 0.99098, 0.99115, 0.99133,
  0.99150, 0.99167, 0.99184, 0.99201, 0.99218, 0.99235, 0.99252, 0.99269,
  0.99285, 0.99302, 0.99319, 0.99335, 0.99351, 0.99368, 0.99384, 0.99400,
  0.99416, 0.99432, 0.99448, 0.99464, 0.99480, 0.99495, 0.99511, 0.99527,
  0.99542, 0.99558, 0.99573, 0.99588, 0.99603, 0.99619, 0.99634, 0.99649,
  0.99664, 0.99678, 0.99693, 0.99708, 0.99722, 0.99737, 0.99751, 0.99766,
  0.99780, 0.99794, 0.99809, 0.99823, 0.99837, 0.99851, 0.99865, 0.99879,
  0.99892, 0.99906, 0.99920, 0.99933, 0.99947, 0.99960, 0.99974, 0.99987,
  1.00000,
]);

/**
 * Evaluate the default tone curve at x (linear interpolation over the table;
 * x outside [0, 1] is pinned — callers clamp upstream).
 */
export function applyDefaultToneCurve(x: number): number {
  const n = ACR3_TONE_CURVE.length - 1;
  const idx = x * n;
  let i0 = idx | 0;
  if (i0 < 0) i0 = 0; else if (i0 > n - 1) i0 = n - 1;
  return ACR3_TONE_CURVE[i0] + (ACR3_TONE_CURVE[i0 + 1] - ACR3_TONE_CURVE[i0]) * (idx - i0);
}

/**
 * Exposure ramp (SDR): rescales the scene line so the BaselineExposure-shifted
 * white lands on display white, hard-clipping above. In the reference render
 * the BaselineExposure gain lives HERE (not as a raw pixel multiply): a +EV
 * capture declares "sensor white minus EV is my render white".
 */
export function applyExposureRampSdr(x: number, exposure: number): number {
  const y = x * Math.pow(2, Math.max(0, exposure));
  return y < 0 ? 0 : y > 1 ? 1 : y;
}

/**
 * The reference render's exposure ramp with its shadow pedestal — the exact
 * `dng_function_exposure_ramp` construction: `black = shadows × ShadowScale ×
 * Stage3Gain × 0.001` (default shadow clip 5/1000 × ShadowScale), `white =
 * 2^−max(0, exposure)`, and a quadratic toe of half-width
 * `min(0.5·black, (white−black)/16)` blending into the linear
 * `(x − black)/(white − black)` body. SDR: the body clamps at display white.
 */
export function makeExposureRamp(
  exposure: number,
  shadowScale: number,
): (x: number) => number {
  const white = 1 / Math.pow(2, Math.max(0, exposure));
  const minBlack = 5.0 * shadowScale * 0.001;
  const black = Math.min(minBlack, 0.99 * white);
  const slope = 1 / (white - black);
  const radius = Math.min(0.5 * black, (1 / 16) / slope);
  const qScale = radius > 0 ? slope / (4 * radius) : 0;
  return (x: number): number => {
    if (x <= black - radius) return 0;
    if (x >= black + radius) {
      const y = (x - black) * slope;
      return y > 1 ? 1 : y;
    }
    const y = x - (black - radius);
    return qScale * y * y;
  };
}

/**
 * Exposure tone (the negative-exposure half of the reference tone pair):
 * darkens with a quadratic roll-off over the top two stops so pure white stays
 * pure white. Identity for exposure ≥ 0.
 */
export function applyExposureTone(x: number, exposure: number): number {
  if (exposure >= 0) return x;
  const slope = Math.pow(2, exposure);
  const a = (16.0 / 9.0) * (1.0 - slope);
  const b = slope - 0.5 * a;
  const c = 1.0 - a - b;
  return x <= 0.25 ? x * slope : (a * x + b) * x + c;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Baked profile look: HueSatMap + LookTable + ToneCurve fused into one LUT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The profile's look stages (HueSatMap → LookTable → ToneCurve) fused into a
 * single 33³ RGB lattice in the working-linear domain.
 *
 * WHY FUSED: the render order applies these three stages sequentially after
 * the matrix + exposure + gain-table steps. Each stage is per-pixel HSV-grid
 * or curve math; running all three per pixel on a 12MP+ image costs seconds
 * in JS. All three are pure color-to-color maps with no spatial or exposure
 * dependence, so they bake into one 3D lattice (bake: tens of ms; per pixel:
 * one trilinear lookup). The gain-table stage does NOT fold in — it is
 * spatial and sits BEFORE these stages in the render order.
 *
 * Domain trade: the lattice covers [0, 1]³. Specular overrange (> 1) clamps
 * at the lattice edge, so look shaping above display white is flat — the
 * standard 3D-LUT domain trade; the overrange truth itself survives (the
 * lookup output is interpolated, never clamped to the input range).
 */
export interface BakedProfileLook {
  /** Lattice edge length (33 → 35937 × 3 f32 ≈ 430 KB). */
  size: number;
  /** `lut[(b * size * size + g * size + r) * 3 + c]` — working-linear RGB out. */
  lut: Float32Array;
}

/**
 * Lattice coordinate encoding. Grid points are spaced uniformly in a
 * GAMMA-ENCODED domain (x^(1/2.2)), not linear light: the HSV look maps vary
 * fastest in the shadows, and a linear-spaced 33³ lattice leaves the darkest
 * stop with one or two cells (measured: 8-bit p95 error 12 vs reference at
 * linear spacing, 1 when evaluated exactly). Outputs stay linear.
 */
const LATTICE_GAMMA = 2.2;
const encodeLattice = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 1 : Math.pow(v, 1 / LATTICE_GAMMA));
const decodeLattice = (v: number): number => Math.pow(v, LATTICE_GAMMA);

/** Shared lattice baker: maps each (encoded-domain) lattice color through `fn`. */
function bakeLattice(
  fn: (r: number, g: number, b: number) => [number, number, number],
): BakedProfileLook {
  const size = 33;
  const lut = new Float32Array(size * size * size * 3);
  let k = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const [cr, cg, cb] = fn(
          decodeLattice(r / (size - 1)),
          decodeLattice(g / (size - 1)),
          decodeLattice(b / (size - 1)),
        );
        lut[k++] = cr;
        lut[k++] = cg;
        lut[k++] = cb;
      }
    }
  }
  return { size, lut };
}

/**
 * Bake the profile HueSatMap stage into its own lattice — it sits BEFORE the
 * gain-table stage in the reference render order (matrix → HSM → gain table →
 * exposure ramp → LookTable → tone), so it cannot share a lattice with the
 * later look stages. Returns null when the profile has no HueSatMap (the
 * common case: the look lives in the gain table instead).
 */
export function bakeHueSatLut(grid: HueSatGrid | null): BakedProfileLook | null {
  if (!grid) return null;
  return bakeLattice((r, g, b) => applyHueSatGrid(grid, r, g, b));
}

/**
 * Bake the LookTable stage into its own lattice — it sits AFTER the exposure
 * ramp in the reference render order (matrix → HSM → gain table → exposure
 * ramp → LookTable → tone), so it cannot share a lattice with the HueSatMap
 * stage. Returns null when the profile has no LookTable.
 */
export function bakeLookTableLut(lookTable: HueSatGrid | null): BakedProfileLook | null {
  if (!lookTable) return null;
  return bakeLattice((r, g, b) => applyHueSatGrid(lookTable, r, g, b));
}

/**
 * The reference render's profile tone curve — a natural cubic spline through
 * the file's ProfileToneCurve control points (C0/C1/C2 continuous, zero second
 * derivative at the ends), solved exactly as the reference pipeline's spline
 * solver does. The render installs this curve whenever the profile declares
 * one (Apple ProRAW and Adobe-converter profiles both do — it carries the
 * file's actual rendering intent); the ACR3 default table above is only the
 * fallback for profiles without a curve. Returns null for malformed input
 * (fewer than 2 points, non-increasing x, values outside [0, 1]) so the
 * caller falls back to the default curve.
 *
 * Outside the point list the curve pins to its end values (the SDR render
 * applies no slope extension).
 */
export function buildProfileToneSpline(
  points: ReadonlyArray<readonly [number, number]>,
): ((x: number) => number) | null {
  const count = points.length;
  if (count < 2) return null;
  const X: number[] = [];
  const Y: number[] = [];
  for (const [x, y] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 1 || y > 1) return null;
    if (X.length > 0 && x <= X[X.length - 1]) return null;
    X.push(x);
    Y.push(y);
  }

  // Initial slopes: weighted average of adjacent segment slopes.
  const S: number[] = new Array(count);
  let a = X[1] - X[0];
  let b = (Y[1] - Y[0]) / a;
  S[0] = b;
  for (let j = 2; j < count; j++) {
    const c = X[j] - X[j - 1];
    const d = (Y[j] - Y[j - 1]) / c;
    S[j - 1] = (b * c + d * a) / (a + c);
    a = c;
    b = d;
  }
  S[count - 1] = 2.0 * b - S[count - 2];
  S[0] = 2.0 * S[0] - S[1];

  if (count > 2) {
    // Tridiagonal pass for C2 continuity (the reference solver's exact steps).
    const E: number[] = new Array(count);
    const F: number[] = new Array(count);
    const G: number[] = new Array(count);
    F[0] = 0.5;
    E[count - 1] = 0.5;
    G[0] = 0.75 * (S[0] + S[1]);
    G[count - 1] = 0.75 * (S[count - 2] + S[count - 1]);
    for (let j = 1; j < count - 1; j++) {
      const denom = (X[j + 1] - X[j - 1]) * 2.0;
      E[j] = (X[j + 1] - X[j]) / denom;
      F[j] = (X[j] - X[j - 1]) / denom;
      G[j] = 1.5 * S[j];
    }
    for (let j = 1; j < count; j++) {
      const denom = 1.0 - F[j - 1] * E[j];
      if (j !== count - 1) F[j] /= denom;
      G[j] = (G[j] - G[j - 1] * E[j]) / denom;
    }
    for (let j = count - 2; j >= 0; j--) {
      G[j] = G[j] - F[j] * G[j + 1];
    }
    for (let j = 0; j < count; j++) {
      S[j] = G[j];
    }
  }

  // One cubic segment between each point pair (1-D Bezier with end slopes).
  const segment = (x: number, x0: number, y0: number, s0: number, x1: number, y1: number, s1: number): number => {
    const A = x1 - x0;
    const B = (x - x0) / A;
    const C = (x1 - x) / A;
    return ((y0 * (2.0 - C + B) + s0 * A * B) * C * C) +
           ((y1 * (2.0 - B + C) - s1 * A * C) * B * B);
  };

  return (x: number): number => {
    if (x <= X[0]) return Y[0];
    if (x >= X[count - 1]) return Y[count - 1];
    let lower = 1;
    let upper = count - 1;
    while (upper > lower) {
      const mid = (lower + upper) >> 1;
      if (x === X[mid]) return Y[mid];
      if (x > X[mid]) lower = mid + 1;
      else upper = mid;
    }
    return segment(x, X[lower - 1], Y[lower - 1], S[lower - 1], X[lower], Y[lower], S[lower]);
  };
}

/**
 * The reference render's total tone as a 4097-entry table — the exact
 * `dng_1d_table` construction over `totalTone = exposureTone(exposure) ∘
 * curve` (the exposure tone runs FIRST; the reference concatenation pins its
 * output to [0, 1] before the curve reads it). `curve` is the profile's own
 * tone spline when it declares one, else the default ACR3 table.
 *
 * The tone itself is a JOINT RGB operation (see {@link applyHuePreservingTone})
 * — it can NOT bake into the per-channel look lattice.
 */
export function bakeToneTable(
  exposure: number,
  curve: ((x: number) => number) | null = null,
): Float32Array {
  const count = 4096;
  const table = new Float32Array(count + 1);
  const finalCurve = curve ?? applyDefaultToneCurve;
  for (let j = 0; j <= count; j++) {
    const x = j / count;
    let t = applyExposureTone(x, exposure);
    if (t < 0) t = 0; else if (t > 1) t = 1;
    table[j] = finalCurve(t);
  }
  return table;
}

/** Evaluate a baked tone table (inputs pinned to [0, 1], linear between entries). */
export function evaluateToneTable(table: Float32Array, x: number): number {
  if (x < 0) x = 0; else if (x > 1) x = 1;
  const y = x * (table.length - 1);
  const i0 = Math.min(table.length - 2, Math.floor(y));
  const f = y - i0;
  return table[i0] * (1 - f) + table[i0 + 1] * f;
}

/**
 * The reference render's tone step — NOT per-channel: the tone table applies
 * to the MAX and MIN channels and the middle channel is reconstructed by
 * linear interpolation between them, so the curve preserves the pixel's
 * saturation ratios (the classic display-referred RGB tone). Inputs pin to
 * [0, 1]. This joint-RGB shape is why the tone cannot fold into the
 * per-channel look lattice.
 */
export function applyHuePreservingTone(
  table: Float32Array,
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  if (r < 0) r = 0; else if (r > 1) r = 1;
  if (g < 0) g = 0; else if (g > 1) g = 1;
  if (b < 0) b = 0; else if (b > 1) b = 1;

  // Channel order cases (max, mid, min); the tone maps the outer two and the
  // middle rides the segment between their results.
  const tone = (v: number): number => evaluateToneTable(table, v);
  const mid = (hi: number, lo: number, m: number): number => {
    const thi = tone(hi);
    const tlo = tone(lo);
    return tlo + (thi - tlo) * ((m - lo) / (hi - lo));
  };
  if (r >= g) {
    if (g > b) return [tone(r), mid(r, b, g), tone(b)]; // r >= g > b
    if (b > r) return [mid(b, g, r), tone(g), tone(b)]; // b > r >= g
    if (b > g) return [tone(r), tone(g), mid(r, g, b)]; // r >= b > g
    return [tone(r), tone(g), tone(g)]; // r >= g == b
  }
  if (r >= b) return [mid(g, b, r), tone(g), tone(b)]; // g > r >= b
  if (b > g) return [tone(r), mid(b, r, g), tone(b)]; // b > g > r
  return [tone(r), tone(g), mid(g, r, b)]; // g >= b > r
}

/**
 * Trilinear lookup into a baked look lattice. Inputs are NOT clamped on
 * entry: in-range components interpolate; overrange components ride the edge
 * lattice plane (the standard LUT domain trade, stated above).
 */
export function applyProfileLookLut(
  baked: BakedProfileLook,
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const { size, lut } = baked;
  const max = size - 1;
  const fx = encodeLattice(r) * max;
  const fy = encodeLattice(g) * max;
  const fz = encodeLattice(b) * max;

  const x0 = Math.min(max - 1, Math.floor(fx));
  const y0 = Math.min(max - 1, Math.floor(fy));
  const z0 = Math.min(max - 1, Math.floor(fz));
  const dx = fx - x0;
  const dy = fy - y0;
  const dz = fz - z0;

  // Lattice addressing: (b * size² + g * size + r) * 3.
  const strideG = size * 3;
  const strideB = size * size * 3;
  const base = (z0 * size + y0) * size * 3 + x0 * 3;

  const read = (bz: number, by: number, bx: number, c: number): number =>
    lut[base + bz * strideB + by * strideG + bx * 3 + c];

  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c000 = read(0, 0, 0, c);
    const c100 = read(0, 0, 1, c);
    const c010 = read(0, 1, 0, c);
    const c110 = read(0, 1, 1, c);
    const c001 = read(1, 0, 0, c);
    const c101 = read(1, 0, 1, c);
    const c011 = read(1, 1, 0, c);
    const c111 = read(1, 1, 1, c);
    const z00 = c000 + (c001 - c000) * dz;
    const z10 = c100 + (c101 - c100) * dz;
    const z01 = c010 + (c011 - c010) * dz;
    const z11 = c110 + (c111 - c110) * dz;
    const y0v = z00 + (z01 - z00) * dy;
    const y1v = z10 + (z11 - z10) * dy;
    out[c] = y0v + (y1v - y0v) * dx;
  }
  return out;
}
