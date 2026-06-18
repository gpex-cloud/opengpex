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
import { TimeTravelAction, LocalHistorySettings } from "./components";
import { TIMETRAVEL_COMMANDS } from "./commands";
import * as P from "./protocols";

/**
 * TimeTravel Plugin: Global history system
 * Replaces legacy HistoryTool, supporting global operations like undo branch creation.
 */
export const plugin: EditorPlugin = {
  manifest: {
    id: P.PLUGIN_ID,
    displayName: "Time Traveler",
    version: "1.0.0",
    description:
      "Global history system replacing old HistoryTool, supporting undo and branch creation.",
    category: "backstage",
    author: P.PLUGIN_AUTHOR,
    requirements: {
      coreVersion: ">=1.0.0",
      auth: "none",
    },
  },
  slot: "HIDDEN",
  show: "frame-required",
  component: () => null,

  commands: Object.values(TIMETRAVEL_COMMANDS),
  contributions: [
    {
      slot: "TOOL_MENU",
      component: TimeTravelAction,
      order: 200,
    },
    {
      slot: "SETTINGS_FILE_INFO",
      component: LocalHistorySettings,
      order: 100,
    },
  ],
};
