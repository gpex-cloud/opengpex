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
 * adjustments.ts — `Layer.adjustMasks` (the ordered grade chain) → declarative
 * `AdjustStageDesc[]` / `FilterDesc[]` / LUT-atlas upload translation.
 *
 * CONTRACT:
 *   • One STAGE per enabled mask whose grade carries at least one non-identity
 *     colour arm, in chain (commit) order. A disabled mask, or a mask whose
 *     only effect is blur/edgeFeather, contributes no stage. An all-identity
 *     chain yields NO stages so the composite signature (which serialises
 *     these arrays) collapses back to the un-adjusted signature.
 *   • Inside a stage the arms are emitted in the fixed `basic → levels →
 *     curves → channelMix → colorBalance` order the shader evaluates them in.
 *     A panel-written stage holds one arm; a migrated legacy stage may hold
 *     several and then reproduces the old single-pass result exactly.
 *   • The neighbourhood filters (`gaussianBlur` from `blur`, then
 *     `alphaFeather` from `edgeFeather`, per mask in chain order) ride in
 *     `filters` and run AFTER the whole grade chain — the blur of a mask is
 *     never interleaved between two grade stages.
 *   • Every stage that samples a tone table gets rows in ONE per-layer LUT
 *     ATLAS (`texture_2d`, `LUT_ENTRIES` × `ADJUST_LUT_ATLAS_ROWS`): row
 *     `2·i` is stage i's levels table, row `2·i+1` its curves table. The atlas
 *     id is a content hash of the per-row table ids, so identical chains on
 *     different layers share a resident texture and any table edit yields a
 *     new id (signature dirties, re-upload happens).
 *
 * @module core/gpu/scene/adjustments
 */

import type {
  AdjustmentState,
  ChannelMixState,
  ColorBalanceState,
  CurvesState,
  GradeState,
  Layer,
  LevelsState,
} from '@opengpex/editor/core/types';
import type { AdjustmentDesc, AdjustStageDesc, FilterDesc } from './Scene';
import type { LutUpload } from '@opengpex/editor/core/engine/pipeline/IEngine';
import { buildLevelsLutData, buildCurvesLutData, LUT_ENTRIES } from './lutPlan';
import { ADJUST_MAX_STAGES } from '@opengpex/editor/core/engine/gpu/shaders/adjust';
import {
  isIdentityBasicColor,
  isIdentityCurve,
  isIdentityCurves,
  isIdentityLevels,
  isIdentityChannelMix,
  isIdentityColorBalance,
} from '@opengpex/editor/core/helpers/adjustments';

/** Rows of the per-layer LUT atlas: two tables (levels, curves) per stage. */
export const ADJUST_LUT_ATLAS_ROWS = ADJUST_MAX_STAGES * 2;

// ────────────────────────────────────────────────────────────
// Numeric canonicalization
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
 * across runs — used to derive compact content ids.
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
// Per-arm translation
// ────────────────────────────────────────────────────────────

interface TableRow {
  readonly lutId: string;
  readonly data: Uint16Array;
}

interface ArmTranslation {
  readonly adjustments: AdjustmentDesc[];
  readonly levelsRow?: TableRow;
  readonly curvesRow?: TableRow;
}

function translateBasic(a: AdjustmentState | undefined, out: AdjustmentDesc[]): void {
  if (!a || isIdentityBasicColor(a)) return;
  out.push({
    kind: 'basic',
    brightness: q(a.brightness ?? 100),
    contrast: q(a.contrast ?? 100),
    saturation: q(a.saturation ?? 100),
    hueRotate: q(a.hueRotate ?? 0),
  });
}

function translateLevels(l: LevelsState | undefined, out: AdjustmentDesc[]): TableRow | undefined {
  if (!l || isIdentityLevels(l)) return undefined;
  const canonical = {
    inputBlack: q(l.inputBlack),
    inputWhite: q(l.inputWhite),
    gamma: q(l.gamma),
    outputBlack: q(l.outputBlack),
    outputWhite: q(l.outputWhite),
  };
  const lutId = `levels-${hashString(JSON.stringify(canonical))}`;
  out.push({ kind: 'levels', lutId });
  return { lutId, data: buildLevelsLutData(canonical) };
}

function translateCurves(c: CurvesState | undefined, out: AdjustmentDesc[]): TableRow | undefined {
  if (!c || isIdentityCurves(c)) return undefined;
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
  out.push({ kind: 'curves', lutId });
  return { lutId, data: buildCurvesLutData(canonical) };
}

function translateChannelMix(m: ChannelMixState | undefined, out: AdjustmentDesc[]): void {
  if (!m || isIdentityChannelMix(m)) return;
  out.push({
    kind: 'channelMix',
    matrix: [...qTriple(m.red), ...qTriple(m.green), ...qTriple(m.blue)],
    constant: m.constant ? qTriple(m.constant) : [0, 0, 0],
  });
}

