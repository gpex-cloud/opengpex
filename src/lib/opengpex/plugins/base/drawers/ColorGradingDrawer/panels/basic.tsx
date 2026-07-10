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
 * BasicPanel — brightness / contrast / saturation / hueRotate / blur.
 *
 * Step 7.5 (spec §六 Step 7.5): migrates the AdjustmentDrawer UI into
 * ColorGradingDrawer as its fourth sub-panel. Visual style is a faithful
 * port of the original AdjustmentDrawer content (native `<input type="range">`
 * with dynamic accent color: gray at identity, emerald above, amber below),
 * minus the panel-level "Adjustments" header + Reset button — those live at
 * the ColorGradingDrawer header now (one drawer = one reset UI).
 *
 * Data flow & undo coalescing mirror the sibling panels (spec §5.6):
 *
 * - `useColorGradingDrawer().activeLayer` reads the layer.
 * - `useFilterGesture(beginAdjustmentsEditCmd)` bookends each drag with a
 *   single undoable checkpoint at pointerdown and closes it at pointerup, so
 *   one continuous slider drag collapses into exactly one Undo step.
 * - Writes go to `layer.adjustments` via `updateAdjustments({ patch })`.
 *   `Canvas2dEngine.drawLayerDirect()` sees the mutation on the next frame:
 *   because `hasAdvancedFilters(layer)` INTENTIONALLY does not consult
 *   `layer.adjustments`, a Basic-only edit stays on the painter's `ctx.filter`
 *   fast path (no worker roundtrip). When Basic is combined with
 *   Curves/Levels/Mixer, `normalizeFilterDescriptors` folds the adjustments
 *   into the same filter chain (spec §5.1 / §Step 7.5 序言 "引擎行为不变").
 */

import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { usePluginCommands } from "@opengpex/editor/core/context";
import type { AdjustmentState } from "@opengpex/editor/core/types/models";
import type { ColorGradingDrawerCommandsMap } from "../commands.d";
import { DEFAULT_ADJUSTMENTS_STATE } from "../protocols";
import { useColorGradingDrawer, useFilterGesture } from "../hooks";

// ─── Slider descriptors ────────────────────────────────────────────────────────

/**
 * One row per adjustment. Ranges match the old AdjustmentDrawer + CSS
 * `ctx.filter()` semantics (100 = identity for brightness/contrast/saturation;
 * 0 = identity for hueRotate/blur). See `docs/…/filter_pipeline_architecture_spec.md`
 * §Step 7.5 for the rationale on why we did NOT rescale to [-100, 100] during
 * migration (Photoshop-compatible + zero cross-version data migration).
 */
interface SliderSpec {
  key: keyof AdjustmentState;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  /**
   * Optional CSS `background` string painted on the range track — a
   * semantic gradient that visualizes what the slider actually does
   * (e.g. rainbow for Hue, black→white for Brightness). Mirrors the
   * Photoshop "Hue/Saturation" dialog affordance, where each track's
   * gradient tells the user which direction produces which effect
   * before they even move the thumb.
   *
   * When omitted, the track falls back to a neutral subtle gray so
   * "measurement-only" sliders like Blur don't fake a false gradient.
   */
  trackGradient?: string;
}

