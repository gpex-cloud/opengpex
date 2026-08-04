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

/**
 * ChannelMixerPanel — Photoshop-style 3×3 RGB channel mixer.
 *
 * Interaction & data-flow (spec §5, §6 & §7, mirrors CurvesPanel / LevelsPanel):
 *
 * - The panel is a strict UI + state-writer layer: it only mutates
 *   `layer.channelMix` through the plugin's commands. `Canvas2dEngine.drawLayerDirect()`
 *   observes the mutation on the next frame and, on cache-miss, dispatches
 *   the worker via `resolveFilteredSource` (spec §5.1 / §3.5). This file has
 *   ZERO knowledge of `AsyncFilterCache` / `WorkerBridge` — the hard
 *   constraint in spec §3.5.
 *
 * - Layout:
 *     • Preset dropdown at the top (None / B&W×3 / Sepia / Cross Process /
 *       Photo Negative). Each preset is a single undoable dispatch —
 *       `applyChannelMixPresetCmd` — so a preset switch is one Undo step.
 *     • "Monochrome" checkbox: when ON, all three output rows share the same
 *       coefficients (Photoshop's monochrome mode); the R/G/B output segment
 *       gets grayed out because there's only one editable row.
 *     • Output-channel segmented control (R / G / B): picks which row of the
 *       matrix the four sliders below edit. This is EDIT TARGET, not a view
 *       filter — dragging a slider only rewrites the picked row.
 *     • Four sliders + numeric fields:
 *         - Red source (row[0]):   coefficient of input R in the chosen output.
 *         - Green source (row[1]): coefficient of input G in the chosen output.
 *         - Blue source (row[2]):  coefficient of input B in the chosen output.
 *         - Constant offset:       additive bias on the chosen output.
 *       Slider range is -2.0 … +2.0 (displayed as -200% … +200%, Photoshop
 *       convention). Drag = gesture-coalesced (one Undo per drag); numeric
 *       field commit = short mini-gesture (one Undo per commit).
 *     • Total row: `row[0] + row[1] + row[2]` for the CURRENTLY edited output
 *       shown as a percentage. ≠ 100% is a soft warning (yellow tint) — it
 *       does NOT block editing; it just alerts users that overall brightness
 *       for that channel will drift, matching Photoshop's hint.
 *
 * - We deliberately share visual language with LevelsPanel (compact numeric
 *   inputs, `flex flex-col gap-2` outer stack, `text-[9px] tracking-widest`
 *   labels). The `NumberField` helper is a straight copy of the Photoshop-
 *   style input pattern from levels.tsx; extracting it to a shared
 *   `components.tsx` is Step 8 housekeeping (not required to ship this panel).
 *
 * - Performance note (spec §7 risk 8): 3×3 matrix per-pixel is 3–9× slower
 *   than the 1D LUT of curves/levels, but still lands in the same
 *   `resolveFilteredSource → worker` path. The panel doesn't need to know or
 *   care — it only writes state; the worker eats the CPU cost.
 */

import React, { useCallback, useMemo, useState } from "react";
import { usePluginCommands } from "@opengpex/editor/core/context";
import type { ChannelMixState } from "@opengpex/editor/core/types/models";
import type { AdjustmentDrawerCommandsMap } from "../commands.d";
import {
  DEFAULT_CHANNEL_MIX_STATE,
  CHANNEL_MIX_PRESETS,
  CHANNEL_MIX_PRESET_LABELS,
  CHANNEL_MIX_PRESET_ORDER,
} from "../protocols";
import type { ChannelMixOutput, ChannelMixPresetId } from "../protocols";
import { useAdjustmentDrawer, useFilterGesture } from "../hooks";
import FancySvgSlider from "@opengpex/editor/widgets/FancySvgSlider";
import ActionDropdown from "@opengpex/editor/widgets/ActionDropdown";
import type { ActionOption } from "@opengpex/editor/widgets/ActionDropdown";

