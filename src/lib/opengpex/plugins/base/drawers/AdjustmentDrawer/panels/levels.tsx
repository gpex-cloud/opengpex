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
 * LevelsPanel — Photoshop-style histogram + input/output/gamma editor.
 *
 * Interaction & data-flow (spec §5 & §6, mirrors CurvesPanel):
 *
 * - The histogram at the top of the panel is a Rec. 601 luminance count
 *   sampled from the active layer's decoded bitmap (see
 *   `useLayerHistogram()`). The stat is lazy: on layer switch we render an
 *   empty grid immediately and swap in the bars a frame or two later once
 *   the (256px-downsampled) sample completes. The bars share the SAME
 *   `x ∈ [0,255]` axis as the input track below them, so users can eyeball
 *   the blackpoint / whitepoint against real image data.
 *
 * - On top of the histogram we overlay the current levels-LUT curve, which
 *   is computed by the same `generateLevelsLUT` function the worker uses to
 *   bake the filter into pixels (`core/engine/filters/lut.ts`). Keeping the
 *   preview and the worker on ONE evaluator eliminates the "editor says one
 *   thing, canvas shows another" class of bugs.
 *
 * - Two horizontal tracks below the histogram carry the handles:
 *     - Input track: three triangular handles (blackpoint, gamma, whitepoint).
 *       These correspond directly to `levels.inputBlack / .gamma /
 *       .inputWhite`. Gamma is displayed on the input track's centre by
 *       Photoshop convention — dragging left/right pumps gamma < 1 or > 1
 *       and the visible position of the gamma triangle interpolates between
 *       `inputBlack` and `inputWhite` (see `gammaToTrackFraction` for the
 *       mapping).
 *     - Output track: two triangular handles (outputBlack, outputWhite) on
 *       a separate strip below.
 *
 * - Each handle uses `useFilterGesture(beginLevelsEditCmd)` for its
 *   pointerdown / pointermove / pointerup lifecycle — the same gesture
 *   pattern as the Curves panel. A drag = one Undo step; the checkpoint is
 *   the `beginLevelsEdit` command (empty body, undoable) and every
 *   intermediate `updateLevels` write during the drag is non-undoable so
 *   the whole gesture coalesces (spec §5.6).
 *
 * - A row of numeric inputs mirrors the handle positions. Typing a value
 *   also goes through a gesture (short-lived, begin → update → end)  so
 *   keyboard edits produce a single Undo step per commit.
 *
 * - "Auto" button reads the cached histogram, finds the 0.1 / 99.9
 *   percentiles (Photoshop convention), then dispatches `autoLevelsCmd`
 *   with the two computed inputBlack / inputWhite values. gamma/output are
 *   preserved — this matches user expectation that "Auto Levels" only
 *   affects contrast, not tint/brightness bias.
 *
 * - This panel does NOT dispatch to `AsyncFilterCache` or WorkerBridge.
 *   Writing to `layer.levels` triggers `Canvas2dEngine.drawLayerDirect()`
 *   on the next frame; that path is responsible for `resolveFilteredSource`
 *   dispatching the worker (spec §5.1 / §3.5 hard constraint).
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { generateLevelsLUT } from "@opengpex/editor/core/engine/filters/lut";
import { usePluginCommands } from "@opengpex/editor/core/context";
import type { LevelsState } from "@opengpex/editor/core/types/models";
import type { AdjustmentDrawerCommandsMap } from "../commands.d";
import { DEFAULT_LEVELS_STATE } from "../protocols";
import { NumberField } from "../components";
import {
  useAdjustmentDrawer,
  useFilterGesture,
  useLayerHistogram,
} from "../hooks";

// ─── Constants ─────────────────────────────────────────────────────────────────

/**
 * SVG viewBox width for the histogram + curve overlay. We chose 256 to line up
 * the histogram's 256 bins 1:1 with pixels in the coordinate system — a bin at
 * intensity 128 renders exactly at `x=128` without any fractional maths. Height
 * is smaller because the panel is narrow — we care about relative shape more
 * than absolute counts.
 */
const GRAPH_VB_W = 256;
const GRAPH_VB_H = 100;

