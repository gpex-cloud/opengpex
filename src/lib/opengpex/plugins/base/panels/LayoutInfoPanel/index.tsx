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
import { LAYOUT_COMMANDS } from "./commands";
import * as P from "./protocols";

const LayoutInfoComponent = dynamic(
  () => import("./components").then((m) => m.LayoutInfoComponent),
  { ssr: false },
);
const LayoutInfoSettings = dynamic(
  () => import("./components").then((m) => m.LayoutInfoSettings),
  { ssr: false },
);

/**
 * LayoutInfo Plugin: Real-time visual blueprint inspector for workspace blocks & slot contributions.
 */
export const plugin: EditorPlugin = {
  manifest: {
    id: P.PLUGIN_ID,
    displayName: "Layout Inspector",
    version: "1.0.0",
    description:
      "Real-time visual blueprint inspector for workspace blocks & slot contributions.",
    category: "panels",
    author: P.PLUGIN_AUTHOR,
    requirements: {
      coreVersion: ">=1.0.0",
      auth: "none",
    },
  },
  slot: "BR",
  component: LayoutInfoComponent,
  initialConfig: { enabled: false } satisfies P.LayoutConfig,
  commands: Object.values(LAYOUT_COMMANDS),
  contributions: [
    {
      slot: "TOOL_SETTINGS",
      component: LayoutInfoSettings,
      title: "LayoutInfoPanel",
      order: 230,
    },
  ],
};

export default plugin;
