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

import React from "react";
import { Type } from "lucide-react";
import { EditorPlugin } from "@opengpex/editor/core/types";
import { FONT_LOADER_COMMANDS } from "./commands";
import { FontSettings } from "./FontSettings";
import * as P from "./protocols";

/**
 * FontLoader Plugin: System-wide dynamic font loading, caching, and configuration management.
 *
 * This is a backstage (HIDDEN) plugin that provides:
 * - `cmd.load_font` command for other plugins to trigger font loading
 * - `signal.loading` signal for UI to show loading indicators
 * - Future: FontSettings contribution to SETTINGS_CONFIG_PANEL
 *
 * Architecture:
 * - Runs as a global service plugin (slot: "HIDDEN", same as TimeTraveler)
 * - Delegates actual loading to ctx.fonts (FontService on EditorServiceContextValue)
 * - Acts as a command/signal bridge between UI plugins and the core font service
 */
export const plugin: EditorPlugin = {
  manifest: {
    id: P.PLUGIN_ID,
    displayName: "Font Loader",
    version: "1.0.0",
    description:
      "System-wide dynamic font loading, caching, and configuration management.",
    category: "backstage",
    author: P.PLUGIN_AUTHOR,
    requirements: {
      coreVersion: ">=1.0.0",
      auth: "none",
    },
  },
  slot: "HIDDEN",
  component: () => null,

  commands: Object.values(FONT_LOADER_COMMANDS),
  signals: [
    {
      id: P.SIGNAL_LOADING,
      name: "Font Loading State",
      scope: "public",
      defaultValue: false,
    },
  ],

  contributions: [
    {
      slot: "SETTINGS_CONFIG_PANEL",
      component: FontSettings,
      title: "Fonts",
      icon: <Type size={12} />,
      order: 300,
    },
  ],
};