/** Number of subdivisions of the levels LUT we sample for the overlay curve. */
const LUT_PREVIEW_SAMPLES = 64;

/** Handle height in track viewBox units. Tracks are drawn at 24-unit tall SVG. */
const TRACK_VB_H = 24;

/** Which handle is currently being dragged. `null` means idle. */
type DragTarget =
  | { kind: "inputBlack" }
  | { kind: "gamma" }
  | { kind: "inputWhite" }
  | { kind: "outputBlack" }
  | { kind: "outputWhite" };

// ─── Utilities ─────────────────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/**
 * Read the current levels state, falling back to identity defaults. We return
 * a fresh copy every call (mutating the layer's state directly would defeat
 * React's referential-equality checks).
 */
function readLevels(current: LevelsState | undefined): LevelsState {
  return { ...DEFAULT_LEVELS_STATE, ...(current ?? {}) };
}

/**
 * Map gamma ∈ [0.1, 10] to a fraction ∈ [0, 1] along the input track between
 * `inputBlack` and `inputWhite`. Photoshop uses a log2 scale so gamma=1
 * lands exactly at the midpoint — we replicate this.
 *
 *   gamma = 1.0  → 0.5  (midpoint)
 *   gamma = 0.1  → 0.0  (leftmost, near black)
 *   gamma = 10   → 1.0  (rightmost, near white)
 *
 * Concretely:  fraction = 0.5 * (1 - log2(gamma) / log2(9.99))
 * (`9.99` because gamma range is [1/9.99, 9.99] symmetric around 1.0).
 */
const GAMMA_LOG_RANGE = Math.log2(9.99); // ≈ 3.32

function gammaToTrackFraction(gamma: number): number {
  const clamped = clamp(gamma, 0.1, 10);
  return 0.5 - (Math.log2(clamped) / GAMMA_LOG_RANGE) * 0.5;
}

function trackFractionToGamma(f: number): number {
  const clamped = clamp(f, 0, 1);
  const exp = ((0.5 - clamped) / 0.5) * GAMMA_LOG_RANGE;
  return clamp(Math.pow(2, exp), 0.1, 10);
}

/**
 * Convert a horizontal pointer coordinate to an intensity value in [0, 255].
 * The track's SVG occupies `viewBox="0 0 256 24"`, so we scale by the DOM
 * rect and clamp — same maths as the Curves panel's `eventToVB`.
 */
function pointerToIntensity(evt: { clientX: number }, el: Element): number {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0) return 0;
  const raw = ((evt.clientX - rect.left) / rect.width) * 255;
  return clamp(Math.round(raw), 0, 255);
}


// ─── Histogram helpers ────────────────────────────────────────────────────────

/**
 * Build the SVG polyline `d` for the histogram bars. We normalize by the
 * MAX-of-non-endpoint-bins so a single spike at 0 or 255 (very common on
 * masked or clipped layers) doesn't crush the rest of the graph into
 * invisibility. The endpoints are then re-scaled independently so they
 * still show up as bars, but capped at graph height.
 */
function histogramToPathD(
  hist: Uint32Array | null,
  vbW: number,
  vbH: number,
): string {
  if (!hist || hist.length === 0) return "";
  // Ignore the two extreme bins when finding the display maximum so a common
  // "all-zero-alpha corners" spike doesn't dominate. We still draw them,
  // just clamped to the height ceiling.
  let interiorMax = 0;
  for (let i = 1; i < hist.length - 1; i++) {
    if (hist[i] > interiorMax) interiorMax = hist[i];
  }
  if (interiorMax === 0) {
    // Nothing interior — fall back to the true max so single-value images
    // still render *something*.
    for (let i = 0; i < hist.length; i++) {
      if (hist[i] > interiorMax) interiorMax = hist[i];
    }
  }
  if (interiorMax === 0) return "";

  // We render as a filled polygon (baseline → bars → baseline) which reads
  // better than 256 individual `<rect>`s and stays cheap to diff.
  const parts: string[] = [`M 0 ${vbH}`];
  const step = vbW / hist.length;
  for (let i = 0; i < hist.length; i++) {
    const h = Math.min(vbH, (hist[i] / interiorMax) * vbH);
    const x = i * step;
    parts.push(`L ${x.toFixed(2)} ${(vbH - h).toFixed(2)}`);
    parts.push(`L ${(x + step).toFixed(2)} ${(vbH - h).toFixed(2)}`);
  }
  parts.push(`L ${vbW} ${vbH} Z`);
  return parts.join(" ");
}

