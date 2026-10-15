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
 * Migrates the AdjustmentDrawer UI into
 * AdjustmentDrawer as its fourth sub-panel. Visual style is a faithful
 * port of the original AdjustmentDrawer content (native `<input type="range">`
 * with dynamic accent color: gray at identity, emerald above, amber below),
 * minus the panel-level "Adjustments" header + Reset button — those live at
 * the AdjustmentDrawer header now (one drawer = one reset UI).
 *
 * Data flow & undo coalescing mirror the sibling panels:
 *
 * - `useAdjustmentDrawer().activeLayer` reads the layer.
 * - `useFilterGesture(beginAdjustmentsEditCmd)` bookends each drag with a
 *   single undoable checkpoint at pointerdown and closes it at pointerup, so
 *   one continuous slider drag collapses into exactly one Undo step.
 * - Writes go to `layer.adjustments` via `updateAdjustments({ patch })`.
 *   The render engine picks the mutation up on the next frame with no special
 *   casing: `SceneAssembler` translates the state into `AdjustmentDesc[]`, the
 *   composite signature dirties, and `adjust.wgsl` evaluates it on the GPU at
 *   full resolution. Basic / Curves / Levels / Mixer all travel the
 *   SAME single path — there is no fast/slow track and no worker roundtrip.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePluginCommands } from "@opengpex/editor/core/context";
import type { AdjustmentState } from "@opengpex/editor/core/types/models";
import { readEdgeFeather } from "@opengpex/editor/core/layer/services/fragment";
import FancySvgSlider from "@opengpex/editor/widgets/FancySvgSlider";
import type { AdjustmentDrawerCommandsMap } from "../commands.d";
import { DEFAULT_ADJUSTMENTS_STATE } from "../protocols";
import { useAdjustmentDrawer, useFilterGesture } from "../hooks";

// ─── Slider descriptors ────────────────────────────────────────────────────────

/**
 * One row per adjustment. Ranges match the old AdjustmentDrawer + CSS
 * `ctx.filter()` semantics (100 = identity for brightness/contrast/saturation;
 * 0 = identity for hueRotate/blur). We did NOT rescale to [-100, 100] during
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
  /**
   * Optional explanatory tooltip rendered on the row label — used by Edge
   * Feather to set expectations on the bitmap-mask limitation.
   */
  hint?: string;
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
  // Edge Feather — 落层后边缘羽化. ROUTED slider: the write goes to whichever
  // carrier holds this layer's edge (logical fragment → visibleShape re-pad;
  // vector-mask layer → mask `feather`; otherwise → the `alphaFeather` filter
  // via adjustments.edgeFeather). Display value likewise reads the routed
  // carrier, not adjustments (see the value override in BasicPanel).
  {
    key: "edgeFeather", label: "Edge Feather", min: 0, max: 20, step: 0.1, unit: "px",
    hint: "Softens layer edges. Feathering a bitmap-mask edge requires rasterizing the mask first.",
  },
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
  return key === "hueRotate" || key === "blur" || key === "edgeFeather" ? 0 : 100;
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

/**
 * Neutral quantity sliders (Blur / Edge Feather — the ones without a semantic
 * track gradient) are NOT semantic accents: a dragged value is not "better" or
 * "worse", so emerald/amber would read as judgment. Their thumb + fill use a
 * single theme-independent gray: zinc-400 reads as LIGHT gray on the dark
 * stage track (#1e1e1e) and as mid gray on the light track (#f1f1f1) — one
 * constant covers both themes (Tailwind's canonical disabled/neutral gray).
 */
