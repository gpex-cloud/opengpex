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
import { SettingsTrigger, SettingsPanel } from "./components";
import { SETTINGS_COMMANDS } from "./commands";
import * as P from "./protocols";

/**
 * SettingsPanel Plugin
 * Manages editor global preferences.
 */
export const plugin: EditorPlugin = {
  manifest: {
    id: P.PLUGIN_ID,
    displayName: "Editor Settings",
    version: "1.0.0",
    description: "Global preferences and theme settings.",
    category: "panels",
    author: P.PLUGIN_AUTHOR,
    requirements: {
      coreVersion: ">=1.0.0",
      auth: "none",
    },
  },

  slot: "HIDDEN",
  component: () => null,

  initialConfig: {
    panelPosition: "CT",
  } satisfies P.SettingsConfig,

  commands: Object.values(SETTINGS_COMMANDS),

  signals: [
    { id: P.SIGNAL_OPEN, name: 'Panel Open State', scope: 'public', defaultValue: false },
    { id: P.SIGNAL_TAB, name: 'Active Tab', scope: 'public', defaultValue: null },
  ],

  contributions: [
    {
      slot: "TOOL_SETTINGS",
      component: SettingsTrigger,
      order: 110,
    },
    {
      slot: "ROOT_OVERLAY",
      component: SettingsPanel,
    },
  ],
};

export default plugin;
