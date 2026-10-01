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
 * adjustments.ts — Layer adjustment STATE → declarative `AdjustmentDesc[]` /
 * `FilterDesc[]` translation.
 *
 * WHY THIS MODULE EXISTS (and why it does NOT reuse the old normalizer):
 *   `protocol/normalizer.ts` produced the old CPU-filter descriptor shape for the
 *   deleted Canvas2D filter runtime.
 *   `AdjustmentDesc` (`Scene.ts`) is the SINGLE adjustment description shape in
 *   v2 — this translation replaced that path and does not depend on it.
 *   Identity/quantization helpers are implemented locally on purpose.
 *
 * CONTRACT:
 *   • Identity state (brightness=100 / identity levels / identity mixer / …) is
 *     dropped so a "reset to default" layer yields NO descriptor — this is what
 *     makes the composite signature (which JSON-serialises these arrays) collapse
 *     back to the un-adjusted signature (ensuring no spurious re-composite).
 *   • Ordering is deterministic: adjustments are emitted `basic → levels →
 *     curves → channelMix → colorBalance`; the single neighbourhood filter
 *     (`gaussianBlur`, from `adjustments.blur`) rides in `filters`.
 *   • curves/levels reference a resident 1D-LUT texture by a DETERMINISTIC
 *     `lutId` (content hash of the quantized config). LUT texture upload and
 *     deduplication are handled downstream; this module only produces the stable id so the
 *     signature dirties on a curve/levels edit and stays clean otherwise.
 *
 * @module core/gpu/scene/adjustments
 */

import type {
  Layer,
  AdjustmentState,
  CurvesState,
  LevelsState,
  ChannelMixState,
  ColorBalanceState,
} from '@opengpex/editor/core/types';
import type { AdjustmentDesc, FilterDesc } from './Scene';
import type { LutUpload } from '@opengpex/editor/core/engine/pipeline/IEngine';
import { buildLevelsLutData, buildCurvesLutData, LUT_ENTRIES } from './lutPlan';

// ────────────────────────────────────────────────────────────
// Numeric canonicalization (local — mirrors the old normalizer's `q`)
// ────────────────────────────────────────────────────────────

/**
 * Round to 6 significant digits so double-precision jitter from React
 * re-renders (`0.499999999` vs `0.5`) never perturbs the derived `lutId` /
 * descriptor value (which would spuriously dirty the composite signature).
 */
function q(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n === 0) return 0;
  const digits = 6;
  const magnitude = Math.pow(10, digits - Math.ceil(Math.log10(Math.abs(n))));
  return Math.round(n * magnitude) / magnitude;
}

function qTriple(t: readonly [number, number, number]): [number, number, number] {
  return [q(t[0]), q(t[1]), q(t[2])];
}

/**
 * FNV-1a 32-bit hash → base36. Deterministic, dependency-free, and stable
 * across runs — used to derive a compact `lutId` from a quantized config so
 * two identical curves/levels share one LUT texture (deduplication) and a change
 * yields a different id (signature dirties).
 */
function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 32-bit FNV prime multiply (kept in uint32 range via Math.imul).
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// ────────────────────────────────────────────────────────────
// Identity predicates
// ────────────────────────────────────────────────────────────

/** Basic scalars at their defaults (brightness/contrast/saturation=100, hue=0). */
function isIdentityBasic(a: AdjustmentState | undefined): boolean {
  if (!a) return true;
  return (
    (a.brightness ?? 100) === 100 &&
    (a.contrast ?? 100) === 100 &&
    (a.saturation ?? 100) === 100 &&
    (a.hueRotate ?? 0) === 0
  );
}

function isIdentityCurve(pts: readonly (readonly [number, number])[] | undefined): boolean {
  if (!pts || pts.length === 0) return true;
  if (pts.length !== 2) return false;
  const [a, b] = pts;
  return a[0] === 0 && a[1] === 0 && b[0] === 1 && b[1] === 1;
}

function isIdentityCurves(c: CurvesState | undefined): boolean {
  if (!c) return true;
  return (
    isIdentityCurve(c.rgb) &&
    isIdentityCurve(c.red) &&
    isIdentityCurve(c.green) &&
    isIdentityCurve(c.blue)
  );
}

function isIdentityLevels(l: LevelsState | undefined): boolean {
  if (!l) return true;
  return (
    l.inputBlack === 0 &&
    l.inputWhite === 255 &&
    l.gamma === 1 &&
    l.outputBlack === 0 &&
    l.outputWhite === 255
  );
}

function isIdentityChannelMix(m: ChannelMixState | undefined): boolean {
  if (!m) return true;
  const eq = (v: readonly [number, number, number], t: [number, number, number]) =>
    v[0] === t[0] && v[1] === t[1] && v[2] === t[2];
  return (
    eq(m.red, [1, 0, 0]) &&
    eq(m.green, [0, 1, 0]) &&
    eq(m.blue, [0, 0, 1]) &&
    (!m.constant || eq(m.constant, [0, 0, 0]))
  );
}

