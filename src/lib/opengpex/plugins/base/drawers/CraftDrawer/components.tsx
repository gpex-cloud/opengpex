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
import { motion } from "framer-motion";
import { useEditorServices } from "@opengpex/editor/core/context";
import { SettingsPanelAPI } from "../../panels/SettingsPanel/protocols";
import Tooltip from "@opengpex/editor/widgets/Tooltip";
import { FancyButton } from "@opengpex/editor/widgets/FancyButton";
import ActionGroup, { type ActionGroupItem } from "@opengpex/editor/widgets/ActionGroup";
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
            <FancyButton iconOnly shape="rect"
              key={btn.type}
              onClick={() => selectCraft(btn.type)}
              active={isActive}
              title={btn.type === 'eraser' && activeCraft === 'restore' ? 'Restore Mode (Tab)' : btn.label}
              variant="ghost"
              tooltipPosition="bottom"
              className="w-7 h-7 rounded-lg text-blue-400"
            >
              {displayIcon}
            </FancyButton>
          );
        })}
      </div>
    </Tooltip>
  );
});

// ─── CraftPanelButtonGroup ─────────────────────────────────────────────────────

/**
 * CraftPanelButtonGroup: Button group [T] [B] [E] at the header of CraftDrawer panel.
 *
 * Thin adapter over the generic `ActionGroup` widget. Two domain concerns
 * this wrapper handles that ActionGroup doesn't need to know about:
 *
 *   1. `getButtonState` — mapping (activeCraft, layer type) to the tri-state
 *      `active | inferred | default` shape ActionGroup expects. `restore`
 *      counts as `active` on the eraser button (Tab toggles the sub-mode).
 *   2. Dynamic icon — when eraser is in `restore` sub-mode, its icon flips
 *      to Undo2 to hint "next click undoes the mask erase". We compute this
 *      per render and pass the resulting node in as the item's `icon`, so
 *      ActionGroup stays a pure presentational widget with no knowledge of
 *      Craft-specific state.
 *   3. Dynamic label — same eraser/restore sub-mode swap: the tooltip
 *      changes from "Eraser Tool (E)" to "Restore Mode (Tab)".
 *
 * State model is strictly two-state (`active` vs default). Note that `restore`
 * is a sub-mode of eraser (Tab toggles between them), so when `activeCraft`
 * is `'restore'` the Eraser button still reads as active. Earlier drafts
 * had a third "inferred" state (dot indicator) that lit up when the layer
 * type matched a tool but no tool was active — that hint was removed along
 * with ColorGradingDrawer's equivalent, because users found the dot noisy
 * and never asked for it. If you need to bring it back for one drawer,
 * add it opt-in on the widget rather than resurrecting a shared tri-state
 * default.
 */
const CraftPanelButtonGroup = React.memo(function CraftPanelButtonGroup() {
  const { activeCraft, handleButtonClick } = useCraftButtonGroup();

  // Assemble items per render. Cheap (3 entries) and the icon/label swap
  // for eraser-in-restore-mode is a pure function of activeCraft, so any
  // memoization would just move the branch elsewhere without saving work.
  const items: ActionGroupItem<CraftType>[] = CRAFT_BUTTONS.map((btn) => {
    const isRestoreOnEraser =
      btn.type === "eraser" && activeCraft === "restore";
    const active =
      activeCraft === btn.type ||
      (btn.type === "eraser" && activeCraft === "restore");
    return {
      key: btn.type,
      // Dynamic icon: swap Eraser → Undo2 when we're in restore sub-mode.
      // ActionGroup takes any ReactNode, so we build the node here.
      icon: isRestoreOnEraser ? <Undo2 size={10} /> : btn.iconSmall,
      // Dynamic label: mirror the icon swap so the tooltip stays truthful.
      label: isRestoreOnEraser ? "Restore Mode (Tab)" : btn.label,
      active,
    };
  });

  return <ActionGroup items={items} onSelect={handleButtonClick} />;
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
      <motion.div
        layout="position"
        className="flex justify-between items-center shrink-0"
      >
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
      </motion.div>

      {showTextPanel && (
        <motion.div layout="position" className="flex flex-col">
          <TextPanel />
        </motion.div>
      )}

      {showBrushPanel && (
        <motion.div layout="position" className="flex flex-col">
          <BrushPanel />
        </motion.div>
      )}

      {showPlaceholder && (
        <motion.div
          layout="position"
          className="flex flex-col bg-[var(--bg-stage)] p-4 rounded-xl border border-[var(--border-subtle)] items-center justify-center py-8 text-center gap-2"
        >
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
        </motion.div>
      )}
    </div>
  );
});
