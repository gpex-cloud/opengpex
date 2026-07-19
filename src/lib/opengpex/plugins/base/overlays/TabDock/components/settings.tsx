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
import { Rows2, Columns2, Maximize2, Indent, Activity } from "lucide-react";
import Switch from "@opengpex/editor/widgets/Switch";
import { useTabDock } from "../hooks";

/**
 * TabDockSettings: Configuration item component contributed to settings panel
 */
export function TabDockSettings() {
  const { state, updateConfig } = useTabDock();
  const { config } = state;

  // Feature toggles to easily toggle read-only behavior for settings
  const IS_LAYOUT_READ_ONLY = true;
  const IS_GRID_RESTRICTED_READ_ONLY = true; // when true, grid items other than BL, BC, BR are read-only

  return (
    <div className="flex flex-col gap-3">
      <h5 className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-widest pl-1">
        Tab Dock Layout
      </h5>

      {/* 1. Orientation Toggle */}
      <div className="flex bg-[var(--bg-stage)] rounded-xl p-1 gap-1">
        {[
          { id: "horizontal", icon: <Rows2 size={13} />, label: "Horizontal" },
          { id: "vertical", icon: <Columns2 size={13} />, label: "Vertical" },
        ].map((item) => {
          const isActive = (config.orientation || "horizontal") === item.id;
          return (
            <button
              key={item.id}
              disabled={IS_LAYOUT_READ_ONLY}
              onClick={() => {
                if (IS_LAYOUT_READ_ONLY) return;
                updateConfig({
                  orientation: item.id as "horizontal" | "vertical",
                });
              }}
              className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg transition-all ${
                isActive
                  ? IS_LAYOUT_READ_ONLY
                    ? "bg-[var(--bg-panel)]/60 text-indigo-500/60 shadow-none"
                    : "bg-[var(--bg-panel)] text-indigo-500 shadow-sm"
                  : IS_LAYOUT_READ_ONLY
                    ? "text-[var(--text-muted)]/50"
                    : "text-[var(--text-muted)] hover:text-[var(--text-main)]"
              } ${IS_LAYOUT_READ_ONLY ? "cursor-not-allowed opacity-50" : ""}`}
            >
              {item.icon}{" "}
              <span className="text-[10px] font-black uppercase tracking-tight">
                {item.label}
              </span>
            </button>
          );
        })}
      </div>

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
          checked={config.showMetricsHud ?? true}
          onChange={(v) => updateConfig({ showMetricsHud: v })}
          activeColor="bg-amber-500"
        />
      </button>

      {/* 5. Dock Alignment (Miniature Grid) */}
      <div className="flex items-start justify-between p-2.5 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] transition-colors hover group">
        <div className="flex flex-col pl-1 pt-1 text-left leading-tight">
          <span className="text-[10px] font-black text-[var(--text-main)] uppercase tracking-tight">
            Dock Alignment
          </span>
          <span className="text-[8px] text-[var(--text-muted)] font-bold uppercase">
            {config.snap === "TC"
              ? "Top Center"
              : (config.snap || "BC") === "BC"
                ? "Bottom Center"
                : config.snap === "TL"
                  ? "Top Left"
                  : config.snap === "TR"
                    ? "Top Right"
                    : config.snap === "BL"
                      ? "Bottom Left"
                      : config.snap === "BR"
                        ? "Bottom Right"
                        : config.snap}
          </span>
        </div>

        <div className="w-16 aspect-square p-1 flex items-center justify-center">
          <div className="grid grid-cols-3 grid-rows-3 gap-1.5 w-full h-full">
            {(
              ["TL", "TC", "TR", "ML", "MC", "MR", "BL", "BC", "BR"] as const
            ).map((snap) => {
              const isHorizontal =
                (config.orientation || "horizontal") === "horizontal";
              const isInactive =
                snap === "MC" ||
                (isHorizontal
                  ? snap === "ML" || snap === "MR"
                  : snap === "TC" || snap === "BC");

              const isSnapReadOnly =
                IS_GRID_RESTRICTED_READ_ONLY &&
                !["BL", "BC", "BR"].includes(snap);

              return isInactive ? (
                <div
                  key={snap}
                  className="flex items-center justify-center pointer-events-none opacity-10"
                >
                  <div className="w-0.5 h-0.5 rounded-full bg-[var(--text-muted)]" />
                </div>
              ) : (
                <button
                  key={snap}
                  disabled={isSnapReadOnly}
                  onClick={() => {
                    if (isSnapReadOnly) return;
                    updateConfig({ snap, position: undefined });
                  }}
                  className={`group/snap relative rounded-md transition-all flex items-center justify-center ${
                    (config.snap || "BC") === snap
                      ? isSnapReadOnly
                        ? "bg-indigo-500/40 shadow-none"
                        : "bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.5)]"
                      : `bg-[var(--bg-panel)]/50 ${isSnapReadOnly ? "" : "hover:bg-[var(--border-subtle)]"}`
                  } ${isSnapReadOnly ? "cursor-not-allowed opacity-40" : ""}`}
                >
                  <div
                    className={`w-1 h-1 rounded-full transition-all duration-300 ${
                      (config.snap || "BC") === snap
                        ? isSnapReadOnly
                          ? "bg-[var(--text-main)]/50"
                          : "bg-[var(--text-main)]"
                        : `bg-[var(--text-muted)] opacity-50 ${
                            isSnapReadOnly
                              ? ""
                              : "group-hover/snap:bg-[var(--text-main)] group-hover/snap:opacity-100"
                          }`
                    }`}
                  />
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
