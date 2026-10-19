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
import dynamic from "next/dynamic";
import { FORMAT_STRATEGY_COMMANDS } from "./commands";
import * as P from "./protocols";

const FormatStrategyComponent = dynamic(
  () => import("./components").then((m) => m.FormatStrategyComponent),
  { ssr: false },
);
const FormatStrategySettings = dynamic(
  () => import("./components").then((m) => m.FormatStrategySettings),
  { ssr: false },
);

/**
 * FormatStrategy Plugin: visual review console for the ingest decision rule
 * table and the egest capability map / decision solver. Everything renders
 * from the live strategy sources — no copied strategy data, nothing to drift.
 */
export const plugin: EditorPlugin = {
  manifest: {
    id: P.PLUGIN_ID,
    displayName: "Format Strategy",
    version: "1.0.0",
    description:
      "Inspect the full ingest rule table (with winning-rule highlighting) and the egest capability map with a live decision resolver.",
    category: "panels",
    author: P.PLUGIN_AUTHOR,
    requirements: {
      coreVersion: ">=1.0.0",
      auth: "none",
    },
  },

  slot: "BR",
  show: "always-show",

  component: FormatStrategyComponent,

  initialConfig: {
    enabled: false,
  } satisfies P.FormatStrategyPluginConfig,

  commands: Object.values(FORMAT_STRATEGY_COMMANDS),

  contributions: { ui: [
    {
      slot: "TOOL_SETTINGS",
      component: FormatStrategySettings,
      title: "FormatStrategyPanel",
      order: 230,
    },
  ] },
};

export default plugin;
