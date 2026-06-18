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

import PluginSlot from "./PluginSlot";
import { EDITOR_Z_INDEX } from "@opengpex/editor/core/helpers/config";

export const ViewportHUD = () => (
  <div className="absolute inset-0 pointer-events-none">
    <PluginSlot
      name="VIEWPORT_OVERLAY"
      className="absolute inset-0 pointer-events-none"
    />
    <PluginSlot
      name="TL"
      className="absolute top-6 left-6 pointer-events-auto"
      style={{
        zIndex: EDITOR_Z_INDEX.UI.WORKSPACE_BASE,
        left: "calc(var(--v-offset-left) + 24px)",
      }}
    />
    <PluginSlot
      name="TR"
      className="absolute top-6 right-6 pointer-events-auto"
      style={{
        zIndex: EDITOR_Z_INDEX.UI.WORKSPACE_BASE,
        right: "calc(var(--v-offset-right) + 24px)",
      }}
    />
    <PluginSlot
      name="BL"
      className="absolute bottom-6 left-6 pointer-events-auto"
      style={{
        zIndex: EDITOR_Z_INDEX.UI.WORKSPACE_BASE,
        left: "calc(var(--v-offset-left) + 24px)",
      }}
    />
    <PluginSlot
      name="BR"
      className="absolute bottom-6 right-6 flex flex-row-reverse items-end gap-3 pointer-events-none"
      style={{
        zIndex: EDITOR_Z_INDEX.UI.WORKSPACE_BASE,
        right: "calc(var(--v-offset-right) + 24px)",
      }}
    />
  </div>
);
