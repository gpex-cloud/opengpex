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
 * CurvesPanel — SVG-based tone-curve editor.
 *
 * Pure geometry (coordinate mapping, hit-testing, point constraints, spline
 * preview) lives in `./geometry`; shared cross-panel helpers (histogram
 * path, clamps) in `../helpers`. This file is the interaction/render
 * orchestrator.
 *
 * Design:
 *
 * - Users can drag existing control points, add new ones by clicking on the
 *   empty grid, and remove interior points by right-clicking them. The
 *   endpoints at x=0 and x=1 are always present and non-removable — they
 *   anchor the mapping domain. (An earlier iteration used double-click for
 *   removal but the `dblclick` event doesn't fire reliably once we take
 *   pointer capture on `pointerdown`, so we standardized on right-click.)
 *
 * - The curve preview uses the SAME Fritsch-Carlson monotonic cubic-spline
 *   evaluator that powers the runtime LUT (`core/engine/color/luts.ts`),
 *   sampled at ~64 subdivisions for the SVG path. This means the preview
 *   line the user sees is byte-identical to the tone curve the GPU samples
 *   from the resident 1D LUT texture — no visual drift between
 *   "editor preview" and "rendered result".
 *
 * - Editing is decoupled into three phases (gesture coalescing):
 *     1. pointerdown → `useFilterGesture.begin()` fires the undoable checkpoint
 *        (`beginCurvesEdit`) which snapshots layer state into TimeTravel.
 *     2. pointermove → non-undoable `updateChannelCurve` writes accumulate on
 *        `layer.curves.<channel>`. Because the checkpoint captured the
 *        pre-drag state, all intermediate writes coalesce into a single Undo
 *        step.
 *     3. pointerup → `useFilterGesture.end()` marks the drag complete. The
 *        final layer state is already durable; nothing to commit.
 *
 * - Histogram background (grid → histogram → curve, painted back-to-front):
 *   the layer's SOURCE histograms are computed once per bitmap in the Worker
 *   (`useLayerHistogram()`), then scattered through the SAME levels→curves
 *   LUT chain the GPU applies (`deriveLayerHistogram`) on every frame — so
 *   the background deforms live while dragging control points, which is the
 *   core PS Curves feedback loop. Tint follows the active channel tab via the
 *   CHANNEL_TABS brand hex (rgb → theme gray); each histogram layer is
 *   `pointer-events: none` so it never interferes with point hit-testing.
 *
 * - Graph geometry is 256×192 (4:3, PS-like) — X stays 1:1 with the histogram
 *   bins and the CSS aspect matches the viewBox ratio so the render scale is
 *   uniform (circles stay round). The selected control point gets PS-style
 *   In/Out numeric fields (0–255, editable, one Undo per commit) below the
 *   graph; endpoints are x-pinned by `movePointConstrained` exactly as when
 *   dragging. The row is always on screen — with no point selected both
 *   fields sit disabled at "-". Reset / undo / preset / layer switch clear
 *   the selection (see `selection` below) so the fields never show stale
 *   values.
 *
 * - This panel does NOT dispatch to `AsyncFilterCache` or the engine worker —
 *   that's the render engine's job. We only
 *   mutate `layer.curves`; the render loop picks up the change on its next
 *   frame and, on cache-miss, the engine
 *   schedules the worker job. Kept the strict "UI ↔ state" boundary.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { deriveLayerHistogram } from "@opengpex/editor/core/engine/color";
import { usePluginCommands } from "@opengpex/editor/core/context";
import type { CurvesState } from "@opengpex/editor/core/types/models";
import type { AdjustmentDrawerCommandsMap } from "../../commands.d";
import type { CurveChannel } from "../../protocols";
import { NumberField } from "../../components";
import {
  curveToPathD,
  findHitIndex,
  insertLocalPreview,
  movePointConstrained,
  normalizedToSvg,
  readPointsFor,
  svgToNormalized,
  VB_H,
  VB_W,
} from "./geometry";
import { clamp01, histogramToPathD } from "../helpers";
import {
  useAdjustmentDrawer,
  useFilterGesture,
  useLayerHistogram,
} from "../../hooks";

