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
import { Type, Paintbrush, Eraser, Undo2, Settings } from "lucide-react";
import { useEditorServices } from "@opengpex/editor/core/context";
import { SettingsPanelAPI } from "../../panels/SettingsPanel/protocols";
import Tooltip from "@opengpex/editor/widgets/Tooltip";
import FunctionButton from "@opengpex/editor/widgets/FunctionButton";
import { TextPanel } from "./panels/text";
import { BrushPanel } from "./panels/brush";
import { useCraftDrawer, useCraftTrigger, useCraftButtonGroup } from "./hooks";
import { CraftDrawerIcon } from "./icon";
import type { CraftType } from "./protocols";

// ─── Constants ─────────────────────────────────────────────────────────────────

const CRAFT_BUTTONS: {
  type: CraftType;
  icon: React.ReactNode;
  iconSmall: React.ReactNode;
  label: string;
}[] = [
  {
    type: "text",
    icon: <Type size={13} />,
    iconSmall: <Type size={10} />,
    label: "Text Tool (T)",
  },
  {
    type: "brush",
    icon: <Paintbrush size={13} />,
    iconSmall: <Paintbrush size={10} />,
    label: "Brush Tool (B)",
  },
  {
    type: "eraser",
    icon: <Eraser size={13} />,
    iconSmall: <Eraser size={10} />,
    label: "Eraser Tool (E)",
  },
];

// ─── CraftTriggerButtons ───────────────────────────────────────────────────────

/**
 * CraftTriggerButtons: Tool trigger button group injected into ColorOptions CRAFT_SLOT
 *
 * Renders three buttons: [📝 Text] [🖌️ Brush] [🧹 Eraser].
 * Button click calls setCraft command to toggle tool. Click again to deactivate (toggle behavior).
 * Active status buttons have accent color highlight + pulse animation.
 */
export const CraftTriggerButtons = React.memo(function CraftTriggerButtons() {
  const { activeCraft, selectCraft } = useCraftTrigger();

  const tipContent =
    activeCraft === "text"
      ? "Click canvas to place text\nHold Cmd/Ctrl to move\nEsc to exit"
      : activeCraft === "brush"
        ? "Draw on canvas\nEsc to exit"
        : activeCraft === "eraser" || activeCraft === "restore"
          ? "Erase / Restore mask pixels\nTab to toggle eraser ↔ restore\nCmd/Ctrl+click to create new mask\nEsc to exit"
          : null;

  return (
    <Tooltip
      content={tipContent || ""}
      position="bottom"
      align={
        activeCraft === "text"
          ? "start"
          : activeCraft === "eraser" || activeCraft === "restore"
            ? "end"
            : "center"
      }
      alwaysShow={!!tipContent}
      showOnHover={false}
      uppercase={false}
      display="inline-flex"
      className="!whitespace-normal text-left"
    >
      <div className="flex items-center gap-1">
        {CRAFT_BUTTONS.map((btn) => {
          const isActive = activeCraft === btn.type || (btn.type === 'eraser' && activeCraft === 'restore');
          // Dynamic icon: show Undo2 when eraser button is in restore sub-mode
          const displayIcon = (btn.type === 'eraser' && activeCraft === 'restore')
            ? <Undo2 size={13} />
            : btn.icon;
          return (
            <FunctionButton
              key={btn.type}
              onClick={() => selectCraft(btn.type)}
              active={isActive}
              title={btn.type === 'eraser' && activeCraft === 'restore' ? 'Restore Mode (Tab)' : btn.label}
              variant="glass"
              tooltipPosition="bottom"
              className="w-7 h-7 rounded-lg text-blue-400"
            >
              {displayIcon}
            </FunctionButton>
          );
        })}
      </div>
    </Tooltip>
  );
});

// ─── CraftPanelButtonGroup ─────────────────────────────────────────────────────

/**
 * CraftPanelButtonGroup: Button group [T] [B] [E] at the header of CraftDrawer panel
 *
 * Replaces the original badge label, acting as both a mode indicator and a panel switcher.
 * Buttons have three visual states:
 * - accent highlight: activeCraft is explicitly equal to this button type (tool actively activated)
 * - soft background: activeCraft is null but layer type infers that this panel should be displayed (passive inference status)
 * - default gray: unrelated
 *
 * Click logic includes the "go home" rule (see useCraftButtonGroup hook).
 */
