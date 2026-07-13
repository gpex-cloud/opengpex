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

/**
 * AIToolsSettings — Unified settings panel for all AI tools.
 *
 * This is the main settings panel shell registered in SETTINGS_CONFIG_PANEL.
 * Each tool contributes its own settings section as a collapsible group.
 */

import { BgRemovalModelSettings } from "./bgremover";

export function AIToolsSettings() {
  return (
    <div className="flex flex-col gap-0">
      {/* ─── BG Removal Section ──────────────────────────────── */}
      <BgRemovalModelSettings />

      {/* ─── Future tool sections will be added here ─────────── */}
      {/* <UpscaleSettings /> */}
      {/* <SegmentationSettings /> */}
    </div>
  );
}