/**
 * Compute inputBlack/inputWhite from a luminance histogram at the given
 * percentile split (Photoshop uses 0.1% / 99.9% ≈ black/white clip).
 * Returns null if the histogram is empty (all-transparent layer).
 */
function percentileFromHistogram(
  hist: Uint32Array,
  lowPct: number,
  highPct: number,
): { inputBlack: number; inputWhite: number } | null {
  let total = 0;
  for (let i = 0; i < hist.length; i++) total += hist[i];
  if (total === 0) return null;
  const lowTarget = total * lowPct;
  const highTarget = total * highPct;
  let acc = 0;
  let inputBlack = 0;
  let inputWhite = 255;
  let foundLow = false;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (!foundLow && acc >= lowTarget) {
      inputBlack = i;
      foundLow = true;
    }
    if (acc >= highTarget) {
      inputWhite = i;
      break;
    }
  }
  // Preserve at least a minimum span so autoLevels can't crush contrast to
  // zero on a nearly-monochrome layer.
  if (inputWhite <= inputBlack + 1) {
    inputWhite = clamp(inputBlack + 2, 0, 255);
  }
  return { inputBlack, inputWhite };
}

/**
 * Sample the levels LUT into an SVG polyline path so users see how the
 * current input/gamma/output settings remap intensity. Because we use the
 * same `generateLevelsLUT` the worker uses, this line is a preview of the
 * final filter output — no drift between UI and render.
 */
