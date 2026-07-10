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

'use client';

import { EditorContextValue, EditorCommand } from '@opengpex/editor/core/types';
import type { CurvePoints, CurvesState, LevelsState, ChannelMixState, AdjustmentState } from '@opengpex/editor/core/types/models';
import * as P from './protocols';
import type {
  GradingTool,
  ColorGradingDrawerConfig,
  CurveChannel,
  LevelsPatch,
  ChannelMixPatch,
  ChannelMixPresetId,
  AdjustmentsPatch,
} from './protocols';





// ─── Shared Logic ──────────────────────────────────────────────────────────────

/**
 * Persists the active grading tool both to the shared signal (so other plugins
 * can observe it via `ColorGradingDrawerAPI.signals.activeTool`) and to
 * `pluginConfig` so the choice survives across editor sessions.
 *
 * We intentionally keep this a signal (not just pluginConfig) because switching
 * panels should trigger UI re-renders synchronously — pluginConfig by itself
 * doesn't force an immediate re-render of subscribers.
 */
function setActiveTool(ctx: EditorContextValue, tool: GradingTool) {
  ctx.scoped!.setSignal(P.SIGNAL_ACTIVE_GRADING_TOOL, tool);
  const cfg = ctx.scoped!.selfConfig as ColorGradingDrawerConfig | undefined;
  if (cfg?.lastTool !== tool) {
    ctx.scoped!.setSelfConfig({ lastTool: tool });
  }
}

// ─── Curves helpers ────────────────────────────────────────────────────────────

/**
 * Merge a channel-scoped `points` patch into `layer.curves` while keeping the
 * other channels intact. Writing `points === undefined` collapses the field
 * entirely (identity semantics from `IDENTITY_CURVE_POINTS`), which is what
 * `resetActivePanel` relies on to escape the AsyncFilterCache fast path.
 */
function mergeCurves(
  current: CurvesState | undefined,
  channel: CurveChannel,
  points: CurvePoints,
): CurvesState {
  return { ...(current ?? {}), [channel]: points };
}

/**
 * Insert a control point into a channel's points array while keeping the list
 * sorted by x and preventing exact-x duplicates (which would confuse the
 * cubic-spline evaluator downstream). Endpoints at x=0 / x=1 are kept because
 * they anchor the curve — new points can nudge in-between them.
 */
function insertPointSorted(
  points: CurvePoints,
  x: number,
  y: number,
): CurvePoints {
  const clampedX = Math.max(0, Math.min(1, x));
  const clampedY = Math.max(0, Math.min(1, y));
  const next: CurvePoints = [];
  let inserted = false;
  for (const p of points) {
    if (!inserted && p[0] > clampedX) {
      next.push([clampedX, clampedY]);
      inserted = true;
    }
    // Skip duplicates on x — the new point wins (Photoshop-style).
    if (p[0] === clampedX) continue;
    next.push([p[0], p[1]]);
  }
  if (!inserted) next.push([clampedX, clampedY]);
  return next;
}

// ─── Commands ──────────────────────────────────────────────────────────────────

/**
 * COLOR_GRADING_COMMANDS: Command definitions for the ColorGradingDrawer.
 *
 * Curves editing follows the gesture-based Undo coalescing pattern from spec
 * §5.6 (mirrors `AdjustmentDrawer`): `beginCurvesEdit` is the ONLY undoable
 * command — it takes a snapshot before the drag; `updateChannelCurve` /
 * `addCurvePoint` / `removeCurvePoint` run non-undoable so intermediate
 * `pointermove` writes collapse into a single history step at `pointerup`.
 *
 * Only reset & begin-edit commands carry `undoable: true` — Steps 6/7 will add
 * the corresponding `beginLevelsEdit` / `beginChannelMixEdit` following the
 * same shape.
 */
