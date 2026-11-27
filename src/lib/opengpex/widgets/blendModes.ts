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
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * blendModes.ts — the single UI vocabulary seat for blend-mode dropdowns.
 *
 * Every blend-mode picker in the app (layer props bar, per-effect panels)
 * must render the SAME grouped list in the SAME order: one seat means one
 * place to add a mode or reorder a group. The mode MATH itself lives in the
 * shader's BLEND_MODE_MAP (core/gpu/shaders/blend) — this module is display
 * vocabulary only and neither seat may add enum members.
 *
 * @module widgets/blendModes
 */

import type { ActionOption } from '@opengpex/editor/widgets/ActionDropdown';
import type { LayerBlendMode } from '@opengpex/editor/core/types/models';

export interface BlendModeEntry {
  readonly value: LayerBlendMode;
  readonly label: string;
}

export interface BlendModeGroup {
  readonly modes: readonly BlendModeEntry[];
}

/** Grouped exactly like the reference product's blend-mode menu: normal,
 * darken family, lighten family, contrast family, difference family,
 * HSL component family. */
export const BLEND_MODE_GROUPS: readonly BlendModeGroup[] = [
  { modes: [{ value: 'source-over', label: 'Normal' }] },
  { modes: [
    { value: 'multiply', label: 'Multiply' },
    { value: 'darken', label: 'Darken' },
    { value: 'color-burn', label: 'Color Burn' },
  ] },
  { modes: [
    { value: 'screen', label: 'Screen' },
    { value: 'lighten', label: 'Lighten' },
    { value: 'color-dodge', label: 'Color Dodge' },
  ] },
  { modes: [
    { value: 'overlay', label: 'Overlay' },
    { value: 'soft-light', label: 'Soft Light' },
    { value: 'hard-light', label: 'Hard Light' },
  ] },
  { modes: [
    { value: 'difference', label: 'Difference' },
    { value: 'exclusion', label: 'Exclusion' },
  ] },
  { modes: [
    { value: 'hue', label: 'Hue' },
    { value: 'saturation', label: 'Saturation' },
    { value: 'color', label: 'Color' },
    { value: 'luminosity', label: 'Luminosity' },
  ] },
];

/** Flat mode-label lookup for the closed dropdown trigger. */
export const BLEND_MODE_LABEL_MAP: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const group of BLEND_MODE_GROUPS) {
    for (const mode of group.modes) {
      map.set(mode.value, mode.label);
    }
  }
  return map;
})();

/**
 * ActionDropdown options with a divider between groups. One display-order
 * deviation from BLEND_MODE_GROUPS: the HSL band renders before the
 * Difference band with no divider at their shared boundary. The multi-
 * column option grid is rectangular; with the canonical order the 2-mode
 * Difference group leaves a permanent hole in one row and the HSL group's
 * 4th member sits alone on the last row. Rendering HSL (4 modes) followed
 * directly by Difference (2 modes) fills exactly two rows — Luminosity
 * stays adjacent to its own family and the 2-mode group closes the panel.
 * Enum membership and BLEND_MODE_GROUPS (the family truth) are untouched —
 * this is display packing only.
 */
export const BLEND_MODE_DROPDOWN_OPTIONS: ActionOption[] = (() => {
  // Display order swaps the last two bands: HSL renders before Difference
  // (see the comment above the export).
  const difference = BLEND_MODE_GROUPS.find((g) => g.modes.some((m) => m.value === 'difference'));
  const hsl = BLEND_MODE_GROUPS.find((g) => g.modes.some((m) => m.value === 'hue'));
  const rest = BLEND_MODE_GROUPS.filter((g) => g !== difference && g !== hsl);
  const displayOrder = [...rest, hsl, difference];
  const options: ActionOption[] = [];
  for (let gi = 0; gi < displayOrder.length; gi++) {
    const group = displayOrder[gi];
    if (!group) continue;
    // The joined HSL→Difference boundary carries no divider: a divider
    // would land mid-row (the option grid cannot express a divider between
    // two cells of a row), and the seamless join is what packs the two
    // groups into two full rows.
    const joinedWithPrevious = group === difference;
    if (gi > 0 && !joinedWithPrevious) {
      options.push({ divider: true });
    }
    for (const mode of group.modes) {
      options.push({ label: mode.label, value: mode.value });
    }
  }
  return options;
})();
