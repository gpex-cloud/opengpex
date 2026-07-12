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

import { EditorPlugin } from "@opengpex/editor/core/types";
import { ClipOptionsMain, ClipSelectionActions } from "./components";
import { CLIP_OPTIONS_COMMANDS, CLIP_INTERCEPTORS } from "./commands";

import * as P from "./protocols";
import { Maximize } from "lucide-react";

/**
 * ClipOptions Plugin: Provides cropping, canvas adjustments, and WebP export features.
 */
export const plugin: EditorPlugin = {
  manifest: {
    id: P.PLUGIN_ID,
    displayName: "Clip Options",
    version: "1.0.0",
    description:
      "Provides precise image cropping, canvas resizing, and standard export features.",
    category: "options",
    author: P.PLUGIN_AUTHOR,
    requirements: {
      coreVersion: ">=1.0.0",
      auth: "none",
    },
  },
  icon: <Maximize size={16} />,
  slot: "OPTION_BAR",
  show: "frame-required",
  order: 200,
  component: ClipOptionsMain,
  commands: Object.values(CLIP_OPTIONS_COMMANDS),
  signals: [
    {
      id: P.SIGNAL_RE_CANVAS,
      name: "Canvas Re-Size Active Status",
      defaultValue: false,
      scope: "public",
    },
    {
      id: P.SIGNAL_CLIP_FEATHER,
      name: "Feather Radius (px)",
      defaultValue: 0,
      scope: "public",
    },
  ],
  interceptors: {
    command: {
      beforeExecute: (id, ctx) => CLIP_INTERCEPTORS.beforeExecute(id, ctx),
    },
  },
  contributions: [
    {
      slot: "TOOL_MENU",
      component: ClipSelectionActions,
      order: 300,
    },
  ],
};

export default plugin;
