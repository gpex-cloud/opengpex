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
import { AlignLeft, AlignCenter, AlignRight } from "lucide-react";
import { ColorPickerPro } from "@opengpex/editor/widgets/ColorPickerPro";
import ComboInput from "@opengpex/editor/widgets/ComboInput";
import { FontPicker } from "@opengpex/editor/widgets/FontPicker";
import FunctionButton from "@opengpex/editor/widgets/FunctionButton";
import { useTextPanel } from "../hooks";

import { FONT_REGISTRY } from "@opengpex/editor/core/fonts/registry";

/**
 * Global map linking CSS font-weight numeric values to their localized/user-friendly
 * string representation. Conforms strictly to the W3C CSS Fonts specification.
 */
const ALL_WEIGHT_LABELS: Record<number, string> = {
  100: "Thin",
  200: "Extra Light",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "Semi Bold",
  700: "Bold",
  800: "Ultra Bold",
  900: "Black",
};

// ─── Logarithmic Slider Helpers ────────────────────────────────────────────────

const TEXT_SIZE_POWER = 2.5;
const TEXT_SIZE_MAX = 200;
const TEXT_SIZE_MIN = 6;

function sliderToTextSize(percent: number): number {
  return Math.round(TEXT_SIZE_MIN + (TEXT_SIZE_MAX - TEXT_SIZE_MIN) * Math.pow(percent / 100, TEXT_SIZE_POWER));
}

function textSizeToSlider(size: number): number {
  return Math.round(Math.pow((size - TEXT_SIZE_MIN) / (TEXT_SIZE_MAX - TEXT_SIZE_MIN), 1 / TEXT_SIZE_POWER) * 100);
}

/**
 * Finds the nearest matching numeric font weight from a given list of available weights.
 * Used to gracefully fallback when switching to a font family that does not support
 * the active font weight (e.g. switching from Poppins 800 to Lora which only goes up to 700).
 *
 * @param targetWeight The currently selected font weight.
 * @param availableWeights The array of weights supported by the newly selected font.
 * @returns The closest available font weight.
 */
function getClosestWeight(targetWeight: number, availableWeights: number[]): number {
  if (availableWeights.includes(targetWeight)) return targetWeight;
  let closest = availableWeights[0] || 400;
  let minDiff = Math.abs(closest - targetWeight);
  for (const w of availableWeights) {
    const diff = Math.abs(w - targetWeight);
    if (diff < minDiff) {
      minDiff = diff;
      closest = w;
    }
  }
  return closest;
}

// ─── TextPanel ─────────────────────────────────────────────────────────────────

/**
 * TextPanel: Text attributes panel
 *
 * Rendered inside CraftDrawer, displayed when activeCraft='text'.
 * Property changes synchronized to currently editing text layer in real time.
 */
