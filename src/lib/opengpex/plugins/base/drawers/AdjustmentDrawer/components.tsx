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

/* eslint-disable react/display-name */

"use client";

import React from "react";
import { Sliders, RotateCcw as ResetIcon, Layers } from "lucide-react";
import { useEditorState } from "@opengpex/editor/core/context";
import ActionButton from "@opengpex/editor/widgets/ActionButton";
import { useAdjustmentCommands } from "./hooks";
import type { LayerAdjustments } from "./protocols";
import { DEFAULT_ADJUSTMENTS } from "./protocols";

/**
 * AdjustmentContent: Pure rendering layer, applying React.memo to intercept irrelevant updates
 */
const AdjustmentContent = React.memo(
  ({
    adjustments,
    onUpdate,
    onCommit,
    onReset,
    resetShortcutLabel,
  }: {
    adjustments: LayerAdjustments;
    onUpdate: (key: string, val: number) => void;
    onCommit: () => void;
    onReset: () => void;
    resetShortcutLabel: string;
  }) => {
    return (
      <div className="flex flex-col gap-2 px-2 pt-1 pb-1">
        <div className="flex justify-between items-center mb-1 shrink-0">
          <div className="flex items-center gap-2">
            <Layers size={12} className="text-indigo-500 opacity-80" />
            <span className="text-[10px] font-black uppercase tracking-[0.15em] text-[var(--text-muted)]">
              Adjustments
            </span>
          </div>
          <div className="flex items-center">
            <ActionButton
              onClick={(e) => {
                e.stopPropagation();
                onReset();
              }}
              icon={<ResetIcon size={12} />}
              tooltip={`Reset Adjustments (${resetShortcutLabel})`}
              variant="glass"
              size="sm"
              className="text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors"
            />
          </div>
        </div>

        <div className="space-y-2">
          {([
            {
              key: "brightness" as keyof LayerAdjustments,
              label: "Brightness",
              min: 0,
              max: 200,
              step: 1,
              unit: "%",
            },
            { key: "contrast" as keyof LayerAdjustments, label: "Contrast", min: 0, max: 200, step: 1, unit: "%" },
            {
              key: "saturation" as keyof LayerAdjustments,
              label: "Saturation",
              min: 0,
              max: 200,
              step: 1,
              unit: "%",
            },
            {
              key: "hueRotate" as keyof LayerAdjustments,
              label: "Hue Rotate",
              min: 0,
              max: 360,
              step: 1,
              unit: "°",
            },
            {
              key: "blur" as keyof LayerAdjustments,
              label: "Blur",
              min: 0,
              max: 20,
              step: 0.1,
              unit: "px",
            },
          ]).map((ctrl) => (
            <div key={ctrl.key} className="space-y-0.5 group">
              <div className="flex justify-between">
                <span className="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-tight">
                  {ctrl.label}
                </span>
                <span className="text-[10px] font-bold text-[var(--text-main)] tabular-nums">
                  {Math.round(adjustments[ctrl.key] * 10) / 10}
                  {ctrl.unit}
                </span>
              </div>
              <input
                type="range"
                min={ctrl.min}
                max={ctrl.max}
                step={ctrl.step || 1}
                value={adjustments[ctrl.key]}
                onMouseDown={onCommit}
                onChange={(e) => onUpdate(ctrl.key, parseFloat(e.target.value))}
                style={{
                  accentColor: (() => {
                    const val = adjustments[ctrl.key];
                    const def =
                      ctrl.key === "hueRotate" || ctrl.key === "blur" ? 0 : 100;
                    if (Math.abs(val - def) < 0.1) return "#666666";
                    return val > def ? "#10b981" : "#f59e0b"; // Emerald-500 : Amber-500
                  })(),
                }}
                className="w-full h-1.5 bg-[var(--bg-stage)] rounded-full appearance-none cursor-ew-resize hover:bg-[var(--border-subtle)] transition-all border-t border-[var(--border-subtle)] border-b border-[var(--border-subtle)] shadow-inner"
              />
            </div>
          ))}
        </div>
      </div>
    );
  },
);

/**
 * AdjustmentComponent: Container layer, responsible for responding to Context changes and performing Prop Stripping
 */
export function AdjustmentComponent() {
  const { activeFrame, activeLayer } = useEditorState();
  const { updateCmd, resetCmd, commit } =
    useAdjustmentCommands();

  if (!activeFrame || !activeLayer) {
    return (
      <div className="py-6 flex flex-col items-center justify-center border border-dashed border-[var(--border-subtle)] rounded-2xl bg-[var(--bg-stage)]/40">
        <Sliders
          size={18}
          className="text-[var(--text-muted)] opacity-30 mb-2"
        />
        <p className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-widest text-center">
          Select a Layer
          <br />
          to Adjust
        </p>
      </div>
    );
  }

  return (
      <AdjustmentContent
        adjustments={(activeLayer.adjustments as LayerAdjustments) || DEFAULT_ADJUSTMENTS}
        onUpdate={(key, val) => updateCmd?.execute({ key, value: val })}
        onCommit={commit}
        onReset={() => resetCmd?.execute()}
        resetShortcutLabel={resetCmd?.shortcutLabel || ''}
      />
  );
}
