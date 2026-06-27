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
import { ImageInfoComponent } from "./components";
import { IMAGE_INFO_COMMANDS } from "./commands";

import { Info } from "lucide-react";

import * as P from "./protocols";

/**
 * Export Plugin: Image Info, Image Scaling and Export
 */
export const plugin: EditorPlugin = {
  // --- 1. Identity ---
  manifest: {
    id: P.PLUGIN_ID,
    displayName: "Image Info",
    version: "1.0.0",
    description: "Inspect selected image/layer properties and export options.",
    category: "drawers",
    author: P.PLUGIN_AUTHOR,
    requirements: {
      coreVersion: ">=1.0.0",
      auth: "none",
    },
  },

  // --- 2. UI Entry ---
  icon: <Info size={20} />,
  slot: "SIDE_BAR",
  side: "left",
  order: 1100,
  show: "frame-required",

  // --- 3. Core Implementation ---
  component: ImageInfoComponent,
  initialConfig: {
    pixels: { w: 0, h: 0 },
    lockAspect: true,
    format: "image/webp",
    quality: 92,
    preferredWidth: 320,
    keepExif: true,
  },

  // --- 4. Capabilities ---
  commands: Object.values(IMAGE_INFO_COMMANDS),
};

export default plugin;
