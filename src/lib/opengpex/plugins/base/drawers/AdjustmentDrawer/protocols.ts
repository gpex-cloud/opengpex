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

/**
 * AdjustmentDrawer Plugin Protocols
 *
 * Defines constants and type contracts for the unified adjustment panel.
 * AdjustmentDrawer is a single sidebar Drawer that switches internally between
 * three sub-panels (Curves / Levels / Channel Mixer) via an icon-button group at
 * the panel header — mirroring the visual pattern used by CraftDrawer.
 *
 * Design decisions (spec 20260604_filter_pipeline_architecture_spec.md §4):
 * - §4.1 single plugin + icon-switch — three tools share one Drawer slot instead
 *   of occupying three separate sidebar icons.
 * - §4.2 mutually-exclusive panels — the icon group at the top-right selects one
 *   of `curves | levels | mixer` and the corresponding body renders.
 * - §4.3 NO keyboard shortcuts on the switch — this differentiates it from
 *   CraftDrawer (T/B/E shortcuts) because adjustment is a mouse-heavy
 *   workflow and stealing single-letter keys pollutes the global shortcut map.
 * - §4.4 AdjustmentDrawer stays a separate plugin for now; a future Step 7.5
 *   will migrate its basic sliders in as a fourth 'basic' tab.
 * - §4.6 layer data model — panels write into `layer.curves / .levels /
 *   .channelMix` (already declared in `core/types/models.ts`). Filter dispatch
 *   happens in `Canvas2dEngine.drawLayerDirect()` (spec §3.5); this plugin is
 *   pure UI + state writer and does NOT know about the render backend.
 */

import type { CurvePoints, CurvesState, LevelsState, ChannelMixState, AdjustmentState } from '@opengpex/editor/core/types/models';

/**
 * Re-export `CurvePoints` from the domain model so the auto-generated
 * `commands.d.ts` (which only scans `protocols.ts` for type exports) can wire
 * up a proper `CommandInstance<{ points: CurvePoints }>` for the curves
 * commands. Panels can therefore import both `CurveChannel` (defined here)
 * and `CurvePoints` (re-exported here) from a single path.
 *
 * `LevelsState` is re-exported for the same reason: Step 6 commands
 * (`updateLevels`) carry a `Partial<LevelsState>` payload, and the
 * gen-plugin-types script needs to resolve that identifier locally.
 *
 * `AdjustmentState` (Step 7.5) is the migrated payload shape of the old
 * AdjustmentDrawer's basic slider bank (brightness / contrast / saturation /
 * hueRotate / blur). Panels write it through `updateAdjustments({ patch:
 * AdjustmentsPatch })` on the Basic sub-panel.
 */
export type { CurvePoints, LevelsState, ChannelMixState, AdjustmentState };


/**
 * Partial-shaped patch of `LevelsState` for the `updateLevels` command
 * payload. Extracted into a named alias (rather than inlining
 * `Partial<LevelsState>` in the command's generic) because the plugin
 * type-generator's regex-based scanner in `scripts/gen-plugin-types.mjs`
 * can't currently balance nested `<>` (e.g. `EditorCommand<{ patch:
 * Partial<LevelsState> }, void>` gets clipped at the inner `>`). Using a
 * plain identifier here sidesteps that limitation without changing the
 * runtime semantics — `Partial<LevelsState>` and `LevelsPatch` are structurally
 * identical.
 */
export type LevelsPatch = Partial<LevelsState>;

/**
 * Same rationale as `LevelsPatch`: `updateChannelMix` carries a partial
 * matrix patch (any subset of `red / green / blue / constant`). The
 * command-type scanner in `scripts/gen-plugin-types.mjs` truncates at nested
 * `>`, so we thread the payload through this named alias.
 */
export type ChannelMixPatch = Partial<ChannelMixState>;

/**
 * Partial-shaped patch of `AdjustmentState` for the `updateAdjustments`
 * command payload (Step 7.5 — migrated from the old AdjustmentDrawer).
 * Same named-alias trick as `LevelsPatch` / `ChannelMixPatch` so the
 * `scripts/gen-plugin-types.mjs` regex scanner can resolve the payload
 * without tripping on nested `<>`.
 */
export type AdjustmentsPatch = Partial<AdjustmentState>;





export const PLUGIN_ID = 'drawers.adjustments';
export const PLUGIN_AUTHOR = 'opengpex';