const CraftPanelButtonGroup = React.memo(function CraftPanelButtonGroup() {
  const {
    activeCraft,
    activeLayerIsText,
    activeLayerIsPaint,
    handleButtonClick,
  } = useCraftButtonGroup();

  /**
   * Calculates visual state of each button
   */
  const getButtonState = (
    type: CraftType,
  ): "active" | "inferred" | "default" => {
    // Explicitly activated tool -> accent highlight
    // restore is a sub-mode of eraser (Tab toggles between them), so eraser stays "active"
    if (activeCraft === type) return "active";
    if (type === "eraser" && activeCraft === "restore") return "active";
    // eraser shares brush's panel, so brush button does not need special status when eraser is active
    // Inference state: judged by layer type when no tool is active
    if (activeCraft === null) {
      if (type === "text" && activeLayerIsText) return "inferred";
      if (type === "brush" && activeLayerIsPaint) return "inferred";
    }
    return "default";
  };

  return (
    <div className="flex items-center h-5 rounded-md overflow-hidden border border-[var(--border-subtle)]">
      {CRAFT_BUTTONS.map((btn, index) => {
        const state = getButtonState(btn.type);
        // Dynamic icon: show Undo2 when eraser button is in restore sub-mode
        const displayIconSmall = (btn.type === 'eraser' && activeCraft === 'restore')
          ? <Undo2 size={10} />
          : btn.iconSmall;
        return (
          <React.Fragment key={btn.type}>
            {index > 0 && (
              <div className="w-[1px] h-2.5 bg-zinc-300/50 dark:bg-white/10 shrink-0" />
            )}
            <button
              onClick={() => handleButtonClick(btn.type)}
              className={`relative flex items-center justify-center w-6 h-full transition-all outline-none select-none focus:outline-none focus:ring-0 focus-visible:outline-none
                ${
                  state === "active"
                    ? "text-[var(--accent)] craft-btn-active"
                    : state === "inferred"
                      ? "text-[var(--text-main)]"
                      : "hover:bg-[var(--bg-stage)] text-[var(--text-muted)] hover:text-[var(--text-main)]"
                }`}
              style={
                state === "active"
                  ? {
                      background:
                        "color-mix(in srgb, currentColor 12%, var(--bg-panel))",
                      boxShadow:
                        "0 0 0 1px color-mix(in srgb, var(--accent) 50%, transparent) inset",
                      WebkitTapHighlightColor: "transparent",
                    }
                  : state === "inferred"
                    ? {
                        background:
                          "color-mix(in srgb, currentColor 8%, var(--bg-panel))",
                        boxShadow:
                          "0 0 0 1px color-mix(in srgb, currentColor 20%, transparent) inset",
                        WebkitTapHighlightColor: "transparent",
                      }
                    : {
                        WebkitTapHighlightColor: "transparent",
                      }
              }
              title={btn.type === 'eraser' && activeCraft === 'restore' ? 'Restore Mode (Tab)' : btn.label}
            >
              {displayIconSmall}
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
});

// ─── CraftDrawerComponent ──────────────────────────────────────────────────────

/**
 * CraftDrawerComponent: Unified sidebar panel for craft tools
 *
 * Automatically switches content panel (mutually exclusive) based on activeCraft signal + currently selected layer type:
 * - activeCraft='text' → TextPanel
 * - activeCraft='brush'|'eraser' → BrushPanel
 * - activeCraft=null && layer.type='text' -> TextPanel (inferred)
 * - activeCraft=null && layer.type='paint' -> BrushPanel (inferred)
 * - others -> generic tip
 */
export const CraftDrawerComponent = React.memo(function CraftDrawerComponent() {
  const { activeCraft, activeLayerIsText, activeLayerIsPaint } =
    useCraftDrawer();
  const { actions } = useEditorServices();

  const handleOpenSettings = React.useCallback(() => {
    actions.setStateSignal(SettingsPanelAPI.signals.tab, 'Fonts');
    actions.setStateSignal(SettingsPanelAPI.signals.open, true);
  }, [actions]);

  // Mutually exclusive panel decisions (priority from high to low)
  const showTextPanel =
    activeCraft === "text" || (activeCraft === null && activeLayerIsText);

  const showBrushPanel =
    activeCraft === "brush" ||
    activeCraft === "eraser" ||
    activeCraft === "restore" ||
    (activeCraft === null && activeLayerIsPaint);

  const showPlaceholder = !showTextPanel && !showBrushPanel;

  return (
    <div className="flex flex-col gap-2 px-2 pt-1 pb-1">
      <div className="flex justify-between items-center shrink-0">
        <div className="flex items-center gap-2">
          <CraftDrawerIcon size={12} className="text-indigo-600 dark:text-indigo-400" />
          <span className="text-[10px] font-black uppercase tracking-[0.15em] text-[var(--text-muted)]">
            Drawing Tools
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <CraftPanelButtonGroup />
          <button
            onClick={handleOpenSettings}
            className="p-1 rounded hover:bg-white/5 text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors"
            title="Font Settings"
          >
            <Settings size={12} />
          </button>
        </div>
      </div>

      {showTextPanel && <TextPanel />}

      {showBrushPanel && <BrushPanel />}

      {showPlaceholder && (
        <div className="flex flex-col bg-[var(--bg-stage)] p-4 rounded-xl border border-[var(--border-subtle)] items-center justify-center py-8 text-center gap-2">
          <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-widest">
            No Tool Active
          </span>
          <span className="text-[9px] text-[var(--text-muted)] tracking-tight">
            Press{" "}
            <kbd className="px-1.5 py-0.5 bg-[var(--bg-panel)] border border-[var(--border-subtle)] rounded-md text-[8px] font-bold shadow-sm">
              T
            </kbd>{" "}
            for Text,{" "}
            <kbd className="px-1.5 py-0.5 bg-[var(--bg-panel)] border border-[var(--border-subtle)] rounded-md text-[8px] font-bold shadow-sm">
              B
            </kbd>{" "}
            for Brush,{" "}
            <kbd className="px-1.5 py-0.5 bg-[var(--bg-panel)] border border-[var(--border-subtle)] rounded-md text-[8px] font-bold shadow-sm">
              E
            </kbd>{" "}
            for Eraser, or{" "}
            <kbd className="px-1.5 py-0.5 bg-[var(--bg-panel)] border border-[var(--border-subtle)] rounded-md text-[8px] font-bold shadow-sm">
              R
            </kbd>{" "}
            for Restore.
          </span>
        </div>
      )}
    </div>
  );
});
