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
 * levels/geometry.ts — pure math for LevelsPanel.
 *
 * React-free by design: graph/track geometry, gamma mapping, histogram
 * percentiles and the LUT preview path live here so they stay unit-testable
 * without a renderer, and `index.tsx` stays an interaction/render
 * orchestrator. Cross-panel helpers live in `../helpers`.
 */

import type { LevelsState } from "@opengpex/editor/core/types/models";
import { generateLevelsLUT } from "@opengpex/editor/core/engine/color";
import { clamp } from "../helpers";
import { DEFAULT_LEVELS_STATE } from "../../protocols";

// ─── Graph geometry ────────────────────────────────────────────────────────────

/**
 * SVG viewBox width for the histogram + curve overlay. We chose 256 to line up
 * the histogram's 256 bins 1:1 with pixels in the coordinate system — a bin at
 * intensity 128 renders exactly at `x=128` without any fractional maths. Height
 * is smaller because the panel is narrow — we care about relative shape more
 * than absolute counts.
 */
export const GRAPH_VB_W = 256;
export const GRAPH_VB_H = 100;

/** Number of subdivisions of the levels LUT we sample for the overlay curve. */
export const LUT_PREVIEW_SAMPLES = 64;

/** Handle height in track viewBox units. Tracks are drawn at 24-unit tall SVG. */
export const TRACK_VB_H = 24;

// ─── State normalization ───────────────────────────────────────────────────────

/**
 * Read the current levels state, falling back to identity defaults. We return
 * a fresh copy every call (mutating the layer's state directly would defeat
 * React's referential-equality checks).
 */
export function readLevels(current: LevelsState | undefined): LevelsState {
  return { ...DEFAULT_LEVELS_STATE, ...(current ?? {}) };
}

// ─── Gamma ↔ track mapping ─────────────────────────────────────────────────────

/**
 * Map gamma ∈ [0.1, 10] to a fraction ∈ [0, 1] along the input track between
 * `inputBlack` and `inputWhite`. Photoshop uses a log2 scale so gamma=1
 * lands exactly at the midpoint — we replicate this.
 *
 *   gamma = 1.0  → 0.5  (midpoint)
 *   gamma = 0.1  → 0.0  (leftmost, near black)
 *   gamma = 10   → 1.0  (rightmost, near white)
 *
 * Concretely:  fraction = 0.5 * (1 - log2(gamma) / log2(9.99))
 * (`9.99` because gamma range is [1/9.99, 9.99] symmetric around 1.0).
 */
const GAMMA_LOG_RANGE = Math.log2(9.99); // ≈ 3.32

export function gammaToTrackFraction(gamma: number): number {
  const clamped = clamp(gamma, 0.1, 10);
  return 0.5 - (Math.log2(clamped) / GAMMA_LOG_RANGE) * 0.5;
}

export function trackFractionToGamma(f: number): number {
  const clamped = clamp(f, 0, 1);
  const exp = ((0.5 - clamped) / 0.5) * GAMMA_LOG_RANGE;
  return clamp(Math.pow(2, exp), 0.1, 10);
}

// ─── Pointer mapping ───────────────────────────────────────────────────────────

/**
 * Convert a horizontal pointer coordinate to an intensity value in [0, 255].
 * The track's SVG occupies `viewBox="0 0 256 24"`, so we scale by the DOM
 * rect and clamp — same maths as the Curves panel's `eventToVB`.
 */
export function pointerToIntensity(evt: { clientX: number }, el: Element): number {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0) return 0;
  const raw = ((evt.clientX - rect.left) / rect.width) * 255;
  return clamp(Math.round(raw), 0, 255);
}

// ─── Histogram math ────────────────────────────────────────────────────────────

/**
 * Compute inputBlack/inputWhite from a histogram at the given percentile
 * split (Photoshop uses 0.1% / 99.9% ≈ black/white clip). Returns null if
 * the histogram is empty (all-transparent layer).
 */
export function percentileFromHistogram(
  hist: Uint32Array,
  lowPct: number,
  highPct: number,
): { inputBlack: number; inputWhite: number } | null {
  let total = 0;
  for (let i = 0; i < hist.length; i++) total += hist[i];
  if (total === 0) return null;
  const lowTarget = total * lowPct;
  const highTarget = total * highPct;
  let acc = 0;
  let inputBlack = 0;
  let inputWhite = 255;
  let foundLow = false;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (!foundLow && acc >= lowTarget) {
      inputBlack = i;
      foundLow = true;
    }
    if (acc >= highTarget) {
      inputWhite = i;
      break;
    }
  }
  // Preserve at least a minimum span so autoLevels can't crush contrast to
  // zero on a nearly-monochrome layer.
  if (inputWhite <= inputBlack + 1) {
    inputWhite = clamp(inputBlack + 2, 0, 255);
  }
  return { inputBlack, inputWhite };
}

// ─── LUT preview ───────────────────────────────────────────────────────────────

/**
 * Sample the levels LUT into an SVG polyline path so users see how the
 * current input/gamma/output settings remap intensity. Because we use the
 * same `generateLevelsLUT` the worker uses, this line is a preview of the
 * final filter output — no drift between UI and render.
 */
export function levelsLutToPathD(
  levels: LevelsState,
  vbW: number,
  vbH: number,
): string {
  const lut = generateLevelsLUT(levels, 256 as const, "f32") as Float32Array;
  const step = (lut.length - 1) / (LUT_PREVIEW_SAMPLES - 1);
  const parts: string[] = [];
  for (let i = 0; i < LUT_PREVIEW_SAMPLES; i++) {
    const li = Math.round(i * step);
    const x = (li / (lut.length - 1)) * vbW;
    // lut[li] ∈ [0,1] where 1 = white. SVG y grows downward, so invert.
    const y = (1 - lut[li]) * vbH;
    parts.push(`${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return parts.join(" ");
}

// ─── Handle SVG ────────────────────────────────────────────────────────────────

/**
 * Generate an SVG path `d` attribute for the house/pentagon-shaped thumb used
 * by the triangle handles on the input/output tracks.
 *
 * @param cx - Center x position in the SVG coordinate system
 * @param height - Total height of the thumb in SVG units
 * @param halfWidth - Half-width of the thumb body (default 5)
 * @returns SVG path data string
 */
export function thumbSvgPath(cx: number, height: number, halfWidth = 5): string {
  const roofApexY = 0;
  const roofBaseY = height * 0.28;
  const bodyBottomY = height * 0.78;
  const cornerR = 1;

  return [
    `M ${cx} ${roofApexY}`,
    `L ${cx + halfWidth} ${roofBaseY}`,
    `L ${cx + halfWidth} ${bodyBottomY - cornerR}`,
    `Q ${cx + halfWidth} ${bodyBottomY} ${cx + halfWidth - cornerR} ${bodyBottomY}`,
    `L ${cx - halfWidth + cornerR} ${bodyBottomY}`,
    `Q ${cx - halfWidth} ${bodyBottomY} ${cx - halfWidth} ${bodyBottomY - cornerR}`,
    `L ${cx - halfWidth} ${roofBaseY}`,
    `Z`,
  ].join(' ');
}
