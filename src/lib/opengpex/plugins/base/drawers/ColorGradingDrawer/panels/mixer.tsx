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

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { usePluginCommands } from "@opengpex/editor/core/context";
import type { ChannelMixState } from "@opengpex/editor/core/types/models";
import type { ColorGradingDrawerCommandsMap } from "../commands.d";
import {
  DEFAULT_CHANNEL_MIX_STATE,
  CHANNEL_MIX_PRESETS,
  CHANNEL_MIX_PRESET_LABELS,
  CHANNEL_MIX_PRESET_ORDER,
} from "../protocols";
import type { ChannelMixOutput, ChannelMixPresetId } from "../protocols";
import { useColorGradingDrawer, useFilterGesture } from "../hooks";

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

/** Slider track viewBox — mirrors Levels' track layout (256 wide × 24 tall). */
const TRACK_VB_W = 256;
const TRACK_VB_H = 24;

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

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

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

/** Round to the step grid so accumulator drift ("1.0300000000000004") stays out of layer state. */
function snapToStep(v: number): number {
  return Number((Math.round(v / COEF_STEP) * COEF_STEP).toFixed(COEF_PRECISION));
}

/**
 * Convert a horizontal pointer coordinate to a coefficient value in
 * `[COEF_MIN, COEF_MAX]`. Mirrors `pointerToIntensity` in levels.tsx but
 * scales into the coefficient domain instead of the 0..255 intensity domain.
 */
function pointerToCoef(evt: { clientX: number }, el: Element): number {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0) return 0;
  const frac = (evt.clientX - rect.left) / rect.width;
  const raw = COEF_MIN + clamp(frac, 0, 1) * (COEF_MAX - COEF_MIN);
  return snapToStep(clamp(raw, COEF_MIN, COEF_MAX));
}

