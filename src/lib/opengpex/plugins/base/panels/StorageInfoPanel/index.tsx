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
import { STORAGE_COMMANDS } from "./commands";
import * as P from "./protocols";

const StorageInfoComponent = dynamic(
  () => import("./components").then((m) => m.StorageInfoComponent),
  { ssr: false },
);
const StorageInfoSettings = dynamic(
  () => import("./components").then((m) => m.StorageInfoSettings),
  { ssr: false },
);

/**
 * StorageInfo Plugin: Visually displays the current storage assets (CAS Pool) and their reference relationships
 */
export const plugin: EditorPlugin = {
  manifest: {
    id: P.PLUGIN_ID,
    displayName: "Storage Explorer",
    version: "1.0.0",
    description:
      "Visualize storage assets (CAS Pool) and reference relationships.",
    category: "panels",
    author: P.PLUGIN_AUTHOR,
    requirements: {
      coreVersion: ">=1.0.0",
      auth: "none",
    },
  },

  slot: "BR",
  component: StorageInfoComponent,

  initialConfig: {
    enabled: false,
    dashboardMode: false,
  } satisfies P.StoragePluginConfig,

  commands: Object.values(STORAGE_COMMANDS),

  contributions: [
    {
      slot: "TOOL_SETTINGS",
      component: StorageInfoSettings,
      title: "StorageInfoPanel",
      order: 220,
    },
  ],
};

export default plugin;
