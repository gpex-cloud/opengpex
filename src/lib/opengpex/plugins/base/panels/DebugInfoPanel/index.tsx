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
import { EditorPlugin } from "@opengpex/editor/core/types";
import dynamic from "next/dynamic";
import { DEBUG_COMMANDS } from "./commands";
import * as P from "./protocols";

const DebugInfoComponent = dynamic(
  () => import("./components").then((m) => m.DebugInfoComponent),
  { ssr: false },
);
const DebugInfoSettings = dynamic(
  () => import("./components").then((m) => m.DebugInfoSettings),
  { ssr: false },
);

/**
 * DebugInfo Plugin: Provides real-time coordinates, performance, and state tree debugging info
 */
export const plugin: EditorPlugin = {
  manifest: {
    id: P.PLUGIN_ID,
    displayName: "Debug Info",
    version: "1.0.0",
    description:
      "Provide real-time coordinates, performance and state tree debugging info.",
    category: "panels",
    author: P.PLUGIN_AUTHOR,
    requirements: {
      coreVersion: ">=1.0.0",
      auth: "none",
    },
  },
  slot: "BR",
  show: "frame-required",
  component: DebugInfoComponent as React.ComponentType<Record<string, unknown>>,
  initialConfig: { enabled: false },
  commands: Object.values(DEBUG_COMMANDS),
  contributions: [
    {
      slot: "TOOL_SETTINGS",
      component: DebugInfoSettings as React.ComponentType<Record<string, unknown>>,
      title: "DebugInfoPanel",
      order: 210,
    },
  ],
};

export default plugin;
