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
import FunctionButton from "@opengpex/editor/widgets/FunctionButton";
import { useTextPanel } from "../hooks";

// ─── Constants ─────────────────────────────────────────────────────────────────

const FONT_OPTIONS = [
  // --- Mobile & OS Defaults ---
  { value: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif", label: "Apple System" },
  { value: "'Segoe UI', Roboto, Helvetica, Arial, sans-serif", label: "Segoe UI" },
  { value: "Roboto, sans-serif", label: "Roboto" },

  // --- Web Creative Sans-Serif ---
  { value: "Inter, sans-serif", label: "Inter" },
  { value: "'Avenir Next', Avenir, sans-serif", label: "Avenir Next" },
  { value: "'Helvetica Neue', Helvetica, Arial, sans-serif", label: "Helvetica" },
  { value: "'Plus Jakarta Sans', sans-serif", label: "Plus Jakarta Sans" },
  { value: "Poppins, sans-serif", label: "Poppins" },
  { value: "Outfit, sans-serif", label: "Outfit" },

  // --- Chinese Mainstream ---
  { value: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif", label: "PingFang SC" },
  { value: "'Microsoft YaHei', \u5fae\u8f6f\u96c5\u9ed1, sans-serif", label: "Microsoft YaHei" },

  // --- Creative Serif ---
  { value: "'Playfair Display', serif", label: "Playfair Display" },
  { value: "'DM Serif Display', serif", label: "DM Serif Display" },
  { value: "Lora, serif", label: "Lora" },
  { value: "Georgia, serif", label: "Georgia" },

  // --- Monospace Code ---
  { value: "'Geist Mono', monospace", label: "Geist Mono" },
  { value: "'JetBrains Mono', monospace", label: "JetBrains Mono" },
];

const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 64, 72, 96];

const FONT_WEIGHT_MAP: Record<string, number> = {
  "Light": 300,
  "Regular": 400,
  "Medium": 500,
  "Semi Bold": 600,
  "Bold": 700,
};

const FONT_WEIGHT_LABELS: Record<number, string> = {
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "Semi Bold",
  700: "Bold",
};

// ─── TextPanel ─────────────────────────────────────────────────────────────────

/**
 * TextPanel: Text attributes panel
 *
 * Rendered inside CraftDrawer, displayed when activeCraft='text'.
 * Property changes synchronized to currently editing text layer in real time.
 */
export const TextPanel = React.memo(function TextPanel() {
  const { targetLayer, textData, updateTextData, updateTextDataLive, textColor, updateTextColor, updateTextColorLive } = useTextPanel();

  const currentFontLabel =
    FONT_OPTIONS.find((f) => f.value === (textData?.fontFamily || "Inter, sans-serif"))?.label || "Inter";

  const currentWeightLabel =
    FONT_WEIGHT_LABELS[textData?.fontWeight || 400] || "Regular";

  return (
    <div className="flex flex-col gap-2">
      {/* Typography Card */}
      <div className="flex flex-col gap-2.5 p-1">
        {/* Font Family */}
        <ComboInput
          label="Font"
          value={currentFontLabel}
          readOnly={true}
          options={FONT_OPTIONS.map((f) => f.label)}
          onChange={(val) => {
            const found = FONT_OPTIONS.find((f) => f.label === val);
            if (found) {
              updateTextData({ fontFamily: found.value });
            }
          }}
        />

        {/* Font Size & Weight */}
        <div className="flex gap-2">
          <div className="flex-1">
            <ComboInput
              label="Size"
              value={textData?.fontSize || 24}
              type="number"
              options={FONT_SIZES}
              onChange={(val) => updateTextData({ fontSize: Number(val) })}
            />
          </div>
          <div className="flex-1">
            <ComboInput
              label="Weight"
              value={currentWeightLabel}
              readOnly={true}
              options={Object.keys(FONT_WEIGHT_MAP)}
              onChange={(val) => {
                const weight = FONT_WEIGHT_MAP[val];
                if (weight) {
                  updateTextData({ fontWeight: weight });
                }
              }}
            />
          </div>
        </div>
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