// ─── Signal IDs ────────────────────────────────────────────────────────────────

/**
 * Currently active grading tool selected in the drawer header (mutually
 * exclusive). Defaults to `'curves'` on first mount — spec §4.2.
 *
 * Kept as a `public` signal so that other plugins (e.g. a future ChannelMixer
 * quick-toggle in ColorOptions) can read/write it, following the same pattern
 * as `CraftDrawerAPI.signals.activeCraft`.
 */
export const SIGNAL_ACTIVE_GRADING_TOOL = 'signal.active_grading_tool';

// ─── Command IDs ───────────────────────────────────────────────────────────────

/** Switch to a specific grading tool (payload: `{ tool: GradingTool }`). */
export const CMD_SET_GRADING_TOOL = 'cmd.set_grading_tool';

/** Reset all grading state on the active layer (curves + levels + channelMix). */
export const CMD_RESET_ALL_GRADING = 'cmd.reset_all_grading';

/** Reset only the currently-visible sub-panel's state on the active layer. */
export const CMD_RESET_ACTIVE_PANEL = 'cmd.reset_active_panel';

// ─── Curves commands (Step 5) ──────────────────────────────────────────────────
//
// `beginCurvesEdit` is the Undo checkpoint (undoable command with empty body,
// following the AdjustmentDrawer pattern). The write commands
// (`updateChannelCurve` / `addCurvePoint` / `removeCurvePoint`) are non-undoable
// so a drag's `pointermove` train coalesces into a single history step at
// `pointerup` (spec §5.6 gesture-based coalescing).

/** Snapshot current layer state before a curve-edit gesture starts. */
export const CMD_BEGIN_CURVES_EDIT = 'cmd.begin_curves_edit';

/** Replace all points of a single channel's curve. Payload: `{channel, points}`. */
export const CMD_UPDATE_CHANNEL_CURVE = 'cmd.update_channel_curve';

/** Insert a control point on a channel curve. Payload: `{channel, x, y}` (all 0..1). */
export const CMD_ADD_CURVE_POINT = 'cmd.add_curve_point';

/** Remove an interior control point. Payload: `{channel, index}`. Endpoints protected. */
export const CMD_REMOVE_CURVE_POINT = 'cmd.remove_curve_point';

// ─── Levels commands (Step 6) ──────────────────────────────────────────────────
//
// Same pattern as Curves: `beginLevelsEdit` is the undoable checkpoint (empty
// body), `updateLevels` is the non-undoable state writer coalesced by
// `useFilterGesture()`, and `autoLevels` is a one-shot convenience command
// that internally begins its own gesture (single history step).

/** Snapshot current layer state before a levels-edit gesture starts. */
export const CMD_BEGIN_LEVELS_EDIT = 'cmd.begin_levels_edit';

/** Patch `layer.levels`. Payload: `{ patch: Partial<LevelsState> }`. Non-undoable. */
export const CMD_UPDATE_LEVELS = 'cmd.update_levels';

/**
 * Auto-Levels: compute inputBlack/inputWhite from the layer's own histogram
 * (0.1 / 99.9 percentile — Photoshop convention) and atomically write both.
 * Undoable; gamma & output range are preserved.
 * Payload: `{ inputBlack: number; inputWhite: number }` (values computed by
 * the panel, which already owns the histogram).
 */
export const CMD_AUTO_LEVELS = 'cmd.auto_levels';

// ─── Channel Mixer commands (Step 7) ───────────────────────────────────────────
//
// Same shape as Curves / Levels: `beginChannelMixEdit` is the undoable
// checkpoint fired by `useFilterGesture()` at the start of a drag;
// `updateChannelMix` is the non-undoable state writer coalesced across the
// gesture; and `applyChannelMixPreset` is a one-shot undoable command that
// atomically writes a preset matrix (single Undo step per preset switch).

/** Snapshot current layer state before a channel-mix-edit gesture starts. */
export const CMD_BEGIN_CHANNEL_MIX_EDIT = 'cmd.begin_channel_mix_edit';

/** Patch `layer.channelMix`. Payload: `{ patch: ChannelMixPatch }`. Non-undoable. */
export const CMD_UPDATE_CHANNEL_MIX = 'cmd.update_channel_mix';

/** Atomically write a built-in channel-mix preset. Payload: `{ presetId }`. Undoable. */
export const CMD_APPLY_CHANNEL_MIX_PRESET = 'cmd.apply_channel_mix_preset';