export const TextPanel = React.memo(function TextPanel() {
  const { targetLayer, textData, updateTextData, updateTextDataLive, textColor, updateTextColor, updateTextColorLive } = useTextPanel();

  // Retrieve the active font family (defaulting to "Inter")
  const selectedFamily = textData?.fontFamily || "Inter";
  
  // Find the metadata of the selected font from the registry
  const fontInfo = FONT_REGISTRY.find(
    (f) => f.family.toLowerCase() === selectedFamily.toLowerCase()
  );
  
  // Obtain the array of supported weights (defaulting to [400, 700] if not found)
  const availableWeights = fontInfo?.weights || [400, 700];

  // Map numeric weights (e.g. [400, 700]) to readable names (e.g. ["Regular", "Bold"])
  const weightOptions = availableWeights.map(w => ALL_WEIGHT_LABELS[w] || String(w));

  // Determine the display label of the active font weight (defaulting to "Regular")
  const currentWeightLabel =
    ALL_WEIGHT_LABELS[textData?.fontWeight || 400] || "Regular";

  return (
    <div className="flex flex-col gap-2">
      {/* Typography Card */}
      <div className="flex flex-col gap-2.5 p-1">
        {/* Size (logarithmic slider) */}
        <div className="flex items-center gap-2 px-1">
          <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight w-16">
            Size
          </span>
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            value={textSizeToSlider(textData?.fontSize || 24)}
            onChange={(e) => {
              const newSize = sliderToTextSize(Number(e.target.value));
              updateTextDataLive({ fontSize: newSize });
            }}
            onMouseUp={(e) => {
              const newSize = sliderToTextSize(Number(e.currentTarget.value));
              updateTextData({ fontSize: newSize });
              e.currentTarget.blur();
            }}
            onTouchEnd={(e) => {
              const newSize = sliderToTextSize(Number(e.currentTarget.value));
              updateTextData({ fontSize: newSize });
              e.currentTarget.blur();
            }}
            className="flex-1 h-1.5 bg-[var(--bg-stage)] rounded-full appearance-none cursor-ew-resize hover:bg-[var(--border-subtle)] transition-all border-t border-[var(--border-subtle)] border-b border-[var(--border-subtle)] shadow-inner"
          />
          <div className="flex items-center gap-0.5 text-right w-12 justify-end text-indigo-400 font-black text-[10px] tabular-nums">
            <input
              type="number"
              min={TEXT_SIZE_MIN}
              max={TEXT_SIZE_MAX}
              value={textData?.fontSize || 24}
              onChange={(e) => {
                const val = Math.max(TEXT_SIZE_MIN, Math.min(TEXT_SIZE_MAX, Number(e.target.value) || TEXT_SIZE_MIN));
                updateTextData({ fontSize: val });
              }}
              className="w-8 bg-transparent text-right focus:outline-none outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
            <span className="text-[8px] font-bold text-[var(--text-muted)] shrink-0">px</span>
          </div>
        </div>

        {/* Font Family Selection */}
        <FontPicker
          value={textData?.fontFamily || "Inter"}
          onChange={(family) => {
            const fontInfo = FONT_REGISTRY.find(
              (f) => f.family.toLowerCase() === family.toLowerCase()
            );
            const nextWeights = fontInfo?.weights || [400, 700];
            const currentWeight = textData?.fontWeight || 400;
            // Align active weight to the closest available weight of the new font family
            const newWeight = getClosestWeight(currentWeight, nextWeights);
            
            updateTextData({
              fontFamily: family,
              ...(newWeight !== currentWeight ? { fontWeight: newWeight } : {}),
            });
          }}
          label="Font"
          fontWeight={textData?.fontWeight || 400}
        />

        {/* Font Weight Selection */}
        <ComboInput
          label="Weight"
          value={currentWeightLabel}
          readOnly={true}
          options={weightOptions}
          onChange={(val) => {
            // Find corresponding numeric weight value for the selected label name
            const weightEntry = Object.entries(ALL_WEIGHT_LABELS).find(([_, label]) => label === val);
            if (weightEntry) {
              updateTextData({ fontWeight: Number(weightEntry[0]) });
            }
          }}
          inputStyle={{ fontFamily: textData?.fontFamily || "Inter", fontWeight: textData?.fontWeight || 400, fontSize: 12 }}
        />
      </div>

      {/* Style & Alignment Card */}
      <div className="flex flex-col gap-2.5 p-1">
        {/* Color */}
        <div className="flex flex-col gap-1.5">
          <ColorPickerPro
            variant="compact"
            color={textColor}
            onChange={updateTextColorLive}
            onCommit={updateTextColor}
            showHarmony={false}
            showRecents={false}
          />
        </div>

        {/* Alignment & Style */}
        <div className="flex items-end gap-3 mt-0.5">
          {/* Alignment */}
          <div className="flex flex-col gap-1.5 flex-1">
            <span className="text-[8px] font-bold text-[var(--text-muted)] uppercase tracking-tight">
              Align
            </span>
            <div className="flex items-center gap-1">
              {(["left", "center", "right"] as const).map((align) => (
                <FunctionButton
                  key={align}
                  onClick={() => updateTextData({ align })}
                  active={textData?.align === align}
                  variant="glass"
                  className="w-8 h-7 !rounded-lg text-[10px]"
                >
                  {align === "left" && <AlignLeft size={13} />}
                  {align === "center" && <AlignCenter size={13} />}
                  {align === "right" && <AlignRight size={13} />}
                </FunctionButton>
              ))}
            </div>
          </div>

          {/* Text Style (B, I, U, S) */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[8px] font-bold text-[var(--text-muted)] uppercase tracking-tight">
              Style
            </span>
            <div className="flex items-center gap-1">
              {/* Bold Button */}
              <FunctionButton
                onClick={() => updateTextData({ fontWeight: textData?.fontWeight === 700 ? 400 : 700 })}
                active={textData?.fontWeight === 700}
                variant="glass"
                className="w-8 h-7 !rounded-lg text-[10px]"
              >
                B
              </FunctionButton>

              {/* Italic Button */}
              <FunctionButton
                onClick={() => updateTextData({ italic: !textData?.italic })}
                active={!!textData?.italic}
                variant="glass"
                className="w-8 h-7 !rounded-lg text-[10px] italic font-serif"
              >
                I
              </FunctionButton>

              {/* Underline Button */}
              <FunctionButton
                onClick={() => updateTextData({ underline: !textData?.underline })}
                active={!!textData?.underline}
                variant="glass"
                className="w-8 h-7 !rounded-lg text-[10px] underline"
              >
                U
              </FunctionButton>

              {/* Strikethrough Button */}
              <FunctionButton
                onClick={() => updateTextData({ strikethrough: !textData?.strikethrough })}
                active={!!textData?.strikethrough}
                variant="glass"
                className="w-8 h-7 !rounded-lg text-[10px] line-through"
              >
                S
              </FunctionButton>
            </div>
          </div>
        </div>
      </div>

      {/* Layout Card */}
      <div className="flex flex-col gap-2 p-1">
        <div className="flex items-center gap-2 px-1 mt-1">
          <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight w-16">
            Line Height
          </span>
          <input
            type="range"
            min="1"
            max="2.5"
            step="0.1"
            value={textData?.lineHeight || 1.4}
            onChange={(e) => updateTextDataLive({ lineHeight: Number(e.target.value) })}
            onMouseUp={(e) => {
              // Commit undoable snapshot when released (generates independent undo point in non-editing state)
              updateTextData({ lineHeight: Number(e.currentTarget.value) });
              e.currentTarget.blur();
            }}
            onTouchEnd={(e) => {
              updateTextData({ lineHeight: Number(e.currentTarget.value) });
              e.currentTarget.blur();
            }}
            className="flex-1 h-1.5 bg-[var(--bg-stage)] rounded-full appearance-none cursor-ew-resize hover:bg-[var(--border-subtle)] transition-all border-t border-[var(--border-subtle)] border-b border-[var(--border-subtle)] shadow-inner"
          />
          <span className="text-[10px] font-black w-8 text-right tabular-nums text-indigo-400">
            {(textData?.lineHeight || 1.4).toFixed(1)}
          </span>
        </div>
      </div>

      {!targetLayer && (
        <div className="text-[9px] text-[var(--text-muted)] italic mt-1 bg-[var(--bg-stage)] p-2.5 rounded-xl border border-[var(--border-subtle)] text-center">
          Click on canvas to create a text layer, or select an existing one.
        </div>
      )}
    </div>
  );
});
