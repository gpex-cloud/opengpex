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
'use client';

/**
 * Manual grade-write policy — the hot-tail rules that land one gesture on the
 * chain. Editing follows the gesture-based Undo coalescing pattern: the panel
 * command layer opens the gesture (`begin*Edit` snapshot) and the writes here
 * collapse into that single history step. Provenance note: masks written here
 * carry NO `origin` tag — absence means user-owned, so preset applications
 * and presets-panel resets never delete hand-written grades.
 *
 * @module plugins/base/drawers/AdjustmentDrawer/grading/manual-apply
 */

import type {
  AdjustmentState,
  AdjustmentMask,
  GradeCategory,
  GradeState,
  Layer,
  Frame,
  CurvePoints,
  CurvesState,
  LevelsState,
  ChannelMixState,
  ColorBalanceState,
} from '@opengpex/editor/core/types/models';
import { MAX_ADJUSTMENT_MASKS_PER_LAYER } from '@opengpex/editor/core/types/models';
import { GRADE_ARM_KEY, createAdjustMask } from '@opengpex/editor/core/layer/amask';
import { LayerFactory } from '@opengpex/editor/core/layer/factory';
import type { EditorContextValue } from '@opengpex/editor/core/types';
import type { CurveChannel } from '../protocols';
import { resolveEditableTail, projectSelectionToLayer } from '../utils-hotTail';

/**
 * The grade value a panel should display: the EDITABLE hot tail's arm when one
 * exists (same category, same layer, coverage matching the current selection),
 * otherwise `undefined` — the panel then starts from its defaults.
 */
export function readPanelArm(
  ctx: EditorContextValue,
  category: GradeCategory,
): GradeArm | undefined {
  const { activeFrame, activeLayer } = ctx;
  if (!activeFrame || !activeLayer) return undefined;
  const tail = resolveEditableTail(ctx.geometry, activeFrame, activeLayer, category);
  return tail?.grade[GRADE_ARM_KEY[category]];
}

/** Any category's parameter arm (the panels narrow by their own category). */
export type GradeArm = AdjustmentState | CurvesState | LevelsState | ChannelMixState | ColorBalanceState;

/** HUD message when the per-layer mask cap blocks a new commit. */
export function capBlocked(ctx: EditorContextValue): boolean {
  ctx.actions.setInteraction({
    hud: {
      message: `Adjustment limit reached: ${MAX_ADJUSTMENT_MASKS_PER_LAYER} masks per layer. Delete one in the Layers panel to add another.`,
      type: 'error',
    },
  });
  return true;
}

// ─── Hot-tail grade writes ────────────────────────────────────────────────────

/** HUD message when the per-layer mask cap blocks a new commit. */

/**
 * Compute the next `adjustMasks` array for a write of one category's arm:
 * the EDITABLE hot tail is patched in place; otherwise a NEW single-category
 * mask is appended, carrying the frozen selection snapshot when one is active.
 * Returns `undefined` (no write) when the append hits the per-layer cap.
 */
export function nextMasksForArm(
  ctx: EditorContextValue,
  frame: Frame,
  layer: Layer,
  category: GradeCategory,
  arm: GradeArm,
): AdjustmentMask[] | undefined {
  const masks = layer.adjustMasks ?? [];
  const tail = resolveEditableTail(ctx.geometry, frame, layer, category);
  const key = GRADE_ARM_KEY[category];
  if (tail) {
    return masks.map((m) => (m.id === tail.id ? { ...m, grade: { ...m.grade, [key]: arm } } : m));
  }
  if (masks.length >= MAX_ADJUSTMENT_MASKS_PER_LAYER) {
    capBlocked(ctx);
    return undefined;
  }
  const shape = projectSelectionToLayer(ctx.geometry, frame, layer);
  const mask = createAdjustMask(category, arm as GradeState);
  // Manual write path: no `origin` tag — absence means user-owned, so preset
  // applications and presets-panel resets never delete hand-written grades.
  mask.id = LayerFactory.newAdjustMaskId();
  if (shape) mask.shape = shape;
  return [...masks, mask];
}

/**
 * Write one category's arm through the hot-tail rules (one Redux write, one
 * undo step with the gesture's checkpoint). A selection snapshot rides the
 * SAME write when a new mask is born, matching "draw selection → adjust".
 */
export function writeArm(
  ctx: EditorContextValue,
  category: GradeCategory,
  arm: GradeArm,
): void {
  const { activeFrame, activeLayer, actions } = ctx;
  if (!activeFrame || !activeLayer) return;
  const masks = nextMasksForArm(ctx, activeFrame, activeLayer, category, arm);
  if (!masks) return;
  actions.updateLayer(activeFrame.id, activeLayer.id, {
    adjustMasks: masks.length ? masks : undefined,
  });
}

// ─── Curves helpers ────────────────────────────────────────────────────────────

/**
 * Merge a channel-scoped `points` patch into a curves arm while keeping the
 * other channels intact.
 */
export function mergeCurves(
  current: CurvesState | undefined,
  channel: CurveChannel,
  points: CurvePoints,
): CurvesState {
  return { ...(current ?? {}), [channel]: points };
}

/**
 * Insert a control point into a channel's points array while keeping the list
 * sorted by x and preventing exact-x duplicates (which would confuse the
 * cubic-spline evaluator downstream). Endpoints at x=0 / x=1 are kept because
 * they anchor the curve — new points can nudge in-between them.
 */
export function insertPointSorted(
  points: CurvePoints,
  x: number,
  y: number,
): CurvePoints {
  const clampedX = Math.max(0, Math.min(1, x));
  const clampedY = Math.max(0, Math.min(1, y));
  const next: CurvePoints = [];
  let inserted = false;
  for (const p of points) {
    if (!inserted && p[0] > clampedX) {
      next.push([clampedX, clampedY]);
      inserted = true;
    }
    // Skip duplicates on x — the new point wins (Photoshop-style).
    if (p[0] === clampedX) continue;
    next.push([p[0], p[1]]);
  }
  if (!inserted) next.push([clampedX, clampedY]);
  return next;
}
