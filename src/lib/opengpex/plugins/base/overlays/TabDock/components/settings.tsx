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
import { Maximize2, Indent, Activity, Settings, AlignHorizontalDistributeCenter } from "lucide-react";
import Switch from "@opengpex/editor/widgets/Switch";
import { useTabDock } from "../hooks";

/**
 * TabDockSettings: Configuration item component contributed to settings panel
 */
export function TabDockSettings() {
  const { state, updateConfig } = useTabDock();
  const { config } = state;
  const showSettingsButton = config.showSettingsButton ?? true;

  // Feature toggles to easily toggle read-only behavior for settings

  const SNAP_OPTIONS = [
    { id: 'BL', label: 'Left' },
    { id: 'BC', label: 'Center' },
    { id: 'BR', label: 'Right' },
  ] as const;

  const snapLabel = SNAP_OPTIONS.find((o) => o.id === (config.snap || 'BC'))?.label ?? 'Center';

  return (
    <div className="flex flex-col gap-3">
      <h5 className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-widest pl-1">
        Tab Dock Layout
      </h5>      
      {/* 1. Show Settings Button Toggle */}
      <button
        onClick={() => updateConfig({ showSettingsButton: !showSettingsButton })}
        className="flex items-center justify-between w-full p-2.5 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] group"
      >
        <div className="flex items-center gap-3">
          <div
            className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${showSettingsButton ? "bg-violet-500/10 text-violet-500" : "bg-[var(--bg-stage)] text-[var(--text-muted)]"}`}
          >
            <Settings size={13} />
          </div>
          <span className="text-[10px] font-black text-[var(--text-main)] uppercase tracking-tight">
            Show Settings Button
          </span>
        </div>
        <Switch
          checked={showSettingsButton}
          onChange={(v) => updateConfig({ showSettingsButton: v })}
          activeColor="bg-violet-500"
        />
      </button>

      {/* 2. Always Expand Switch */}
      <button
        onClick={() => updateConfig({ showProps: !config.showProps })}
        className="flex items-center justify-between w-full p-2.5 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] group"
      >
        <div className="flex items-center gap-3">
          <div
            className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${config.showProps ? "bg-emerald-500/10 text-emerald-500" : "bg-[var(--bg-stage)] text-[var(--text-muted)]"}`}
          >
            <Maximize2 size={13} />
          </div>
          <span className="text-[10px] font-black text-[var(--text-main)] uppercase tracking-tight">
            Always Expand
          </span>
        </div>
        <Switch
          checked={config.showProps || false}
          onChange={(v) => updateConfig({ showProps: v })}
          activeColor="bg-emerald-500"
        />
      </button>

      {/* 3. Branch Indentation Toggle */}
      <button
        onClick={() => updateConfig({ indentBranches: !config.indentBranches })}
        className="flex items-center justify-between w-full p-2.5 rounded-xl bg-[var(--bg-stage)] hover transition-all border border-[var(--border-subtle)] group"
      >
        <div className="flex items-center gap-3">
          <div
            className={`w-7 h-7 rounded-lg flex-shrink-0 flex items-center justify-center transition-colors ${config.indentBranches ? "bg-indigo-500/10 text-indigo-600 " : "bg-[var(--bg-stage)] text-[var(--text-muted)]"}`}
          >
            <Indent size={14} />
          </div>
          <div className="flex flex-col items-start leading-tight text-left">
            <span className="text-[10px] font-black text-[var(--text-main)] uppercase tracking-tight">
              Branch Indentation
            </span>
            <span className="text-[8px] text-[var(--text-muted)] font-bold uppercase">
              Show hierarchy levels
            </span>
          </div>
        </div>
        <Switch
          checked={config.indentBranches || false}
          onChange={(v) => updateConfig({ indentBranches: v })}
          activeColor="bg-indigo-500"
        />
      </button>

      {/* 4. Metrics HUD Toggle */}
      <button
        onClick={() => updateConfig({ showMetricsHud: !config.showMetricsHud })}
        className="flex items-center justify-between w-full p-2.5 rounded-xl bg-[var(--bg-stage)] hover transition-all border border-[var(--border-subtle)] group"
      >
        <div className="flex items-center gap-3">
          <div
            className={`w-7 h-7 rounded-lg flex-shrink-0 flex items-center justify-center transition-colors ${config.showMetricsHud ? "bg-amber-500/10 text-amber-500" : "bg-[var(--bg-stage)] text-[var(--text-muted)]"}`}
          >
            <Activity size={14} />
          </div>
          <div className="flex flex-col items-start leading-tight text-left">
            <span className="text-[10px] font-black text-[var(--text-main)] uppercase tracking-tight">
              Metrics HUD
            </span>
            <span className="text-[8px] text-[var(--text-muted)] font-bold uppercase">
              FPS · World · Local coords
            </span>
          </div>
        </div>
        <Switch
          checked={config.showMetricsHud ?? false}
          onChange={(v) => updateConfig({ showMetricsHud: v })}
          activeColor="bg-amber-500"
        />
      </button>

      {/* 6. Dock Alignment */}
      <div className="flex items-center justify-between p-2.5 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)]">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-indigo-500/10 text-indigo-500">
            <AlignHorizontalDistributeCenter size={13} />
          </div>
          <div className="flex flex-col text-left leading-tight">
            <span className="text-[10px] font-black text-[var(--text-main)] uppercase tracking-tight">
              Dock Alignment
            </span>
            <span className="text-[8px] text-[var(--text-muted)] font-bold uppercase">
              {snapLabel}
            </span>
          </div>
        </div>

        <div className="flex gap-1">
          {SNAP_OPTIONS.map(({ id, label }) => {
            const isActive = (config.snap || "BC") === id;
            return (
              <button
                key={id}
                onClick={() => updateConfig({ snap: id, position: undefined })}
                title={label}
                className={`w-3.5 h-3.5 rounded-md transition-all flex items-center justify-center ${
                  isActive
                    ? "bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.5)]"
                    : "bg-[var(--bg-panel)]/50 hover:bg-[var(--border-subtle)]"
                }`}
              >
                <div
                  className={`w-1 h-1 rounded-full transition-all duration-300 ${
                    isActive
                      ? "bg-[var(--text-main)]"
                      : "bg-[var(--text-muted)] opacity-50"
                  }`}
                />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
