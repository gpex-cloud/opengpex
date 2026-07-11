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
 * Design (spec §5 & §6):
 *
 * - Users can drag existing control points, add new ones by clicking on the
 *   empty grid, and remove interior points by right-clicking them. The
 *   endpoints at x=0 and x=1 are always present and non-removable — they
 *   anchor the mapping domain. (An earlier iteration used double-click for
 *   removal but the `dblclick` event doesn't fire reliably once we take
 *   pointer capture on `pointerdown`, so we standardized on right-click.)
 *
 * - The curve preview uses the SAME Fritsch-Carlson monotonic cubic-spline
 *   evaluator that powers the runtime LUT (`core/engine/filters/lut.ts`),
 *   sampled at ~64 subdivisions for the SVG path. This means the preview
 *   line the user sees is byte-identical to the tone curve that the worker
 *   eventually bakes into the layer bitmap — no visual drift between
 *   "editor preview" and "rendered result".
 *
 * - Editing is decoupled into three phases (spec §5.6 gesture coalescing):
 *     1. pointerdown → `useFilterGesture.begin()` fires the undoable checkpoint
 *        (`beginCurvesEdit`) which snapshots layer state into TimeTravel.
 *     2. pointermove → non-undoable `updateChannelCurve` writes accumulate on
 *        `layer.curves.<channel>`. Because the checkpoint captured the
 *        pre-drag state, all intermediate writes coalesce into a single Undo
 *        step.
 *     3. pointerup → `useFilterGesture.end()` marks the drag complete. The
 *        final layer state is already durable; nothing to commit.
 *
 * - This panel does NOT dispatch to `AsyncFilterCache` or the engine worker —
 *   that's `Canvas2dEngine.drawLayerDirect()`'s job (spec §5.1). We only
 *   mutate `layer.curves`; the render loop picks up the change on its next
 *   frame and, on cache-miss, `Canvas2dEngine.resolveFilteredSource()`
 *   schedules the worker job. Kept the strict "UI ↔ state" boundary the spec
 *   §3.5 asks for.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { generateCurveLUT } from "@opengpex/editor/core/engine/filters/lut";
import { usePluginCommands } from "@opengpex/editor/core/context";
import type { CurvePoints, CurvesState } from "@opengpex/editor/core/types/models";
import type { AdjustmentDrawerCommandsMap } from "../commands.d";
import type { CurveChannel } from "../protocols";
import { IDENTITY_CURVE_POINTS } from "../protocols";
import { useAdjustmentDrawer, useFilterGesture } from "../hooks";

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

/** SVG viewBox side (square). Keeps math simple: x,y ∈ [0, VB]. */
const VB = 256;
/**
 * Number of samples along the preview path. 64 keeps the SVG small and easy
 * to diff in devtools while still producing a visually smooth curve — the
 * eye can't distinguish >32 segments on a 256px-wide canvas.
 */
const PREVIEW_SAMPLES = 64;
/**
 * Radius (in viewBox units) around a control point where a pointerdown counts
 * as "grabbed this point" rather than "add a new point somewhere else". At
 * VB=256 this is ~4% of the width, comfortable for touch.
 */
const HIT_RADIUS_VB = 10;

// ─── Utilities ─────────────────────────────────────────────────────────────────

/** Clamp helper. */
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Read the current points for `channel`, defaulting to a fresh copy of the
 * identity segment. We hand back a COPY because the caller often needs to
 * mutate the result before writing back through `updateChannelCurve`.
 */
function readPointsFor(
  curves: CurvesState | undefined,
  channel: CurveChannel,
): CurvePoints {
  const existing = curves?.[channel];
  if (existing && existing.length >= 2) {
    return existing.map((p) => [p[0], p[1]] as [number, number]);
  }
  return IDENTITY_CURVE_POINTS.map((p) => [p[0], p[1]] as [number, number]);
}

/**
 * Convert an SVG coordinate to a normalized (x, y) in [0, 1]. Y is inverted
 * because SVG's origin is top-left, but the curve editor's origin is
 * bottom-left (higher y = brighter output — standard tone-curve convention).
 */
