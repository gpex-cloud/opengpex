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
 * ColorBalancePanel — Photoshop-style three-way color balance.
 *
 * Interaction & data-flow (mirrors mixer.tsx / levels.tsx):
 *
 * - The panel is a strict UI + state-writer layer: it only mutates
 *   `layer.colorBalance` through the plugin's commands. `Canvas2dEngine`
 *   observes the mutation on the next frame and dispatches through
 *   `resolveFilteredSource`. This file has ZERO knowledge of
 *   `AsyncFilterCache` / `WorkerBridge`.
 *
 * - Layout:
 *     • Tone-region segmented control (Shadows / Midtones / Highlights):
 *       picks which [R,G,B] triple the sliders below edit.
 *     • Three bipolar sliders:
 *         - Cyan ↔ Red     (index 0)
 *         - Magenta ↔ Green (index 1)
 *         - Yellow ↔ Blue   (index 2)
 *       Slider range: -100 … +100.
 *     • "Preserve Luminosity" checkbox at the bottom.
 *
 * - Gesture model: same as Curves/Levels/Mixer — `beginColorBalanceEdit`
 *   is the undoable checkpoint, `updateColorBalance` is the non-undoable
 *   coalesced writer; `useFilterGesture` orchestrates the pair.
 */

import React, { useCallback, useMemo, useState } from "react";
import { usePluginCommands } from "@opengpex/editor/core/context";
import type { ColorBalanceState } from "@opengpex/editor/core/types/models";
import type { AdjustmentDrawerCommandsMap } from "../commands.d";
import { DEFAULT_COLOR_BALANCE_STATE } from "../protocols";
import { useAdjustmentDrawer, useFilterGesture } from "../hooks";
import FancySvgSlider from "@opengpex/editor/widgets/FancySvgSlider";

// ─── Types ─────────────────────────────────────────────────────────────────────

type ToneRegion = "shadows" | "midtones" | "highlights";

/** Which of the 3 axes a slider is bound to. */
type BalanceAxis = 0 | 1 | 2;

// ─── Constants ─────────────────────────────────────────────────────────────────

const BALANCE_MIN = -100;
const BALANCE_MAX = 100;
const BALANCE_STEP = 1;

const TONE_REGIONS: { key: ToneRegion; label: string }[] = [
  { key: "shadows", label: "Shadows" },
  { key: "midtones", label: "Midtones" },
  { key: "highlights", label: "Highlights" },
];

/**
 * Per-axis visual metadata (bipolar: left color ↔ right color).
 * Photoshop convention: negative = Cyan/Magenta/Yellow, positive = Red/Green/Blue.
 */
const AXIS_META: {
  leftLabel: string;
  rightLabel: string;
  leftHex: string;
  rightHex: string;
}[] = [
  { leftLabel: "Cyan", rightLabel: "Red", leftHex: "#06b6d4", rightHex: "#ef4444" },
  { leftLabel: "Magenta", rightLabel: "Green", leftHex: "#d946ef", rightHex: "#22c55e" },
  { leftLabel: "Yellow", rightLabel: "Blue", leftHex: "#eab308", rightHex: "#3b82f6" },
];

// ─── Utilities ─────────────────────────────────────────────────────────────────

function readBalance(current: ColorBalanceState | undefined): ColorBalanceState {
  const src = current ?? DEFAULT_COLOR_BALANCE_STATE;
  return {
    shadows: [src.shadows[0], src.shadows[1], src.shadows[2]],
    midtones: [src.midtones[0], src.midtones[1], src.midtones[2]],
    highlights: [src.highlights[0], src.highlights[1], src.highlights[2]],
    preserveLuminosity: src.preserveLuminosity,
  };
}

// ─── Panel Component ──────────────────────────────────────────────────────────