// ─── Constants ─────────────────────────────────────────────────────────────────

/**
 * Slider domain. Photoshop's Channel Mixer sliders go -200%..+200% for the
 * source-channel weights and -200%..+200% for the constant; we keep the same
 * numeric range but store as a float in [-2, +2] so the runtime matrix
 * multiplication doesn't need a divide.
 */
const COEF_MIN = -2;
const COEF_MAX = 2;
/** Slider step (0.01 in float ≡ 1% in the displayed value). */
const COEF_STEP = 0.01;
/** Numeric-field precision (2 decimals — 3 would be noise past the eye). */
const COEF_PRECISION = 2;

/**
 * Per-output-row visual metadata. Keeps R/G/B tinting consistent with the
 * Curves panel's channel tabs so the visual language across the drawer feels
 * like one thing rather than three panels welded together.
 */
const OUTPUT_META: Record<ChannelMixOutput, { label: string; hex: string }> = {
  red: { label: "R", hex: "#ef4444" },
  green: { label: "G", hex: "#22c55e" },
  blue: { label: "B", hex: "#3b82f6" },
};

// ─── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Read the current channel-mix state, falling back to identity defaults so
 * the UI is always looking at a fully-formed matrix (avoids `undefined` row
 * checks scattered through the render). Returns a fresh clone every call —
 * mutating layer state directly would defeat React's referential equality.
 */
function readMix(current: ChannelMixState | undefined): ChannelMixState {
  const src = current ?? DEFAULT_CHANNEL_MIX_STATE;
  return {
    red: [src.red[0], src.red[1], src.red[2]],
    green: [src.green[0], src.green[1], src.green[2]],
    blue: [src.blue[0], src.blue[1], src.blue[2]],
    constant: src.constant
      ? [src.constant[0], src.constant[1], src.constant[2]]
      : [0, 0, 0],
  };
}

/**
 * Detect whether the current mix is (structurally) a match for one of the
 * built-in presets. Used to highlight the correct dropdown entry. `null`
 * means "custom" — no preset matches the current row triples & constant
 * within a small epsilon.
 */
const PRESET_MATCH_EPS = 1e-3;
function detectActivePreset(mix: ChannelMixState | undefined): ChannelMixPresetId | null {
  if (!mix) return "none";
  for (const id of CHANNEL_MIX_PRESET_ORDER) {
    const preset = CHANNEL_MIX_PRESETS[id];
    const rowsMatch = (["red", "green", "blue"] as const).every((k) => {
      const a = mix[k];
      const b = preset[k];
      return (
        Math.abs(a[0] - b[0]) < PRESET_MATCH_EPS &&
        Math.abs(a[1] - b[1]) < PRESET_MATCH_EPS &&
        Math.abs(a[2] - b[2]) < PRESET_MATCH_EPS
      );
    });
    if (!rowsMatch) continue;
    const ca = mix.constant ?? [0, 0, 0];
    const cb = preset.constant ?? [0, 0, 0];
    const constMatch =
      Math.abs(ca[0] - cb[0]) < PRESET_MATCH_EPS &&
      Math.abs(ca[1] - cb[1]) < PRESET_MATCH_EPS &&
      Math.abs(ca[2] - cb[2]) < PRESET_MATCH_EPS;
    if (constMatch) return id;
  }
  return null;
}

/**
 * A monochrome mix means all three output rows carry identical coefficients
 * AND identical constant offsets — the visual signature of "Photoshop's
 * Monochrome checkbox is ON". We detect it structurally rather than
 * persisting a boolean flag, matching the domain model (ChannelMixState has
 * no `monochrome` field).
 */
