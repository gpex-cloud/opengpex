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
 * The adjustment-mask chain domain — the single vocabulary and the chain
 * mutation primitives for `Layer.adjustMasks`.
 *
 * Every writer of the chain (manual gestures, preset applications, future
 * consumers) speaks THIS shape: a mask owns one category's grade arm, tagged
 * with its provenance. `origin` drives reset semantics everywhere — a preset
 * application owns exactly the masks it wrote and is removed wholesale;
 * untagged (manual) masks are user work that survives look swaps. Keeping the
 * vocabulary and the drop/append primitives here means the chain has one
 * interpretation in the codebase instead of one per consumer.
 *
 * @module core/layer/amask
 */

import type {
  AdjustmentMask,
  GradeCategory,
  GradeState,
  Layer,
} from '@opengpex/editor/core/types/models';

/** The grade-state key that holds a category's parameters. */
export const GRADE_ARM_KEY = {
  basic: 'adjustments',
  levels: 'levels',
  curves: 'curves',
  channelMix: 'channelMix',
  colorBalance: 'colorBalance',
} as const;

/** Provenance of one chain mask (absent `origin` means user-written). */
export function isPresetOwned(mask: AdjustmentMask): boolean {
  return mask.origin === 'preset';
}

/** Options for the mask factory: provenance stamp and selection snapshot. */
export interface NewAdjustMaskOptions {
  /** Marks the mask as written by a preset application (with its id). */
  origin?: 'preset';
  /** The applying preset's id — present only alongside `origin: 'preset'`. */
  fromPreset?: string;
}

/** Create one chain mask for `category` carrying the given arm. */
export function createAdjustMask(
  category: GradeCategory,
  arm: GradeState,
  opts: NewAdjustMaskOptions = {},
): AdjustmentMask {
  const key = GRADE_ARM_KEY[category as keyof typeof GRADE_ARM_KEY];
  const mask: AdjustmentMask = {
    id: '',
    category,
    grade: { [key]: arm } as GradeState,
    enabled: true,
    ...(opts.origin ? { origin: opts.origin } : {}),
    ...(opts.fromPreset ? { fromPreset: opts.fromPreset } : {}),
  };
  return mask;
}

/**
 * Drop a category's MANUAL masks from the chain (per-panel reset semantics:
 * masks tagged `origin: 'preset'` survive — removing an applied look is the
 * presets panel's job). Returns the patch for `updateLayer`; `undefined`
 * adjustMasks short-circuits back to the no-grade state.
 */
export function dropManualCategoryMasks(layer: Layer, category: GradeCategory): Partial<Layer> {
  const remaining = (layer.adjustMasks ?? []).filter(
    (m) => m.category !== category || isPresetOwned(m),
  );
  return { adjustMasks: remaining.length ? remaining : undefined };
}

/**
 * Drop every preset-owned mask from the chain (presets-panel reset and
 * second-click semantics). Hand-written grades stay on the layer.
 */
export function dropPresetOwnedMasks(layer: Layer): Partial<Layer> {
  const remaining = (layer.adjustMasks ?? []).filter((m) => !isPresetOwned(m));
  return { adjustMasks: remaining.length ? remaining : undefined };
}
