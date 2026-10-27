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
import ColorSwatchRow from "@opengpex/editor/widgets/ColorSwatchRow";
import Switch from "@opengpex/editor/widgets/Switch";
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
  const {
    brushSize, brushOpacity, brushHardness, brushColor, isEraser,
    eraserAntiAliased, brushAntiAliased, updateBrushParam, updateBrushColor,
    updateEraserAntiAliased, updateBrushAntiAliased,
    brushStabilizer, brushPressureOpacity, brushTaperStart, brushTaperEnd,
    brushTaperLink, brushVelocity, brushPresets,
    updateBrushFlag, saveBrushPreset, applyBrushPreset, deleteBrushPreset,
  } = useBrushPanel();

  // Inline preset naming state: replaces the blocking native window.prompt,
  // which is focus-hostile and can be suppressed entirely inside embedded or
  // sandboxed environments. When non-null the value is the draft name; the
  // input row mounts in place of the Save button and commits on Enter or blur.
  const [presetNaming, setPresetNaming] = React.useState<string | null>(null);
  const commitPresetName = () => {
    if (presetNaming && presetNaming.trim()) saveBrushPreset(presetNaming.trim());
    setPresetNaming(null);
  };

  // AA ⇔ hardness two-way binding, IDENTICAL for brush and eraser: a soft tip
  // (hardness < 100) always needs AA, so dragging hardness below 100 forces the
  // switch ON, and switching AA OFF snaps hardness up to 100 — the pair is only
  // self-consistent at hardness=100. Eraser OFF routes `hard: true` into the
  // BitmapMask — the GPU thresholds the sampled mask alpha at 0.5 ("pencil
  // eraser", idempotent under repeated clicks). AA ON leaves hardness alone so
  // soft feathered erasing (hardness < 100) stays reachable.
  const handleHardnessChange = (value: number) => {
    updateBrushParam('brushHardness', value);
    if (isEraser && value < 100 && !eraserAntiAliased) updateEraserAntiAliased(true);
    if (!isEraser && value < 100 && !brushAntiAliased) updateBrushAntiAliased(true);
  };

  const handleEraserAAChange = (aa: boolean) => {
    updateEraserAntiAliased(aa);
    if (!aa && brushHardness < 100) updateBrushParam('brushHardness', 100);
  };

  const handleBrushAAChange = (aa: boolean) => {
    updateBrushAntiAliased(aa);
    if (!aa && brushHardness < 100) updateBrushParam('brushHardness', 100);
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Parameters */}
      <div className="flex flex-col gap-2 p-1">
        {/* Color — mini swatch (marker-panel style): swatch + hex, full picker on demand */}
        {!isEraser && (
          <ColorSwatchRow
            label="Color"
            labelClassName="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight w-16 shrink-0"
            color={brushColor}
            onChange={updateBrushColor}
          />
        )}

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
          <div className="flex items-center gap-0.5 text-right w-12 justify-end text-indigo-600 dark:text-indigo-400 font-black text-[10px] tabular-nums">
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
          <div className="flex items-center gap-0.5 text-right w-12 justify-end text-indigo-600 dark:text-indigo-400 font-black text-[10px] tabular-nums">
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
            onChange={(e) => handleHardnessChange(Number(e.target.value))}
            onMouseUp={(e) => e.currentTarget.blur()}
            onTouchEnd={(e) => e.currentTarget.blur()}
            className="flex-1 h-1.5 bg-[var(--bg-stage)] rounded-full appearance-none cursor-ew-resize hover:bg-[var(--border-subtle)] transition-all border-t border-[var(--border-subtle)] border-b border-[var(--border-subtle)] shadow-inner"
          />
          <div className="flex items-center gap-0.5 text-right w-12 justify-end text-indigo-600 dark:text-indigo-400 font-black text-[10px] tabular-nums">
            <input
              type="number"
              min="0"
              max="100"
              value={brushHardness}
              onChange={(e) => {
                const val = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                handleHardnessChange(val);
              }}
              className="w-8 bg-transparent text-right focus:outline-none outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
            <span className="text-[8px] font-bold text-[var(--text-muted)] shrink-0">%</span>
          </div>
        </div>

        {/* Edge AA (always visible in brush & eraser modes) — OFF = binary
            "pixel pencil" / "pencil eraser" edge, hardness frozen at 100 by the binding above */}
        <div className="flex items-center justify-between px-1">
          <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight w-16">
            Anti Alias
          </span>
          <Switch
            checked={isEraser ? eraserAntiAliased : brushAntiAliased}
            onChange={isEraser ? handleEraserAAChange : handleBrushAAChange}
            activeColor="bg-indigo-500"
          />
        </div>

      </div>

      {/* Input dynamics (brush only) */}
      {!isEraser && (
        <>
          <div className="mx-1 border-t border-[var(--border-subtle)] dark:border-white/10" />
          <div className="flex flex-col gap-2 p-1">
          {/* Stabilizer — rope-model smoothing slack */}
          <div className="flex items-center gap-2 px-1">
              <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight w-16">
                Smoothing
              </span>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                value={brushStabilizer}
                onChange={(e) => updateBrushParam('brushStabilizer', Number(e.target.value))}
                onMouseUp={(e) => e.currentTarget.blur()}
                onTouchEnd={(e) => e.currentTarget.blur()}
                className="flex-1 h-1.5 bg-[var(--bg-stage)] rounded-full appearance-none cursor-ew-resize hover:bg-[var(--border-subtle)] transition-all border-t border-[var(--border-subtle)] border-b border-[var(--border-subtle)] shadow-inner"
              />
              <div className="w-12 justify-end text-right text-indigo-600 dark:text-indigo-400 font-black text-[10px] tabular-nums">
                {brushStabilizer}
              </div>
            </div>

            {/* Taper — per-end calligraphic entry/exit, % of tip diameter.
                Start = stroke beginning (尖入笔), End = stroke exit (出锋).
                The link toggle mirrors a slider edit onto the other end;
                unlink for asymmetric tips (sharp exit / round entry). */}
            <div className="flex items-center gap-2 px-1">
              <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight w-16">
                Taper Start
              </span>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                value={brushTaperStart}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  updateBrushParam('brushTaperStart', v);
                  if (brushTaperLink) updateBrushParam('brushTaperEnd', v);
                }}
                onMouseUp={(e) => e.currentTarget.blur()}
                onTouchEnd={(e) => e.currentTarget.blur()}
                className="flex-1 h-1.5 bg-[var(--bg-stage)] rounded-full appearance-none cursor-ew-resize hover:bg-[var(--border-subtle)] transition-all border-t border-[var(--border-subtle)] border-b border-[var(--border-subtle)] shadow-inner"
              />
              <div className="w-12 justify-end text-right text-indigo-600 dark:text-indigo-400 font-black text-[10px] tabular-nums">
                {brushTaperStart}%
              </div>
            </div>
            <div className="flex items-center gap-2 px-1">
              <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight w-16">
                Taper End
              </span>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                value={brushTaperEnd}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  updateBrushParam('brushTaperEnd', v);
                  if (brushTaperLink) updateBrushParam('brushTaperStart', v);
                }}
                onMouseUp={(e) => e.currentTarget.blur()}
                onTouchEnd={(e) => e.currentTarget.blur()}
                className="flex-1 h-1.5 bg-[var(--bg-stage)] rounded-full appearance-none cursor-ew-resize hover:bg-[var(--border-subtle)] transition-all border-t border-[var(--border-subtle)] border-b border-[var(--border-subtle)] shadow-inner"
              />
              <div className="w-12 justify-end text-right text-indigo-600 dark:text-indigo-400 font-black text-[10px] tabular-nums">
                {brushTaperEnd}%
              </div>
            </div>
            <div className="flex items-center justify-between px-1">
              <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight w-16">
                Taper Link
              </span>
              <Switch
                checked={brushTaperLink}
                onChange={(v: boolean) => updateBrushFlag('brushTaperLink', v)}
                activeColor="bg-indigo-500"
              />
            </div>

            {/* Pressure → opacity; velocity → width */}
            <div className="flex items-center justify-between px-1">
              <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight w-16">
                Pressure Opacity
              </span>
              <Switch
                checked={brushPressureOpacity}
                onChange={(v: boolean) => updateBrushFlag('brushPressureOpacity', v)}
                activeColor="bg-indigo-500"
              />
            </div>
            <div className="flex items-center justify-between px-1">
              <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight w-16">
                Velocity
              </span>
              <Switch
                checked={brushVelocity}
                onChange={(v: boolean) => updateBrushFlag('brushVelocity', v)}
                activeColor="bg-indigo-500"
              />
            </div>
          </div>
        </>
      )}

      {/* Presets (brush only) */}
      {!isEraser && (
        <>
          <div className="mx-1 border-t border-[var(--border-subtle)] dark:border-white/10" />
          <div className="flex flex-col gap-1.5 p-1">
            <div className="flex items-center justify-between px-1">
              <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight">
                Presets
              </span>
            {presetNaming === null ? (
              <button
                onClick={() => setPresetNaming(`Preset ${brushPresets.length + 1}`)}
                className="text-[9px] font-black uppercase tracking-tight text-indigo-600 dark:text-indigo-400 outline-none"
              >
                Save
              </button>
            ) : (
              <div className="flex items-center gap-1">
                <input
                  autoFocus
                  value={presetNaming}
                  onChange={(e) => setPresetNaming(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitPresetName();
                    if (e.key === 'Escape') setPresetNaming(null);
                  }}
                  onBlur={commitPresetName}
                  placeholder="Preset name"
                  className="w-24 h-5 px-1.5 text-[10px] font-bold bg-[var(--bg-stage)] border border-[var(--border-subtle)] rounded outline-none focus:border-indigo-500/50 text-[var(--text-primary)]"
                />
              </div>
            )}
          </div>
          {brushPresets.map((p) => (
            <div key={p.id} className="flex items-center gap-1 px-1">
              <button
                onClick={() => applyBrushPreset(p.id)}
                className="flex-1 text-left text-[10px] font-bold text-[var(--text-primary)] truncate px-2 py-1 rounded bg-[var(--bg-stage)] hover:bg-[var(--border-subtle)] transition-colors outline-none"
              >
                {p.name}
              </button>
              <button
                onClick={() => deleteBrushPreset(p.id)}
                className="text-[10px] font-black text-[var(--text-muted)] hover:text-red-500 px-1 outline-none"
                aria-label={`Delete preset ${p.name}`}
              >
                ×
              </button>
            </div>
          ))}
          </div>
        </>
      )}

    </div>
  );
});
