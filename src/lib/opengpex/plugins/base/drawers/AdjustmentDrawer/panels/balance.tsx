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

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { usePluginCommands } from "@opengpex/editor/core/context";
import type { ColorBalanceState } from "@opengpex/editor/core/types/models";
import type { AdjustmentDrawerCommandsMap } from "../commands.d";
import { DEFAULT_COLOR_BALANCE_STATE } from "../protocols";
import { NumberField } from "../components";
import { useAdjustmentDrawer, useFilterGesture } from "../hooks";

// ─── Types ─────────────────────────────────────────────────────────────────────

type ToneRegion = "shadows" | "midtones" | "highlights";

/** Which of the 3 axes a slider is bound to. */
type BalanceAxis = 0 | 1 | 2;

// ─── Constants ─────────────────────────────────────────────────────────────────

const BALANCE_MIN = -100;
const BALANCE_MAX = 100;
const BALANCE_STEP = 1;

/** SVG track geometry — same as mixer.tsx for visual consistency. */
const TRACK_VB_W = 256;
const TRACK_VB_H = 24;

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

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

function readBalance(current: ColorBalanceState | undefined): ColorBalanceState {
  const src = current ?? DEFAULT_COLOR_BALANCE_STATE;
  return {
    shadows: [src.shadows[0], src.shadows[1], src.shadows[2]],
    midtones: [src.midtones[0], src.midtones[1], src.midtones[2]],
    highlights: [src.highlights[0], src.highlights[1], src.highlights[2]],
    preserveLuminosity: src.preserveLuminosity,
  };
}

function pointerToBalance(evt: { clientX: number }, el: Element): number {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0) return 0;
  const frac = (evt.clientX - rect.left) / rect.width;
  const raw = BALANCE_MIN + clamp(frac, 0, 1) * (BALANCE_MAX - BALANCE_MIN);
  return Math.round(clamp(raw, BALANCE_MIN, BALANCE_MAX));
}

function balanceToTrackX(v: number): number {
  const frac =
    (clamp(v, BALANCE_MIN, BALANCE_MAX) - BALANCE_MIN) /
    (BALANCE_MAX - BALANCE_MIN);
  return frac * TRACK_VB_W;
}

// ─── Bipolar Slider ────────────────────────────────────────────────────────────

function BalanceSlider({
  axis,
  value,
  onDragStart,
  onDragMove,
  onDragEnd,
  onFieldCommit,
}: {
  axis: BalanceAxis;
  value: number;
  onDragStart: (evt: ReactPointerEvent<SVGSVGElement>) => void;
  onDragMove: (evt: ReactPointerEvent<SVGSVGElement>) => void;
  onDragEnd: (evt: ReactPointerEvent<SVGSVGElement>) => void;
  onFieldCommit: (v: number) => void;
}) {
  const meta = AXIS_META[axis];
  const thumbX = balanceToTrackX(value);
  const zeroX = balanceToTrackX(0);
  const fillX = Math.min(thumbX, zeroX);
  const fillW = Math.abs(thumbX - zeroX);
  const fillColor = value < 0 ? meta.leftHex : meta.rightHex;

  return (
    <div className="flex flex-col gap-0.5">
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
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <svg
            viewBox={`0 0 ${TRACK_VB_W} ${TRACK_VB_H}`}
            preserveAspectRatio="none"
            overflow="visible"
            className="w-full h-5 select-none overflow-visible touch-none cursor-ew-resize"
            role="slider"
            aria-label={`${meta.leftLabel}–${meta.rightLabel}`}
            aria-valuemin={BALANCE_MIN}
            aria-valuemax={BALANCE_MAX}
            aria-valuenow={value}
            onPointerDown={onDragStart}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            onPointerCancel={onDragEnd}
          >
            {/* Track baseline */}
            <rect
              x={0}
              y={TRACK_VB_H * 0.45}
              width={TRACK_VB_W}
              height={TRACK_VB_H * 0.1}
              fill="#71717a"
              fillOpacity={0.3}
              rx={1}
            />
            {/* Center marker (zero) */}
            <line
              x1={zeroX}
              y1={TRACK_VB_H * 0.2}
              x2={zeroX}
              y2={TRACK_VB_H * 0.8}
              stroke="#71717a"
              strokeOpacity={0.7}
              strokeWidth={0.75}
            />
            {/* Filled portion from center → thumb */}
            <rect
              x={fillX}
              y={TRACK_VB_H * 0.45}
              width={fillW}
              height={TRACK_VB_H * 0.1}
              fill={fillColor}
              fillOpacity={0.9}
              rx={1}
            />
            {/* Thumb */}
            <circle
              cx={thumbX}
              cy={TRACK_VB_H / 2}
              r={4}
              fill={fillColor}
              stroke="#f9fafb"
              strokeWidth={1}
              className="dark:hidden"
            />
            <circle
              cx={thumbX}
              cy={TRACK_VB_H / 2}
              r={4}
              fill={fillColor}
              stroke="#111827"
              strokeWidth={1}
              className="hidden dark:block"
            />
          </svg>
        </div>
        <div className="shrink-0">
          <NumberField
            value={value}
            min={BALANCE_MIN}
            max={BALANCE_MAX}
            step={BALANCE_STEP}
            precision={0}
            onCommit={onFieldCommit}
            ariaLabel={`${meta.leftLabel}–${meta.rightLabel} offset`}
          />
        </div>
      </div>
    </div>
  );
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

  // ─── Drag pipeline ────────────────────────────────────────────────────────

  const dragRef = useRef<BalanceAxis | null>(null);

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

  const beginDrag = useCallback(
    (axis: BalanceAxis, evt: ReactPointerEvent<SVGSVGElement>) => {
      if (!activeLayer) return;
      if (evt.button !== 0) return;
      dragRef.current = axis;
      gesture.begin();
      evt.currentTarget.setPointerCapture?.(evt.pointerId);
      const nextVal = pointerToBalance(evt, evt.currentTarget);
      commitValue(axis, nextVal);
    },
    [activeLayer, gesture, commitValue],
  );

  const handleDragMove = useCallback(
    (axis: BalanceAxis) =>
      (evt: ReactPointerEvent<SVGSVGElement>) => {
        if (dragRef.current !== axis) return;
        const nextVal = pointerToBalance(evt, evt.currentTarget);
        commitValue(axis, nextVal);
      },
    [commitValue],
  );

  const finishDrag = useCallback(
    (evt?: ReactPointerEvent<SVGSVGElement>) => {
      if (dragRef.current === null) return;
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

  // Cleanup on unmount mid-drag
  useEffect(() => {
    return () => {
      if (dragRef.current !== null) {
        dragRef.current = null;
        gesture.end();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        {([0, 1, 2] as BalanceAxis[]).map((axis) => (
          <BalanceSlider
            key={axis}
            axis={axis}
            value={currentTriple[axis]}
            onDragStart={(e) => beginDrag(axis, e)}
            onDragMove={handleDragMove(axis)}
            onDragEnd={finishDrag}
            onFieldCommit={commitNumeric(axis)}
          />
        ))}
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
