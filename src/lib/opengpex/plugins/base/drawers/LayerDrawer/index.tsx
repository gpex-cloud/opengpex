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

"use client";

import { EditorPlugin } from "@opengpex/editor/core/types";
import { LayerComponent } from "./components/LayerDrawer";
import { LAYER_COMMANDS } from "./commands";
import { Layers } from "lucide-react";

import * as P from "./protocols";

/**
 * Layer Plugin: Professional Layer Manager
 */
export const plugin: EditorPlugin = {
  // --- 1. Identity ---
  manifest: {
    id: P.PLUGIN_ID,
    displayName: "Layers",
    version: "1.0.0",
    description:
      "Professional layer manager for reordering, visibility toggling, merging, and property editing.",
    category: "drawers",
    author: P.PLUGIN_AUTHOR,
    requirements: {
      coreVersion: ">=1.0.0",
      auth: "none",
    },
  },

  // --- 2. UI Entry ---
  icon: <Layers size={20} />,
  slot: "SIDE_BAR",
  side: "left",
  order: 1100,
  show: "frame-required",

  // --- 3. Core Implementation ---
  component: LayerComponent,
  initialConfig: {
    preferredWidth: 320,
  },

  // --- 4. Auto-Reveal ---
  autoReveal: {
    // Expand when active frame has more than 1 layer
    when: (state) => {
      if (!state.activeFrameId) return false;
      const frame = state.frames.byId[state.activeFrameId];
      return !!frame && frame.layers.order.length > 1;
    },
    priority: 90,
  },

  // --- 5. Capabilities ---
  commands: Object.values(LAYER_COMMANDS),

  // --- 6. Signals ---
  signals: [
    {
      id: P.MASK_EDITING_KEY,
      name: "Mask Editing Target",
      defaultValue: null,
      scope: "public",
    },
    {
      id: P.MASK_FOCUS_KEY,
      name: "Mask Focus Overlay Active",
      defaultValue: true,
      scope: "public",
    },
    {
      id: P.SHOW_SUB_LAYERS_KEY,
      name: "Show Sub-layers Button",
      defaultValue: false,
      scope: "public",
    },
  ],
};
