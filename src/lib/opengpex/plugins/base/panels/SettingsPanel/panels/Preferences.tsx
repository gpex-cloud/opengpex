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

import { Sliders, Grid, RefreshCw } from "lucide-react";
import {
  useEditorState,
  useEditorServices,
} from "@opengpex/editor/core/context";

interface ExtendedUIConfig {
  VIEWPORT_FIT_FACTOR?: number;
  BACKDROP_GRID_CONFIG?: {
    GRID_SIZE?: number;
    PATTERN_SIZE?: number;
    color?: string;
  };
}

interface ExtendedState {
  config?: ExtendedUIConfig;
}

interface ExtendedActions {
  updateConfig?: (patch: Record<string, unknown>) => void;
  updateUI?: (patch: { config?: ExtendedUIConfig }) => void;
}

export default function PreferencesPanel() {
  const { state } = useEditorState();
  const { actions } = useEditorServices();

  // Fallback security strategy: assume config is in state.config, default to 0.90 (90%) or 0.92
  // Following new rules, we align default to 90%
  const config = (state as unknown as ExtendedState).config || {
    VIEWPORT_FIT_FACTOR: 0.9,
    BACKDROP_GRID_CONFIG: {
      GRID_SIZE: 8,
      PATTERN_SIZE: 16,
      color: "#e2e8f0",
    },
  };

  const currentGridSize = config.BACKDROP_GRID_CONFIG?.GRID_SIZE ?? 8;
  const currentFitFactor = config.VIEWPORT_FIT_FACTOR ?? 0.9;

  // Helper function to quickly update configuration
  const updateConfigValue = (key: string, value: unknown) => {
    const extActions = actions as unknown as ExtendedActions;
    if (typeof extActions.updateConfig === "function") {
      extActions.updateConfig({ [key]: value });
    } else if (typeof extActions.updateUI === "function") {
      extActions.updateUI({
        config: {
          ...config,
          [key]: value,
        } as ExtendedUIConfig,
      });
    }
  };

  // Handler function when selecting different grid steps
  const handleGridSizeSelect = (size: number) => {
    updateConfigValue("BACKDROP_GRID_CONFIG", {
      ...config.BACKDROP_GRID_CONFIG,
      GRID_SIZE: size,
      PATTERN_SIZE: size * 2, // Automatically calculated as twice the GRID_SIZE
    });
  };

  // Reset to factory presets
  const resetToDefault = () => {
    updateConfigValue("VIEWPORT_FIT_FACTOR", 0.9); // Default to 90%
    updateConfigValue("BACKDROP_GRID_CONFIG", {
      GRID_SIZE: 8,
      PATTERN_SIZE: 16,
      color: "#e2e8f0",
    });
  };

  // Define all optional discrete steps for VIEWPORT_FIT_FACTOR (0.80, 0.85, 0.90, 0.95, 1.00)
  const fitFactorSteps = [0.8, 0.85, 0.9, 0.95, 1.0];

  return (
    <div className="flex flex-col gap-8">
      {/* 1. Visual adaptation coefficient setting (VIEWPORT_FIT_FACTOR - progress bar slider form) */}
      <div className="flex flex-col gap-3">
        <div className="flex justify-between items-center pl-1">
          <h5 className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-widest flex items-center gap-1.5">
            <Sliders size={11} /> Viewport Fit Factor
          </h5>
          <span className="text-[10px] font-mono font-black text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded-md">
            {Math.round(currentFitFactor * 100)}%
          </span>
        </div>

        <div className="flex flex-col gap-2 bg-[var(--bg-stage)] rounded-xl p-4">
          <div className="relative w-full flex items-center">
            {/* Progress bar style range selector */}
            <input
              type="range"
              min="0.80"
              max="1.00"
              step="0.05"
              value={currentFitFactor}
              onChange={(e) =>
                updateConfigValue(
                  "VIEWPORT_FIT_FACTOR",
                  parseFloat(e.target.value),
                )
              }
              className="w-full accent-indigo-600 bg-[var(--bg-stage)] h-1.5 rounded-lg cursor-pointer"
            />
          </div>

          {/* Percentage step label line below the progress bar */}
          <div className="flex justify-between px-0.5 mt-1">
            {fitFactorSteps.map((step) => {
              const isSelected = Math.abs(currentFitFactor - step) < 0.01;
              return (
                <div key={step} className="flex flex-col items-center gap-1">
                  {/* Small scale needle */}
                  <div
                    className={`w-[1px] h-1 rounded-full ${isSelected ? "bg-indigo-500" : "bg-[var(--border-subtle)]"}`}
                  />
                  {/* Step text */}
                  <span
                    className={`text-[8px] font-mono transition-colors ${
                      isSelected
                        ? "text-indigo-600 font-bold"
                        : "text-[var(--text-muted)] font-medium"
                    }`}
                  >
                    {Math.round(step * 100)}%
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* 2. Background grid configuration (BACKDROP_GRID_CONFIG) */}
      <div className="flex flex-col gap-3">
        <h5 className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-widest pl-1 flex items-center gap-1.5">
          <Grid size={11} /> Backdrop Grid Configuration
        </h5>

        <div className="flex flex-col gap-4 bg-[var(--bg-stage)] rounded-xl p-3">
          {/* GRID_SIZE three-step radio button group */}
          <div className="flex flex-col gap-2">
            <span className="text-[10px] font-bold text-[var(--text-main)] uppercase tracking-wider pl-0.5">
              Grid Size
            </span>
            <div className="grid grid-cols-3 bg-[var(--bg-stage)] rounded-xl p-1 gap-1">
              {[4, 8, 16].map((size) => {
                const isSelected = currentGridSize === size;
                return (
                  <button
                    key={size}
                    type="button"
                    onClick={() => handleGridSizeSelect(size)}
                    className={`flex items-center justify-center py-2 rounded-lg transition-all ${
                      isSelected
                        ? "bg-[var(--bg-panel)] text-indigo-600 shadow-sm font-black"
                        : "text-[var(--text-muted)] hover:text-[var(--text-main)] font-bold"
                    }`}
                  >
                    <span className="text-[10px] tracking-tight">{size}px</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* PATTERN_SIZE automatically calculated link display */}
          <div className="flex items-center justify-between pt-2 border-t border-[var(--border-subtle)] ">
            <span className="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider pl-0.5">
              Pattern Size (Auto)
            </span>
            <span className="text-[10px] font-mono font-medium text-[var(--text-muted)] bg-[var(--bg-stage)] px-1.5 py-0.5 rounded-md">
              {currentGridSize * 2}px
            </span>
          </div>
        </div>
      </div>

      {/* Operation button area: reset */}
      <div className="flex justify-end pt-1">
        <button
          onClick={resetToDefault}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-stage)] transition-all"
        >
          <RefreshCw size={11} />
          <span className="text-[9px] font-black uppercase tracking-wider">
            Reset Defaults
          </span>
        </button>
      </div>

      <p className="px-1 text-[8px] text-[var(--text-muted)] font-bold leading-relaxed uppercase tracking-tight italic opacity-60">
        Preferences optimize layout calculations and background overlay
        renderers.
      </p>
    </div>
  );
}