// ─── Constants ─────────────────────────────────────────────────────────────────

/**
 * Per-channel visual metadata.
 *
 * - `strokeLight` / `strokeDark`: theme-specific SVG stroke for the drawn
 *   curve. RGB uses zinc-500 in light and zinc-300 in dark — this reads
 *   clearly against both surfaces without shouting "text foreground"
 *   (currentColor was too dark on light, too bright/harsh on dark).
 *   Per-channel curves use the same brand hex on both themes because those
 *   colors already have enough saturation to survive on either surface.
 * - `hex` is the label tint used in the compact tab strip; RGB uses `null`
 *   which the selector falls back to `text-main` for the active state and
 *   `text-muted` when inactive.
 */
const CHANNEL_TABS: {
  channel: CurveChannel;
  label: string;
  /** SVG stroke in light theme (hex). */
  strokeLight: string;
  /** SVG stroke in dark theme (hex). */
  strokeDark: string;
  /** Label tint in the tab strip; `null` = adopt drawer foreground. */
  hex: string | null;
}[] = [
  // RGB: mid-gray on light (zinc-500 = #71717a), light-gray on dark (zinc-300
  // = #d4d4d8). Both keep visible contrast against the graph background
  // without being pure black/white.
  { channel: "rgb", label: "RGB", strokeLight: "#71717a", strokeDark: "#d4d4d8", hex: null },
  { channel: "red", label: "R", strokeLight: "#ef4444", strokeDark: "#ef4444", hex: "#ef4444" },
  { channel: "green", label: "G", strokeLight: "#22c55e", strokeDark: "#22c55e", hex: "#22c55e" },
  { channel: "blue", label: "B", strokeLight: "#3b82f6", strokeDark: "#3b82f6", hex: "#3b82f6" },
];

/**
 * Selection anchor state. `curves` holds the `layer.curves` OBJECT the point
 * was selected against; the panel is the single authority for what that
 * object is after its own writes — but a command handler can't observe the
 * fresh object its `execute` created (the store isn't synchronously readable
 * from here), so authored writes park the anchor at `null` ("pending") and
 * the NEXT render binds it to the `curves` it came with (guarded render-phase
 * state adjustment, the pattern React documents for derived state). Any
 * curves REFERENCE change the panel didn't author — Reset button, undo /
 * redo, preset, layer switch — then fails the binding and drops the
 * selection, so the In/Out fields fall back to "-" instead of showing stale
 * values (e.g. 255/255 for an endpoint after Reset).
 */