function levelsLutToPathD(
  levels: LevelsState,
  vbW: number,
  vbH: number,
): string {
  const lut = generateLevelsLUT(levels, 256 as const, "f32") as Float32Array;
  const step = (lut.length - 1) / (LUT_PREVIEW_SAMPLES - 1);
  const parts: string[] = [];
  for (let i = 0; i < LUT_PREVIEW_SAMPLES; i++) {
    const li = Math.round(i * step);
    const x = (li / (lut.length - 1)) * vbW;
    // lut[li] ∈ [0,1] where 1 = white. SVG y grows downward, so invert.
    const y = (1 - lut[li]) * vbH;
    parts.push(`${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return parts.join(" ");
}

// ─── Handle SVG ────────────────────────────────────────────────────────────────

/**
 * Renders a Photoshop-style triangular handle. `fill` toggles between the
 * three semantic colors: black for shadow, gray for gamma midtone, white
 * for highlight. Stroke keeps a visible outline on both themes.
 */
function TriangleHandle({
  cx,
  vbH,
  fill,
  strokeLight,
  strokeDark,
  onPointerDown,
  role,
  ariaLabel,
}: {
  cx: number;
  vbH: number;
  fill: string;
  strokeLight: string;
  strokeDark: string;
  onPointerDown: (e: ReactPointerEvent<SVGGElement>) => void;
  role: string;
  ariaLabel: string;
}) {
  // Triangle: apex at the top of the track pointing up, wide base 6 units wide.
  // The apex touches y=0 (the track's top edge) so the handle "hangs" from
  // the top; this mirrors Photoshop's convention for the input track.
  const half = 5;
  const apexY = 0;
  const baseY = vbH * 0.75;
  const path = `M ${cx} ${apexY} L ${cx - half} ${baseY} L ${cx + half} ${baseY} Z`;
  return (
    <g
      className="cursor-ew-resize touch-none"
      onPointerDown={onPointerDown}
      role={role}
      aria-label={ariaLabel}
      // Larger invisible hit area so the ~10px triangle is easy to grab.
      style={{ pointerEvents: "auto" }}
    >
      <rect
        x={cx - half - 2}
        y={apexY - 2}
        width={half * 2 + 4}
        height={baseY + 4}
        fill="transparent"
      />
      {/* Two paths for theme-aware stroke — same idiom used in curves.tsx. */}
      <path d={path} fill={fill} stroke={strokeLight} strokeWidth={1} className="dark:hidden" />
      <path d={path} fill={fill} stroke={strokeDark} strokeWidth={1} className="hidden dark:block" />
    </g>
  );
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function LevelsPanel() {
  const {
    beginLevelsEditCmd,
    updateLevelsCmd,
    autoLevelsCmd,
  } = usePluginCommands<AdjustmentDrawerCommandsMap>();
  const { activeLayer } = useAdjustmentDrawer();
  const { luminance: histogram, loading: histLoading } = useLayerHistogram();
  const gesture = useFilterGesture(beginLevelsEditCmd);

  const levels = useMemo(() => readLevels(activeLayer?.levels), [activeLayer?.levels]);

  const dragRef = useRef<DragTarget | null>(null);
  const graphRef = useRef<SVGSVGElement | null>(null);
  const inputTrackRef = useRef<SVGSVGElement | null>(null);
  const outputTrackRef = useRef<SVGSVGElement | null>(null);

  // ── Derived positions ───────────────────────────────────────────────────────

  const histogramPath = useMemo(
    () => histogramToPathD(histogram, GRAPH_VB_W, GRAPH_VB_H),
    [histogram],
  );
  const lutPath = useMemo(
    () => levelsLutToPathD(levels, GRAPH_VB_W, GRAPH_VB_H),
    [levels],
  );

  const gammaFraction = gammaToTrackFraction(levels.gamma);
  // Map gamma fraction ∈ [0,1] back onto the [inputBlack, inputWhite] span so
  // the triangle visually sits at the tonal midpoint between the two anchors.
  const gammaX = levels.inputBlack + gammaFraction * (levels.inputWhite - levels.inputBlack);

  // ── Commit helpers (wrap gesture + updateLevels) ────────────────────────────

  const patchLevels = useCallback(
    (patch: Partial<LevelsState>) => {
      updateLevelsCmd?.execute({ patch });
    },
    [updateLevelsCmd],
  );

  /**
   * Wrap a single atomic mutation (numeric input commit or Auto button) in a
   * short gesture so it becomes exactly one Undo entry. Note: Auto uses its
   * own dedicated `autoLevelsCmd` (undoable) — the gesture wrapper is only
   * for keyboard commits + click-based autoLevels re-runs.
   */
  const commitAtomic = useCallback(
    (fn: () => void) => {
      gesture.begin();
      fn();
      gesture.end();
    },
    [gesture],
  );

  // ── Handle drag pipeline ────────────────────────────────────────────────────

  const beginDrag = useCallback(
    (target: DragTarget, evt: ReactPointerEvent<SVGGElement | SVGSVGElement>) => {
      if (!activeLayer) return;
      // Left-click only. Right-click has no meaning on a triangle handle.
      if ((evt as ReactPointerEvent<SVGGElement>).button !== 0) return;
      dragRef.current = target;
      gesture.begin();
      (evt.currentTarget as Element & { setPointerCapture?: (id: number) => void }).setPointerCapture?.(
        evt.pointerId,
      );
    },
    [activeLayer, gesture],
  );

  const finishDrag = useCallback(
    (evt?: ReactPointerEvent<SVGSVGElement | SVGGElement>) => {
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

  /**
   * pointermove on the input track handles the three input handles: black,
   * gamma, white. We look up which handle we're dragging via `dragRef` and
   * translate the pointer to the appropriate levels field.
   */
  const handleInputPointerMove = useCallback(
    (evt: ReactPointerEvent<SVGSVGElement>) => {
      const target = dragRef.current;
      if (!target || !inputTrackRef.current) return;
      if (target.kind === "gamma") {
        // The gamma handle's visible x is between inputBlack and inputWhite.
        // We need to recover a fraction within [inputBlack, inputWhite], not
        // the raw 0..255 track — otherwise dragging the gamma handle also
        // moves the visible black/white anchors (bad).
        const rawX = pointerToIntensity(evt, inputTrackRef.current);
        const span = levels.inputWhite - levels.inputBlack;
        // Degenerate span (user pulled black past white via keyboard):
        // fall back to a fixed midpoint fraction so gamma still responds.
        const frac = span > 0 ? clamp((rawX - levels.inputBlack) / span, 0, 1) : 0.5;
        patchLevels({ gamma: trackFractionToGamma(frac) });
        return;
      }
      const nextV = pointerToIntensity(evt, inputTrackRef.current);
      if (target.kind === "inputBlack") {
        // Enforce inputBlack < inputWhite (min 1-unit gap keeps the tonal
        // range from collapsing and generating a degenerate LUT branch).
        patchLevels({ inputBlack: Math.min(nextV, levels.inputWhite - 1) });
      } else if (target.kind === "inputWhite") {
        patchLevels({ inputWhite: Math.max(nextV, levels.inputBlack + 1) });
      }
    },
    [levels, patchLevels],
  );

  /**
   * pointermove on the output track handles outputBlack / outputWhite.
   * Photoshop allows outputBlack > outputWhite (inverts the image!); we
   * follow suit — the LUT evaluator already handles both orderings, so no
   * clamp against each other is needed here.
   */
  const handleOutputPointerMove = useCallback(
    (evt: ReactPointerEvent<SVGSVGElement>) => {
      const target = dragRef.current;
      if (!target || !outputTrackRef.current) return;
      const nextV = pointerToIntensity(evt, outputTrackRef.current);
      if (target.kind === "outputBlack") {
        patchLevels({ outputBlack: nextV });
      } else if (target.kind === "outputWhite") {
        patchLevels({ outputWhite: nextV });
      }
    },
    [patchLevels],
  );

  /**
   * Clicking on empty track area jumps the nearest matching handle to the
   * click position and starts a drag from there — a Photoshop convenience.
   * We compute which handle is closer in raw distance along the axis.
   */
  const handleInputTrackPointerDown = useCallback(
    (evt: ReactPointerEvent<SVGSVGElement>) => {
      if (!inputTrackRef.current || !activeLayer) return;
      if (evt.button !== 0) return;
      // Don't consume — if the pointerdown originated on a handle <g>, the
      // React event bubbling would still fire this. We check the drag target
      // in case a handle already claimed the gesture.
      if (dragRef.current) return;
      const raw = pointerToIntensity(evt, inputTrackRef.current);
      // Distances to each anchor. Gamma is derived so we use its visible x.
      const dB = Math.abs(raw - levels.inputBlack);
      const dG = Math.abs(raw - gammaX);
      const dW = Math.abs(raw - levels.inputWhite);
      let kind: DragTarget["kind"] = "inputBlack";
      if (dW <= dB && dW <= dG) kind = "inputWhite";
      else if (dG <= dB && dG <= dW) kind = "gamma";
      beginDrag({ kind } as DragTarget, evt);
      // Also jump the handle to the click point so drag starts responsive.
      if (kind === "inputBlack") {
        patchLevels({ inputBlack: Math.min(raw, levels.inputWhite - 1) });
      } else if (kind === "inputWhite") {
        patchLevels({ inputWhite: Math.max(raw, levels.inputBlack + 1) });
      } else if (kind === "gamma") {
        const span = levels.inputWhite - levels.inputBlack;
        const frac = span > 0 ? clamp((raw - levels.inputBlack) / span, 0, 1) : 0.5;
        patchLevels({ gamma: trackFractionToGamma(frac) });
      }
    },
    [activeLayer, levels, gammaX, beginDrag, patchLevels],
  );

  const handleOutputTrackPointerDown = useCallback(
    (evt: ReactPointerEvent<SVGSVGElement>) => {
      if (!outputTrackRef.current || !activeLayer) return;
      if (evt.button !== 0) return;
      if (dragRef.current) return;
      const raw = pointerToIntensity(evt, outputTrackRef.current);
      const dB = Math.abs(raw - levels.outputBlack);
      const dW = Math.abs(raw - levels.outputWhite);
      const kind: DragTarget["kind"] = dB <= dW ? "outputBlack" : "outputWhite";
      beginDrag({ kind } as DragTarget, evt);
      if (kind === "outputBlack") patchLevels({ outputBlack: raw });
      else patchLevels({ outputWhite: raw });
    },
    [activeLayer, levels, beginDrag, patchLevels],
  );

  // ── Auto Levels ─────────────────────────────────────────────────────────────

  const autoLevelsAvailable = !!histogram && !histLoading && !!activeLayer;

  const handleAutoLevels = useCallback(() => {
    if (!histogram) return;
    // Photoshop's Auto Levels defaults are 0.1% / 99.9% — leaves the extreme
    // outliers alone so a single bright specular or a pinpoint of pure black
    // doesn't blow the whole tonal range.
    const pct = percentileFromHistogram(histogram, 0.001, 0.999);
    if (!pct) return;
    autoLevelsCmd?.execute(pct);
  }, [histogram, autoLevelsCmd]);

  // ── Position helpers for track SVG ──────────────────────────────────────────

  // Track viewBox is [0..255, 0..24]. Fraction * 255 → x. Note: pointer maths
  // clamps to 0..255 integer, so triangle apex sits neatly on a bin edge.
  const posBlackX = levels.inputBlack;
  const posWhiteX = levels.inputWhite;
  const posOutBlackX = levels.outputBlack;
  const posOutWhiteX = levels.outputWhite;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    // Same "no outer card" pattern as CurvesPanel — parent drawer supplies
    // the surface. Padding lives on the drawer.
    <div className="flex flex-col gap-2">
      {/* Auto row: tiny button aligned to the right. Placing it above the graph
          rather than beside it keeps the graph full-width. */}
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-black tracking-widest uppercase text-[var(--text-muted)]">
          Levels
        </span>
        <button
          type="button"
          disabled={!autoLevelsAvailable}
          onClick={handleAutoLevels}
          title="Auto-set blackpoint / whitepoint from image histogram"
          className={`text-[9px] font-black tracking-widest uppercase px-2 py-0.5 rounded-md border transition-colors ${
            autoLevelsAvailable
              ? "border-zinc-200 dark:border-white/10 hover:bg-zinc-100 dark:hover:bg-white/5 text-[var(--text-main)]"
              : "border-transparent text-[var(--text-muted)] cursor-not-allowed"
          }`}
        >
          Auto
        </button>
      </div>

      {/* Histogram + curve overlay. */}
      <svg
        ref={graphRef}
        viewBox={`0 0 ${GRAPH_VB_W} ${GRAPH_VB_H}`}
        className="w-full h-24 rounded-md bg-zinc-50 dark:bg-zinc-900/70 border border-zinc-200 dark:border-white/10"
        role="img"
        aria-label="Luminance histogram with levels curve overlay"
        preserveAspectRatio="none"
      >
        {/* Grid guides at 0.25/0.5/0.75 — same idiom as CurvesPanel. */}
        <g className="dark:hidden">
          {[0.25, 0.5, 0.75].map((t) => (
            <line
              key={`lg-${t}`}
              x1={t * GRAPH_VB_W}
              y1={0}
              x2={t * GRAPH_VB_W}
              y2={GRAPH_VB_H}
              stroke="#a1a1aa"
              strokeOpacity={0.35}
              strokeWidth={0.5}
            />
          ))}
        </g>
        <g className="hidden dark:block">
          {[0.25, 0.5, 0.75].map((t) => (
            <line
              key={`dg-${t}`}
              x1={t * GRAPH_VB_W}
              y1={0}
              x2={t * GRAPH_VB_W}
              y2={GRAPH_VB_H}
              stroke="#ffffff"
              strokeOpacity={0.14}
              strokeWidth={0.5}
            />
          ))}
        </g>

        {/* Histogram — theme-tinted fill, no stroke (bars would double-draw). */}
        {histogramPath ? (
          <>
            <path
              d={histogramPath}
              fill="#71717a"
              fillOpacity={0.55}
              className="dark:hidden"
            />
            <path
              d={histogramPath}
              fill="#d4d4d8"
              fillOpacity={0.55}
              className="hidden dark:block"
            />
          </>
        ) : histLoading ? (
          <text
            x={GRAPH_VB_W / 2}
            y={GRAPH_VB_H / 2}
            textAnchor="middle"
            fontSize="10"
            fill="var(--text-muted)"
          >
            Sampling histogram…
          </text>
        ) : null}

        {/* Levels LUT overlay — same evaluator the worker uses. */}
        <path
          d={lutPath}
          fill="none"
          stroke="#3b82f6"
          strokeWidth={1.2}
          strokeLinejoin="round"
          strokeLinecap="round"
          opacity={0.9}
        />

        {/* Vertical guides showing blackpoint / whitepoint on the histogram. */}
        <line
          x1={posBlackX}
          y1={0}
          x2={posBlackX}
          y2={GRAPH_VB_H}
          stroke="#000"
          strokeOpacity={0.45}
          strokeWidth={0.75}
        />
        <line
          x1={posWhiteX}
          y1={0}
          x2={posWhiteX}
          y2={GRAPH_VB_H}
          stroke="#fff"
          strokeOpacity={0.9}
          strokeWidth={0.75}
        />
      </svg>

      {/* Input track. `viewBox` is 256×24; we lay handles absolutely by x. */}
      {/* Wrapper adds horizontal padding so the triangle handles at the
          extremes (x=0 / x=255) have room to render their full base without
          clipping. The SVG itself keeps `viewBox=0 0 256 24` — this preserves
          pointer→intensity math (which uses `evt.clientX - rect.left`
          normalized to the SVG's DOM rect). We rely on `overflow="visible"`
          so children can draw outside the viewBox extents into that padding. */}
      <div className="flex flex-col gap-0.5 px-1.5">
        <svg
          ref={inputTrackRef}
          viewBox={`0 0 256 ${TRACK_VB_H}`}
          preserveAspectRatio="none"
          overflow="visible"
          className="w-full h-5 touch-none select-none overflow-visible"
          role="group"
          aria-label="Input levels controls"
          onPointerDown={handleInputTrackPointerDown}
          onPointerMove={handleInputPointerMove}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
        >

          {/* Track background: gradient from black to white (matches
              Photoshop). Two <linearGradient> defs so the theme stays neutral. */}
          <defs>
            <linearGradient id="cg-levels-input-track" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#000" />
              <stop offset="100%" stopColor="#fff" />
            </linearGradient>
          </defs>
          <rect
            x={0}
            y={2}
            width={256}
            height={TRACK_VB_H * 0.45}
            fill="url(#cg-levels-input-track)"
            stroke="#71717a"
            strokeOpacity={0.35}
            strokeWidth={0.5}
            rx={1}
          />
          {/* Handle stroke convention: black handles get a WHITE outline in
              both themes, white handles get a BLACK outline in both themes.
              Reasoning: the track gradient goes black → white beneath the
              handles, so a black triangle with a black stroke would visually
              vanish where it lands on the gradient's black end (x=0). Photoshop
              follows the same "always inverse-outlined" rule for exactly this
              reason. Grey (gamma) handle gets a mid-tone outline. */}
          <TriangleHandle
            cx={posBlackX}
            vbH={TRACK_VB_H}
            fill="#111827"
            strokeLight="#f9fafb"
            strokeDark="#f9fafb"
            onPointerDown={(e) => beginDrag({ kind: "inputBlack" }, e)}
            role="slider"
            ariaLabel={`Input blackpoint at ${levels.inputBlack}`}
          />
          <TriangleHandle
            cx={gammaX}
            vbH={TRACK_VB_H}
            fill="#9ca3af"
            strokeLight="#111827"
            strokeDark="#f9fafb"
            onPointerDown={(e) => beginDrag({ kind: "gamma" }, e)}
            role="slider"
            ariaLabel={`Gamma at ${levels.gamma.toFixed(2)}`}
          />
          <TriangleHandle
            cx={posWhiteX}
            vbH={TRACK_VB_H}
            fill="#f9fafb"
            strokeLight="#111827"
            strokeDark="#111827"
            onPointerDown={(e) => beginDrag({ kind: "inputWhite" }, e)}
            role="slider"
            ariaLabel={`Input whitepoint at ${levels.inputWhite}`}
          />

        </svg>
      </div>

      {/* Numeric readouts for input row. Uses the shared `NumberField`
          (see `../components.tsx`); each commit is one mini-gesture, matching
          drag ergonomics — a user can't tell whether they tweaked shadows by
          dragging the triangle or typing "10", both cost the same undo slot. */}
      <div className="flex items-stretch gap-1">
        <NumberField
          label="Black"
          ariaLabel="Input blackpoint value"
          value={levels.inputBlack}
          min={0}
          max={254}
          step={1}
          precision={0}
          onCommit={(v) =>
            commitAtomic(() =>
              patchLevels({
                inputBlack: Math.min(Math.round(v), levels.inputWhite - 1),
              }),
            )
          }
        />
        <NumberField
          label="Gamma"
          ariaLabel="Gamma value"
          value={levels.gamma}
          min={0.1}
          max={10}
          step={0.01}
          precision={2}
          onCommit={(v) => commitAtomic(() => patchLevels({ gamma: v }))}
        />
        <NumberField
          label="White"
          ariaLabel="Input whitepoint value"
          value={levels.inputWhite}
          min={1}
          max={255}
          step={1}
          precision={0}
          onCommit={(v) =>
            commitAtomic(() =>
              patchLevels({
                inputWhite: Math.max(Math.round(v), levels.inputBlack + 1),
              }),
            )
          }
        />
      </div>

      {/* Output track. Same padding + overflow-visible strategy as the input
          track so the extreme handles (x=0 / x=255) render fully. */}
      <div className="px-1.5 mt-1">
      <svg
        ref={outputTrackRef}
        viewBox={`0 0 256 ${TRACK_VB_H}`}
        preserveAspectRatio="none"
        overflow="visible"
        className="w-full h-5 touch-none select-none overflow-visible"
        role="group"
        aria-label="Output levels controls"
        onPointerDown={handleOutputTrackPointerDown}
        onPointerMove={handleOutputPointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
      >

        <defs>
          <linearGradient id="cg-levels-output-track" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#000" />
            <stop offset="100%" stopColor="#fff" />
          </linearGradient>
        </defs>
        <rect
          x={0}
          y={2}
          width={256}
          height={TRACK_VB_H * 0.45}
          fill="url(#cg-levels-output-track)"
          stroke="#71717a"
          strokeOpacity={0.35}
          strokeWidth={0.5}
          rx={1}
        />
        {/* Same inverse-outline rule as the input track — see comment above. */}
        <TriangleHandle
          cx={posOutBlackX}
          vbH={TRACK_VB_H}
          fill="#111827"
          strokeLight="#f9fafb"
          strokeDark="#f9fafb"
          onPointerDown={(e) => beginDrag({ kind: "outputBlack" }, e)}
          role="slider"
          ariaLabel={`Output blackpoint at ${levels.outputBlack}`}
        />
        <TriangleHandle
          cx={posOutWhiteX}
          vbH={TRACK_VB_H}
          fill="#f9fafb"
          strokeLight="#111827"
          strokeDark="#111827"
          onPointerDown={(e) => beginDrag({ kind: "outputWhite" }, e)}
          role="slider"
          ariaLabel={`Output whitepoint at ${levels.outputWhite}`}
        />

      </svg>
      </div>

      {/* Numeric readouts for output row. */}

      <div className="flex items-stretch gap-1">
        <NumberField
          label="Out Black"
          ariaLabel="Output blackpoint value"
          value={levels.outputBlack}
          min={0}
          max={255}
          step={1}
          precision={0}
          onCommit={(v) => commitAtomic(() => patchLevels({ outputBlack: Math.round(v) }))}
        />
        <NumberField
          label="Out White"
          ariaLabel="Output whitepoint value"
          value={levels.outputWhite}
          min={0}
          max={255}
          step={1}
          precision={0}
          onCommit={(v) => commitAtomic(() => patchLevels({ outputWhite: Math.round(v) }))}
        />
      </div>

      {/* Helper caption. Kept short so the panel doesn't grow taller on a
          narrow sidebar. */}
      <div className="flex items-center justify-between text-[9px] text-[var(--text-muted)] tracking-tight mt-0.5">
        <span>Drag triangles · type to fine-tune · Auto clips 0.1 / 99.9%</span>
      </div>
    </div>
  );
}