const NEUTRAL_SLIDER_COLOR = "#a1a1aa";

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
  onFieldCommit,
}: {
  spec: SliderSpec;
  value: number;
  onDragStart: () => void;
  onDragChange: (v: number) => void;
  onDragEnd: () => void;
  onFieldCommit: (v: number) => void;
}) {
  // No semantic gradient (Blur / Edge Feather) → pass `undefined` so
  // FancySvgSlider takes its plain-track branch: a neutral track PLUS the
  // accent fill bar growing left→thumb on drag (the gradient branch suppresses
  // the fill bar). The old flat `--bg-stage` gradient fallback made these two
  // tracks read as solid black with zero drag feedback. Row height is set by
  // the shared `heightClass`, not the track, so alignment is unaffected.

  // Derive precision from step: step=1 → 0, step=0.1 → 1, step=0.01 → 2
  const precision = spec.step < 1 ? Math.ceil(-Math.log10(spec.step)) : 0;

  return (
    <div className="space-y-0.5 group">
      <span
        className="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-tight"
        title={spec.hint}
      >
        {spec.label}
      </span>
      <FancySvgSlider
        value={value}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        precision={precision}
        slim
        withInput
        ariaLabel={spec.label}
        trackGradient={spec.trackGradient}
        accentColor={
          spec.trackGradient ? accentForValue(spec.key, value) : NEUTRAL_SLIDER_COLOR
        }
        onDragStart={onDragStart}
        onChange={onDragChange}
        onDragEnd={onDragEnd}
        onFieldCommit={onFieldCommit}
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
  const {
    beginAdjustmentsEditCmd,
    updateAdjustmentsCmd,
    fastUpdateAdjustmentsCmd,
    commitAdjustmentsCmd,
    fastUpdateEdgeFeatherCmd,
    commitEdgeFeatherCmd,
    setEdgeFeatherCmd,
  } = usePluginCommands<AdjustmentDrawerCommandsMap>();
  const { activeLayer } = useAdjustmentDrawer();
  const gesture = useFilterGesture(beginAdjustmentsEditCmd);

  // Cascade (碎片联动羽化源洞): opt-in checkbox, shown only on cut fragments
  // that still carry the `assocMaskId` pointer to their source hole. When set,
  // every routed Edge Feather write ALSO updates the hole mask on the source
  // layer inside the same undo step (the command owns that write).
  const [cascade, setCascade] = useState(false);
  const showCascade = !!activeLayer?.metadata?.assocMaskId;

  // Cascade live preview (dual-write): BOTH sides of the complementary pair — the
  // fragment's routed carrier and the source hole's mask feather — ride the
  // volatile fast track per move (`fastUpdateEdgeFeatherCmd`) and land as ONE
  // batched Redux write at gesture end (`commitEdgeFeatherCmd`). The two drafts
  // merge in the SAME ticker tick, so the hole + fragment edges can never drift
  // apart mid-drag (the 120ms idle-flush seam this replaced was exactly that
  // drift, made visible as a gap between the live fragment edge and the
  // not-yet-feathered hole edge). The old throttle existed because a hole write
  // re-baked the source layer's mask at FULL-CANVAS cost; the vmask bake is
  // windowed now (hole-sized — see prepareVmaskSources `resolveVmaskWindow`),
  // so per-move hole updates are the same order as the fragment's.

  // Checkbox transition = an EDIT of its own: the hole's feather state follows
  // the checkbox unconditionally (checked → match the current radius, unchecked
  // → clear to 0 immediately), written hole-only (the fragment keeps its value)
  // inside a mini gesture so the transition is one undo step.
  const handleCascadeChange = useCallback(
    (checked: boolean) => {
      setCascade(checked);
      if (!activeLayer) return;
      gesture.begin();
      setEdgeFeatherCmd?.execute({
        radius: readEdgeFeather(activeLayer),
        holeOnly: true,
        hole: checked ? "match" : "clear",
      });
      gesture.end();
    },
    [activeLayer, gesture, setEdgeFeatherCmd],
  );

  const adjustments = useMemo(
    () => readAdjustments(activeLayer?.adjustments),
    [activeLayer?.adjustments],
  );

  // Which slider (if any) is currently being dragged. `null` = idle. Guards
  // against re-entrant `begin()` calls (some browsers fire pointerdown +
  // mousedown for the same interaction — we want ONE undo checkpoint).
  const dragRef = useRef<keyof AdjustmentState | null>(null);

  // Fast-track drag display: while a plain adjustments slider is dragged its
  // value rides the volatile buffer (no Redux write → no React re-render from
  // the store), so the thumb is fed from THIS local state until the gesture's
  // single commit lands the final value in Redux. Local state re-renders only
  // this panel — the expensive subscribers (canvas merge, engine) never see it.
  const [fastDrag, setFastDrag] = useState<{ key: keyof AdjustmentState; value: number } | null>(null);

  const commitPatch = useCallback(
    (key: keyof AdjustmentState, value: number) => {
      // Edge Feather is ROUTED, not a plain adjustments patch: the command
      // dispatches to the layer's actual edge carrier (visibleShape pad /
      // vectorMask feather / adjustments.edgeFeather). The hole side follows
      // the checkbox as its single source of truth: checked → 'match' on the
      // throttled flush (per-move otherwise 'none'); unchecked → 'clear'
      // enforced on every move (the command's `feather !== 0` guard makes the
      // follow-up moves free).
      if (key === "edgeFeather") {
        if (cascade) {
          // Checked drag (dual-write): fragment + hole parked on the fast track in
          // one dispatch — lockstep merge, no Redux/React storm. `fastDrag`
          // keeps the thumb honest (readEdgeFeather reads the store, which only
          // updates at commit).
          if (fastUpdateEdgeFeatherCmd && commitEdgeFeatherCmd) {
            fastUpdateEdgeFeatherCmd.execute({ radius: value });
            setFastDrag({ key, value });
            return;
          }
          setEdgeFeatherCmd?.execute({ radius: value, hole: "none" });
        } else {
          // Unchecked drag: the hole stays clear (the command's guard makes
          // this free once it already is).
          setEdgeFeatherCmd?.execute({ radius: value, hole: "clear" });
        }
        return;
      }
      // Fast track: park the merged value on the volatile buffer — the canvas
      // renders it live via mergeFrameSnapshot, with NO Redux dispatch / React
      // re-render per pointermove. One `commitAdjustments` write lands at drag
      // end (see handleDragEnd); `fastDrag` keeps the thumb honest meanwhile.
      // (Edge Feather above stays on the Redux path: its routed carrier writes
      // are structurally richer than a plain adjustments merge.)
      if (fastUpdateAdjustmentsCmd && commitAdjustmentsCmd) {
        fastUpdateAdjustmentsCmd.execute({ patch: { [key]: value } });
        setFastDrag({ key, value });
        return;
      }
      if (!updateAdjustmentsCmd) return;
      // Minimal `{ [key]: value }` patch — `updateAdjustments` shallow-merges
      // onto the current record (or DEFAULT_ADJUSTMENTS_STATE if the field is
      // undefined), so we never drop the other sliders' values.
      updateAdjustmentsCmd.execute({ patch: { [key]: value } });
    },
    [updateAdjustmentsCmd, fastUpdateAdjustmentsCmd, commitAdjustmentsCmd, fastUpdateEdgeFeatherCmd, commitEdgeFeatherCmd, setEdgeFeatherCmd, cascade],
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
    const draggedKey = dragRef.current;
    dragRef.current = null;
    // Land the fast-tracked draft(s) as ONE Redux write (the undo
    // checkpoint from gesture.begin owns the history step), then hand display
    // back to the store — the committed value equals the last fast-tracked
    // one, so there is no flicker at the handoff. Edge Feather flushes BOTH
    // drafts (fragment + source hole) via the batched commit.
    if (draggedKey === "edgeFeather") {
      // Motion was quantized to whole px — land the EXACT slider value in
      // one final fast write (no-op when it equals the parked quantized value)
      // so the committed state matches the slider, then flush both drafts.
      if (fastDrag && fastUpdateEdgeFeatherCmd) {
        fastUpdateEdgeFeatherCmd.execute({ radius: fastDrag.value });
      }
      commitEdgeFeatherCmd?.execute();
    } else {
      // Adjustments sliders: blur motion is quantized to 0.5σ — land the
      // exact final value (`exact` skips quantization) before the commit.
      if (fastDrag && fastUpdateAdjustmentsCmd) {
        fastUpdateAdjustmentsCmd.execute({
          patch: { [draggedKey]: fastDrag.value },
          exact: true,
        });
      }
      commitAdjustmentsCmd?.execute();
    }
    setFastDrag(null);
    gesture.end();
  }, [gesture, commitAdjustmentsCmd, commitEdgeFeatherCmd, fastUpdateEdgeFeatherCmd, fastUpdateAdjustmentsCmd, fastDrag]);

  // Numeric field commit: wraps in a mini gesture (begin → patch → end) so
  // each typed value is exactly one undo step, matching mixer.tsx pattern.
  const handleFieldCommit = useCallback(
    (key: keyof AdjustmentState) => (value: number) => {
      if (!activeLayer) return;
      gesture.begin();
      if (key === "edgeFeather") {
        // Single commit, no throttle — land the value directly; the hole
        // follows the checkbox state.
        setEdgeFeatherCmd?.execute({ radius: value, hole: cascade ? "match" : "clear" });
      } else {
        // Typed-value commit is a ONE-SHOT write — it must land in Redux
        // directly (the fast track has no dragEnd to commit it).
        if (!updateAdjustmentsCmd) return;
        updateAdjustmentsCmd.execute({ patch: { [key]: value } });
      }
      gesture.end();
    },
    [activeLayer, gesture, updateAdjustmentsCmd, setEdgeFeatherCmd, cascade],
  );

  // Belt-and-suspenders: if the panel unmounts mid-drag (e.g. tab switch to
  // Curves), close the gesture cleanly and land any pending cascade value.
  // Same guardrail the sibling panels use.
  useEffect(() => {
    return () => {
      const draggedKey = dragRef.current;
      if (draggedKey) {
        dragRef.current = null;
        // A fast-tracked drag interrupted by unmount must still land its
        // draft(s) — adjustments on their own, Edge Feather with its hole.
        if (draggedKey === "edgeFeather") commitEdgeFeatherCmd?.execute();
        else commitAdjustmentsCmd?.execute();
        setFastDrag(null);
        gesture.end();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col gap-2 px-2 pt-1 pb-1">
      <div className="space-y-2">
        {SLIDERS.map((spec) => (
          <React.Fragment key={spec.key}>
            <AdjustmentSliderRow
              spec={spec}
              value={
                // Fast-tracked drag value FIRST — readEdgeFeather/adjustments
                // read the STORE, which stays frozen until the gesture's single
                // commit (the thumb would otherwise not move at all).
                fastDrag?.key === spec.key
                  ? fastDrag.value
                  : spec.key === "edgeFeather" && activeLayer
                    ? readEdgeFeather(activeLayer)
                    : adjustments[spec.key] ?? identityFor(spec.key)
              }
              onDragStart={handleDragStart(spec.key)}
              onDragChange={handleDragChange(spec.key)}
              onDragEnd={handleDragEnd}
              onFieldCommit={handleFieldCommit(spec.key)}
            />
            {spec.key === "edgeFeather" && showCascade && (
              <label className="flex items-center gap-1.5 px-0.5 -mt-1 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={cascade}
                  onChange={(e) => handleCascadeChange(e.target.checked)}
                  className="size-3 accent-[var(--accent)]"
                />
                <span className="text-[9px] text-[var(--text-muted)]">
                  Feather source hole too (seamless rejoin)
                </span>
              </label>
            )}
          </React.Fragment>
        ))}
      </div>


    </div>
  );
}
