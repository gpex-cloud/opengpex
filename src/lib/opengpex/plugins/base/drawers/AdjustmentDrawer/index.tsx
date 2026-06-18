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
import { AdjustmentComponent } from "./components";

import { ADJUSTMENT_COMMANDS } from "./commands";
import { Sliders } from "lucide-react";

import * as P from "./protocols";

/**
 * Adjustments Plugin: Canvas/Layer Adjustment Drawer
 */
export const plugin: EditorPlugin = {
  // --- 1. Identity ---
  manifest: {
    id: P.PLUGIN_ID,
    displayName: "Adjustments",
    version: "1.0.0",
    description:
      "Provide various image adjustments like Levels, Curves, Hue/Saturation, etc.",
    category: "drawers",
    author: P.PLUGIN_AUTHOR,
    requirements: {
      coreVersion: ">=1.0.0",
      auth: "none",
    },
  },

  // --- 2. UI Entry ---
  icon: <Sliders size={20} />,
  slot: "SIDE_BAR",
  order: 400,
  show: "frame-required",

  // --- 3. Core Implementation ---
  component: AdjustmentComponent,
  initialConfig: {
    preferredWidth: 320,
  },

  // --- 4. Capabilities ---
  commands: Object.values(ADJUSTMENT_COMMANDS),
};
