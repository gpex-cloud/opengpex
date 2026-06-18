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
import { ColorOptionsComponent } from "./components";
import { COLOR_OPTIONS_COMMANDS } from "./commands";
import * as P from "./protocols";
import { Palette } from "lucide-react";

/**
 * ColorOptions Plugin: Manages canvas background colors and fill layers.
 */
export const plugin: EditorPlugin = {
  manifest: {
    id: P.PLUGIN_ID,
    displayName: "Color Options",
    version: "1.0.0",
    description: "Set and manage canvas background colors and fill layers.",
    category: "options",
    author: P.PLUGIN_AUTHOR,
    requirements: {
      coreVersion: ">=1.0.0",
      auth: "none",
    },
  },
  icon: <Palette size={16} />,
  slot: "OPTION_BAR",
  show: "frame-required",
  order: 300,
  component: ColorOptionsComponent,
  commands: Object.values(COLOR_OPTIONS_COMMANDS),
  initialConfig: { pendingColor: "#EAB308" },
};

export default plugin;
