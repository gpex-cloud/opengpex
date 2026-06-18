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
import { ColorPickerPro } from "@opengpex/editor/widgets/ColorPickerPro";
import { useBrushPanel } from "../hooks";

// ─── Logarithmic Slider Helpers ────────────────────────────────────────────────

/**
 * Size slider uses exponential mapping (power=3) to give finer control in small brush ranges.
 * Behaves like Photoshop / Procreate: slider mid-value ≈ 63px rather than 250px.
 *
 * Mapping relations:
 *   slider 10% → ~2px, 25% → ~9px, 50% → ~63px, 75% → ~211px, 100% → 500px
 */
const SIZE_POWER = 3;
const SIZE_MAX = 500;
const SIZE_MIN = 1;

function sliderToSize(percent: number): number {
  return Math.round(SIZE_MIN + (SIZE_MAX - SIZE_MIN) * Math.pow(percent / 100, SIZE_POWER));
}

function sizeToSlider(size: number): number {
  return Math.round(Math.pow((size - SIZE_MIN) / (SIZE_MAX - SIZE_MIN), 1 / SIZE_POWER) * 100);
}

// ─── BrushPanel ────────────────────────────────────────────────────────────────

/**
 * BrushPanel: Brush/Eraser attributes panel
 *
 * Rendered inside CraftDrawer, displayed when activeCraft='brush' or 'eraser'.
 * Provides real-time adjustment of Size / Opacity / Hardness parameters + color selection.
 * Parameter changes written via pluginConfig, in real-time affecting BrushCursor and BrushStrokeHandler.
 */
export const BrushPanel = React.memo(function BrushPanel() {
  const { brushSize, brushOpacity, brushHardness, brushColor, isEraser, updateBrushParam, updateBrushColor } = useBrushPanel();

  return (
    <div className="flex flex-col gap-2">
      {/* Parameters */}
      <div className="flex flex-col gap-2 p-1">
        {/* Size (logarithmic slider: small sizes get more resolution) */}
        <div className="flex items-center gap-2 px-1">
          <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight w-16">
            Size
          </span>
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            value={sizeToSlider(brushSize)}
            onChange={(e) => updateBrushParam('brushSize', sliderToSize(Number(e.target.value)))}
            onMouseUp={(e) => e.currentTarget.blur()}
            onTouchEnd={(e) => e.currentTarget.blur()}
            className="flex-1 h-1.5 bg-[var(--bg-stage)] rounded-full appearance-none cursor-ew-resize hover:bg-[var(--border-subtle)] transition-all border-t border-[var(--border-subtle)] border-b border-[var(--border-subtle)] shadow-inner"
          />
          <div className="flex items-center gap-0.5 text-right w-12 justify-end text-indigo-400 font-black text-[10px] tabular-nums">
            <input
              type="number"
              min="1"
              max="500"
              value={brushSize}
              onChange={(e) => {
                const val = Math.max(1, Math.min(500, Number(e.target.value) || 1));
                updateBrushParam('brushSize', val);
              }}
              className="w-8 bg-transparent text-right focus:outline-none outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
            <span className="text-[8px] font-bold text-[var(--text-muted)] shrink-0">px</span>
          </div>
        </div>

        {/* Opacity */}
        <div className="flex items-center gap-2 px-1">
          <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight w-16">
            Opacity
          </span>
          <input
            type="range"
            min="1"
            max="100"
            step="1"
            value={brushOpacity}
            onChange={(e) => updateBrushParam('brushOpacity', Number(e.target.value))}
            onMouseUp={(e) => e.currentTarget.blur()}
            onTouchEnd={(e) => e.currentTarget.blur()}
            className="flex-1 h-1.5 bg-[var(--bg-stage)] rounded-full appearance-none cursor-ew-resize hover:bg-[var(--border-subtle)] transition-all border-t border-[var(--border-subtle)] border-b border-[var(--border-subtle)] shadow-inner"
          />
          <div className="flex items-center gap-0.5 text-right w-12 justify-end text-indigo-400 font-black text-[10px] tabular-nums">
            <input
              type="number"
              min="1"
              max="100"
              value={brushOpacity}
              onChange={(e) => {
                const val = Math.max(1, Math.min(100, Number(e.target.value) || 1));
                updateBrushParam('brushOpacity', val);
              }}
              className="w-8 bg-transparent text-right focus:outline-none outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
            <span className="text-[8px] font-bold text-[var(--text-muted)] shrink-0">%</span>
          </div>
        </div>

        {/* Hardness */}
        <div className="flex items-center gap-2 px-1">
          <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight w-16">
            Hardness
          </span>
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            value={brushHardness}
            onChange={(e) => updateBrushParam('brushHardness', Number(e.target.value))}
            onMouseUp={(e) => e.currentTarget.blur()}
            onTouchEnd={(e) => e.currentTarget.blur()}
            className="flex-1 h-1.5 bg-[var(--bg-stage)] rounded-full appearance-none cursor-ew-resize hover:bg-[var(--border-subtle)] transition-all border-t border-[var(--border-subtle)] border-b border-[var(--border-subtle)] shadow-inner"
          />
          <div className="flex items-center gap-0.5 text-right w-12 justify-end text-indigo-400 font-black text-[10px] tabular-nums">
            <input
              type="number"
              min="0"
              max="100"
              value={brushHardness}
              onChange={(e) => {
                const val = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                updateBrushParam('brushHardness', val);
              }}
              className="w-8 bg-transparent text-right focus:outline-none outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
            <span className="text-[8px] font-bold text-[var(--text-muted)] shrink-0">%</span>
          </div>
        </div>
      </div>

      {/* Color Picker (brush only, shared with ColorOptions) */}
      {!isEraser && (
        <div className="flex flex-col gap-1.5 p-1">
          <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight px-1">
            Color
          </span>
          <ColorPickerPro
            variant="compact"
            color={brushColor}
            onChange={updateBrushColor}
          />
        </div>
      )}
    </div>
  );
});