function isMonochrome(mix: ChannelMixState): boolean {
  const rows: ChannelMixOutput[] = ["red", "green", "blue"];
  for (let i = 1; i < rows.length; i++) {
    const a = mix[rows[0]];
    const b = mix[rows[i]];
    if (
      Math.abs(a[0] - b[0]) > PRESET_MATCH_EPS ||
      Math.abs(a[1] - b[1]) > PRESET_MATCH_EPS ||
      Math.abs(a[2] - b[2]) > PRESET_MATCH_EPS
    ) {
      return false;
    }
  }
  const c = mix.constant ?? [0, 0, 0];
  return (
    Math.abs(c[0] - c[1]) < PRESET_MATCH_EPS &&
    Math.abs(c[1] - c[2]) < PRESET_MATCH_EPS
  );
}

/**
 * Helper: given the CURRENTLY-selected output channel, return which index in
 * the `constant` triple that channel's constant offset lives at. The
 * `constant` layout is `[outputR_bias, outputG_bias, outputB_bias]`, so
 * output `'red'` → 0, `'green'` → 1, `'blue'` → 2. Extracted to reduce
 * ternary noise inside `commitPatch`.
 */
function outputToConstantIdx(output: ChannelMixOutput): number {
  return output === "red" ? 0 : output === "green" ? 1 : 2;
}

// ─── Slider target type ────────────────────────────────────────────────────────

/**
 * Which slider a commit targets. `'r' | 'g' | 'b'` targets the corresponding
 * coefficient of the currently-selected output row; `'const'` targets the
 * constant offset for the same row.
 */
type SliderTarget = "r" | "g" | "b" | "const";

// ─── Panel component ──────────────────────────────────────────────────────────

