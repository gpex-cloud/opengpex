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
import { GuideTrigger, GuidePanel } from "./components";
import { GUIDE_COMMANDS } from "./commands";
import * as P from "./protocols";

/**
 * UserGuidePanel Plugin
 * Provides editor shortcut keys guide and operation instructions
 */
export const plugin: EditorPlugin = {
  manifest: {
    id: P.PLUGIN_ID,
    displayName: "User Guide & Help",
    version: "1.0.0",
    description: "Interactive guide for shortcuts and gestures.",
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
    panelPosition: "BR",
  } satisfies P.GuideConfig,

  commands: Object.values(GUIDE_COMMANDS),

  signals: [
    { id: P.SIGNAL_OPEN, name: 'Guide Panel Open State', scope: 'private', defaultValue: false },
  ],

  contributions: [
    {
      slot: "TOOL_SETTINGS",
      component: GuideTrigger,
      order: 120,
    },
    {
      slot: "ROOT_OVERLAY",
      component: GuidePanel,
    },
  ],
};

export default plugin;