function translateColorBalance(cb: ColorBalanceState | undefined, out: AdjustmentDesc[]): void {
  if (!cb || isIdentityColorBalance(cb)) return;
  out.push({
    kind: 'colorBalance',
    shadows: qTriple(cb.shadows),
    midtones: qTriple(cb.midtones),
    highlights: qTriple(cb.highlights),
    preserveLuminosity: cb.preserveLuminosity,
  });
}

/** Translate one grade bundle's colour arms (fixed in-stage order). */
function translateGradeArms(g: GradeState): ArmTranslation {
  const adjustments: AdjustmentDesc[] = [];
  translateBasic(g.adjustments, adjustments);
  const levelsRow = translateLevels(g.levels, adjustments);
  const curvesRow = translateCurves(g.curves, adjustments);
  translateChannelMix(g.channelMix, adjustments);
  translateColorBalance(g.colorBalance, adjustments);
  return { adjustments, levelsRow, curvesRow };
}

// ────────────────────────────────────────────────────────────
// Public translation
// ────────────────────────────────────────────────────────────

/** The inputs read off a `Layer` (kept minimal for test ergonomics). */
export type AdjustmentInputs = Pick<Layer, 'adjustMasks'>;

export interface LayerAdjustmentTranslation {
  adjustStages?: AdjustStageDesc[];
  adjustLutAtlasId?: string;
  filters?: FilterDesc[];
  /** The per-layer LUT atlas upload (absent when no stage samples a table). */
  luts?: LutUpload[];
}

/**
 * Translate a layer's grade chain into the declarative `Scene` shapes.
 * Returns `undefined` for an empty arm so `LayerNode.adjustStages` / `.filters`
 * stay absent (identity → no signature contribution).
 *
 * Stages past `ADJUST_MAX_STAGES` are dropped from the RENDER only (the
 * document keeps them; the product cap stops the panel from creating them,
 * so this guard is for documents from a build with a higher cap).
 */
export function translateLayerAdjustments(layer: AdjustmentInputs): LayerAdjustmentTranslation {
  const stages: AdjustStageDesc[] = [];
  const filters: FilterDesc[] = [];
  const rows: (TableRow | undefined)[] = new Array(ADJUST_LUT_ATLAS_ROWS).fill(undefined);
  let anyTable = false;

  for (const mask of layer.adjustMasks ?? []) {
    if (!mask.enabled) continue;
    const g = mask.grade;

    if (stages.length < ADJUST_MAX_STAGES) {
      const arms = translateGradeArms(g);
      if (arms.adjustments.length > 0) {
        const i = stages.length;
        if (arms.levelsRow) { rows[2 * i] = arms.levelsRow; anyTable = true; }
        if (arms.curvesRow) { rows[2 * i + 1] = arms.curvesRow; anyTable = true; }
        const coverage = mask.shape && mask.shape.rings.length > 0
          ? {
            rings: mask.shape.rings.map((ring) => ring.map((p) => [p.x, p.y] as const)),
            antiAliased: mask.shape.antiAliased !== false,
            featherPx: q(mask.feather ?? 0),
          }
          : undefined;
        stages.push(coverage ? { adjustments: arms.adjustments, coverage } : { adjustments: arms.adjustments });
      }
    }

    // blur is a NEIGHBOURHOOD filter (not a colour adjustment) — rides in filters.
    const a = g.adjustments;
    if (a && (a.blur ?? 0) !== 0) {
      filters.push({ kind: 'gaussianBlur', radius: q(a.blur) });
    }
    // edgeFeather is the alpha-edge feather — a neighbourhood filter too, emitted
    // AFTER blur so a layered blur+feather blurs first and feathers the result's
    // edge.
    const edgeFeather = a?.edgeFeather;
    if (edgeFeather !== undefined && edgeFeather !== 0) {
      filters.push({ kind: 'alphaFeather', radius: q(edgeFeather) });
    }
  }

  let adjustLutAtlasId: string | undefined;
  let luts: LutUpload[] | undefined;
  if (anyTable) {
    const rowIds = rows.map((r) => (r ? r.lutId : '-'));
    adjustLutAtlasId = `atlas-${hashString(rowIds.join('|'))}`;
    const data = new Uint16Array(LUT_ENTRIES * 4 * ADJUST_LUT_ATLAS_ROWS);
    for (let r = 0; r < ADJUST_LUT_ATLAS_ROWS; r++) {
      const row = rows[r];
      if (row) data.set(row.data, r * LUT_ENTRIES * 4);
    }
    luts = [{ lutId: adjustLutAtlasId, data, width: LUT_ENTRIES, rows: ADJUST_LUT_ATLAS_ROWS }];
  }

  return {
    adjustStages: stages.length ? stages : undefined,
    adjustLutAtlasId,
    filters: filters.length ? filters : undefined,
    luts,
  };
}
