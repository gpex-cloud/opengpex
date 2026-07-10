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
import { motion } from "framer-motion";
import { Sliders, LineChart, BarChart3, SlidersHorizontal, RotateCcw as ResetIcon } from "lucide-react";
import { useEditorServices } from "@opengpex/editor/core/context";
import ActionButton from "@opengpex/editor/widgets/ActionButton";
import ActionGroup, { type ActionGroupItem } from "@opengpex/editor/widgets/ActionGroup";
import { BasicPanel } from "./panels/basic";
import { CurvesPanel } from "./panels/curves";
import { LevelsPanel } from "./panels/levels";
import { ChannelMixerPanel } from "./panels/mixer";

import { useColorGradingDrawer, useGradingToolSwitch } from "./hooks";
import { ColorGradingDrawerIcon } from "./icon";
import { ColorGradingDrawerAPI } from "./protocols";
import type { GradingTool } from "./protocols";

// ─── Constants ─────────────────────────────────────────────────────────────────

/**
 * Header button definitions.
 *
 * Order deliberately puts Basic first, then matches Photoshop's Adjustments
 * panel row for the advanced trio: Curves → Levels → Channel Mixer. Basic
 * fronts the list because Step 7.5 promoted it to the default tool (Photoshop
 * / Lightroom convention — entry-level users see brightness/contrast/
 * saturation first). Professional users can go straight to Curves/Levels/
 * Mixer for pixel-precise tonal work.
 *
 * No shortcut label is shown (spec §4.3): we intentionally do NOT register
 * global shortcuts for these tools to avoid polluting the shortcut namespace
 * that CraftDrawer's T/B/E and existing selection tools already occupy.
 */
const GRADING_BUTTONS: {
  tool: GradingTool;
  iconSmall: React.ReactNode;
  label: string;
}[] = [
  {
    // Step 7.5: 'basic' = migrated AdjustmentDrawer sliders (brightness /
    // contrast / saturation / hueRotate / blur). Icon is lucide `Sliders`
    // — a stack of horizontal sliders, visually distinct from mixer's
    // `SlidersHorizontal` (a single row of vertical sliders).
    tool: "basic",
    iconSmall: <Sliders size={10} />,
    label: "Basic",
  },
  {
    tool: "curves",
    iconSmall: <LineChart size={10} />,
    label: "Curves",
  },
  {
    tool: "levels",
    iconSmall: <BarChart3 size={10} />,
    label: "Levels",
  },
  {
    tool: "mixer",
    iconSmall: <SlidersHorizontal size={10} />,
    label: "Channel Mixer",
  },
];

// ─── GradingPanelButtonGroup ───────────────────────────────────────────────────

/**
 * Header icon-button group.
 *
 * Thin adapter: maps the domain-level `useGradingToolSwitch` state onto the
 * generic `ActionGroup` widget. All visual conventions (segmented control
 * geometry, neutral achromatic selection, focus-ring suppression) live
 * inside `ActionGroup` so future drawer-headers can reuse the same
 * switcher without duplicating pixel-perfect styles.
 *
 * We keep this local wrapper (rather than inlining `ActionGroup` at the
 * call site) because it memoizes independently of
 * `ColorGradingDrawerComponent`, saving re-renders when only `activeLayer`
 * changes but `activeTool` doesn't.
 */
const GradingPanelButtonGroup = React.memo(function GradingPanelButtonGroup() {
  const { activeTool, selectTool } = useGradingToolSwitch();

  // ActionGroup is strictly two-state (active vs default). No per-panel
  // presence-hint dot: users didn't ask for it, and the previous "inferred"
  // dot flagged every fresh layer's identity-value adjustments as if they
  // held real state.
  const items: ActionGroupItem<GradingTool>[] = GRADING_BUTTONS.map((btn) => ({
    key: btn.tool,
    icon: btn.iconSmall,
    label: btn.label,
    active: activeTool === btn.tool,
  }));

  return <ActionGroup items={items} onSelect={selectTool} />;
});


// ─── ColorGradingDrawerComponent ───────────────────────────────────────────────

/**
 * ColorGradingDrawerComponent — sidebar drawer body.
 *
 * Layout mirrors CraftDrawerComponent so the two drawers feel like siblings:
 *
 *   ┌────────────────────────────────────────────────────┐
 *   │ 🎨 Color Grading      [📈][📊][🎛️]   [↺]           │ ← header
 *   ├────────────────────────────────────────────────────┤
 *   │ (active sub-panel content — Curves/Levels/Mixer)   │
 *   └────────────────────────────────────────────────────┘
 *
 * The reset button lives at the header (not inside each sub-panel) so it can
 * later grow "reset current panel" vs "reset all" semantics without redesign.
 * For Step 4 it invokes `resetActivePanel` — resetting only the visible
 * sub-panel's layer state, which is the more conservative default.
 */
export const ColorGradingDrawerComponent = React.memo(function ColorGradingDrawerComponent() {
  const { activeTool, activeLayer } = useColorGradingDrawer();
  const { actions } = useEditorServices();

  const handleReset = React.useCallback(() => {
    // Fire cross-plugin command via UID; keeps the plugin decoupled from its
    // own internal command dispatch machinery (same pattern used by
    // LayerDrawer → CraftDrawer's deactivate).
    actions.executeCommand(ColorGradingDrawerAPI.commands.resetActivePanel.uid);
  }, [actions]);

  const isDisabled = !activeLayer;

  return (
    <div className="flex flex-col gap-2 px-2 pt-1 pb-1">
      <motion.div
        layout="position"
        className="flex justify-between items-center shrink-0"
      >
        <div className="flex items-center gap-2">
          <ColorGradingDrawerIcon size={12} className="text-indigo-600 dark:text-indigo-400" />
          <span className="text-[10px] font-black uppercase tracking-[0.15em] text-[var(--text-muted)]">
            Color Grading
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <GradingPanelButtonGroup />
          <ActionButton
            onClick={(e) => {
              e.stopPropagation();
              handleReset();
            }}
            icon={<ResetIcon size={12} />}
            tooltip={`Reset ${activeTool.charAt(0).toUpperCase() + activeTool.slice(1)}`}
            variant="glass"
            size="sm"
            className="text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors"
          />
        </div>
      </motion.div>

      {isDisabled ? (
        <motion.div
          layout="position"
          className="flex flex-col bg-[var(--bg-stage)] p-4 rounded-xl border border-[var(--border-subtle)] items-center justify-center py-8 text-center gap-2"
        >
          <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-widest">
            No Layer Selected
          </span>
          <span className="text-[9px] text-[var(--text-muted)] tracking-tight">
            Select a layer to apply color-grading adjustments.
          </span>
        </motion.div>
      ) : (
        <motion.div layout="position" className="flex flex-col">
          {activeTool === "basic" && <BasicPanel />}
          {activeTool === "curves" && <CurvesPanel />}
          {activeTool === "levels" && <LevelsPanel />}
          {activeTool === "mixer" && <ChannelMixerPanel />}
        </motion.div>

      )}
    </div>
  );
});