// ─── Basic Adjustments commands (Step 7.5 — migrated from AdjustmentDrawer) ───
//
// Mirrors the Curves / Levels / Channel-Mixer shape: `beginAdjustmentsEdit`
// is the undoable checkpoint (empty body — fires purely so the TimeTraveler
// records a snapshot before mutation), and `updateAdjustments` is the
// non-undoable state writer coalesced across the drag by
// `useFilterGesture(beginAdjustmentsEditCmd)`. Numeric-field commits use the
// `commitAtomic()` mini-gesture pattern to bookend a single undo step per
// keyboard commit.
//
// Design note: we do NOT preserve the old AdjustmentDrawer's per-property
// commands (`updateBrightness / updateContrast / …`) because a `git grep`
// audit showed zero external consumers (spec §Step 7.5 decision "Option B" —
// merge into one `updateAdjustments({ patch })`). If a future integration
// needs the granular ids, we can add thin forwarders here without breaking
// the state pipeline.

/** Snapshot current layer state before an adjustments-edit gesture starts. */
export const CMD_BEGIN_ADJUSTMENTS_EDIT = 'cmd.begin_adjustments_edit';

/** Patch `layer.adjustments`. Payload: `{ patch: AdjustmentsPatch }`. Non-undoable. */
export const CMD_UPDATE_ADJUSTMENTS = 'cmd.update_adjustments';


// ─── Types ─────────────────────────────────────────────────────────────────────



/**
 * Which sub-panel is currently visible in the AdjustmentDrawer body.
 *
 * Step 7.5 extended the union with `'basic'` — the merged AdjustmentDrawer
 * (brightness / contrast / saturation / hueRotate / blur sliders). It is
 * intentionally listed FIRST because Photoshop / Lightroom convention is to
 * expose the entry-level adjustments before Curves/Levels/Mixer, and we
 * default new documents to it via `DEFAULT_GRADING_TOOL` below.
 *
 * Backwards-compatibility note: `pluginConfig.lastTool` may hold a legacy
 * value of `'curves' | 'levels' | 'mixer'` from before Step 7.5 shipped;
 * those values remain part of the union so persisted preferences continue
 * to round-trip without needing a migration.
 */
export type GradingTool = 'basic' | 'curves' | 'levels' | 'mixer';


/** Which per-channel curve is being edited inside the Curves panel. */
export type CurveChannel = 'rgb' | 'red' | 'green' | 'blue';

/**
 * Which output channel the Channel Mixer panel is currently editing.
 *
 * NOTE: unlike `CurveChannel`, there is no `'rgb'` master here — Channel Mixer
 * is a strict 3x3 matrix operator, each output channel is edited
 * independently. The `monochrome` toggle on `ChannelMixState` (see below)
 * mirrors the same row into all three outputs at write time, but the "which
 * row are we editing" UI concept remains R / G / B.
 */
export type ChannelMixOutput = 'red' | 'green' | 'blue';

/**
 * Built-in Channel Mixer presets. `'none'` is the reset-to-identity choice
 * (equivalent to `resetActivePanel` from the Mixer's perspective and is what
 * the dropdown highlights when the current mix has been reset).
 *
 * The four B&W variants + Sepia + CrossProcess + PhotoNegative are the same
 * pre-baked matrices Photoshop ships in its Channel Mixer dropdown. See
 * `CHANNEL_MIX_PRESETS` below for the actual coefficients.
 */
export type ChannelMixPresetId =
  | 'none'
  | 'bwRed'
  | 'bwGreen'
  | 'bwBlue'
  | 'sepia'
  | 'crossProcess'
  | 'photoNegative';


/** Signal value type (never null — unlike CraftDrawer, we always have one tool selected). */
export type ActiveGradingTool = GradingTool;

/**
 * Default sub-panel when the plugin first mounts.
 *
 * Step 7.5 changed this from `'curves'` to `'basic'` to align with the
 * Photoshop / Lightroom onboarding convention: entry-level users should see
 * the familiar brightness / contrast / saturation sliders first, and only
 * dive into Curves/Levels/Mixer when they need pixel-precise tonal control.
 */
export const DEFAULT_GRADING_TOOL: GradingTool = 'basic';


/**
 * Plugin-local pluginConfig storage.
 *
 * We persist the last-picked tool per user, so re-opening the drawer restores
 * their preferred workspace (Photoshop / Lightroom convention). Actual grading
 * state lives on the Layer (`layer.curves / .levels / .channelMix`), NOT here.
 */
