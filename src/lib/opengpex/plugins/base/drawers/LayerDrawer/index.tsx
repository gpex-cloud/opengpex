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
  order: 200,
  show: "frame-required",

  // --- 3. Core Implementation ---
  component: LayerComponent,
  initialConfig: {
    preferredWidth: 320,
  },

  // --- 4. Capabilities ---
  commands: Object.values(LAYER_COMMANDS),
};
