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
 * hdrTransfer.ts — PQ (SMPTE ST 2084 / BT.2100) and HLG (BT.2100) transfer
 * functions, anchored to the scene-referred linear domain the engine works in.
 *
 * WHY WE OWN THE EOTF (probe-verified): the wasm
 * AVIF decoder (libavif) delivers RAW TRANSFER CODE VALUES bit-exactly
 * (maxDev 0 on lossless identity-matrix ramps) — no linearization, no OOTF,
 * no tone mapping. The 8-bit `image-bitmap` path is the opposite (the browser
 * applies an uncontrolled tone map, meanDev ≈ 30/255). So for HDR AVIF the
 * EOTF is OURS to apply, deterministically.
 *
 * SCENE ANCHOR: PQ is ABSOLUTE (code → cd/m²). The scene-referred 1.0 is
 * anchored at 203 cd/m² = SDR white (CIE 2108 and mainstream HDR graphics
 * practice), so linearScene = nits / HDR_REF_WHITE_NITS. Values > 1.0 are EDR
 * headroom (PQ 10-bit tops out at 10000/203 ≈ 49× white). HLG is relative:
 * the BT.2100 inverse OOTF for the 1000-cd/m² reference display (system
 * gamma 1.2) yields absolute cd/m², normalized by the same 203 anchor — both
 * transfers share one scene convention: 1.0 = SDR white, above = headroom.
 *
 * The inverse directions (OETFs) exist for the round-trip golden (ramp →
 * EOTF → OETF → bit-exact codes) and the future HDR export lane.
 */

/** PQ absolute reference white: the cd/m² level that is scene 1.0. */
export const HDR_REF_WHITE_NITS = 203;

/** PQ peak luminance of the standard container (BT.2100: 10000 cd/m²). */
export const PQ_MAX_NITS = 10000;

/** ST 2084 / BT.2100 Table 5 constants. */
const PQ_M1 = 2610 / 16384;
const PQ_M2 = 2523 / 4096 * 128;
const PQ_C1 = 3424 / 4096;
const PQ_C2 = 2413 / 4096 * 32;
const PQ_C3 = 2392 / 4096 * 32;

/**
 * PQ EOTF: normalized code [0,1] → absolute luminance in cd/m².
 * E' = (c1 + c2·Y^m1) / (1 + c3·Y^m1); code = E'^m2; Y = ((code^(1/m2) − c1)/(c2 − c3·code^(1/m2)))^(1/m1).
 */
export function pqEotfNits(code: number): number {
  if (code <= 0) return 0;
  const p = Math.pow(code, 1 / PQ_M2);
  const num = p - PQ_C1;
  if (num <= 0) return 0;
  const den = PQ_C2 - PQ_C3 * p;
  return PQ_MAX_NITS * Math.pow(num / den, 1 / PQ_M1);
}

/**
 * PQ inverse EOTF: absolute cd/m² → normalized code [0,1].
 */
export function pqOetfCode(nits: number): number {
  if (nits <= 0) return 0;
  const y = nits / PQ_MAX_NITS;
  const inner = Math.pow(y, PQ_M1);
  return Math.pow((PQ_C1 + PQ_C2 * inner) / (1 + PQ_C3 * inner), PQ_M2);
}

/** HLG OETF constants (BT.2100 Note 2i). */
const HLG_A = 0.17883277;
const HLG_B = 0.28466892;
const HLG_C = 0.55991073;

/**
 * HLG inverse OETF: normalized signal [0,1] → relative scene light (the
 * analytical inverse of the piecewise OETF; 0.5 is the join).
 */
export function hlgInverseOetf(signal: number): number {
  if (signal <= 0) return 0;
  if (signal <= 0.5) return (signal * signal) / 3;
  return (Math.exp((signal - HLG_C) / HLG_A) + HLG_B) / 12;
}

/** HLG OETF: relative scene light → normalized signal [0,1]. */
export function hlgOetf(scene: number): number {
  if (scene <= 0) return 0;
  if (scene <= 1 / 12) return Math.sqrt(3 * scene);
  return HLG_A * Math.log(12 * scene - HLG_B) + HLG_C;
}

/**
 * HLG inverse OOTF for the BT.2100 REFERENCE display (peak 1000 cd/m²,
 * system gamma 1.2): signal → ABSOLUTE display luminance in cd/m². The
 * display-side OOTF maps scene light Ys to Yd = α·Ys^γ (γ = 1.2, α = peak).
 * The scene reference this produces is the DISPLAY light a reference monitor
 * would emit — the standard basis on which HLG content is graded.
 */
export function hlgSignalToNits(signal: number): number {
  const scene = hlgInverseOetf(signal);
  return 1000 * Math.pow(scene, 1.2);
}

/** HLG forward OOTF (display cd/m² → signal), the exact inverse of the above. */
export function hlgNitsToSignal(nits: number): number {
  if (nits <= 0) return 0;
  const scene = Math.pow(nits / 1000, 1 / 1.2);
  return hlgOetf(scene);
}

/**
 * PQ: normalized code → SCENE-REFERENCED linear light (1.0 = 203 cd/m²).
 */
export function pqToSceneLinear(code: number): number {
  return pqEotfNits(code) / HDR_REF_WHITE_NITS;
}

/**
 * PQ: scene-referenced linear → normalized code (inverse of pqToSceneLinear).
 */
export function sceneLinearToPq(scene: number): number {
  return pqOetfCode(scene * HDR_REF_WHITE_NITS);
}

/**
 * HLG: normalized signal → SCENE-REFERENCED linear light (same 203-nit
 * anchor; HLG 75% diffuse white lands at ≈ scene 1.0, headroom above).
 */
export function hlgToSceneLinear(signal: number): number {
  return hlgSignalToNits(signal) / HDR_REF_WHITE_NITS;
}

/**
 * HLG: scene-referenced linear → normalized signal (inverse of the above).
 */
export function sceneLinearToHlg(scene: number): number {
  return hlgNitsToSignal(scene * HDR_REF_WHITE_NITS);
}
