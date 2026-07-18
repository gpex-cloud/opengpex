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
import { CraftDrawerComponent, CraftTriggerButtons } from "./components";
import { CRAFT_COMMANDS } from "./commands";
import { CraftDrawerIcon } from "./icon";
import { ColorOptionsAPI } from "../../options/ColorOptions/protocols";
import * as P from "./protocols";

/**
 * CraftDrawer Plugin: Unified craft tool panel (Text / Brush / Eraser)
 *
 * Sidebar Drawer, managing tabs internally.
 * activeCraft signal drives current tool state.
 */
export const plugin: EditorPlugin = {
  // --- 1. Identity ---
  manifest: {
    id: P.PLUGIN_ID,
    displayName: "Drawing Tools",
    version: "1.0.0",
    description: "Text, Brush and Eraser tool settings.",
    author: P.PLUGIN_AUTHOR,
    category: "drawers",
    requirements: {
      coreVersion: ">=1.0.0",
      auth: "none",
    },
  },

  // --- 2. UI Entry ---
  icon: <CraftDrawerIcon />,
  slot: "SIDE_BAR",
  show: "frame-required",
  order: 3100,

  // --- 3. Core Implementation ---
  component: CraftDrawerComponent,

  // --- 4. Commands ---
  commands: Object.values(CRAFT_COMMANDS),

  // --- 5. Signals ---
  signals: [
    {
      id: P.SIGNAL_ACTIVE_CRAFT,
      name: "Currently Active Tool",
      defaultValue: null,
      scope: "public",
    },
  ],

  // --- 6. Contributions ---
  contributions: [
    {
      slot: ColorOptionsAPI.slots.craft,
      component: CraftTriggerButtons,
      order: 100,
    },
  ],

  // --- 7. Auto-Reveal ---
  autoReveal: {
    // Expand when any craft tool is activated (user clicked a trigger button or pressed T/B/E)
    when: (state) => state.interaction.signals[P.CraftDrawerAPI.signals.activeCraft] != null,
    // Auto-collapse when craft tool is deactivated (user pressed V or mode changed externally)
    collapseWhenFalse: 'restore',
    priority: 200,
  },

  // --- 8. Bidirectional Linkage ---
  // Forward: activeCraft set to non-null → auto-set interactionMode='craft'
  // Reverse: interactionMode leaves 'craft' → auto-clear activeCraft
  onAction: (action, state, actions) => {
    if (action.type === "SET_INTERACTION") {
      const payload = action.payload as { interactionMode?: string; signals?: Record<string, unknown> };
      const craftKey = P.CraftDrawerAPI.signals.activeCraft;

      // Reverse linkage: mode explicitly set to non-'craft' → clear activeCraft
      if (payload.interactionMode && payload.interactionMode !== "craft") {
        if (state.interaction.signals[craftKey] != null) {
          actions.setStateSignal(craftKey, null);
        }
      }

      // Forward linkage: activeCraft set to non-null → auto-set mode='craft'
      if (payload.signals && craftKey in payload.signals) {
        const newCraft = payload.signals[craftKey];
        if (newCraft != null && state.interaction.interactionMode !== "craft" && !payload.interactionMode) {
          actions.setInteraction({ interactionMode: "craft" });
        }
      }
    }
  },
};
