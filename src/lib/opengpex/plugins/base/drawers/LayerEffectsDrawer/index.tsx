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

import { EditorPlugin } from "@opengpex/editor/core/types";
import { LayerEffectsDrawerComponent } from "./components";
import { EfxIcon } from "./icon";
import { EFFECT_COMMANDS } from "./commands";
import * as P from "./protocols";

/**
 * LayerEffectsDrawer Plugin: per-layer non-destructive render effects (A8).
 *
 * Vertical-tab drawer (one tab per effect category, main area = the active
 * category's parameter panel) — the PS Layer Style dialog form. A dedicated
 * drawer (not a LayersDrawer Popover) because the effect family grows to ten
 * kinds; the drawer framework absorbs growth unchanged.
 *
 * Ordering rationale: `order: 3160` places it directly after AdjustmentDrawer
 * (3150), so the sidebar reads layers → info → craft → grading → effects →
 * animation — content-affecting drawers grouped together.
 *
 * - `show: 'frame-required'`: effects edit per-layer state; the panel is
 *   meaningless without a document loaded.
 * - No `autoReveal`: the user opens it (or jumps from the layers-drawer
 *   family row in P4); it gates on no interaction mode.
 * - P3 wires the parameter pipeline: per-instance tabs (eye / floor-guarded
 *   delete), the stroke parameter rows on the Q4 fast channel, and the chain
 *   commands. The layers-drawer jump channel lands with P4; shadow's rows
 *   with P5. `pnpm sync-plugins` picks the plugin up.
 */
export const plugin: EditorPlugin = {
  // --- 1. Identity ---
  manifest: {
    id: P.PLUGIN_ID,
    displayName: "Effects",
    version: "0.1.0",
    description: "Per-layer non-destructive render effects (stroke / drop shadow).",
    category: "drawers",
    author: P.PLUGIN_AUTHOR,
    requirements: {
      coreVersion: ">=1.0.0",
      auth: "none",
    },
  },

  // --- 2. UI Entry ---
  icon: <EfxIcon size={20} />,
  slot: "SIDE_BAR",
  show: "frame-required",
  order: 3160,

  // --- 3. Core Implementation ---
  component: LayerEffectsDrawerComponent,

  // --- 3b. Signals (P4 jump channel: layers-drawer family row → this drawer) ---
  signals: [
    {
      id: P.SIGNAL_ACTIVE_EFFECT_INSTANCE,
      name: 'Jump to Effect Instance',
      defaultValue: null,
      scope: 'public',
    },
  ],

  // --- 4. Commands (P3 chain + Q4 fast gesture trio; P4 jump) ---
  commands: Object.values(EFFECT_COMMANDS),
};

export default plugin;