const SLIDERS: readonly SliderSpec[] = [
  // Brightness track: black→mid→white matches CSS `brightness()` semantics
  // where 0% is fully black and 200% is fully white (100% = original).
  {
    key: "brightness", label: "Brightness", min: 0, max: 200, step: 1, unit: "%",
    trackGradient: "linear-gradient(90deg, #000 0%, #808080 50%, #fff 100%)",
  },
  // Contrast track: two-layer background — a full black→white dynamic-range
  // gradient underneath, and a mid-gray fade-out mask on top. At the left
  // end the mask is fully opaque, so only the mid-gray shows (i.e. contrast
  // has collapsed to a single tone). Toward the right the mask fades out
  // and the underlying black↔white range emerges (i.e. contrast expands to
  // the full luminance range). This mirrors the Lightroom "Whites/Blacks"
  // slider affordance, where the track visually widens as contrast grows.
  //
  // NOTE: the two `linear-gradient(...)` are the same-property multi-value
  // form of CSS `background`, drawn top-to-bottom in listing order. The
  // FIRST gradient is the top overlay; the SECOND is the underlay.
  {
    key: "contrast", label: "Contrast", min: 0, max: 200, step: 1, unit: "%",
    trackGradient:
      "linear-gradient(90deg, rgba(128,128,128,1) 0%, rgba(128,128,128,0) 100%), linear-gradient(90deg, #000 0%, #fff 100%)",
  },

  // Saturation track: gray→neutral→saturated red. This is the exact PS
  // "Hue/Saturation" saturation slider background — a middle-neutral means
  // "no change", pushing right pumps color, pushing left drains toward gray.
  {
    key: "saturation", label: "Saturation", min: 0, max: 200, step: 1, unit: "%",
    trackGradient: "linear-gradient(90deg, #808080 0%, #a04040 50%, #ff2020 100%)",
  },
  // [Hue as bidirectional] Hue is a rotation on the HSL color wheel — it has
  // a natural neutral (0° = no rotation) and both signed directions are
  // meaningful (+ warms toward yellow/green, - cools toward magenta). Photoshop,
  // Lightroom, and CSS `hue-rotate()` all model it this way. Keeping 0° in the
  // middle stops the "both ends of the slider produce the same result"
  // confusion caused by 0°/360° aliasing.
  //
  // Rainbow track uses 7 stops (red→yellow→green→cyan→blue→magenta→red) so
  // -180° and +180° both land on the same red hue at the two ends, faithfully
  // reflecting that hue-rotate is a cyclic operation. The 4th stop (green,
  // 50%) is where the identity-0° thumb parks.
  {
    key: "hueRotate", label: "Hue Rotate", min: -180, max: 180, step: 1, unit: "°",
    trackGradient:
      "linear-gradient(90deg, #ff0000 0%, #ffff00 16.67%, #00ff00 33.33%, #00ffff 50%, #0000ff 66.67%, #ff00ff 83.33%, #ff0000 100%)",
  },
  // Blur has no natural "direction" gradient (no negative blur), so we
  // leave `trackGradient` undefined and let the CSS fall back to a plain
  // subtle stage color. The rendered kernel radius is communicated by the
  // numeric value label alone.
  { key: "blur", label: "Blur", min: 0, max: 20, step: 0.1, unit: "px" },
] as const;


/**
 * Fold any stored hue degree (from legacy projects or presets that predate the
 * signed range) into the canonical `[-180, 180]` window. CSS `hue-rotate()` is
 * modulo-360 in behavior — 200° renders identically to -160° — so this is a
 * lossless UI-side normalization; the underlying render pipeline is unaffected.
 * Kept separate from the slider spec so the write path stays 1:1 with what the
 * user drags (no hidden mutation on commit).
 */
function normalizeHueDeg(v: number): number {
  // ((v + 180) mod 360) in JS's "positive-remainder" idiom, then shift back.
  return ((((v + 180) % 360) + 360) % 360) - 180;
}


/**
 * Identity (zero-effect) value for each slider — same lookup the original
 * AdjustmentDrawer used to color-tint the thumb. Kept as a function rather
 * than a `readonly Record<>` because the switch is small and the compiler
 * inlines it either way.
 */
function identityFor(key: keyof AdjustmentState): number {
  return key === "hueRotate" || key === "blur" ? 0 : 100;
}

/**
 * Pick a Photoshop-style tint for the range input's `accent-color` CSS: gray
 * at identity, emerald when nudged up, amber when nudged down. Mirrors the
 * subtle affordance existing AdjustmentDrawer users are already trained on.
 */
function accentForValue(key: keyof AdjustmentState, value: number): string {
  const identity = identityFor(key);
  if (Math.abs(value - identity) < 0.1) return "#666666";
  return value > identity ? "#10b981" : "#f59e0b"; // emerald-500 : amber-500
}

// ─── Slider row ───────────────────────────────────────────────────────────────

/**
 * A single row: uppercase label + tabular value on top, native range input
 * below. Deliberately compact (`text-[9px] / text-[10px]`) so five rows fit
 * comfortably without vertical scroll on a 720p sidebar.
 */
/**
 * Row layout — Photoshop "Hue/Saturation" affordance:
 *
 * ┌──────────────────────────────────────────────┐
 * │ LABEL                              123 %     │  ← header
 * ├──────────────────────────────────────────────┤
 * │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ │  ← semantic gradient track
 * │                     ▲                        │  ← downward-facing triangle thumb
 * └──────────────────────────────────────────────┘
 *
 * We keep the native `<input type="range">` for accessibility, keyboard
 * arrows, and pointer capture — but hide its default track/thumb and paint
 * our own via `-webkit-slider-runnable-track` / `-webkit-slider-thumb`
 * (with the Firefox `-moz-*` equivalents). The gradient is passed in as a
 * CSS custom property `--track-bg` so the same stylesheet works for every
 * row and we don't have to lift 5 separate `<style>` blocks.
 *
 * The thumb itself is drawn as a CSS triangle using the classic "0-size
 * box + solid bottom border" trick, matching the downward chevron in
 * Photoshop's Hue/Saturation dialog.
 */