export function ColorBalancePanel() {
  const {
    beginColorBalanceEditCmd,
    updateColorBalanceCmd,
  } = usePluginCommands<AdjustmentDrawerCommandsMap>();
  const { activeLayer } = useAdjustmentDrawer();
  const gesture = useFilterGesture(beginColorBalanceEditCmd);

  const [toneRegion, setToneRegion] = useState<ToneRegion>("midtones");

  const balance = useMemo(
    () => readBalance(activeLayer?.colorBalance),
    [activeLayer?.colorBalance],
  );

  const currentTriple = balance[toneRegion];

  // ─── Value commit helpers ──────────────────────────────────────────────────

  const commitValue = useCallback(
    (axis: BalanceAxis, value: number) => {
      if (!updateColorBalanceCmd) return;
      const nextTriple: [number, number, number] = [...currentTriple] as [number, number, number];
      nextTriple[axis] = value;
      updateColorBalanceCmd.execute({ patch: { [toneRegion]: nextTriple } });
    },
    [updateColorBalanceCmd, currentTriple, toneRegion],
  );

  const commitAtomic = useCallback(
    (fn: () => void) => {
      gesture.begin();
      fn();
      gesture.end();
    },
    [gesture],
  );

  // ─── Numeric commit helpers ─────────────────────────────────────────────────

  const commitNumeric = useCallback(
    (axis: BalanceAxis) => (value: number) => {
      commitAtomic(() => commitValue(axis, value));
    },
    [commitAtomic, commitValue],
  );

  // ─── Preserve Luminosity toggle ─────────────────────────────────────────────

  const handlePreserveLuminosity = useCallback(
    (checked: boolean) => {
      if (!updateColorBalanceCmd) return;
      commitAtomic(() =>
        updateColorBalanceCmd.execute({ patch: { preserveLuminosity: checked } }),
      );
    },
    [updateColorBalanceCmd, commitAtomic],
  );

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-2">
      {/* Header */}
      <span className="text-[9px] font-black tracking-widest uppercase text-[var(--text-muted)]">
        Color Balance
      </span>

      {/* Tone-region segmented control */}
      <div
        role="tablist"
        aria-label="Tone region"
        className="flex p-0.5 gap-0.5 rounded-lg border border-zinc-200 dark:border-white/5 bg-zinc-100/80 dark:bg-black/20 shadow-inner"
      >
        {TONE_REGIONS.map((tr) => {
          const active = tr.key === toneRegion;
          return (
            <button
              key={tr.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setToneRegion(tr.key)}
              className={`flex-1 h-5 rounded-md text-[9px] font-black tracking-widest transition-colors outline-none focus:outline-none ${
                active
                  ? "bg-white dark:bg-zinc-700 shadow-sm dark:shadow-[inset_0_1px_1px_rgba(255,255,255,0.05)] text-[var(--text-main)]"
                  : "hover:bg-white/40 dark:hover:bg-white/5 text-[var(--text-muted)]"
              }`}
              title={tr.label}
            >
              {tr.label}
            </button>
          );
        })}
      </div>

      {/* Three bipolar sliders */}
      <div className="flex flex-col gap-1.5">
        {([0, 1, 2] as BalanceAxis[]).map((axis) => {
          const meta = AXIS_META[axis];
          return (
            <div key={axis} className="flex flex-col gap-0.5">
              {/* Labels: left ↔ right */}
              <div className="flex items-center justify-between px-0.5">
                <span
                  className="text-[8px] font-black tracking-widest uppercase"
                  style={{ color: meta.leftHex }}
                >
                  {meta.leftLabel}
                </span>
                <span
                  className="text-[8px] font-black tracking-widest uppercase"
                  style={{ color: meta.rightHex }}
                >
                  {meta.rightLabel}
                </span>
              </div>
              <FancySvgSlider
                bipolar={{ negativeColor: meta.leftHex, positiveColor: meta.rightHex }}
                withInput
                value={currentTriple[axis]}
                min={BALANCE_MIN}
                max={BALANCE_MAX}
                step={BALANCE_STEP}
                precision={0}
                ariaLabel={`${meta.leftLabel}–${meta.rightLabel}`}
                onDragStart={() => gesture.begin()}
                onChange={(v) => commitValue(axis, v)}
                onDragEnd={() => gesture.end()}
                onFieldCommit={commitNumeric(axis)}
              />
            </div>
          );
        })}
      </div>

      {/* Preserve Luminosity checkbox */}
      <label className="flex items-center gap-1.5 text-[10px] tracking-tight text-[var(--text-main)] select-none cursor-pointer mt-1">
        <input
          type="checkbox"
          checked={balance.preserveLuminosity}
          onChange={(e) => handlePreserveLuminosity(e.currentTarget.checked)}
          className="accent-[var(--accent-primary,#60a5fa)] w-3 h-3"
        />
        Preserve Luminosity
      </label>
    </div>
  );
}