interface SelectionAnchor {
  index: number;
  /** Bound `layer.curves` reference; `null` = pending bind after an authored write. */
  curves: CurvesState | undefined | null;
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function CurvesPanel() {
  const {
    beginCurvesEditCmd,
    updateChannelCurveCmd,
    addCurvePointCmd,
    removeCurvePointCmd,
  } = usePluginCommands<AdjustmentDrawerCommandsMap>();
  const { activeLayer } = useAdjustmentDrawer();
  const gesture = useFilterGesture(beginCurvesEditCmd);
  const { histogram: srcHistogram } = useLayerHistogram();

  /**
   * The channel selector is a UI-only concern: which curve the user is
   * currently editing. We deliberately keep it local (React state) instead of
   * a plugin signal because no other plugin needs to observe it — a future
   * "quick red-curve toggle" in ColorOptions could promote this to a signal
   * later without breaking the panel.
   */
  const [channel, setChannel] = useState<CurveChannel>("rgb");

  /**
   * Currently selected control point (PS Curves parity): its In/Out values
   * are shown as editable number fields below the graph. See `SelectionAnchor`
   * for how the anchor survives authored writes but dies on reset / undo.
   */
  const [selectionState, setSelection] = useState<SelectionAnchor | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  /**
   * Which control point is being dragged. `-1` means "no drag in progress".
   * We keep this in a ref (not state) to avoid re-rendering the SVG on every
   * pointermove — the actual re-render is driven by the layer state change
   * that `updateChannelCurve` triggers, which is the source of truth anyway.
   */
  const dragIndexRef = useRef<number>(-1);

  const points = useMemo(
    () => readPointsFor(activeLayer?.curves, channel),
    [activeLayer?.curves, channel],
  );

  const pathD = useMemo(() => curveToPathD(points), [points]);

  // ── Selection binding & external-write invalidation ─────────────────────────
  // Conditional render-phase state adjustment (guarded, own-component only —
  // the React-documented pattern). Two cases:
  //   pending anchor (authored write) → bind to this render's curves object;
  //   bound anchor that no longer matches (or index out of range) → drop it.
  const curvesNow = activeLayer?.curves;
  let selection = selectionState;
  if (selection && selection.curves === null) {
    selection = { ...selection, curves: curvesNow };
    setSelection(selection);
  } else if (
    selection &&
    (selection.index >= points.length || selection.curves !== curvesNow)
  ) {
    setSelection(null);
    selection = null;
  }
  const selected: number | null = selection?.index ?? null;
  const selectedPoint = selected !== null ? points[selected] : null;

  // Histogram background, derived through the SAME levels+curves chain the
  // GPU applies (deps must include levels AND curves — dropping either would
  // freeze the background while the canvas moves).
  const derivedHistogram = useMemo(
    () =>
      srcHistogram
        ? deriveLayerHistogram(srcHistogram, activeLayer?.levels, activeLayer?.curves)
        : null,
    [srcHistogram, activeLayer?.levels, activeLayer?.curves],
  );

  const histogramData = useMemo(() => {
    if (!derivedHistogram) return null;
    switch (channel) {
      case "red": return derivedHistogram.r;
      case "green": return derivedHistogram.g;
      case "blue": return derivedHistogram.b;
      default: return derivedHistogram.composite;
    }
  }, [derivedHistogram, channel]);

  const histogramPathD = useMemo(
    () => histogramToPathD(histogramData, VB_W, VB_H),
    [histogramData],
  );

  /**
   * Translate a PointerEvent to viewBox coordinates. Uses `getBoundingClientRect`
   * to correctly account for CSS scaling — the SVG is 100% width, so its
   * pixel width usually differs from `VB_W`.
   */
  const eventToVB = useCallback(
    (evt: { clientX: number; clientY: number }): [number, number] => {
      const svg = svgRef.current;
      if (!svg) return [0, 0];
      const rect = svg.getBoundingClientRect();
      const vx = ((evt.clientX - rect.left) / rect.width) * VB_W;
      const vy = ((evt.clientY - rect.top) / rect.height) * VB_H;
      return [vx, vy];
    },
    [],
  );

  // ── Pointer handlers ─────────────────────────────────────────────────────────

  const handlePointerDown = useCallback(
    (evt: ReactPointerEvent<SVGSVGElement>) => {
      if (!activeLayer) return;
      const [vx, vy] = eventToVB(evt);
      const currentPts = readPointsFor(activeLayer.curves, channel);
      const hitIdx = findHitIndex(currentPts, vx, vy);

      // Ignore right/middle-button pointerdown here: right-click removal is
      // handled by the SVG's `onContextMenu` (see `handleContextMenu` below).
      // Letting a right-click fall through would insert a point and grab
      // pointer capture — the classic "context menu ate my drag" bug.
      if (evt.button !== 0) return;

      // Start the undoable gesture BEFORE the first mutation so TimeTravel
      // snapshots the pre-edit state.
      gesture.begin();

      if (hitIdx >= 0) {
        dragIndexRef.current = hitIdx;
        // Known object → anchor immediately.
        setSelection({ index: hitIdx, curves: activeLayer.curves });
      } else {
        // No point close by — insert a new one at the click, then let the
        // subsequent pointermove drag the newly-inserted point around.
        const [nx, ny] = svgToNormalized(vx, vy);
        addCurvePointCmd?.execute({ channel, x: nx, y: ny });
        // The added point is not at a predictable index yet (insertion
        // preserves sort order); we recompute the target index using the
        // updated array immediately after dispatch. We use `nx` to disambiguate.
        //
        // Because `addCurvePointCmd` is synchronous (it just calls actions),
        // the next `updateChannelCurve` we send during pointermove will read
        // the fresh `activeLayer.curves` on the next render. To make the drag
        // feel instant, we ALSO stash the local expected index so subsequent
        // moves target it without waiting for a re-render.
        const inserted = insertLocalPreview(currentPts, nx, ny);
        dragIndexRef.current = inserted.index;
        // The command built a fresh curves object we can't observe from here —
        // park the anchor as pending; the next render binds it.
        setSelection({ index: inserted.index, curves: null });
      }

      // Capture the pointer so we still receive move/up events even if the
      // pointer strays outside the SVG (e.g. off the drawer entirely).
      svgRef.current?.setPointerCapture(evt.pointerId);
    },
    [activeLayer, eventToVB, channel, addCurvePointCmd, gesture],
  );

  const handlePointerMove = useCallback(
    (evt: ReactPointerEvent<SVGSVGElement>) => {
      if (dragIndexRef.current < 0 || !activeLayer) return;
      const [vx, vy] = eventToVB(evt);
      const [nx, ny] = svgToNormalized(vx, vy);
      const currentPts = readPointsFor(activeLayer.curves, channel);
      // Guard the drag index: if the array shrank (e.g. remove came in via
      // undo), skip this frame silently.
      if (dragIndexRef.current >= currentPts.length) return;
      const next = movePointConstrained(
        currentPts,
        dragIndexRef.current,
        nx,
        ny,
      );
      // Fire non-undoable — coalesces via the beginCurvesEdit checkpoint.
      updateChannelCurveCmd?.execute({ channel, points: next });
      // Authored write → re-pend the anchor for the next render.
      setSelection((s) => (s ? { ...s, curves: null } : s));
    },
    [activeLayer, eventToVB, channel, updateChannelCurveCmd],
  );

  const finishDrag = useCallback(
    (evt?: ReactPointerEvent<SVGSVGElement>) => {
      if (dragIndexRef.current < 0) return;
      dragIndexRef.current = -1;
      gesture.end();
      if (evt && svgRef.current?.hasPointerCapture(evt.pointerId)) {
        svgRef.current.releasePointerCapture(evt.pointerId);
      }
    },
    [gesture],
  );

  const handlePointerUp = useCallback(
    (evt: ReactPointerEvent<SVGSVGElement>) => finishDrag(evt),
    [finishDrag],
  );

  const handlePointerCancel = useCallback(
    (evt: ReactPointerEvent<SVGSVGElement>) => finishDrag(evt),
    [finishDrag],
  );

  // Belt-and-suspenders: if the SVG unmounts mid-drag (channel switch, layer
  // deselect, etc.), close the gesture so we don't leave `isDragging()` true.
  useEffect(() => {
    return () => {
      if (dragIndexRef.current >= 0) {
        dragIndexRef.current = -1;
        gesture.end();
      }
    };
    // gesture is stable across renders (memoized).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Right-click on an interior point removes it. Endpoints are protected
   * inside the `removeCurvePoint` command, so users can't accidentally
   * unbolt the domain anchors. `contextmenu` uses `preventDefault` so the
   * browser's system menu doesn't appear over the graph.
   *
   * NOTE: we handle context-menu at the SVG level (not per-circle) because
   * setPointerCapture during pointerdown can prevent per-child event
   * delivery on some browsers.
   */
  const handleContextMenu = useCallback(
    (evt: React.MouseEvent<SVGSVGElement>) => {
      evt.preventDefault();
      if (!activeLayer) return;
      const [vx, vy] = eventToVB(evt);
      const currentPts = readPointsFor(activeLayer.curves, channel);
      const hitIdx = findHitIndex(currentPts, vx, vy);
      if (hitIdx < 0) return;
      const isEndpoint = hitIdx === 0 || hitIdx === currentPts.length - 1;
      if (isEndpoint) return;
      gesture.begin();
      removeCurvePointCmd?.execute({ channel, index: hitIdx });
      gesture.end();
      // Authored write → re-pend. Removed index shifts the selection: same
      // index → drop it, larger index → slide down by one.
      setSelection((s) => {
        if (!s) return s;
        const nextIdx =
          s.index === hitIdx ? null : s.index > hitIdx ? s.index - 1 : s.index;
        return nextIdx === null ? null : { index: nextIdx, curves: null };
      });
    },
    [activeLayer, eventToVB, channel, removeCurvePointCmd, gesture],
  );

  // ── Selected-point numeric editing (PS Curves parity) ────────────────────────

  /**
   * Commit a typed In/Out value (0–255) for the selected point. Routes through
   * `movePointConstrained` so endpoints stay x-pinned and interior points keep
   * the strict x-sort (an out-of-order In snaps into the legal gap). Wrapped
   * in a short gesture → exactly one Undo step, same contract as the Levels
   * panel's number fields.
   */
  const commitSelectedPoint = useCallback(
    (axis: "x" | "y", value255: number) => {
      if (selected === null || !activeLayer) return;
      const currentPts = readPointsFor(activeLayer.curves, channel);
      if (selected >= currentPts.length) return;
      const nx = axis === "x" ? clamp01(value255 / 255) : currentPts[selected][0];
      const ny = axis === "y" ? clamp01(value255 / 255) : currentPts[selected][1];
      const next = movePointConstrained(currentPts, selected, nx, ny);
      gesture.begin();
      updateChannelCurveCmd?.execute({ channel, points: next });
      gesture.end();
      // Authored write → re-pend the anchor for the next render.
      setSelection((s) => (s ? { ...s, curves: null } : s));
    },
    [selected, activeLayer, channel, updateChannelCurveCmd, gesture],
  );

  // ── Render ───────────────────────────────────────────────────────────────────

  const channelMeta =
    CHANNEL_TABS.find((c) => c.channel === channel) ?? CHANNEL_TABS[0];

  return (
    // NOTE: intentionally NO outer surface panel / padding / border here — the
    // parent drawer already provides the sidebar surface, and adding another
    // "card" wrapper wasted ~24px vertical space on an already-narrow sidebar.
    // The channel tabs and the SVG grid live directly on the drawer surface
    // and rely on their own strokes/tints for visual separation.
    <div className="flex flex-col gap-2">
      {/* Compact channel selector.
          Deliberately NOT the shared FunctionTabs widget because:
          - FunctionTabs renders a `py-2` button = ~28px tall, which wastes
            vertical space on a narrow drawer where the curve graph already
            competes with the panel switcher above it.
          - FunctionTabs renders the label with a single foreground color;
            we want per-channel tinting (R red, G green, B blue) so the tab
            strip visually maps to the curve line below it.
          So we roll a compact segmented control here — the visual language
          (rounded track + shadow-inner + active pill) is intentionally kept
          identical to FunctionTabs so it doesn't look like a foreign widget. */}
      <div
        role="tablist"
        aria-label="Curve channel"
        className="flex p-0.5 gap-0.5 rounded-lg border border-zinc-200 dark:border-white/5 bg-zinc-100/80 dark:bg-black/20 shadow-inner"
      >
        {CHANNEL_TABS.map((tab) => {
          const active = tab.channel === channel;
          return (
            <button
              key={tab.channel}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => {
                setChannel(tab.channel);
                setSelection(null); // point indices are per-channel
              }}
              title={`Edit ${tab.label} curve`}
              className={`flex-1 h-5 rounded-md text-[10px] font-black tracking-widest transition-colors outline-none focus:outline-none focus-visible:outline-none ${
                active
                  ? "bg-white dark:bg-zinc-700 shadow-sm dark:shadow-[inset_0_1px_1px_rgba(255,255,255,0.05)]"
                  : "hover:bg-white/40 dark:hover:bg-white/5"
              }`}
              style={{
                // Active tab: full channel color. Inactive: dim toward muted
                // so the strip reads as a set but the active one dominates.
                color: active
                  ? tab.hex ?? "var(--text-main)"
                  : tab.hex
                  ? `color-mix(in srgb, ${tab.hex} 55%, var(--text-muted))`
                  : "var(--text-muted)",
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Graph. We fill the grid *background* with a subtle checkered pattern
          idiom (two flat solid layers) so it reads clearly on both themes:
          - light theme: near-white surface with a thin zinc stroke frame
          - dark theme: near-black surface with a thin white/10 stroke frame
          The SVG grid + diagonal are drawn with theme-aware opacities so the
          lines stay legible against BOTH surfaces — the earlier 0.08 opacity
          rendered nearly invisible on the light theme's white-on-white. */}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        className="w-full aspect-[4/3] rounded-md touch-none select-none bg-zinc-50 dark:bg-zinc-900/70 border border-zinc-200 dark:border-white/10"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onContextMenu={handleContextMenu}
        role="img"
        aria-label={`${channelMeta.label} tone curve editor`}
      >
        {/* Theme-aware grid definitions.
            - Light theme uses zinc-400 at 45% (readable on zinc-50 surface).
            - Dark theme uses white at 18% (readable on zinc-900 surface).
            We toggle via two classes (`hidden dark:block` / `dark:hidden block`)
            on <g> wrappers because SVG doesn't accept Tailwind color utilities
            on <stroke>. This keeps the *same* geometry rendered under both
            themes with theme-appropriate contrast. */}

        {/* Light-theme grid (visible when NOT dark). */}
        <g className="dark:hidden">
          {[0.25, 0.5, 0.75].map((t) => (
            <React.Fragment key={`l-${t}`}>
              <line
                x1={t * VB_W}
                y1={0}
                x2={t * VB_W}
                y2={VB_H}
                stroke="#a1a1aa"
                strokeOpacity={0.45}
                strokeWidth={1}
              />
              <line
                x1={0}
                y1={t * VB_H}
                x2={VB_W}
                y2={t * VB_H}
                stroke="#a1a1aa"
                strokeOpacity={0.45}
                strokeWidth={1}
              />
            </React.Fragment>
          ))}
          {/* Identity diagonal — solid mid-gray for the light theme. */}
          <line
            x1={0}
            y1={VB_H}
            x2={VB_W}
            y2={0}
            stroke="#71717a"
            strokeOpacity={0.55}
            strokeDasharray="2 3"
            strokeWidth={1}
          />
        </g>

        {/* Dark-theme grid (visible only in dark). */}
        <g className="hidden dark:block">
          {[0.25, 0.5, 0.75].map((t) => (
            <React.Fragment key={`d-${t}`}>
              <line
                x1={t * VB_W}
                y1={0}
                x2={t * VB_W}
                y2={VB_H}
                stroke="#ffffff"
                strokeOpacity={0.18}
                strokeWidth={1}
              />
              <line
                x1={0}
                y1={t * VB_H}
                x2={VB_W}
                y2={t * VB_H}
                stroke="#ffffff"
                strokeOpacity={0.18}
                strokeWidth={1}
              />
            </React.Fragment>
          ))}
          <line
            x1={0}
            y1={VB_H}
            x2={VB_W}
            y2={0}
            stroke="#ffffff"
            strokeOpacity={0.35}
            strokeDasharray="2 3"
            strokeWidth={1}
          />
        </g>

        {/* Histogram background — AFTER the grid, BEFORE the curve. Shows the
            levels→curves OUTPUT distribution for the active channel so control
            points are placed against real data. Tint follows CHANNEL_TABS:
            rgb uses the theme gray pair (same as the Levels panel), per-channel
            tabs reuse their brand hex on both themes. pointer-events: none —
            hit-testing stays on the SVG root. */}
        {histogramPathD && (
          channelMeta.hex ? (
            <path
              d={histogramPathD}
              fill={channelMeta.hex}
              fillOpacity={0.3}
              style={{ pointerEvents: "none" }}
            />
          ) : (
            <>
              <path
                d={histogramPathD}
                fill={channelMeta.strokeLight}
                fillOpacity={0.35}
                className="dark:hidden"
                style={{ pointerEvents: "none" }}
              />
              <path
                d={histogramPathD}
                fill={channelMeta.strokeDark}
                fillOpacity={0.35}
                className="hidden dark:block"
                style={{ pointerEvents: "none" }}
              />
            </>
          )
        )}

        {/* The curve itself — sampled by the same spline evaluator the runtime
            LUT uses so preview == final filter output.

            We render TWO paths (one for each theme), toggled via `dark:hidden`
            / `hidden dark:block` on <g> wrappers, mirroring the grid strategy
            above. Circles for the control points sit inside each <g> so their
            stroke/fill match the curve on the same theme. This avoids relying
            on `currentColor` which we found too dark on the light surface. */}
        {(["Light", "Dark"] as const).map((mode) => {
          const isDark = mode === "Dark";
          const stroke = isDark ? channelMeta.strokeDark : channelMeta.strokeLight;
          return (
            <g
              key={mode}
              className={isDark ? "hidden dark:block" : "dark:hidden"}
            >
              <path
                d={pathD}
                fill="none"
                stroke={stroke}
                strokeWidth={1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {/* Control points on top. Endpoints get a hollow disc
                  (non-removable visual affordance); interior points a filled
                  disc. Circles are drawn with `pointerEvents: none` because
                  pointer handling lives on the parent SVG (with pointer
                  capture): keeping the hit test one level up avoids the
                  pointer-capture-swallows-child-events pitfall so removals
                  via `onContextMenu` always fire on the SVG root. */}
              {points.map((p, i) => {
                const [sx, sy] = normalizedToSvg(p[0], p[1]);
                const isEndpoint = i === 0 || i === points.length - 1;
                return (
                  <circle
                    key={`${mode}-${i}-${p[0].toFixed(4)}`}
                    cx={sx}
                    cy={sy}
                    r={isEndpoint ? 3 : 4}
                    fill={isEndpoint ? "var(--bg-stage)" : stroke}
                    stroke={stroke}
                    strokeWidth={1.5}
                    style={{
                      cursor: isEndpoint ? "ns-resize" : "move",
                      pointerEvents: "none",
                    }}
                    aria-label={
                      isEndpoint
                        ? `Endpoint at ${(p[0] * 100).toFixed(0)}%, ${(p[1] * 100).toFixed(0)}%`
                        : `Control point ${i} at ${(p[0] * 100).toFixed(0)}%, ${(p[1] * 100).toFixed(0)}%`
                    }
                  />
                );
              })}
            </g>
          );
        })}
      </svg>

      {/* Selected-point In/Out numeric editing (PS Curves parity). The row is
          ALWAYS on screen: with no point selected both fields sit disabled at
          "-". Values are 0–255 like PS; typing commits through a one-Undo
          mini-gesture. Fields live-update while the point is being dragged. */}
      <div className="flex items-stretch gap-1">
        <NumberField
          label="In"
          ariaLabel="Selected point input value"
          value={selectedPoint ? Math.round(selectedPoint[0] * 255) : null}
          min={0}
          max={255}
          step={1}
          precision={0}
          onCommit={(v) => commitSelectedPoint("x", v)}
        />
        <NumberField
          label="Out"
          ariaLabel="Selected point output value"
          value={selectedPoint ? Math.round(selectedPoint[1] * 255) : null}
          min={0}
          max={255}
          step={1}
          precision={0}
          onCommit={(v) => commitSelectedPoint("y", v)}
        />
      </div>

      {/* Helper caption — the right-click-to-remove affordance is not
          visible, so we spell it out. Point count on the right so a user
          can eyeball "did my click actually add a point?". */}
      <div className="flex items-center justify-between text-[9px] text-[var(--text-muted)] tracking-tight">
        <span>Drag to shape · click to add · right-click to remove</span>
        <span>{points.length} pts</span>
      </div>
    </div>
  );
}
