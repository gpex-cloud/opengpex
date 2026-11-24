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
import { AdjustmentDrawerComponent } from "./components";
import { AdjustmentSettings } from "./settings";
import { ADJUSTMENT_COMMANDS } from "./commands";
import { ChartSpline, Settings } from "lucide-react";
import * as P from "./protocols";

/**
 * AdjustmentDrawer Plugin: Unified adjustment panel (Curves / Levels / Channel Mixer)
 *
 * Sidebar Drawer with mutually-exclusive sub-panels selected via a header
 * icon-button group — matches CraftDrawer's icon-switch pattern.
 *
 * Ordering rationale:
 * - `order: 3150` places this between CraftDrawer (3100) and the animation
 *   drawer so the sidebar reads top-to-bottom as: layers → info → craft →
 *   grading → animation, i.e. from structural (what) to pixel-level (how it
 *   looks). The old AdjustmentDrawer slot (3200) is now retired — its
 *   sliders live inside this drawer's Basic panel.

 * - `show: 'frame-required'` because adjustment is a per-layer operation
 *   and the layer store is meaningless without a document loaded (avoids
 *   flashing an empty panel on the landing page).
 * - No `autoReveal` — user should choose when to open this drawer; it does
 *   NOT gate on any interaction mode (unlike CraftDrawer's craft mode).
 */
export const plugin: EditorPlugin = {
  // --- 1. Identity ---
  manifest: {
    id: P.PLUGIN_ID,
    displayName: "Adjustments",
    // Bumped to 1.1.0 on the AdjustmentDrawer merge — the plugin
    // now exposes an additional 'basic' tool + `beginAdjustmentsEdit /
    // updateAdjustments` commands, so semver-minor is the right tick.
    version: "1.1.0",
    description:
      "Basic adjustments, Curves, Levels and Channel Mixer — unified per-layer adjustment.",

    author: P.PLUGIN_AUTHOR,
    category: "drawers",
    requirements: {
      coreVersion: ">=1.0.0",
      auth: "none",
    },
  },

  // --- 2. UI Entry ---
  icon: <ChartSpline size={20} />,
  slot: "SIDE_BAR",
  show: "frame-required",
  order: 3150,

  // --- 3. Core Implementation ---
  component: AdjustmentDrawerComponent,

  // --- 4. Commands ---
  commands: Object.values(ADJUSTMENT_COMMANDS),

  // --- 5. Signals ---
  //
  // `defaultValue: DEFAULT_GRADING_TOOL` — currently `'basic'`
  // (Photoshop / Lightroom convention: entry-level users see brightness/
  // contrast/saturation first; power users can flip to Curves/Levels/Mixer).
  // We deliberately do NOT default to `null` (unlike CraftDrawer's
  // activeCraft) because the panel ALWAYS shows one sub-panel; a null value
  // would force ternary fallbacks everywhere in the UI layer. Scope is
  // `public` so ColorOptions or a future scripting bridge can drive it.
  //
  // Legacy `pluginConfig.lastTool` values written before the opening-panel
  // preference shipped are simply ignored — stale config data needs no
  // migration.

  signals: [
    {
      id: P.SIGNAL_ACTIVE_GRADING_TOOL,
      name: "Active Adjustment Tool",
      // Seeded as null (= "no explicit pick this session"). The framework
      // writes defaultValue into the state slot at registration and only
      // when the slot is undefined, so after every reload the slot reads
      // null until the user explicitly picks a panel — at which point the
      // openWithBasic preference no longer overrides their choice. A tool
      // default here (e.g. 'presets') would be indistinguishable from an
      // explicit presets pick and break both the preference and the pick.
      defaultValue: null,
      scope: "public",
    },
  ],

  // --- 6. Contributions ---
  // A settings tab in the global Settings panel (opened via the gear button
  // in the drawer header, next to the Reset split button).
  contributions: { ui: [
    {
      slot: "SETTINGS_CONFIG_PANEL",
      group: "adjustments",
      component: AdjustmentSettings,
      title: "Adjustments",
      icon: <Settings size={12} />,
      order: 510,
    },
  ] },
};
