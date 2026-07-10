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

import React, { useCallback, useEffect, useRef, useState } from "react";
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


// ─── NumberField (Photoshop-style typed input) ────────────────────────────────

/**
 * NumberField — shared numeric input for grading sub-panels.
 *
 * Step 8 housekeeping: `LevelsPanel` and `ChannelMixerPanel` used to ship
 * near-identical local copies (`LevelsNumberField` + panel-local `NumberField`).
 * They diverged only cosmetically — Levels wraps the input under a tiny
 * uppercase label; Mixer places it beside a slider without its own label.
 * This module reconciles both by making `label` optional: when provided,
 * we render the vertical `[label] / [input]` cell used by Levels; when
 * omitted, we render just the input (Mixer's use-case).
 *
 * Behavior contract (unchanged from the two originals):
 *   - Free typing — the input string is preserved verbatim while focused,
 *     never coerced mid-keystroke. This matches Photoshop's numeric fields
 *     where you can safely type "1.03" without the "0" fighting reformatting.
 *   - Commit on blur or Enter — parses, clamps to `[min, max]`, snaps to
 *     `step`, formats to `precision` decimals, and calls `onCommit(final)`.
 *   - Escape cancels — restores the last committed value.
 *   - Invalid input (NaN) restores the last committed value; the field
 *     never displays NaN.
 *
 * `onCommit` is the sole undo-boundary hook: callers wrap it in a mini
 * gesture (begin → dispatch → end) so **every successful commit is exactly
 * one undo step**, matching the drag ergonomics. Do NOT bypass this by
 * mutating layer state directly from the field.
 */
export interface NumberFieldProps {
  /** Current committed value. */
  value: number;
  /** Inclusive lower bound. */
  min: number;
  /** Inclusive upper bound. */
  max: number;
  /**
   * Snap grid. `0` disables snapping (rare — most panels want a positive
   * step to keep patch values on a stable grid so `1.03` doesn't drift to
   * `1.0300000000000004` after enough round-trips).
   */
  step: number;
  /** Digits after the decimal point in the formatted display. */
  precision: number;
  /** Called once per successful commit; must be undo-boundary safe. */
  onCommit: (v: number) => void;
  /**
   * Accessible name. Required — screen readers must never see a nameless
   * numeric input; `panelId + fieldKind` (e.g. `"levels-input-black"`) is
   * the recommended pattern.
   */
  ariaLabel: string;
  /**
   * Optional small uppercase label rendered above the input (Levels style).
   * Omit for the "input-only" Mixer style.
   */
  label?: string;
  /**
   * Disabled state — currently only used by Mixer's Constant field when
   * monochrome mode consolidates the constant across all outputs.
   */
  disabled?: boolean;
}

export function NumberField({
  value,
  min,
  max,
  step,
  precision,
  disabled,
  onCommit,
  ariaLabel,
  label,
}: NumberFieldProps) {
  const [draft, setDraft] = useState(value.toFixed(precision));
  const lastValueRef = useRef(value);

  // Sync external changes into the visible text unless the user is mid-typing.
  // We compare against `lastValueRef.current` (not `draft`) so the sync fires
  // on Reset / Preset apply / another panel writing the same field.
  useEffect(() => {
    if (lastValueRef.current !== value) {
      setDraft(value.toFixed(precision));
      lastValueRef.current = value;
    }
  }, [value, precision]);

  const commit = useCallback(() => {
    const parsed = Number.parseFloat(draft);
    if (Number.isFinite(parsed)) {
      const clamped = Math.min(Math.max(parsed, min), max);
      const stepped = step > 0 ? Math.round(clamped / step) * step : clamped;
      const final = Number(stepped.toFixed(precision));
      onCommit(final);
      setDraft(final.toFixed(precision));
      lastValueRef.current = final;
    } else {
      setDraft(value.toFixed(precision));
    }
  }, [draft, min, max, step, precision, onCommit, value]);

  // Field styling forks by container mode:
  //   - `label` present: fill parent width, sit under a small uppercase caption
  //   - no label:        fixed w-12 (Mixer's numeric column alignment)
  const inputClass = label
    ? "w-full text-center text-[10px] font-mono rounded-sm bg-transparent border border-zinc-200 dark:border-white/10 px-1 py-0.5 focus:outline-none focus:border-[var(--accent-primary,#60a5fa)]"
    : `w-12 text-center text-[10px] font-mono rounded-sm bg-transparent border px-1 py-0.5 focus:outline-none ${
        disabled
          ? "border-transparent text-[var(--text-muted)] cursor-not-allowed"
          : "border-zinc-200 dark:border-white/10 focus:border-[var(--accent-primary,#60a5fa)]"
      }`;

  const input = (
    <input
      type="text"
      inputMode="decimal"
      value={draft}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          (e.target as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          setDraft(value.toFixed(precision));
          (e.target as HTMLInputElement).blur();
        }
      }}
      className={inputClass}
    />
  );

  if (label) {
    return (
      <div className="flex flex-col items-center gap-0.5 flex-1 min-w-0">
        <span className="text-[8px] font-black tracking-widest uppercase text-[var(--text-muted)]">
          {label}
        </span>
        {input}
      </div>
    );
  }
  return input;
}