export interface AdjustmentDrawerConfig {
  /** Remembered sub-panel across sessions (persisted via `pluginConfig`). */
  lastTool?: GradingTool;
}

// ─── Cross-Plugin Typed Facade ─────────────────────────────────────────────────

/**
 * AdjustmentDrawerAPI: Structured facade for external plugins.
 *
 * Usage:
 *   import { AdjustmentDrawerAPI } from '../../drawers/AdjustmentDrawer/protocols';
 *   state.interaction.signals[AdjustmentDrawerAPI.signals.activeTool];
 *   actions.executeCommand(AdjustmentDrawerAPI.commands.resetAll.uid);
 */
export const AdjustmentDrawerAPI = {
  signals: {
    /** Currently active grading sub-panel. */
    activeTool: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SIGNAL_ACTIVE_GRADING_TOOL}` as const,
  },
  commands: {
    /** Switch active sub-panel. Payload: `{ tool: GradingTool }`. */
    setTool: {
      uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_SET_GRADING_TOOL}`,
    } as { uid: string; _payload: { tool: GradingTool } },
    /** Reset all grading state on active layer. */
    resetAll: {
      uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_RESET_ALL_GRADING}`,
    } as { uid: string; _payload: void },
    /** Reset current sub-panel only. */
    resetActivePanel: {
      uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_RESET_ACTIVE_PANEL}`,
    } as { uid: string; _payload: void },
  },
  /** pluginConfig storage key. */
  configKey: `${PLUGIN_AUTHOR}.${PLUGIN_ID}` as const,
} as const;

// ─── Default Grading States ────────────────────────────────────────────────────
//
// These "identity" values match the semantics used by `filters/lut.ts` and
// `normalizeDescriptors.ts::hasAdvancedFilters()`. Writing any of these to
// `layer.curves / .levels / .channelMix` is a no-op as far as the render
// pipeline is concerned (short-circuited by `hasAdvancedFilters()`), so panels
// can safely populate the layer field on first user interaction without
// spawning a worker roundtrip until the user actually deviates from identity.

/** Identity curve: straight line from (0,0) to (1,1) — no tone change. */
export const IDENTITY_CURVE_POINTS: [number, number][] = [
  [0, 0],
  [1, 1],
];

export const DEFAULT_CURVES_STATE: CurvesState = {
  rgb: [...IDENTITY_CURVE_POINTS.map(p => [...p] as [number, number])],
};

/** Identity levels: full range in → full range out, gamma 1.0. */
export const DEFAULT_LEVELS_STATE: LevelsState = {
  inputBlack: 0,
  inputWhite: 255,
  gamma: 1.0,
  outputBlack: 0,
  outputWhite: 255,
};

/** Identity channel mix: R←R, G←G, B←B, zero offset. */
export const DEFAULT_CHANNEL_MIX_STATE: ChannelMixState = {
  red: [1, 0, 0],
  green: [0, 1, 0],
  blue: [0, 0, 1],
  constant: [0, 0, 0],
};

/**
 * Identity adjustments (Step 7.5 — migrated from AdjustmentDrawer):
 * - brightness / contrast / saturation are Photoshop-style percentages where
 *   `100` means "no change" (matches the `ctx.filter` CSS convention),
 * - `hueRotate` at 0° is the identity rotation,
 * - `blur` at 0px is the identity kernel.
 *
 * Writing this exact record to `layer.adjustments` is equivalent to clearing
 * the field — the painter's `getAdjustmentsData()` (see backends/canvas2d/
 * painter.ts) returns `'none'` when all five values equal their identity,
 * so no `ctx.filter` string is applied. The Basic panel's reset therefore
 * writes `undefined` instead (single source of truth: no adjustments record
 * on the layer at all), matching how Curves/Levels/ChannelMix panels reset.
 */
export const DEFAULT_ADJUSTMENTS_STATE: AdjustmentState = {
  brightness: 100,
  contrast: 100,
  saturation: 100,
  hueRotate: 0,
  blur: 0,
};