function AdjustmentSliderRow({
  spec,
  value,
  onDragStart,
  onDragChange,
  onDragEnd,
}: {
  spec: SliderSpec;
  value: number;
  onDragStart: () => void;
  onDragChange: (v: number) => void;
  onDragEnd: () => void;
}) {
  // Track fallback: neutral stage color when this slider has no semantic
  // gradient (e.g. Blur). Kept opaque so the row height stays visually
  // aligned with the gradient-backed rows.
  const trackBg =
    spec.trackGradient ??
    "linear-gradient(90deg, var(--bg-stage), var(--bg-stage))";

  return (
    <div className="space-y-1 group">
      <div className="flex justify-between items-baseline">
        <span className="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-tight">
          {spec.label}
        </span>
        <span className="text-[10px] font-bold text-[var(--text-main)] tabular-nums px-1.5 py-[1px] rounded border border-[var(--border-subtle)] bg-[var(--bg-stage)] min-w-[38px] text-right">
          {Math.round(value * 10) / 10}
          {spec.unit}
        </span>
      </div>
      <input
        type="range"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={value}
        aria-label={spec.label}
        onPointerDown={onDragStart}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        // Fallback for browsers where mousedown/mouseup don't lead pointerdown
        // (rare, but the original AdjustmentDrawer relied on onMouseDown so we
        // keep that + the pointer events for safety).
        onMouseDown={onDragStart}
        onMouseUp={onDragEnd}
        onChange={(e) => {
          const raw = Number.parseFloat(e.target.value);
          if (Number.isFinite(raw)) onDragChange(raw);
        }}
        // Passing the gradient via CSS var lets ONE global stylesheet
        // (see <style jsx global> at the bottom of BasicPanel) style all
        // five rows without per-row style tags. `accentColor` is still
        // set so the Firefox `range-thumb-fallback` (very old versions)
        // has a sensible tint.
        style={{
          ["--track-bg" as string]: trackBg,
          accentColor: accentForValue(spec.key, value),
        }}
        className="opengpex-basic-slider w-full appearance-none cursor-ew-resize bg-transparent"
      />
    </div>
  );
}


// ─── Panel ────────────────────────────────────────────────────────────────────

/**
 * Reads the current adjustments record, falling back to identity so the UI
 * always renders against a fully-formed `AdjustmentState`. Returns a shallow
 * clone so React sees a fresh reference when `layer.adjustments` mutates.
 */
function readAdjustments(
  current: AdjustmentState | undefined,
): AdjustmentState {
  const src = current ?? DEFAULT_ADJUSTMENTS_STATE;
  // [Hue legacy fold] Older projects / presets may have stored hueRotate as
  // a positive-only 0–360 value. Normalize on read so the slider (which now
  // has min=-180 / max=180) can render it without HTML input clamping. The
  // fold is lossless in render (hue-rotate is modulo-360) and the next
  // pointer drag will commit the normalized value back to state.
  return { ...src, hueRotate: normalizeHueDeg(src.hueRotate) };
}


