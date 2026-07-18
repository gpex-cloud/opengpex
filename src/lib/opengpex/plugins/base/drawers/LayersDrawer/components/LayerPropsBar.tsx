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

import React, { useMemo, useCallback, useRef } from "react";
import { useEditorState, useEditorServices } from "@opengpex/editor/core/context";
import type { LayerBlendMode } from "@opengpex/editor/core/types";
import ActionDropdown, { type ActionOption } from "@opengpex/editor/widgets/ActionDropdown";
import { CMD_SET_BLEND_MODE, CMD_SET_LAYER_OPACITY, CMD_SET_LAYER_FILL } from "../protocols";

// ─── Blend Mode Configuration ────────────────────────────────────────────────

interface BlendModeEntry {
  value: LayerBlendMode;
  label: string;
}

interface BlendModeGroup {
  modes: BlendModeEntry[];
}

const BLEND_MODE_GROUPS: BlendModeGroup[] = [
  {
    modes: [
      { value: 'source-over', label: 'Normal' },
    ]
  },
  {
    modes: [
      { value: 'multiply', label: 'Multiply' },
      { value: 'darken', label: 'Darken' },
      { value: 'color-burn', label: 'Color Burn' },
    ]
  },
  {
    modes: [
      { value: 'screen', label: 'Screen' },
      { value: 'lighten', label: 'Lighten' },
      { value: 'color-dodge', label: 'Color Dodge' },
    ]
  },
  {
    modes: [
      { value: 'overlay', label: 'Overlay' },
      { value: 'soft-light', label: 'Soft Light' },
      { value: 'hard-light', label: 'Hard Light' },
    ]
  },
  {
    modes: [
      { value: 'difference', label: 'Difference' },
      { value: 'exclusion', label: 'Exclusion' },
    ]
  },
  {
    modes: [
      { value: 'hue', label: 'Hue' },
      { value: 'saturation', label: 'Saturation' },
      { value: 'color', label: 'Color' },
      { value: 'luminosity', label: 'Luminosity' },
    ]
  },
];

// Flat lookup for label display
const BLEND_MODE_LABEL_MAP = new Map<string, string>();
for (const group of BLEND_MODE_GROUPS) {
  for (const mode of group.modes) {
    BLEND_MODE_LABEL_MAP.set(mode.value, mode.label);
  }
}

// Build ActionDropdown options with dividers between groups
function buildDropdownOptions(): ActionOption[] {
  const options: ActionOption[] = [];
  for (let gi = 0; gi < BLEND_MODE_GROUPS.length; gi++) {
    if (gi > 0) {
      options.push({ divider: true });
    }
    for (const mode of BLEND_MODE_GROUPS[gi].modes) {
      options.push({ label: mode.label, value: mode.value });
    }
  }
  return options;
}

const DROPDOWN_OPTIONS = buildDropdownOptions();

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * LayerPropsBar: Displays blend mode dropdown + opacity slider for the active layer.
 * Placed below the layer list in LayerDrawer.
 */