function svgToNormalized(vx: number, vy: number): [number, number] {
  return [clamp01(vx / VB), clamp01(1 - vy / VB)];
}

function normalizedToSvg(x: number, y: number): [number, number] {
  return [x * VB, (1 - y) * VB];
}

/**
 * Distance² between a point and (px, py) in viewBox space. We compare
 * squared distance to avoid a `Math.sqrt` inside the hit-test loop.
 */
function dist2(x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  return dx * dx + dy * dy;
}

/**
 * Locate a control-point index within `HIT_RADIUS_VB` of (vx, vy).
 * Returns -1 when no point is close enough to grab.
 */
function findHitIndex(
  pts: CurvePoints,
  vx: number,
  vy: number,
): number {
  const r2 = HIT_RADIUS_VB * HIT_RADIUS_VB;
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const [sx, sy] = normalizedToSvg(pts[i][0], pts[i][1]);
    const d = dist2(sx, sy, vx, vy);
    if (d < r2 && d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Build the SVG polyline `d` attribute from a set of control points. We
 * sample the same `generateCurveLUT` used by the runtime so the preview and
 * the actual filter apply share ONE spline evaluator.
 */
function curveToPathD(pts: CurvePoints): string {
  // `generateCurveLUT` at N samples gives us the y-values for xs = 0/(N-1),
  // 1/(N-1), …, 1. We convert those to SVG (with y inverted).
  const lut = generateCurveLUT(pts, 256 as const, "f32") as Float32Array;
  // Down-sample to PREVIEW_SAMPLES points for a compact SVG path.
  const step = (lut.length - 1) / (PREVIEW_SAMPLES - 1);
  const parts: string[] = [];
  for (let i = 0; i < PREVIEW_SAMPLES; i++) {
    const li = Math.round(i * step);
    const x = li / (lut.length - 1);
    const y = lut[li];
    const [sx, sy] = normalizedToSvg(x, y);
    parts.push(`${i === 0 ? "M" : "L"}${sx.toFixed(2)},${sy.toFixed(2)}`);
  }
  return parts.join(" ");
}

/**
 * Constrain the new x of a dragged interior point so it can't jump past its
 * neighbors — this keeps the point list strictly x-sorted and matches the
 * "monotonic domain" invariant `normalizeControlPoints` (in lut.ts) enforces
 * anyway. Endpoints (i=0 and i=n-1) stay pinned at x=0 / x=1.
 */
function movePointConstrained(
  pts: CurvePoints,
  index: number,
  nx: number,
  ny: number,
): CurvePoints {
  const next = pts.map((p) => [p[0], p[1]] as [number, number]);
  const clampedY = clamp01(ny);
  if (index === 0) {
    next[0] = [0, clampedY];
    return next;
  }
  if (index === next.length - 1) {
    next[next.length - 1] = [1, clampedY];
    return next;
  }
  // Interior: leave a tiny gap so points can't sit exactly on each other's x.
  const eps = 1 / VB; // ~0.4%: enough to keep the sort strict.
  const leftX = next[index - 1][0] + eps;
  const rightX = next[index + 1][0] - eps;
  const clampedX = Math.max(leftX, Math.min(rightX, clamp01(nx)));
  next[index] = [clampedX, clampedY];
  return next;
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

  /**
   * The channel selector is a UI-only concern: which curve the user is
   * currently editing. We deliberately keep it local (React state) instead of
   * a plugin signal because no other plugin needs to observe it — a future
   * "quick red-curve toggle" in ColorOptions could promote this to a signal
   * later without breaking the panel.
   */
  const [channel, setChannel] = useState<CurveChannel>("rgb");

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

  /**
   * Translate a PointerEvent to viewBox coordinates. Uses `getBoundingClientRect`
   * to correctly account for CSS scaling — the SVG is 100% width, so its
   * pixel width usually differs from `VB`.
   */
  const eventToVB = useCallback(
    (evt: { clientX: number; clientY: number }): [number, number] => {
      const svg = svgRef.current;
      if (!svg) return [0, 0];
      const rect = svg.getBoundingClientRect();
      const vx = ((evt.clientX - rect.left) / rect.width) * VB;
      const vy = ((evt.clientY - rect.top) / rect.height) * VB;
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
      // snapshots the pre-edit state (spec §5.6).
      gesture.begin();

      if (hitIdx >= 0) {
        dragIndexRef.current = hitIdx;
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
    },
    [activeLayer, eventToVB, channel, removeCurvePointCmd, gesture],
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
          Deliberately NOT the shared FunctionGroup widget because:
          - FunctionGroup renders a `py-2` button = ~28px tall, which wastes
            vertical space on a narrow drawer where the curve graph already
            competes with the panel switcher above it.
          - FunctionGroup renders the label with a single foreground color;
            we want per-channel tinting (R red, G green, B blue) so the tab
            strip visually maps to the curve line below it.
          So we roll a compact segmented control here — the visual language
          (rounded track + shadow-inner + active pill) is intentionally kept
          identical to FunctionGroup so it doesn't look like a foreign widget. */}
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
              onClick={() => setChannel(tab.channel)}
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
        viewBox={`0 0 ${VB} ${VB}`}
        className="w-full aspect-square rounded-md touch-none select-none bg-zinc-50 dark:bg-zinc-900/70 border border-zinc-200 dark:border-white/10"
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
                x1={t * VB}
                y1={0}
                x2={t * VB}
                y2={VB}
                stroke="#a1a1aa"
                strokeOpacity={0.45}
                strokeWidth={1}
              />
              <line
                x1={0}
                y1={t * VB}
                x2={VB}
                y2={t * VB}
                stroke="#a1a1aa"
                strokeOpacity={0.45}
                strokeWidth={1}
              />
            </React.Fragment>
          ))}
          {/* Identity diagonal — solid mid-gray for the light theme. */}
          <line
            x1={0}
            y1={VB}
            x2={VB}
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
                x1={t * VB}
                y1={0}
                x2={t * VB}
                y2={VB}
                stroke="#ffffff"
                strokeOpacity={0.18}
                strokeWidth={1}
              />
              <line
                x1={0}
                y1={t * VB}
                x2={VB}
                y2={t * VB}
                stroke="#ffffff"
                strokeOpacity={0.18}
                strokeWidth={1}
              />
            </React.Fragment>
          ))}
          <line
            x1={0}
            y1={VB}
            x2={VB}
            y2={0}
            stroke="#ffffff"
            strokeOpacity={0.35}
            strokeDasharray="2 3"
            strokeWidth={1}
          />
        </g>

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

// ─── Local-only helper: expected index of a newly-inserted point ───────────────

/**
 * Mirrors `insertPointSorted` in `commands.ts` — kept locally so the panel
 * can predict WHERE in the array the new point will land WITHOUT waiting for
 * a re-render. The command is still the source of truth (it writes to the
 * layer store); this function just computes the index we'll target during
 * the drag that immediately follows a click-to-add.
 *
 * If `commands.ts::insertPointSorted` ever changes shape, this helper must
 * change too. Both are covered by the vitest suite so a drift would surface
 * immediately.
 */
function insertLocalPreview(
  points: CurvePoints,
  x: number,
  y: number,
): { pts: CurvePoints; index: number } {
  const cx = clamp01(x);
  const cy = clamp01(y);
  const next: CurvePoints = [];
  let inserted = false;
  let insertedAt = -1;
  for (const p of points) {
    if (!inserted && p[0] > cx) {
      insertedAt = next.length;
      next.push([cx, cy]);
      inserted = true;
    }
    if (p[0] === cx) continue;
    next.push([p[0], p[1]]);
  }
  if (!inserted) {
    insertedAt = next.length;
    next.push([cx, cy]);
  }
  return { pts: next, index: insertedAt };
}
