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
import { ViewportComponent } from "./components";
import * as P from "./protocols";
import { Monitor } from "lucide-react";

/**
 * ViewportOptions Plugin: A toolbar plugin providing viewport control features
 * including canvas rotation, flipping, and zooming.
 */
export const plugin: EditorPlugin = {
  manifest: {
    id: P.PLUGIN_ID,
    displayName: "Viewport Options",
    version: "1.0.0",
    description:
      "Canvas manipulation tools including rotation, flipping, and zoom control.",
    category: "options",
    author: P.PLUGIN_AUTHOR,
    requirements: {
      coreVersion: ">=1.0.0",
      auth: "none",
    },
  },
  icon: <Monitor size={16} />,
  slot: "OPTION_BAR",
  show: "frame-required",
  component: ViewportComponent,
};

export default plugin;