function isIdentityColorBalance(cb: ColorBalanceState | undefined): boolean {
  if (!cb) return true;
  const isZero = (v: readonly [number, number, number]) => v[0] === 0 && v[1] === 0 && v[2] === 0;
  return isZero(cb.shadows) && isZero(cb.midtones) && isZero(cb.highlights);
}

// ────────────────────────────────────────────────────────────
// Public translation
// ────────────────────────────────────────────────────────────

/** The adjustment inputs read off a `Layer` (kept minimal for test ergonomics). */
export type AdjustmentInputs = Pick<
  Layer,
  'adjustments' | 'curves' | 'levels' | 'channelMix' | 'colorBalance'
>;

/**
 * Translate a layer's adjustment state into the declarative `Scene` shapes.
 * Returns `undefined` for an empty arm so `LayerNode.adjustments` / `.filters`
 * stay absent (identity → no signature contribution).
 */
export function translateLayerAdjustments(layer: AdjustmentInputs): {
  adjustments?: AdjustmentDesc[];
  filters?: FilterDesc[];
  luts?: LutUpload[];
} {
  const adjustments: AdjustmentDesc[] = [];
  const filters: FilterDesc[] = [];
  const luts: LutUpload[] = [];

  // basic (brightness/contrast/saturation/hue) — a single fused descriptor.
  const a = layer.adjustments;
  if (!isIdentityBasic(a) && a) {
    adjustments.push({
      kind: 'basic',
      brightness: q(a.brightness ?? 100),
      contrast: q(a.contrast ?? 100),
      saturation: q(a.saturation ?? 100),
      hueRotate: q(a.hueRotate ?? 0),
    });
  }

  // levels — deterministic 1D-LUT id + data built from the SAME canonical config
  // (id↔data consistency). LUT math is generateLevelsLUT (single source of truth).
  if (!isIdentityLevels(layer.levels)) {
    const l = layer.levels!;
    const canonical = {
      inputBlack: q(l.inputBlack),
      inputWhite: q(l.inputWhite),
      gamma: q(l.gamma),
      outputBlack: q(l.outputBlack),
      outputWhite: q(l.outputWhite),
    };
    const lutId = `levels-${hashString(JSON.stringify(canonical))}`;
    adjustments.push({ kind: 'levels', lutId });
    luts.push({ lutId, data: buildLevelsLutData(canonical), width: LUT_ENTRIES });
  }

  // curves — only the non-identity channels contribute to the LUT id AND data.
  if (!isIdentityCurves(layer.curves)) {
    const c = layer.curves!;
    const canonical: {
      rgb?: [number, number][];
      red?: [number, number][];
      green?: [number, number][];
      blue?: [number, number][];
    } = {};
    if (!isIdentityCurve(c.rgb)) canonical.rgb = c.rgb!.map((p) => [q(p[0]), q(p[1])]);
    if (!isIdentityCurve(c.red)) canonical.red = c.red!.map((p) => [q(p[0]), q(p[1])]);
    if (!isIdentityCurve(c.green)) canonical.green = c.green!.map((p) => [q(p[0]), q(p[1])]);
    if (!isIdentityCurve(c.blue)) canonical.blue = c.blue!.map((p) => [q(p[0]), q(p[1])]);
    const lutId = `curve-${hashString(JSON.stringify(canonical))}`;
    adjustments.push({ kind: 'curves', lutId });
    luts.push({ lutId, data: buildCurvesLutData(canonical), width: LUT_ENTRIES });
  }

  // channel mixer — 3×3 matrix (rows R/G/B) + per-channel constant offset.
  if (!isIdentityChannelMix(layer.channelMix)) {
    const m = layer.channelMix!;
    adjustments.push({
      kind: 'channelMix',
      matrix: [...qTriple(m.red), ...qTriple(m.green), ...qTriple(m.blue)],
      constant: m.constant ? qTriple(m.constant) : [0, 0, 0],
    });
  }

  // colour balance — per-tonal-range RGB shifts.
  if (!isIdentityColorBalance(layer.colorBalance)) {
    const cb = layer.colorBalance!;
    adjustments.push({
      kind: 'colorBalance',
      shadows: qTriple(cb.shadows),
      midtones: qTriple(cb.midtones),
      highlights: qTriple(cb.highlights),
      preserveLuminosity: cb.preserveLuminosity,
    });
  }

  // blur is a NEIGHBOURHOOD filter (not a colour adjustment) — rides in filters.
  if (a && (a.blur ?? 0) !== 0) {
    filters.push({ kind: 'gaussianBlur', radius: q(a.blur) });
  }

  return {
    adjustments: adjustments.length ? adjustments : undefined,
    filters: filters.length ? filters : undefined,
    luts: luts.length ? luts : undefined,
  };
}