/** Map a coefficient in [COEF_MIN, COEF_MAX] to viewBox x in [0, TRACK_VB_W]. */
function coefToTrackX(v: number): number {
  const frac = (clamp(v, COEF_MIN, COEF_MAX) - COEF_MIN) / (COEF_MAX - COEF_MIN);
  return frac * TRACK_VB_W;
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

// ─── NumberField (Photoshop-style typed input) ────────────────────────────────

/**
 * Same numeric-input pattern that ships in levels.tsx (`LevelsNumberField`):
 * - free typing (no forced reformat mid-keystroke)
 * - commit on blur / Enter / abort on Esc
 * - clamp to [min, max] + snap to `step` + fixed precision
 *
 * We locally re-declare instead of importing from `../levels.tsx` so this
 * panel doesn't reach across into a sibling's file surface. The identical
 * pattern is a candidate for extraction to `components.tsx` in Step 8; we
 * defer that until at least three panels want it (curves.tsx currently
 * doesn't need one).
 */
function NumberField({
  value,
  min,
  max,
  step,
  precision,
  disabled,
  onCommit,
  ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  precision: number;
  disabled?: boolean;
  onCommit: (v: number) => void;
  ariaLabel: string;
}) {
  const [draft, setDraft] = useState(value.toFixed(precision));
  const lastValueRef = useRef(value);
  useEffect(() => {
    if (lastValueRef.current !== value) {
      setDraft(value.toFixed(precision));
      lastValueRef.current = value;
    }
  }, [value, precision]);

  const commit = useCallback(() => {
    const parsed = Number.parseFloat(draft);
    if (Number.isFinite(parsed)) {
      const clamped = clamp(parsed, min, max);
      const stepped = step > 0 ? Math.round(clamped / step) * step : clamped;
      const final = Number(stepped.toFixed(precision));
      onCommit(final);
      setDraft(final.toFixed(precision));
      lastValueRef.current = final;
    } else {
      // Reset to last-known-good so the field never displays NaN.
      setDraft(value.toFixed(precision));
    }
  }, [draft, min, max, step, precision, onCommit, value]);

  return (
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
      className={`w-12 text-center text-[10px] font-mono rounded-sm bg-transparent border px-1 py-0.5 focus:outline-none ${
        disabled
          ? "border-transparent text-[var(--text-muted)] cursor-not-allowed"
          : "border-zinc-200 dark:border-white/10 focus:border-[var(--accent-primary,#60a5fa)]"
      }`}
    />
  );
}

// ─── Slider row (track + thumb + label + numeric field) ───────────────────────

/**
 * One horizontal row of the mixer: label on the left, colored track in the
 * middle with a draggable thumb, numeric field on the right. Kept
 * self-contained so the four rows in the panel body are just data + this
 * component.
 *
 * `trackTintHex` colors the track fill from center → thumb so a "positive
 * weight on Red source" reads as a red bar filling rightward — mirrors
 * Photoshop's slider visuals.
 */
function CoefSlider({
  label,
  hex,
  value,
  disabled,
  onDragStart,
  onDragMove,
  onDragEnd,
  onFieldCommit,
}: {
  label: string;
  hex: string;
  value: number;
  disabled?: boolean;
  onDragStart: (evt: ReactPointerEvent<SVGSVGElement>) => void;
  onDragMove: (evt: ReactPointerEvent<SVGSVGElement>) => void;
  onDragEnd: (evt: ReactPointerEvent<SVGSVGElement>) => void;
  onFieldCommit: (v: number) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const thumbX = coefToTrackX(value);
  const zeroX = coefToTrackX(0);
  const fillX = Math.min(thumbX, zeroX);
  const fillW = Math.abs(thumbX - zeroX);

  // Display value: percentage integer (Photoshop convention: "42%").
  const percent = Math.round(value * 100);
  const displayPercent = `${percent > 0 ? "+" : ""}${percent}%`;

  return (
    <div className="flex items-center gap-2">
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
      <div className="flex-1 min-w-0">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${TRACK_VB_W} ${TRACK_VB_H}`}
          preserveAspectRatio="none"
          overflow="visible"
          className={`w-full h-5 select-none overflow-visible ${
            disabled ? "cursor-not-allowed opacity-50" : "touch-none cursor-ew-resize"
          }`}
          role="slider"
          aria-label={`${label} coefficient`}
          aria-valuemin={COEF_MIN * 100}
          aria-valuemax={COEF_MAX * 100}
          aria-valuenow={percent}
          onPointerDown={disabled ? undefined : onDragStart}
          onPointerMove={disabled ? undefined : onDragMove}
          onPointerUp={disabled ? undefined : onDragEnd}
          onPointerCancel={disabled ? undefined : onDragEnd}
        >
          {/* Track baseline. */}
          <rect
            x={0}
            y={TRACK_VB_H * 0.45}
            width={TRACK_VB_W}
            height={TRACK_VB_H * 0.1}
            fill="#71717a"
            fillOpacity={0.3}
            rx={1}
          />
          {/* Zero-marker: a subtle vertical guide at coef=0 so users can eyeball
              the +/- boundary without a mental map. */}
          <line
            x1={zeroX}
            y1={TRACK_VB_H * 0.25}
            x2={zeroX}
            y2={TRACK_VB_H * 0.75}
            stroke="#71717a"
            strokeOpacity={0.7}
            strokeWidth={0.75}
          />
          {/* Filled portion from 0 → thumb (colored). */}
          <rect
            x={fillX}
            y={TRACK_VB_H * 0.45}
            width={fillW}
            height={TRACK_VB_H * 0.1}
            fill={hex}
            fillOpacity={0.9}
            rx={1}
          />
          {/* Thumb — small circle with theme-aware stroke. */}
          <circle
            cx={thumbX}
            cy={TRACK_VB_H / 2}
            r={4}
            fill={hex}
            stroke="#f9fafb"
            strokeWidth={1}
            className="dark:hidden"
          />
          <circle
            cx={thumbX}
            cy={TRACK_VB_H / 2}
            r={4}
            fill={hex}
            stroke="#111827"
            strokeWidth={1}
            className="hidden dark:block"
          />
        </svg>
      </div>
      <div className="shrink-0">
        <NumberField
          value={value}
          min={COEF_MIN}
          max={COEF_MAX}
          step={COEF_STEP}
          precision={COEF_PRECISION}
          disabled={disabled}
          onCommit={onFieldCommit}
          ariaLabel={`${label} numeric input`}
        />
      </div>
    </div>
  );
}

// ─── Panel component ──────────────────────────────────────────────────────────

/**
 * Which slider a drag is currently attached to. `null` means idle. `'r' | 'g'
 * | 'b'` targets the corresponding coefficient of the currently-selected
 * output row; `'const'` targets the constant offset for the same row.
 */
type SliderTarget = "r" | "g" | "b" | "const" | null;

export function ChannelMixerPanel() {
  const {
    beginChannelMixEditCmd,
    updateChannelMixCmd,
    applyChannelMixPresetCmd,
  } = usePluginCommands<ColorGradingDrawerCommandsMap>();
  const { activeLayer } = useColorGradingDrawer();
  const gesture = useFilterGesture(beginChannelMixEditCmd);

  // Which output row the user selected to edit (R by default, matches Photoshop).
  // NOTE: when `monochrome` is on we display the "red" row regardless of this
  // stored selection — see the `output` derivation below. We keep the raw
  // preference in a separate `outputPref` so that toggling monochrome OFF
  // restores whichever row the user was previously editing.
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
   * preference; the segmented control is grayed-out in that mode so the user
   * cannot desynchronize this from what the UI shows. We compute this as a
   * pure derivation instead of a `useEffect + setOutput` because syncing
   * state from a boolean via effect trips
   * `react-hooks/set-state-in-effect` and forces an extra render — the
   * derived value produces the same visual result in one render pass.
   */
  const output: ChannelMixOutput = monochrome ? "red" : outputPref;
  const setOutput = setOutputPref;


  // ─── Drag pipeline ──────────────────────────────────────────────────────────

  const dragRef = useRef<SliderTarget>(null);

  const commitPatch = useCallback(
    (
      target: Exclude<SliderTarget, null>,
      value: number,
    ) => {
      if (!updateChannelMixCmd) return;
      // Write the whole row triple + constant triple so `updateChannelMix`'s
      // shallow merge is safe. We snapshot the CURRENT mix (post-any-earlier
      // frame of the same gesture) rather than reading `layer.channelMix`
      // directly — this keeps drag-through-monochrome coherent because we
      // mirror the write into all three rows in one shot.
      const currentRow: [number, number, number] =
        target === "const"
          ? [mix.constant?.[0] ?? 0, mix.constant?.[1] ?? 0, mix.constant?.[2] ?? 0]
          : [...mix[output]] as [number, number, number];

      // Which cell in the row is being edited (0 = R, 1 = G, 2 = B).
      // For `const`, the "cell" maps by the currently-selected output
      // channel: editing constant while output=red touches only constant[0].
      const cellIdx = target === "r" ? 0 : target === "g" ? 1 : target === "b" ? 2 : outputToConstantIdx(output);
      currentRow[cellIdx] = value;

      if (target === "const") {
        // Constant patch — depending on monochrome, mirror or not.
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
        // Photoshop: monochrome mirrors the edited row into ALL three outputs.
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
   * Wrap a single atomic mutation (number-field commit or the preset click
   * path that isn't already undoable) in a short gesture so it becomes
   * exactly one Undo entry. Presets have their own undoable command and
   * don't use this wrapper.
   */
  const commitAtomic = useCallback(
    (fn: () => void) => {
      gesture.begin();
      fn();
      gesture.end();
    },
    [gesture],
  );

  const beginDrag = useCallback(
    (target: Exclude<SliderTarget, null>, evt: ReactPointerEvent<SVGSVGElement>) => {
      if (!activeLayer) return;
      if (evt.button !== 0) return; // left-click only
      dragRef.current = target;
      gesture.begin();
      evt.currentTarget.setPointerCapture?.(evt.pointerId);
      // Seed the value from the click position so drag-from-click feels
      // instant instead of only reacting after the first pointermove.
      const nextVal = pointerToCoef(evt, evt.currentTarget);
      commitPatch(target, nextVal);
    },
    [activeLayer, gesture, commitPatch],
  );

  const handleDragMove = useCallback(
    (target: Exclude<SliderTarget, null>) =>
      (evt: ReactPointerEvent<SVGSVGElement>) => {
        if (dragRef.current !== target) return;
        const nextVal = pointerToCoef(evt, evt.currentTarget);
        commitPatch(target, nextVal);
      },
    [commitPatch],
  );

  const finishDrag = useCallback(
    (evt?: ReactPointerEvent<SVGSVGElement>) => {
      if (!dragRef.current) return;
      dragRef.current = null;
      gesture.end();
      if (evt) {
        const el = evt.currentTarget as Element & {
          hasPointerCapture?: (id: number) => boolean;
          releasePointerCapture?: (id: number) => void;
        };
        if (el.hasPointerCapture?.(evt.pointerId)) {
          el.releasePointerCapture?.(evt.pointerId);
        }
      }
    },
    [gesture],
  );

  // Belt-and-suspenders: if unmounted mid-drag, close the gesture.
  useEffect(() => {
    return () => {
      if (dragRef.current) {
        dragRef.current = null;
        gesture.end();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Numeric commit helpers ────────────────────────────────────────────────

  const commitNumeric = useCallback(
    (target: Exclude<SliderTarget, null>) => (value: number) => {
      commitAtomic(() => commitPatch(target, value));
    },
    [commitAtomic, commitPatch],
  );

  // ─── Monochrome toggle ─────────────────────────────────────────────────────

  const handleMonochromeToggle = useCallback(
    (nextOn: boolean) => {
      if (!updateChannelMixCmd) return;
      if (nextOn) {
        // Turning ON: mirror the currently-selected row into all three
        // outputs. This is one atomic write, so one undo step.
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
        // Turning OFF: reset to identity so the three rows go back to being
        // independent (Photoshop convention — leaving them all identical
        // wouldn't feel like "un-monochromed"). Users can still tweak
        // individual rows from there.
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

  // "Total" = sum of the three source coefficients for the current output.
  // Photoshop hints that ≠ 100% will shift overall brightness for that
  // channel — we surface the warning in a soft yellow that doesn't block
  // editing.
  const rowSum = currentRow[0] + currentRow[1] + currentRow[2];
  const rowSumPercent = Math.round(rowSum * 100);
  const totalWarn = Math.abs(rowSumPercent - 100) > 1; // 1% tolerance

  const outputMeta = OUTPUT_META[output];

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-2">
      {/* Header: "Channel Mixer" label + Preset dropdown.
          Presets are a single-line <select> to save vertical space; on narrow
          drawers the dropdown UI is already familiar and doesn't need a
          custom widget. */}
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-black tracking-widest uppercase text-[var(--text-muted)]">
          Channel Mixer
        </span>
        <select
          value={activePreset ?? ""}
          onChange={(e) => handlePresetChange(e.target.value as ChannelMixPresetId)}
          title="Apply preset (Photoshop-compatible)"
          className="text-[9px] font-black tracking-widest uppercase px-2 py-0.5 rounded-md border border-zinc-200 dark:border-white/10 bg-transparent text-[var(--text-main)] hover:bg-zinc-100 dark:hover:bg-white/5 focus:outline-none"
        >
          {activePreset === null && (
            // Placeholder shown when the current matrix doesn't match any
            // built-in preset — Photoshop calls this "Custom". Setting
            // value="" keeps the placeholder in sync with the select's
            // current state without polluting the ID enum.
            <option value="" disabled>
              Custom…
            </option>
          )}
          {CHANNEL_MIX_PRESET_ORDER.map((id) => (
            <option key={id} value={id}>
              {CHANNEL_MIX_PRESET_LABELS[id]}
            </option>
          ))}
        </select>
      </div>

      {/* Monochrome checkbox — mirrors Photoshop's placement above the sliders. */}
      <label className="flex items-center gap-1.5 text-[10px] tracking-tight text-[var(--text-main)] select-none cursor-pointer">
        <input
          type="checkbox"
          checked={monochrome}
          onChange={(e) => handleMonochromeToggle(e.currentTarget.checked)}
          className="accent-[var(--accent-primary,#60a5fa)] w-3 h-3"
        />
        Monochrome
      </label>

      {/* Output-channel segmented control (R / G / B).
          Gray out when monochrome is on because all three rows are locked
          together — there's nothing to switch between. */}
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

      {/* Four sliders: three source coefficients + one constant. The active
          output row's tint colors the header label so users always know
          "I'm editing the ROW colored X". Source-channel labels stay tinted
          to their own channel (R red, G green, B blue). */}
      <div className="flex flex-col gap-1.5">
        <CoefSlider
          label="R"
          hex={OUTPUT_META.red.hex}
          value={currentRow[0]}
          onDragStart={(e) => beginDrag("r", e)}
          onDragMove={handleDragMove("r")}
          onDragEnd={finishDrag}
          onFieldCommit={commitNumeric("r")}
        />
        <CoefSlider
          label="G"
          hex={OUTPUT_META.green.hex}
          value={currentRow[1]}
          onDragStart={(e) => beginDrag("g", e)}
          onDragMove={handleDragMove("g")}
          onDragEnd={finishDrag}
          onFieldCommit={commitNumeric("g")}
        />
        <CoefSlider
          label="B"
          hex={OUTPUT_META.blue.hex}
          value={currentRow[2]}
          onDragStart={(e) => beginDrag("b", e)}
          onDragMove={handleDragMove("b")}
          onDragEnd={finishDrag}
          onFieldCommit={commitNumeric("b")}
        />
        <CoefSlider
          label="±"
          // Constant uses neutral gray tint — it's the additive bias, not a
          // channel-tinted operation.
          hex="#71717a"
          value={currentConst}
          onDragStart={(e) => beginDrag("const", e)}
          onDragMove={handleDragMove("const")}
          onDragEnd={finishDrag}
          onFieldCommit={commitNumeric("const")}
        />
      </div>

      {/* Total row: sum of the three source coefficients for the currently
          edited output. Photoshop convention — soft yellow when ≠100%. */}
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