export function ChannelMixerPanel() {
  const {
    beginChannelMixEditCmd,
    updateChannelMixCmd,
    applyChannelMixPresetCmd,
  } = usePluginCommands<AdjustmentDrawerCommandsMap>();
  const { activeLayer } = useAdjustmentDrawer();
  const gesture = useFilterGesture(beginChannelMixEditCmd);

  // Which output row the user selected to edit (R by default, matches Photoshop).
  const [outputPref, setOutputPref] = useState<ChannelMixOutput>("red");

  const mix = useMemo(() => readMix(activeLayer?.channelMix), [activeLayer?.channelMix]);
  const monochrome = useMemo(() => isMonochrome(mix), [mix]);
  const activePreset = useMemo(
    () => detectActivePreset(activeLayer?.channelMix),
    [activeLayer?.channelMix],
  );

  /**
   * Effective edited output row. In monochrome mode all three rows carry the
   * same coefficients so we deterministically edit "red" regardless of user
   * preference; the segmented control is grayed-out in that mode.
   */
  const output: ChannelMixOutput = monochrome ? "red" : outputPref;
  const setOutput = setOutputPref;

  // ─── Commit logic ───────────────────────────────────────────────────────────

  const commitPatch = useCallback(
    (target: SliderTarget, value: number) => {
      if (!updateChannelMixCmd) return;
      const currentRow: [number, number, number] =
        target === "const"
          ? [mix.constant?.[0] ?? 0, mix.constant?.[1] ?? 0, mix.constant?.[2] ?? 0]
          : [...mix[output]] as [number, number, number];

      const cellIdx = target === "r" ? 0 : target === "g" ? 1 : target === "b" ? 2 : outputToConstantIdx(output);
      currentRow[cellIdx] = value;

      if (target === "const") {
        const nextConst: [number, number, number] = [
          mix.constant?.[0] ?? 0,
          mix.constant?.[1] ?? 0,
          mix.constant?.[2] ?? 0,
        ];
        if (monochrome) {
          nextConst[0] = value;
          nextConst[1] = value;
          nextConst[2] = value;
        } else {
          nextConst[cellIdx] = value;
        }
        updateChannelMixCmd.execute({ patch: { constant: nextConst } });
        return;
      }

      // Row-coefficient patch.
      if (monochrome) {
        updateChannelMixCmd.execute({
          patch: { red: currentRow, green: currentRow, blue: currentRow },
        });
      } else {
        updateChannelMixCmd.execute({ patch: { [output]: currentRow } });
      }
    },
    [updateChannelMixCmd, mix, output, monochrome],
  );

  /**
   * Wrap a single atomic mutation (number-field commit) in a short gesture so
   * it becomes exactly one Undo entry.
   */
  const commitAtomic = useCallback(
    (fn: () => void) => {
      gesture.begin();
      fn();
      gesture.end();
    },
    [gesture],
  );

  // ─── Numeric commit helpers ────────────────────────────────────────────────

  const commitNumeric = useCallback(
    (target: SliderTarget) => (value: number) => {
      commitAtomic(() => commitPatch(target, value));
    },
    [commitAtomic, commitPatch],
  );

  // ─── Monochrome toggle ─────────────────────────────────────────────────────

  const handleMonochromeToggle = useCallback(
    (nextOn: boolean) => {
      if (!updateChannelMixCmd) return;
      if (nextOn) {
        const src: [number, number, number] = [...mix[output]] as [number, number, number];
        const srcConst: [number, number, number] = [
          mix.constant?.[output === "red" ? 0 : output === "green" ? 1 : 2] ?? 0,
          mix.constant?.[output === "red" ? 0 : output === "green" ? 1 : 2] ?? 0,
          mix.constant?.[output === "red" ? 0 : output === "green" ? 1 : 2] ?? 0,
        ];
        commitAtomic(() =>
          updateChannelMixCmd.execute({
            patch: { red: src, green: src, blue: src, constant: srcConst },
          }),
        );
      } else {
        commitAtomic(() =>
          updateChannelMixCmd.execute({
            patch: {
              red: [1, 0, 0],
              green: [0, 1, 0],
              blue: [0, 0, 1],
              constant: [0, 0, 0],
            },
          }),
        );
      }
    },
    [updateChannelMixCmd, mix, output, commitAtomic],
  );

  // ─── Preset dropdown ───────────────────────────────────────────────────────

  const handlePresetChange = useCallback(
    (presetId: ChannelMixPresetId) => {
      applyChannelMixPresetCmd?.execute({ presetId });
    },
    [applyChannelMixPresetCmd],
  );

  // ─── Derived display values ────────────────────────────────────────────────

  const currentRow = mix[output];
  const currentConst =
    (mix.constant ?? [0, 0, 0])[
      output === "red" ? 0 : output === "green" ? 1 : 2
    ];

  const rowSum = currentRow[0] + currentRow[1] + currentRow[2];
  const rowSumPercent = Math.round(rowSum * 100);
  const totalWarn = Math.abs(rowSumPercent - 100) > 1;

  const outputMeta = OUTPUT_META[output];

  // ─── Slider row renderer ───────────────────────────────────────────────────

  const renderSliderRow = (
    target: SliderTarget,
    label: string,
    hex: string,
    value: number,
    disabled?: boolean,
  ) => {
    const percent = Math.round(value * 100);
    const displayPercent = `${percent > 0 ? "+" : ""}${percent}%`;
    return (
      <div key={target} className="flex items-center gap-2">
        <div className="w-6 shrink-0 flex flex-col items-start">
          <span
            className="text-[8px] font-black tracking-widest uppercase"
            style={{ color: disabled ? "var(--text-muted)" : hex }}
          >
            {label}
          </span>
          <span className="text-[8px] tracking-tight text-[var(--text-muted)]">
            {displayPercent}
          </span>
        </div>
        <FancySvgSlider
          bipolar
          withInput
          value={value}
          min={COEF_MIN}
          max={COEF_MAX}
          step={COEF_STEP}
          accentColor={hex}
          precision={COEF_PRECISION}
          disabled={disabled}
          ariaLabel={`${label} coefficient`}
          onDragStart={() => gesture.begin()}
          onChange={(v) => commitPatch(target, v)}
          onDragEnd={() => gesture.end()}
          onFieldCommit={commitNumeric(target)}
        />
      </div>
    );
  };

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-2">
      {/* Header: "Channel Mixer" label + Preset dropdown. */}
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-black tracking-widest uppercase text-[var(--text-muted)]">
          Channel Mixer
        </span>
        <ActionDropdown
          align="right"
          trigger={
            <span className="text-[9px] font-black tracking-widest uppercase px-2 py-0.5 rounded-md border border-zinc-200 dark:border-white/10 bg-transparent text-[var(--text-main)] hover:bg-zinc-100 dark:hover:bg-white/5 inline-flex items-center gap-1">
              {activePreset === null ? "Custom…" : CHANNEL_MIX_PRESET_LABELS[activePreset]}
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="opacity-50"><polyline points="6 9 12 15 18 9"/></svg>
            </span>
          }
          options={CHANNEL_MIX_PRESET_ORDER.map((id): ActionOption => ({
            label: CHANNEL_MIX_PRESET_LABELS[id],
            value: id,
            checked: activePreset === id,
          }))}
          onSelect={(val) => handlePresetChange(val as ChannelMixPresetId)}
        />
      </div>

      {/* Monochrome checkbox */}
      <label className="flex items-center gap-1.5 text-[10px] tracking-tight text-[var(--text-main)] select-none cursor-pointer">
        <input
          type="checkbox"
          checked={monochrome}
          onChange={(e) => handleMonochromeToggle(e.currentTarget.checked)}
          className="accent-[var(--accent-primary,#60a5fa)] w-3 h-3"
        />
        Monochrome
      </label>

      {/* Output-channel segmented control (R / G / B). */}
      <div
        role="tablist"
        aria-label="Output channel"
        className={`flex p-0.5 gap-0.5 rounded-lg border border-zinc-200 dark:border-white/5 bg-zinc-100/80 dark:bg-black/20 shadow-inner ${
          monochrome ? "opacity-50 pointer-events-none" : ""
        }`}
      >
        {(["red", "green", "blue"] as ChannelMixOutput[]).map((out) => {
          const meta = OUTPUT_META[out];
          const active = out === output;
          return (
            <button
              key={out}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setOutput(out)}
              className={`flex-1 h-5 rounded-md text-[10px] font-black tracking-widest transition-colors outline-none focus:outline-none ${
                active
                  ? "bg-white dark:bg-zinc-700 shadow-sm dark:shadow-[inset_0_1px_1px_rgba(255,255,255,0.05)]"
                  : "hover:bg-white/40 dark:hover:bg-white/5"
              }`}
              style={{
                color: active
                  ? meta.hex
                  : `color-mix(in srgb, ${meta.hex} 55%, var(--text-muted))`,
              }}
              title={`Edit ${meta.label} output row`}
            >
              {meta.label}
            </button>
          );
        })}
      </div>

      {/* Four sliders: three source coefficients + one constant. */}
      <div className="flex flex-col gap-1.5">
        {renderSliderRow("r", "R", OUTPUT_META.red.hex, currentRow[0])}
        {renderSliderRow("g", "G", OUTPUT_META.green.hex, currentRow[1])}
        {renderSliderRow("b", "B", OUTPUT_META.blue.hex, currentRow[2])}
        {renderSliderRow("const", "±", "#71717a", currentConst)}
      </div>

      {/* Total row */}
      <div className="flex items-center justify-between text-[9px] tracking-tight mt-0.5">
        <span className="text-[var(--text-muted)]">
          {outputMeta.label} = a·R + b·G + c·B{currentConst !== 0 ? " + Δ" : ""}
        </span>
        <span
          className="font-mono"
          style={{
            color: totalWarn ? "#f59e0b" : "var(--text-muted)",
          }}
          title={
            totalWarn
              ? "Total ≠ 100% — overall brightness of this channel will drift"
              : "Total = 100% (neutral brightness)"
          }
        >
          Total: {rowSumPercent > 0 ? "+" : ""}
          {rowSumPercent}%
        </span>
      </div>
    </div>
  );
}
