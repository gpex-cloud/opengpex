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
import { ColorGradingDrawerComponent } from "./components";
import { COLOR_GRADING_COMMANDS } from "./commands";
import { ColorGradingDrawerIcon } from "./icon";
import * as P from "./protocols";

/**
 * ColorGradingDrawer Plugin: Unified color-grading panel (Curves / Levels / Channel Mixer)
 *
 * Sidebar Drawer with mutually-exclusive sub-panels selected via a header
 * icon-button group — matches CraftDrawer's icon-switch pattern.
 *
 * Ordering rationale — spec §4.5 (post Step 7.5):
 * - `order: 3150` places this between CraftDrawer (3100) and the animation
 *   drawer so the sidebar reads top-to-bottom as: layers → info → craft →
 *   grading → animation, i.e. from structural (what) to pixel-level (how it
 *   looks). The old AdjustmentDrawer slot (3200) is now retired — its
 *   sliders live inside this drawer's Basic panel.

 * - `show: 'frame-required'` because color grading is a per-layer operation
 *   and the layer store is meaningless without a document loaded (avoids
 *   flashing an empty panel on the landing page — spec §3.5.5 memory
 *   constraint).
 * - No `autoReveal` — user should choose when to open this drawer; it does
 *   NOT gate on any interaction mode (unlike CraftDrawer's craft mode).
 */
export const plugin: EditorPlugin = {
  // --- 1. Identity ---
  manifest: {
    id: P.PLUGIN_ID,
    displayName: "Color Grading",
    // Bumped to 1.1.0 on the Step 7.5 AdjustmentDrawer merge — no API break
    // for consumers of `ColorGradingDrawerAPI`, but the plugin now exposes an
    // additional 'basic' tool + `beginAdjustmentsEdit / updateAdjustments`
    // commands, so semver-minor is the right tick.
    version: "1.1.0",
    description:
      "Basic adjustments, Curves, Levels and Channel Mixer — unified per-layer color grading.",

    author: P.PLUGIN_AUTHOR,
    category: "drawers",
    requirements: {
      coreVersion: ">=1.0.0",
      auth: "none",
    },
  },

  // --- 2. UI Entry ---
  icon: <ColorGradingDrawerIcon />,
  slot: "SIDE_BAR",
  show: "frame-required",
  order: 3150,

  // --- 3. Core Implementation ---
  component: ColorGradingDrawerComponent,

  // --- 4. Commands ---
  commands: Object.values(COLOR_GRADING_COMMANDS),

  // --- 5. Signals ---
  //
  // `defaultValue: DEFAULT_GRADING_TOOL` — currently `'basic'` after Step 7.5
  // (Photoshop / Lightroom convention: entry-level users see brightness/
  // contrast/saturation first; power users can flip to Curves/Levels/Mixer).
  // We deliberately do NOT default to `null` (unlike CraftDrawer's
  // activeCraft) because the panel ALWAYS shows one sub-panel; a null value
  // would force ternary fallbacks everywhere in the UI layer. Scope is
  // `public` so ColorOptions or a future scripting bridge can drive it.
  //
  // Legacy `pluginConfig.lastTool` values of `'curves' | 'levels' | 'mixer'`
  // written before Step 7.5 shipped still round-trip through the union — the
  // new `'basic'` value is additive, no migration needed.

  signals: [
    {
      id: P.SIGNAL_ACTIVE_GRADING_TOOL,
      name: "Active Color-Grading Tool",
      defaultValue: P.DEFAULT_GRADING_TOOL,
      scope: "public",
    },
  ],

  // --- 6. Contributions ---
  // No cross-plugin contributions in Step 4. Step 8 may add a curve-preview
  // dot into ColorOptions once the Curves editor is real.
  contributions: [],
};