export function BasicPanel() {
  const { beginAdjustmentsEditCmd, updateAdjustmentsCmd } =
    usePluginCommands<ColorGradingDrawerCommandsMap>();
  const { activeLayer } = useColorGradingDrawer();
  const gesture = useFilterGesture(beginAdjustmentsEditCmd);

  const adjustments = useMemo(
    () => readAdjustments(activeLayer?.adjustments),
    [activeLayer?.adjustments],
  );

  // Which slider (if any) is currently being dragged. `null` = idle. Guards
  // against re-entrant `begin()` calls (some browsers fire pointerdown +
  // mousedown for the same interaction — we want ONE undo checkpoint).
  const dragRef = useRef<keyof AdjustmentState | null>(null);

  const commitPatch = useCallback(
    (key: keyof AdjustmentState, value: number) => {
      if (!updateAdjustmentsCmd) return;
      // Minimal `{ [key]: value }` patch — `updateAdjustments` shallow-merges
      // onto the current record (or DEFAULT_ADJUSTMENTS_STATE if the field is
      // undefined), so we never drop the other four sliders' values.
      updateAdjustmentsCmd.execute({ patch: { [key]: value } });
    },
    [updateAdjustmentsCmd],
  );

  const handleDragStart = useCallback(
    (key: keyof AdjustmentState) => () => {
      if (!activeLayer) return;
      if (dragRef.current) return; // ignore re-entrant begins
      dragRef.current = key;
      gesture.begin();
    },
    [activeLayer, gesture],
  );

  const handleDragChange = useCallback(
    (key: keyof AdjustmentState) => (value: number) => {
      commitPatch(key, value);
    },
    [commitPatch],
  );

  const handleDragEnd = useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = null;
    gesture.end();
  }, [gesture]);

  // Belt-and-suspenders: if the panel unmounts mid-drag (e.g. tab switch to
  // Curves), close the gesture cleanly. Same guardrail the sibling panels use.
  useEffect(() => {
    return () => {
      if (dragRef.current) {
        dragRef.current = null;
        gesture.end();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col gap-2 px-2 pt-1 pb-1">
      <div className="space-y-2">
        {SLIDERS.map((spec) => (
          <AdjustmentSliderRow
            key={spec.key}
            spec={spec}
            value={adjustments[spec.key]}
            onDragStart={handleDragStart(spec.key)}
            onDragChange={handleDragChange(spec.key)}
            onDragEnd={handleDragEnd}
          />
        ))}
      </div>

      {/*
        [Photoshop-style range styling]
        We hide the native track/thumb and repaint them ourselves so each
        slider can carry a semantic gradient background (see SliderSpec
        `trackGradient`). Layout on Chromium/WebKit vs. Firefox is handled
        by the vendor-prefixed pseudo-elements — CSS has no way to unify
        them, so this block is intentionally duplicated across `-webkit-*`
        and `-moz-*` groups. Both branches keep track height, thumb size,
        and thumb offset in sync via the `--thumb-size` custom property so
        we only tweak numbers in one place.

        `global` scope is required because native pseudo-elements
        (`::-webkit-slider-thumb`, `::-moz-range-thumb`) cannot be
        targeted by styled-jsx's scoped selectors.

        The thumb is drawn as a downward-pointing triangle using the
        classic CSS "0-size box + colored borders" trick, matching the
        Photoshop Hue/Saturation dialog chevron in the reference image.
      */}
      <style jsx global>{`
        /*
          Thumb geometry: 12px x 10px box, painted white, clipped to an
          upward-pointing chevron via clip-path polygon(50% 0%, 100% 100%,
          0% 100%). Tip at top-center, base along the bottom edge.

          Why clip-path (not the classic border-triangle hack):
            1. Works uniformly in ::-webkit-slider-thumb AND ::-moz-range-thumb.
            2. The thumb keeps a real width/height, so WebKit's built-in
               "center thumb on track" math does what we want without a
               fudge-factor margin.
            3. background-color drives the fill, so :focus/:hover recoloring
               is a one-line change.
        */

        .opengpex-basic-slider {
          --thumb-w: 12px;
          --thumb-h: 10px;
          --track-height: 8px;
          /* Reserve enough height for track + thumb below track. WebKit
             centers thumb on track, so half of the thumb hangs below —
             the row must be tall enough to contain that. */
          height: calc(var(--track-height) + var(--thumb-h) + 2px);
          padding: 0;
          margin: 0;
          background: transparent;
          outline: none;
        }

        /* ── WebKit / Blink ─────────────────────────────────── */
        .opengpex-basic-slider::-webkit-slider-runnable-track {
          height: var(--track-height);
          border-radius: 2px;
          background: var(--track-bg);
          border: 1px solid var(--border-subtle);
          box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.35);
        }
        .opengpex-basic-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: var(--thumb-w);
          height: var(--thumb-h);
          /* Shift thumb DOWN so its top tip sits just below the track's
             bottom edge. WebKit centers thumb at track midline; we want
             the tip (top of thumb box) at (track_y + track_h + 1px), so:
                 margin-top = (track_h + 1) - (track_h/2 - thumb_h/2)
                            = track_h/2 + thumb_h/2 + 1 */
          margin-top: calc(var(--track-height) / 2 + 1px);
          background: var(--text-main);
          border: none;
          /* Chevron pointing UP: apex at (50% 0), base along the bottom. */
          clip-path: polygon(50% 0%, 100% 100%, 0% 100%);
          cursor: ew-resize;
          filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.55));
        }
        .opengpex-basic-slider:hover::-webkit-slider-thumb,
        .opengpex-basic-slider:focus-visible::-webkit-slider-thumb {
          background: #10b981; /* emerald-500 focus/hover accent */
        }

        /* ── Firefox ────────────────────────────────────────── */
        .opengpex-basic-slider::-moz-range-track {
          height: var(--track-height);
          border-radius: 2px;
          background: var(--track-bg);
          border: 1px solid var(--border-subtle);
          box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.35);
        }
        .opengpex-basic-slider::-moz-range-thumb {
          width: var(--thumb-w);
          height: var(--thumb-h);
          background: var(--text-main);
          border: none;
          clip-path: polygon(50% 0%, 100% 100%, 0% 100%);
          cursor: ew-resize;
          filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.55));
        }
        .opengpex-basic-slider:hover::-moz-range-thumb,
        .opengpex-basic-slider:focus-visible::-moz-range-thumb {
          background: #10b981;
        }
        /* Firefox paints a "progress" fill by default — we don't want that
           since the track already carries a meaningful gradient. */
        .opengpex-basic-slider::-moz-range-progress {
          background: transparent;
        }
      `}</style>

    </div>
  );
}