// ─── Channel Mixer presets ────────────────────────────────────────────────────
//
// The matrices below match Photoshop's dropdown presets — sourced from Adobe's
// own documentation of the Channel Mixer's built-in "Preset" menu. Each entry
// is a fully-formed `ChannelMixState` (all three rows explicit, `constant`
// zero unless the preset intentionally biases the tone). Applying a preset
// is a single undoable command (`applyChannelMixPreset`); the panel does NOT
// merge these into the existing state — a preset switch is a wholesale
// replacement, matching Photoshop's behaviour.
//
// The three B&W presets all set `red = green = blue = <row>` because that is
// exactly what a "monochrome mixer" does: same weighted sum written to every
// output channel. `constant` is `[0,0,0]` for these because the classic B&W
// weight rows already sum to 1.0 (no brightness drift). Sepia biases the
// green / blue output rows down to warm the mid-tones; Cross-Process bends
// R↔B for that cyan-magenta look; Photo Negative just inverts the identity.

/** Display label for a `ChannelMixPresetId` (used in the panel's dropdown). */
export const CHANNEL_MIX_PRESET_LABELS: Record<ChannelMixPresetId, string> = {
  none: 'None',
  bwRed: 'B&W: Red Filter',
  bwGreen: 'B&W: Green Filter',
  bwBlue: 'B&W: Blue Filter',
  sepia: 'Sepia',
  crossProcess: 'Cross Process',
  photoNegative: 'Photo Negative',
};

/**
 * Preset matrices. `'none'` maps to identity — used by the panel when the
 * user picks "None" from the dropdown; the command layer treats it the same
 * as clearing `layer.channelMix` (so `hasAdvancedFilters()` short-circuits).
 *
 * The Rec.601 luminance weights (0.299 / 0.587 / 0.114) drive the "B&W:
 * <color> Filter" family: swapping *which* input channel gets the dominant
 * weight simulates the effect of shooting through a physical colored filter
 * on B&W film. Cross-Process uses a classic 1970s "swap red/blue with a
 * green pump" recipe; Sepia's constant offset warms the whole image toward
 * antique-photo tones.
 */
export const CHANNEL_MIX_PRESETS: Record<ChannelMixPresetId, ChannelMixState> = {
  none: {
    red: [1, 0, 0],
    green: [0, 1, 0],
    blue: [0, 0, 1],
    constant: [0, 0, 0],
  },
  // "B&W: Red Filter" — Photoshop's default B&W preset. Bright reds (skin,
  // brick, sunset) render lighter; blues (sky) darken dramatically.
  bwRed: {
    red: [1, 0, 0],
    green: [1, 0, 0],
    blue: [1, 0, 0],
    constant: [0, 0, 0],
  },
  // "B&W: Green Filter" — foliage / grass pops; skin tones soften.
  bwGreen: {
    red: [0, 1, 0],
    green: [0, 1, 0],
    blue: [0, 1, 0],
    constant: [0, 0, 0],
  },
  // "B&W: Blue Filter" — dramatic skies, deep contrast in cloud cover.
  bwBlue: {
    red: [0, 0, 1],
    green: [0, 0, 1],
    blue: [0, 0, 1],
    constant: [0, 0, 0],
  },
  // Sepia — Rec.601 luminance in R, warm-shifted for G/B via reduced green
  // and blue transmission plus a mild warm constant offset in R & G.
  sepia: {
    red: [0.393, 0.769, 0.189],
    green: [0.349, 0.686, 0.168],
    blue: [0.272, 0.534, 0.131],
    constant: [0, 0, 0],
  },
  // Cross Process — 1970s film-emulation look: pushes reds up in the red
  // output and slightly desaturates by pulling from all three channels, with
  // a green-magenta imbalance familiar from process-shift photos.
  crossProcess: {
    red: [1.15, -0.10, 0],
    green: [-0.05, 1.10, 0],
    blue: [0.05, -0.10, 1.20],
    constant: [0, 0, 0],
  },
  // Photo Negative — each channel becomes its algebraic complement. Constant
  // 1.0 shifts the whole thing back into [0,1] so this reads as a proper
  // "invert" without needing a separate `mode: negate` flag.
  photoNegative: {
    red: [-1, 0, 0],
    green: [0, -1, 0],
    blue: [0, 0, -1],
    constant: [1, 1, 1],
  },
};

/** Ordered ID list — used by the panel to render the dropdown in a fixed order. */
export const CHANNEL_MIX_PRESET_ORDER: ChannelMixPresetId[] = [
  'none',
  'bwRed',
  'bwGreen',
  'bwBlue',
  'sepia',
  'crossProcess',
  'photoNegative',
];

