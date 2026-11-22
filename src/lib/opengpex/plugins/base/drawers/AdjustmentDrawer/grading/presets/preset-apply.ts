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
 * Preset application policy — how one look-swap lands on the layer's chain.
 *
 * @module plugins/base/drawers/AdjustmentDrawer/grading/presets/preset-apply
 */

import type {
  AdjustmentMask,
  GradeCategory,
  GradeState,
  Layer,
  Frame,
  AdjustmentState,
} from '@opengpex/editor/core/types/models';
import { MAX_ADJUSTMENT_MASKS_PER_LAYER } from '@opengpex/editor/core/types/models';
import { createAdjustMask, isPresetOwned } from '@opengpex/editor/core/layer/amask';
import { LayerFactory } from '@opengpex/editor/core/layer/factory';
import { applyPresetChainStrength, resolvePresetChain, type FilterPreset } from './preset-chain';
import { getFilterPreset } from './preset-data';
import { capBlocked, type GradeArm } from '../manual-apply';
import * as P from '../../protocols';
import type { AdjustmentDrawerConfig } from '../../protocols';
import { projectSelectionToLayer } from '../../utils-hotTail';
import type { EditorContextValue } from '@opengpex/editor/core/types';

export { isPresetOwned };

/**
 * Build the next `adjustMasks` array for a filter-preset write.
 *
 * WRITE STRATEGY — PRESET-OWNED REPLACEMENT: a preset owns only the masks it
 * wrote itself (tagged `origin: 'preset'`). The returned chain keeps every
 * NON-preset mask in its original order (manual grades survive a look swap)
 * and appends the new preset's strength-resolved masks after them. A second
 * application therefore replaces the previous preset's masks without ever
 * touching the user's own grades. A frozen selection snapshot rides each new
 * mask, matching the single-category writeArm semantics, and each new mask is
 * stamped with the applied preset's id (`fromPreset`) so the presets panel
 * highlights the card by identity rather than inferring it from grade values.
 *
 * CHAIN MODEL: the preset normalizes through `resolvePresetChain` — built-ins
 * contribute their single state as one stage; saved customs contribute one
 * stage per extracted mask. EVERY stage becomes its own mask in chain order,
 * because the renderer applies stages sequentially: a stage pair like
 * saturation 81.8 then saturation 200 compounds differently than any merge,
 * so writing the stages verbatim is what makes a saved look reproduce the
 * screen. Stage grades are written as resolved: the basic / curves arms stay
 * partial (the translator defaults absent basic fields to identity), while
 * levels / colorBalance / channelMix arms are completed with identity values
 * and the `preserveLuminosity: true` default — the translator reads those
 * fields directly with no internal fallback.
 *
 * Returns `undefined` (no write) when the write would exceed the per-layer
 * mask cap.
 */

export function buildPresetMasks(
  ctx: EditorContextValue,
  frame: Frame,
  layer: Layer,
  preset: FilterPreset,
  strength: number,
): AdjustmentMask[] | undefined {
  const resolved = applyPresetChainStrength(resolvePresetChain(preset), strength);
  const surviving = (layer.adjustMasks ?? []).filter((m) => !isPresetOwned(m));

  const shape = projectSelectionToLayer(ctx.geometry, frame, layer);
  const newMasks: AdjustmentMask[] = [];
  const push = (category: GradeCategory, arm: GradeArm) => {
    const mask = createAdjustMask(category, arm as GradeState, {
      origin: 'preset',
      fromPreset: preset.id,
    });
    mask.id = LayerFactory.newAdjustMaskId();
    if (shape) mask.shape = shape;
    newMasks.push(mask);
  };

  for (const entry of resolved) {
    const g = entry.grade;
    if (g.adjustments) {
      // Verbatim partial basic arm (no identity fill): absent fields render
      // as identity, and extraction re-reads only the fields the mask
      // defines, so a saved stage round-trips exactly.
      push('basic', g.adjustments as AdjustmentState);
    }
    if (g.curves) push('curves', g.curves);
    if (g.levels) push('levels', { ...P.DEFAULT_LEVELS_STATE, ...g.levels });
    if (g.colorBalance) {
      push('colorBalance', { ...P.DEFAULT_COLOR_BALANCE_STATE, ...g.colorBalance });
    }
    if (g.channelMix) {
      push('channelMix', {
        red: g.channelMix.red ?? [1, 0, 0],
        green: g.channelMix.green ?? [0, 1, 0],
        blue: g.channelMix.blue ?? [0, 0, 1],
        constant: g.channelMix.constant ?? [0, 0, 0],
      });
    }
  }

  if (surviving.length + newMasks.length > MAX_ADJUSTMENT_MASKS_PER_LAYER) {
    capBlocked(ctx);
    return undefined;
  }
  return [...surviving, ...newMasks];
}

/**
 * Resolve a preset id across BOTH sources: the built-in table first, then the
 * user's saved custom presets in the AdjustmentDrawer plugin config. Custom
 * presets are structurally identical `FilterPreset` values, so application is
 * the exact same write path — only the lookup differs.
 */

export function resolvePresetForApply(ctx: EditorContextValue, presetId: string): FilterPreset | undefined {
  return (
    getFilterPreset(presetId) ??
    (ctx.scoped?.selfConfig as AdjustmentDrawerConfig | undefined)?.customFilterPresets?.find(
      (p) => p.id === presetId,
    )
  );
}