export const COLOR_GRADING_COMMANDS = {
  setTool: {
    id: P.CMD_SET_GRADING_TOOL,
    name: 'Switch Color Grading Tool',
    execute: (ctx: EditorContextValue, payload: { tool: GradingTool }) => {
      setActiveTool(ctx, payload.tool);
    },
  } as EditorCommand<{ tool: GradingTool }, void>,

  resetAll: {
    id: P.CMD_RESET_ALL_GRADING,
    name: 'Reset All Color Grading',
    undoable: true,
    execute: (ctx: EditorContextValue) => {
      const { activeFrame, activeLayer, actions } = ctx;
      if (!activeFrame || !activeLayer) return;
      // Setting to undefined removes the fields entirely so `hasAdvancedFilters`
      // returns false and the layer short-circuits back to the ctx.filter
      // fast path (spec §5.1 / §3.5).
      // Step 7.5: `adjustments` is now managed by the Basic panel inside this
      // same drawer, so "Reset All Color Grading" also wipes it. Previously
      // AdjustmentDrawer owned its own reset path; merging into a single
      // reset preserves the mental model "one panel = one reset button".
      actions.updateLayer(activeFrame.id, activeLayer.id, {
        adjustments: undefined,
        curves: undefined,
        levels: undefined,
        channelMix: undefined,
      });
    },
  } as EditorCommand<void, void>,

  resetActivePanel: {
    id: P.CMD_RESET_ACTIVE_PANEL,
    name: 'Reset Current Panel',
    undoable: true,
    execute: (ctx: EditorContextValue) => {
      const { activeFrame, activeLayer, actions, scoped } = ctx;
      if (!activeFrame || !activeLayer) return;
      const tool =
        (scoped!.getSignal(P.SIGNAL_ACTIVE_GRADING_TOOL, P.DEFAULT_GRADING_TOOL) as GradingTool) ??
        P.DEFAULT_GRADING_TOOL;
      // Switch (not chained ternaries) so Step 7.5's `'basic'` case reads
      // parallel to the existing three panels, and adding a fifth tool
      // later slots in without re-flowing the diff.
      let patch: Partial<Record<
        'adjustments' | 'curves' | 'levels' | 'channelMix',
        undefined
      >>;
      switch (tool) {
        case 'basic':
          patch = { adjustments: undefined };
          break;
        case 'curves':
          patch = { curves: undefined };
          break;
        case 'levels':
          patch = { levels: undefined };
          break;
        case 'mixer':
        default:
          patch = { channelMix: undefined };
          break;
      }
      actions.updateLayer(activeFrame.id, activeLayer.id, patch);
    },
  } as EditorCommand<void, void>,


  // ─── Curves-specific commands (Step 5) ───────────────────────────────────────
  //
  // These write to `layer.curves.{rgb|red|green|blue}`. `beginCurvesEdit` is
  // the Undo checkpoint — its execute body is intentionally empty because the
  // history plugin snapshots layer state on any undoable command dispatch
  // (spec §5.6 & AdjustmentDrawer parallel).

  beginCurvesEdit: {
    id: P.CMD_BEGIN_CURVES_EDIT,
    name: 'Begin Curves Edit',
    undoable: true,
    execute: () => {},
  } as EditorCommand<void, void>,

  updateChannelCurve: {
    id: P.CMD_UPDATE_CHANNEL_CURVE,
    name: 'Update Channel Curve',
    execute: (
      ctx: EditorContextValue,
      payload: { channel: CurveChannel; points: CurvePoints },
    ) => {
      const { activeFrame, activeLayer, actions } = ctx;
      if (!activeFrame || !activeLayer) return;
      actions.updateLayer(activeFrame.id, activeLayer.id, {
        curves: mergeCurves(activeLayer.curves, payload.channel, payload.points),
      });
    },
  } as EditorCommand<{ channel: CurveChannel; points: CurvePoints }, void>,

  addCurvePoint: {
    id: P.CMD_ADD_CURVE_POINT,
    name: 'Add Curve Control Point',
    execute: (
      ctx: EditorContextValue,
      payload: { channel: CurveChannel; x: number; y: number },
    ) => {
      const { activeFrame, activeLayer, actions } = ctx;
      if (!activeFrame || !activeLayer) return;
      // Read current channel points; fall back to identity endpoints so the
      // very first add creates a proper 3-point curve.
      const currentChannelPts =
        activeLayer.curves?.[payload.channel] ??
        P.IDENTITY_CURVE_POINTS.map((p) => [p[0], p[1]] as [number, number]);
      const nextPts = insertPointSorted(currentChannelPts, payload.x, payload.y);
      actions.updateLayer(activeFrame.id, activeLayer.id, {
        curves: mergeCurves(activeLayer.curves, payload.channel, nextPts),
      });
    },
  } as EditorCommand<{ channel: CurveChannel; x: number; y: number }, void>,

  removeCurvePoint: {
    id: P.CMD_REMOVE_CURVE_POINT,
    name: 'Remove Curve Control Point',
    execute: (
      ctx: EditorContextValue,
      payload: { channel: CurveChannel; index: number },
    ) => {
      const { activeFrame, activeLayer, actions } = ctx;
      if (!activeFrame || !activeLayer) return;
      const currentPts: CurvePoints | undefined = activeLayer.curves?.[payload.channel];
      if (!currentPts || currentPts.length <= 2) {
        // Endpoints (index 0 and last) are non-removable — a 2-point curve is
        // already the identity shape; going below 2 points would be undefined.
        return;
      }
      // Additionally guard against removing the strict endpoints, which
      // anchor the domain to [0, 1].
      if (payload.index <= 0 || payload.index >= currentPts.length - 1) return;
      const nextPts: CurvePoints = currentPts.filter(
        (_pt: [number, number], i: number) => i !== payload.index,
      );
      actions.updateLayer(activeFrame.id, activeLayer.id, {
        curves: mergeCurves(activeLayer.curves, payload.channel, nextPts),
      });
    },
  } as EditorCommand<{ channel: CurveChannel; index: number }, void>,

  // ─── Levels-specific commands (Step 6) ───────────────────────────────────────
  //
  // These write to `layer.levels`. The interaction pattern mirrors Curves:
  // `beginLevelsEdit` snapshots layer state as the undoable checkpoint;
  // `updateLevels` fires non-undoable during pointer drags so the run of
  // intermediate writes coalesces into a single history entry at pointerup
  // (spec §5.6 gesture-based coalescing).
  //
  // `autoLevels` is a one-shot: the panel already owns the histogram, so it
  // computes the 0.1 / 99.9 percentile inputBlack/inputWhite locally and hands
  // both values in through the payload. We keep the command undoable so a
  // single "Auto Levels" click is one undo step; gamma & output range are
  // preserved (Photoshop convention).

  beginLevelsEdit: {
    id: P.CMD_BEGIN_LEVELS_EDIT,
    name: 'Begin Levels Edit',
    undoable: true,
    execute: () => {},
  } as EditorCommand<void, void>,

  updateLevels: {
    id: P.CMD_UPDATE_LEVELS,
    name: 'Update Levels',
    execute: (
      ctx: EditorContextValue,
      payload: { patch: LevelsPatch },
    ) => {
      const { activeFrame, activeLayer, actions } = ctx;
      if (!activeFrame || !activeLayer) return;
      // Merge onto whatever exists (starting from DEFAULT_LEVELS_STATE the
      // first time). This keeps `hasAdvancedFilters()` correctly tripping the
      // moment any field deviates from identity, and ensures a partial patch
      // never accidentally drops the other three fields.
      const current = activeLayer.levels ?? P.DEFAULT_LEVELS_STATE;
      const next: LevelsState = { ...current, ...payload.patch };
      actions.updateLayer(activeFrame.id, activeLayer.id, { levels: next });
    },
  } as EditorCommand<{ patch: LevelsPatch }, void>,


  autoLevels: {
    id: P.CMD_AUTO_LEVELS,
    name: 'Auto Levels',
    undoable: true,
    execute: (
      ctx: EditorContextValue,
      payload: { inputBlack: number; inputWhite: number },
    ) => {
      const { activeFrame, activeLayer, actions } = ctx;
      if (!activeFrame || !activeLayer) return;
      const current = activeLayer.levels ?? P.DEFAULT_LEVELS_STATE;
      // Clamp defensively — the panel is expected to already clamp, but a
      // corrupt histogram (e.g. all-zero layer) shouldn't be able to write an
      // out-of-range value to layer state.
      const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
      const ib = clamp(Math.round(payload.inputBlack));
      const iw = clamp(Math.round(payload.inputWhite));
      // Refuse to invert the range: a degenerate `ib >= iw` would hard-clip
      // the whole tonal range (see `generateLevelsLUT` degenerate branch).
      // Fall back to no-op if the histogram couldn't produce a valid split.
      if (iw <= ib) return;
      const next: LevelsState = {
        ...current,
        inputBlack: ib,
        inputWhite: iw,
      };
      actions.updateLayer(activeFrame.id, activeLayer.id, { levels: next });
    },
  } as EditorCommand<{ inputBlack: number; inputWhite: number }, void>,

  // ─── Channel Mixer commands (Step 7) ─────────────────────────────────────────
  //
  // Same gesture-coalescing shape as Curves & Levels. `beginChannelMixEdit`
  // is the undoable checkpoint (empty body — history plugin snapshots layer
  // state on any undoable dispatch). `updateChannelMix` deep-merges its
  // partial patch onto whatever's currently on `layer.channelMix` (falling
  // back to the identity matrix so a fresh layer's first slider tweak
  // produces a fully-formed `ChannelMixState`). `applyChannelMixPreset` is
  // the one-shot preset switch — undoable so a preset click is a single
  // history entry, and `'none'` clears the field entirely so
  // `hasAdvancedFilters()` short-circuits (same trick `resetActivePanel`
  // uses).

  beginChannelMixEdit: {
    id: P.CMD_BEGIN_CHANNEL_MIX_EDIT,
    name: 'Begin Channel Mix Edit',
    undoable: true,
    execute: () => {},
  } as EditorCommand<void, void>,

  updateChannelMix: {
    id: P.CMD_UPDATE_CHANNEL_MIX,
    name: 'Update Channel Mix',
    execute: (
      ctx: EditorContextValue,
      payload: { patch: ChannelMixPatch },
    ) => {
      const { activeFrame, activeLayer, actions } = ctx;
      if (!activeFrame || !activeLayer) return;
      const current = activeLayer.channelMix ?? P.DEFAULT_CHANNEL_MIX_STATE;
      // Shallow merge is enough because the patch's rows are whole triples —
      // callers write a full `[r,g,b]` per row rather than nudging a single
      // coefficient. Same for `constant`. This keeps the merge O(1) and
      // avoids the deep-clone cost that comes with row-level assignment.
      const next: ChannelMixState = { ...current, ...payload.patch };
      actions.updateLayer(activeFrame.id, activeLayer.id, { channelMix: next });
    },
  } as EditorCommand<{ patch: ChannelMixPatch }, void>,

  applyChannelMixPreset: {
    id: P.CMD_APPLY_CHANNEL_MIX_PRESET,
    name: 'Apply Channel Mix Preset',
    undoable: true,
    execute: (
      ctx: EditorContextValue,
      payload: { presetId: ChannelMixPresetId },
    ) => {
      const { activeFrame, activeLayer, actions } = ctx;
      if (!activeFrame || !activeLayer) return;
      // `'none'` clears the field entirely — treated exactly like a
      // reset from the render pipeline's perspective (short-circuits
      // `hasAdvancedFilters()` back to the ctx.filter fast path).
      if (payload.presetId === 'none') {
        actions.updateLayer(activeFrame.id, activeLayer.id, {
          channelMix: undefined,
        });
        return;
      }
      const preset = P.CHANNEL_MIX_PRESETS[payload.presetId];
      if (!preset) return; // Silently ignore unknown IDs.
      // Wholesale replacement — presets are complete matrices, not diffs.
      // We deep-clone the tuples so subsequent shallow mutations on the
      // layer state can't leak into the shared preset table.
      const next: ChannelMixState = {
        red: [preset.red[0], preset.red[1], preset.red[2]],
        green: [preset.green[0], preset.green[1], preset.green[2]],
        blue: [preset.blue[0], preset.blue[1], preset.blue[2]],
        constant: preset.constant
          ? [preset.constant[0], preset.constant[1], preset.constant[2]]
          : [0, 0, 0],
      };
      actions.updateLayer(activeFrame.id, activeLayer.id, { channelMix: next });
    },
  } as EditorCommand<{ presetId: ChannelMixPresetId }, void>,

  // ─── Basic Adjustments commands (Step 7.5 — migrated from AdjustmentDrawer) ─
  //
  // Mirrors the Levels / Channel-Mix shape but writes into `layer.adjustments`
  // rather than `layer.curves|levels|channelMix`. Semantically these are the
  // "fast-path" filters — the Canvas2D painter feeds them straight into
  // `ctx.filter` (see `getAdjustmentsData()` in backends/canvas2d/painter.ts)
  // and `hasAdvancedFilters(layer)` deliberately IGNORES `layer.adjustments`,
  // so a Basic-only edit never spawns a worker roundtrip. When Basic is
  // combined with Curves/Levels/Mixer, `normalizeFilterDescriptors` folds
  // adjustments into the same filter chain and the painter side sees
  // `effectiveLayer = { ...layer, adjustments: undefined }` to avoid a second
  // application (spec §5.1 & §Step 7.5 序言 "引擎行为不变").

  beginAdjustmentsEdit: {
    id: P.CMD_BEGIN_ADJUSTMENTS_EDIT,
    name: 'Begin Basic Adjustments Edit',
    undoable: true,
    execute: () => {},
  } as EditorCommand<void, void>,

  updateAdjustments: {
    id: P.CMD_UPDATE_ADJUSTMENTS,
    name: 'Update Basic Adjustments',
    execute: (
      ctx: EditorContextValue,
      payload: { patch: AdjustmentsPatch },
    ) => {
      const { activeFrame, activeLayer, actions } = ctx;
      if (!activeFrame || !activeLayer) return;
      // Merge onto the identity baseline so a partial patch (e.g. only
      // brightness) never accidentally erases the other four values. This
      // also keeps `getAdjustmentsData()` happy — it expects a fully-formed
      // AdjustmentState with all five keys populated.
      const current = (activeLayer.adjustments ?? P.DEFAULT_ADJUSTMENTS_STATE) as AdjustmentState;
      const next: AdjustmentState = { ...current, ...payload.patch };
      actions.updateLayer(activeFrame.id, activeLayer.id, { adjustments: next });
    },
  } as EditorCommand<{ patch: AdjustmentsPatch }, void>,
} as const;



