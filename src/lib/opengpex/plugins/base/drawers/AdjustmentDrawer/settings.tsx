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

'use client';

/**
 * AdjustmentSettings — Settings panel for the AdjustmentDrawer.
 *
 * Rendered as a SETTINGS_CONFIG_PANEL contribution (a tab inside the global
 * Settings panel, opened via the drawer header split-button dropdown).
 * Currently a single preference: which sub-panel the drawer lands on when
 * opened. Row styling follows the TabDock settings convention (icon tile +
 * uppercase label + trailing Switch).
 */

import React from "react";
import { LayoutPanelTop } from "lucide-react";
import Switch from "@opengpex/editor/widgets/Switch";
import { usePluginSelfConfig } from "@opengpex/editor/core/context";
import type { AdjustmentDrawerConfig } from "./protocols";

export function AdjustmentSettings() {
  const [config, setConfig] = usePluginSelfConfig<AdjustmentDrawerConfig>();
  const openWithBasic = config?.openWithBasic ?? false;

  return (
    <div className="flex flex-col gap-3">
      <h5 className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-widest pl-1">
        Adjustments
      </h5>
      {/* Opening Panel Preference */}
      <button
        onClick={() => setConfig({ openWithBasic: !openWithBasic })}
        className="flex items-center justify-between w-full p-2.5 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] group"
      >
        <div className="flex items-center gap-3">
          <div
            className={`w-7 h-7 rounded-lg flex-shrink-0 flex items-center justify-center transition-colors ${openWithBasic ? "bg-indigo-500/10 text-indigo-600" : "bg-[var(--bg-stage)] text-[var(--text-muted)]"}`}
          >
            <LayoutPanelTop size={14} />
          </div>
          <div className="flex flex-col items-start leading-tight text-left">
            <span className="text-[10px] font-black text-[var(--text-main)] uppercase tracking-tight">
              Default to Basic Panel
            </span>
            <span className="text-[8px] text-[var(--text-muted)] font-bold uppercase">
              Opens the drawer on Basic instead of Presets
            </span>
          </div>
        </div>
        <Switch
          checked={openWithBasic}
          onChange={(v) => setConfig({ openWithBasic: v })}
          activeColor="bg-indigo-500"
        />
      </button>
    </div>
  );
}
