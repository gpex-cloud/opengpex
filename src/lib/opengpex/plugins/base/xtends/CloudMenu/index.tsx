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
import { CloudMenuComponent } from "./components";
import { CLOUD_MENU_COMMANDS } from "./commands";
import * as P from "./protocols";

/**
 * CloudMenu Plugin: Cloud account & storage management UI.
 * Registers to the XTEND_SLOT — a generic extension point in the workspace top-right corner.
 *
 * Configuration:
 *   cloudUrl — The GPEX Cloud API base URL.
 *              Defaults to 'https://gpex.cloud' (production).
 *              Override with 'http://localhost:3031' for local development.
 */
export const plugin: EditorPlugin = {
  manifest: {
    id: P.PLUGIN_ID,
    displayName: "Cloud Menu",
    version: "1.1.0",
    description:
      "Provides cloud account sign-in, storage usage display, and session management.",
    category: "xtends",
    author: P.PLUGIN_AUTHOR,
    requirements: {
      coreVersion: ">=1.0.0",
      auth: "none",
    },
  },
  slot: "XTEND_SLOT",
  show: "always-show",
  order: 100,
  component: CloudMenuComponent,
  commands: Object.values(CLOUD_MENU_COMMANDS),
};

export default plugin;
