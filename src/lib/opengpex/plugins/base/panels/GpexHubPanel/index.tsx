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
import { GpexHubTrigger, GpexHubPanel } from "./components";
import * as P from "./protocols";
import { GPEX_HUB_COMMANDS } from "./commands";

/**
 * GpexHub Plugin: Plugin market & manager panel
 */
export const plugin: EditorPlugin = {
  manifest: {
    id: P.PLUGIN_ID,
    displayName: "GPEX-Hub",
    version: "1.0.0",
    description: "Plugin marketplace and manager.",
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
    open: false,
    activeTab: "explore",
    panelPosition: "CT",
  } satisfies P.GpexHubConfig,

  contributions: [
    {
      slot: "TOOL_MENU",
      component: GpexHubTrigger,
      order: 3000,
    },
    {
      slot: "ROOT_OVERLAY",
      component: GpexHubPanel,
    },
  ],

  commands: Object.values(GPEX_HUB_COMMANDS),
};

export default plugin;