export const LayerPropsBar = React.memo(function LayerPropsBar() {
  const { activeFrame, activeLayer } = useEditorState();
  const { actions } = useEditorServices();

  const disabled = !activeFrame || !activeLayer;
  const currentBlendMode: LayerBlendMode = (activeLayer?.blendMode || 'source-over') as LayerBlendMode;
  const currentOpacity = activeLayer?.opacity ?? 1;
  const opacityPercent = Math.round(currentOpacity * 100);
  const currentFill = activeLayer?.fill ?? 1;
  const fillPercent = Math.round(currentFill * 100);

  // ─── Blend Mode ─────────────────────────────────────────────────────────────

  const handleBlendModeSelect = useCallback((value: string) => {
    if (!activeFrame || !activeLayer) return;
    // Execute undoable command — SIGNAL_COMMIT is auto-dispatched before execution
    actions.executeCommand(CMD_SET_BLEND_MODE, { blendMode: value as LayerBlendMode });
  }, [activeFrame, activeLayer, actions]);

  const blendTrigger = useMemo(() => (
    <div className="flex-1 flex items-center justify-between gap-1 px-2 py-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] hover:bg-[var(--border-subtle)] transition-colors text-left cursor-pointer">
      <span className="text-[9px] font-bold text-[var(--text-main)] truncate">
        {BLEND_MODE_LABEL_MAP.get(currentBlendMode) || 'Normal'}
      </span>
      <svg width="8" height="8" viewBox="0 0 8 8" className="shrink-0 text-[var(--text-muted)]">
        <path d="M2 3L4 5L6 3" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
      </svg>
    </div>
  ), [currentBlendMode]);

  // ─── Opacity Slider ─────────────────────────────────────────────────────────

  // Track whether a slider drag is in progress (to avoid creating multiple checkpoints per drag)
  const isDraggingRef = useRef(false);

  /** On pointerdown: execute the undoable command with current value to create ONE undo checkpoint */
  const handleOpacityPointerDown = useCallback(() => {
    if (!activeFrame || !activeLayer) return;
    isDraggingRef.current = true;
    // Execute undoable command with current opacity → creates checkpoint (state doesn't actually change)
    actions.executeCommand(CMD_SET_LAYER_OPACITY, { opacity: activeLayer.opacity ?? 1 });
  }, [activeFrame, activeLayer, actions]);

  /** During drag: directly update layer opacity (no additional checkpoints) */
  const handleOpacitySlider = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (!activeFrame || !activeLayer) return;
    const val = Number(e.target.value);
    actions.updateLayer(activeFrame.id, activeLayer.id, { opacity: val / 100 });
  }, [activeFrame, activeLayer, actions]);

  /** On pointerup: mark drag as finished */
  const handleOpacityPointerUp = useCallback(() => {
    isDraggingRef.current = false;
  }, []);

  /** Numeric input: execute undoable command for each confirmed value */
  const handleOpacityInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (!activeFrame || !activeLayer) return;
    const val = Math.max(0, Math.min(100, Number(e.target.value) || 0));
    actions.executeCommand(CMD_SET_LAYER_OPACITY, { opacity: val / 100 });
  }, [activeFrame, activeLayer, actions]);

  // ─── Fill Slider ────────────────────────────────────────────────────────────

  const isFillDraggingRef = useRef(false);

  const handleFillPointerDown = useCallback(() => {
    if (!activeFrame || !activeLayer) return;
    isFillDraggingRef.current = true;
    actions.executeCommand(CMD_SET_LAYER_FILL, { fill: activeLayer.fill ?? 1 });
  }, [activeFrame, activeLayer, actions]);

  const handleFillSlider = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (!activeFrame || !activeLayer) return;
    const val = Number(e.target.value);
    actions.updateLayer(activeFrame.id, activeLayer.id, { fill: val / 100 });
  }, [activeFrame, activeLayer, actions]);

  const handleFillPointerUp = useCallback(() => {
    isFillDraggingRef.current = false;
  }, []);

  const handleFillInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (!activeFrame || !activeLayer) return;
    const val = Math.max(0, Math.min(100, Number(e.target.value) || 0));
    actions.executeCommand(CMD_SET_LAYER_FILL, { fill: val / 100 });
  }, [activeFrame, activeLayer, actions]);

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className={`flex flex-col gap-1.5 px-2 py-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-stage)]/50 ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
      {/* Row 1: Blend Mode Dropdown */}
      <div className="flex items-center gap-2">
        <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-tight w-[38px] shrink-0">
          Blend
        </span>
        <ActionDropdown
          trigger={blendTrigger}
          options={DROPDOWN_OPTIONS}
          onSelect={handleBlendModeSelect}
          disabled={disabled}
          cols={3}
          direction="up"
          className="flex-1"
        />
      </div>

      {/* Row 2: Opacity Slider + Input */}
      <div className="flex items-center gap-2">
        <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-tight w-[38px] shrink-0">
          Opacity
        </span>
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          value={opacityPercent}
          onPointerDown={handleOpacityPointerDown}
          onChange={handleOpacitySlider}
          onPointerUp={handleOpacityPointerUp}
          disabled={disabled}
          className={`flex-1 h-1.5 bg-[var(--bg-stage)] rounded-full appearance-none cursor-ew-resize hover:bg-[var(--border-subtle)] transition-all border border-[var(--border-subtle)] shadow-inner disabled:opacity-30 disabled:cursor-not-allowed [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-ew-resize ${opacityPercent >= 100 ? '[&::-webkit-slider-thumb]:bg-[#9ca3af]' : '[&::-webkit-slider-thumb]:bg-indigo-400'}`}
        />
        <div className="flex items-center gap-0.5 shrink-0">
          <input
            type="number"
            min="0"
            max="100"
            value={opacityPercent}
            onChange={handleOpacityInput}
            disabled={disabled}
            className="w-[38px] px-1 py-0 text-[9px] font-bold text-[var(--text-main)] text-center bg-[var(--bg-panel)] border border-[var(--border-subtle)] rounded tabular-nums focus:outline-none focus:border-indigo-500 disabled:opacity-40 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />
          <span className="text-[8px] font-bold text-[var(--text-muted)]">%</span>
        </div>
      </div>

      {/* Row 3: Fill Slider + Input */}
      <div className="flex items-center gap-2">
        <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-tight w-[38px] shrink-0">
          Fill
        </span>
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          value={fillPercent}
          onPointerDown={handleFillPointerDown}
          onChange={handleFillSlider}
          onPointerUp={handleFillPointerUp}
          disabled={disabled}
          className={`flex-1 h-1.5 bg-[var(--bg-stage)] rounded-full appearance-none cursor-ew-resize hover:bg-[var(--border-subtle)] transition-all border border-[var(--border-subtle)] shadow-inner disabled:opacity-30 disabled:cursor-not-allowed [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-ew-resize ${fillPercent >= 100 ? '[&::-webkit-slider-thumb]:bg-[#9ca3af]' : '[&::-webkit-slider-thumb]:bg-indigo-400'}`}
        />
        <div className="flex items-center gap-0.5 shrink-0">
          <input
            type="number"
            min="0"
            max="100"
            value={fillPercent}
            onChange={handleFillInput}
            disabled={disabled}
            className="w-[38px] px-1 py-0 text-[9px] font-bold text-[var(--text-main)] text-center bg-[var(--bg-panel)] border border-[var(--border-subtle)] rounded tabular-nums focus:outline-none focus:border-indigo-500 disabled:opacity-40 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />
          <span className="text-[8px] font-bold text-[var(--text-muted)]">%</span>
        </div>
      </div>
    </div>
  );
});
