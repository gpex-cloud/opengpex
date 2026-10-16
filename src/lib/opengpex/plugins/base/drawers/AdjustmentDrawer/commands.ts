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
import type { Layer } from '@opengpex/editor/core/types';
import type { CurvePoints, CurvesState, LevelsState, ChannelMixState, ColorBalanceState, AdjustmentState } from '@opengpex/editor/core/types/models';
import { resolveEdgeFeatherRoute, buildFeatherRepadPatch } from '@opengpex/editor/core/layer/services/fragment';
import * as P from './protocols';
import type {
  GradingTool,
  AdjustmentDrawerConfig,
  CurveChannel,
  LevelsPatch,
  ChannelMixPatch,
  ChannelMixPresetId,
  AdjustmentsPatch,
  ColorBalancePatch,
} from './protocols';





// ─── Shared Logic ──────────────────────────────────────────────────────────────

/**
 * Persists the active grading tool both to the shared signal (so other plugins
 * can observe it via `usePluginSignals`) and to `pluginConfig` so the choice
 * survives across editor sessions.
 *
 * We intentionally keep this a signal (not just pluginConfig) because switching
 * panels should trigger UI re-renders synchronously — pluginConfig by itself
 * doesn't force an immediate re-render of subscribers.
 */
function setActiveTool(ctx: EditorContextValue, tool: GradingTool) {
  ctx.scoped!.setSignal(P.SIGNAL_ACTIVE_GRADING_TOOL, tool);
  const cfg = ctx.scoped!.selfConfig as AdjustmentDrawerConfig | undefined;
  if (cfg?.lastTool !== tool) {
    ctx.scoped!.setSelfConfig({ lastTool: tool });
  }
}

/**
 * Open the AdjustmentDrawer (ensure it's in activeSidebarIds) and switch to
 * the specified grading tool sub-panel. Used by keyboard shortcut commands.
 */
function openDrawerWithTool(ctx: EditorContextValue, tool: GradingTool) {
  if (!ctx.activeFrame) return;

  // 1. Ensure drawer is open
  const pluginUid = `${P.PLUGIN_AUTHOR}.${P.PLUGIN_ID}`;
  const currentIds = ctx.state.ui.activeSidebarIds || [];
  if (!currentIds.includes(pluginUid)) {
    ctx.actions.updateUI({ activeSidebarIds: [...currentIds, pluginUid] });
  }

  // 2. Switch to the target tool panel
  setActiveTool(ctx, tool);
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
 * Zero the layer's Edge Feather across ALL its carriers, honouring the route.
 * Reset semantics: this layer's feather back to identity — the source hole (a
 * different layer) stays owned by the cascade checkbox, not the reset button.
 * Returns `undefined` when there is nothing to clear (the routed carrier is
 * already at 0), so callers can spread it into their patch unconditionally.
 */
function clearEdgeFeatherPatch(layer: Layer): Partial<Layer> | undefined {
  const route = resolveEdgeFeatherRoute(layer);
  if (route === 'geometry') {
    // Re-pad to 0: restores the tight rect, bounding, pose and birthCenter in
    // one consistent patch; returns undefined when already unfeathered.
    return buildFeatherRepadPatch(layer, 0) ?? undefined;
  }
  if (route === 'vmask') {
    if (!layer.vectorMasks?.some((m) => m.enabled !== false && (m.feather ?? 0) !== 0)) {
      return undefined;
    }
    return {
      vectorMasks: layer.vectorMasks.map((m) => (m.enabled !== false ? { ...m, feather: 0 } : m)),
    };
  }
  // bitmap route: the value lives in `adjustments.edgeFeather`, which the
  // reset patches already clear via `adjustments: undefined`.
  return undefined;
}

/**
 * ADJUSTMENT_COMMANDS: Command definitions for the AdjustmentDrawer.
 *
 * Curves editing follows the gesture-based Undo coalescing pattern (mirrors
 * `AdjustmentDrawer`): `beginCurvesEdit` is the ONLY undoable
 * command — it takes a snapshot before the drag; `updateChannelCurve` /
 * `addCurvePoint` / `removeCurvePoint` run non-undoable so intermediate
 * `pointermove` writes collapse into a single history step at `pointerup`.
 *
 * Only reset & begin-edit commands carry `undoable: true` — Steps 6/7 will add
 * the corresponding `beginLevelsEdit` / `beginChannelMixEdit` following the
 * same shape.
 */
export const ADJUSTMENT_COMMANDS = {
  setTool: {
    id: P.CMD_SET_GRADING_TOOL,
    name: 'Switch Adjustment Tool',
    execute: (ctx: EditorContextValue, payload: { tool: GradingTool }) => {
      setActiveTool(ctx, payload.tool);
    },
  } as EditorCommand<{ tool: GradingTool }, void>,

  openBasic: {
    id: P.CMD_OPEN_BASIC,
    name: 'Open Basic Adjustments',
    category: 'Color Grading',
    shortcuts: [{ key: 'u', meta: true }, { key: 'u', ctrl: true }],
    execute: (ctx: EditorContextValue) => {
      openDrawerWithTool(ctx, 'basic');
    },
  } as EditorCommand<void, void>,

  openCurves: {
    id: P.CMD_OPEN_CURVES,
    name: 'Open Curves',
    category: 'Color Grading',
    shortcuts: [{ key: 'm', meta: true }, { key: 'm', ctrl: true }],
    execute: (ctx: EditorContextValue) => {
      openDrawerWithTool(ctx, 'curves');
    },
  } as EditorCommand<void, void>,

  openLevels: {
    id: P.CMD_OPEN_LEVELS,
    name: 'Open Levels',
    category: 'Color Grading',
    shortcuts: [{ key: 'l', meta: true }, { key: 'l', ctrl: true }],
    execute: (ctx: EditorContextValue) => {
      openDrawerWithTool(ctx, 'levels');
    },
  } as EditorCommand<void, void>,

  openColorBalance: {
    id: P.CMD_OPEN_COLOR_BALANCE,
    name: 'Open Color Balance',
    category: 'Color Grading',
    shortcuts: [{ key: 'b', meta: true }, { key: 'b', ctrl: true }],
    execute: (ctx: EditorContextValue) => {
      openDrawerWithTool(ctx, 'colorBalance');
    },
  } as EditorCommand<void, void>,

  openMixer: {
    id: P.CMD_OPEN_MIXER,
    name: 'Open Channel Mixer',
    category: 'Color Grading',
    shortcuts: [{ key: 'x', meta: true, shift: true }, { key: 'x', ctrl: true, shift: true }],
    execute: (ctx: EditorContextValue) => {
      openDrawerWithTool(ctx, 'mixer');
    },
  } as EditorCommand<void, void>,

  resetAll: {
    id: P.CMD_RESET_ALL_GRADING,
    name: 'Reset All Adjustment',
    undoable: true,
    execute: (ctx: EditorContextValue) => {
      const { activeFrame, activeLayer, actions } = ctx;
      if (!activeFrame || !activeLayer) return;
      // Setting to undefined removes the fields entirely so `hasAdvancedFilters`
      // returns false and the layer short-circuits back to the ctx.filter
      // fast path.
      // `adjustments` is now managed by the Basic panel inside this
      // same drawer, so "Reset All Adjustment" also wipes it. Previously
      // AdjustmentDrawer owned its own reset path; merging into a single
      // reset preserves the mental model "one panel = one reset button".
      actions.updateLayer(activeFrame.id, activeLayer.id, {
        adjustments: undefined,
        curves: undefined,
        levels: undefined,
        channelMix: undefined,
        colorBalance: undefined,
        // Edge Feather's routed carriers (visibleShape pad / vectorMask
        // feather) don't live in `adjustments` — clear them in the SAME write
        // so reset stays one undo step.
        ...clearEdgeFeatherPatch(activeLayer),
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
      // Switch (not chained ternaries) so the `'basic'` case reads
      // parallel to the existing three panels, and adding a fifth tool
      // later slots in without re-flowing the diff.
      let patch: Partial<Record<
        'adjustments' | 'curves' | 'levels' | 'channelMix' | 'colorBalance',
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
        case 'colorBalance':
          patch = { colorBalance: undefined };
          break;
        case 'mixer':
        default:
          patch = { channelMix: undefined };
          break;
      }
      // Basic owns the Edge Feather slider — its routed carriers must reset
      // with the panel (other tools never touched them).
      actions.updateLayer(
        activeFrame.id,
        activeLayer.id,
        tool === 'basic'
          ? { ...patch, ...clearEdgeFeatherPatch(activeLayer) }
          : patch,
      );
    },
  } as EditorCommand<void, void>,


  // ─── Curves-specific commands ───────────────────────────────────────
  //
  // These write to `layer.curves.{rgb|red|green|blue}`. `beginCurvesEdit` is
  // the Undo checkpoint — its execute body is intentionally empty because the
  // history plugin snapshots layer state on any undoable command dispatch.

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

  // ─── Levels-specific commands ───────────────────────────────────────
  //
  // These write to `layer.levels`. The interaction pattern mirrors Curves:
  // `beginLevelsEdit` snapshots layer state as the undoable checkpoint;
  // `updateLevels` fires non-undoable during pointer drags so the run of
  // intermediate writes coalesces into a single history entry at pointerup
  // (gesture-based coalescing).
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

  // ─── Channel Mixer commands ─────────────────────────────────────────
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

  // ─── Basic Adjustments commands (migrated from AdjustmentDrawer) ─
  //
  // Mirrors the Levels / Channel-Mix shape but writes into `layer.adjustments`
  // rather than `layer.curves|levels|channelMix`.
  //
  // ⚠️ v2: there is no longer a "fast path" vs "advanced" split. The old comment
  // here described the deleted Canvas2D painter (`ctx.filter` + a CPU descriptor
  // chain + an `adjustments: undefined` guard against double application). In v2
  // every arm — Basic, Curves, Levels, Mixer, Colour Balance — is translated by
  // `SceneAssembler` into `AdjustmentDesc[]` and evaluated ONCE per frame by
  // `adjust.wgsl` on the GPU. Double
  // application is prevented structurally: the descriptor list IS the single
  // source, and the only place a grade is pre-baked (AdjustPrePass, ahead of a
  // compute filter) explicitly suppresses the inline evaluation.

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

  // ─── Fast-track drag path ─────────────────────────────────────────────
  //
  // A slider drag used to dispatch `updateAdjustments` (→ Redux → React re-render
  // → new frame reference) on EVERY pointermove; the canvas merge coalesced the
  // GPU work, but the dispatch/render storm ran at raw pointermove rate. The
  // fast-track pair parks the merged value on the volatile buffer instead: the
  // per-tick `mergeFrameSnapshot` folds it into the rendered frame (live canvas),
  // React stays idle, and `commitAdjustments` lands ONE Redux write at gesture
  // end. Same bookending as the move gesture (`fast.override` + `fast.commit`).

  fastUpdateAdjustments: {
    id: P.CMD_FAST_UPDATE_ADJUSTMENTS,
    name: 'Fast-Track Basic Adjustments',
    execute: (
      ctx: EditorContextValue,
      payload: { patch: AdjustmentsPatch; exact?: boolean },
    ) => {
      const { activeFrame, activeLayer, actions } = ctx;
      if (!activeFrame || !activeLayer) return;
      // Baseline on the FRESHEST draft (`fast.latestLayer`), not Redux — the
      // draft replaces `adjustments` wholesale, so a Redux baseline would
      // resurrect last frame's values mid-gesture.
      const latest = actions.fast.latestLayer(activeFrame.id, activeLayer.id) ?? activeLayer;
      const current = (latest.adjustments ?? P.DEFAULT_ADJUSTMENTS_STATE) as AdjustmentState;
      const next: AdjustmentState = { ...current, ...payload.patch };

      // ── Blur motion quantization (same cure as fastUpdateEdgeFeather) ──
      // The slider steps 0.1σ; a SLOW drag crosses a step on nearly every
      // ticker frame and each step re-runs the full pipeline (both vmask
      // bakes + whole-scene recomposite + the gaussian H/V dispatch — the
      // latter at FULL-ASSET dims for an uncropped layer). Quantize the
      // MOTION value to 0.5σ (adjacent frames differ imperceptibly while
      // moving) so a slow drag re-renders ~5× less often; `basic.tsx` lands
      // the EXACT slider value in one final `exact` write at drag end.
      const keys = Object.keys(payload.patch);
      if (!payload.exact && keys.length === 1 && keys[0] === 'blur') {
        const q = Math.round((payload.patch.blur as number) * 2) / 2;
        if (q === (current.blur ?? 0)) return; // already parked — byte-stable frame
        next.blur = q;
      }

      actions.fast.overrideLayer(activeFrame.id, activeLayer.id, { adjustments: next });
    },
  } as EditorCommand<{ patch: AdjustmentsPatch; exact?: boolean }, void>,

  commitAdjustments: {
    id: P.CMD_COMMIT_ADJUSTMENTS,
    name: 'Commit Basic Adjustments',
    execute: (ctx: EditorContextValue) => {
      const { activeLayer, actions } = ctx;
      if (!activeLayer) return;
      actions.fast.commit(activeLayer.id);
    },
  } as EditorCommand<void, void>,

  // ─── Edge Feather fast-track drag path (dual-write) ────────────────────────────
  //
  // The cascade-checked drag used to split its writes in time: the fragment
  // landed immediately (per-move Redux), the source hole only on the 120ms
  // idle flush / gesture end — the complementary seam was BROKEN during
  // motion (the live fragment edge overhung the not-yet-feathered hole edge).
  // This pair parks BOTH sides on the volatile buffer per move: two drafts
  // (`fast.override` on the fragment AND on the source layer) merge in the
  // SAME `mergeFrameSnapshot` tick, so hole + fragment update in lockstep and
  // the seam is structurally impossible — not just faster. Per-frame GPU cost
  // is affordable because the hole's vmask bake is WINDOWED (hole-sized, see
  // prepareVmaskSources `resolveVmaskWindow`).
  //
  // Same routing as `setEdgeFeather`, but every read baselines on
  // `fast.latestLayer` (the freshest draft) — the draft replaces the touched
  // fields wholesale, so a stale Redux baseline would resurrect last frame's
  // values (the same discipline `fastUpdateAdjustments` follows).
  //
  // NON-UNDOABLE: the gesture's `beginAdjustmentsEdit` checkpoint owns undo;
  // `commitEdgeFeather` flushes both drafts as one batched write at drag end.

  fastUpdateEdgeFeather: {
    id: P.CMD_FAST_UPDATE_EDGE_FEATHER,
    name: 'Fast-Track Edge Feather',
    execute: (
      ctx: EditorContextValue,
      payload: { radius: number },
    ) => {
      const { activeFrame, activeLayer, actions } = ctx;
      if (!activeFrame || !activeLayer) return;
      const frameId = activeFrame.id;

      // ── Motion quantization ──
      // The slider steps at 0.1px; a SLOW drag crosses a step on nearly every
      // ticker frame, and each step re-bakes BOTH vmasks + re-composites the
      // whole scene. Quantize the MOTION value to whole px (visually seamless
      // at feather scale — the ramp is already ≥3px wide) so a slow drag
      // re-renders ~10× less often; `basic.tsx` lands the EXACT slider value
      // in one final write at drag end, before the commit.
      const radius = Math.max(0, Math.round(payload.radius));

      // ── Fragment side (routed carrier, baselined on the freshest draft) ──
      const latest = actions.fast.latestLayer(frameId, activeLayer.id) ?? activeLayer;
      const route = resolveEdgeFeatherRoute(latest);

      // Skip when the quantized value is already parked (a slow drag between
      // integer steps produces zero drafts — the merge stays byte-stable).
      const parkedFeather = route === 'geometry'
        ? ((latest.visibleShape as { featherPx?: number } | undefined)?.featherPx ?? 0)
        : route === 'vmask'
          ? (latest.vectorMasks?.find((m) => m.enabled !== false)?.feather ?? 0)
          : ((latest.adjustments?.edgeFeather as number | undefined) ?? 0);
      if (parkedFeather === radius) return;

      if (route === 'geometry') {
        const patch = buildFeatherRepadPatch(latest, radius);
        if (patch) actions.fast.overrideLayer(frameId, activeLayer.id, patch);
      } else if (route === 'vmask') {
        const masks = (latest.vectorMasks ?? []).map(
          (m) => (m.enabled !== false ? { ...m, feather: radius } : m),
        );
        actions.fast.overrideLayer(frameId, activeLayer.id, { vectorMasks: masks });
      } else {
        const current = (latest.adjustments ?? P.DEFAULT_ADJUSTMENTS_STATE) as AdjustmentState;
        actions.fast.overrideLayer(frameId, activeLayer.id, {
          adjustments: { ...current, edgeFeather: radius },
        });
      }

      // ── Hole side (same tick, same buffer — lockstep with the fragment) ──
      // A dangling assocMaskId (source layer or hole deleted, e.g. after a
      // heal) degrades SILENTLY — advisory metadata, never a hard dependency.
      const assocMaskId = activeLayer.metadata?.assocMaskId;
      const sourceLayerId = activeLayer.metadata?.sourceLayerId;
      if (!assocMaskId || !sourceLayerId) return;
      const latestSource = actions.fast.latestLayer(frameId, sourceLayerId)
        ?? activeFrame.layers.byId[sourceLayerId];
      const hole = latestSource?.vectorMasks?.find((m) => m.id === assocMaskId);
      if (!latestSource || !hole) return;
      if (hole.feather === radius) return; // guard: no redundant draft churn
      const masks = (latestSource.vectorMasks ?? []).map(
        (m) => (m.id === assocMaskId ? { ...m, feather: radius } : m),
      );
      actions.fast.overrideLayer(frameId, sourceLayerId, { vectorMasks: masks });
    },
  } as EditorCommand<{ radius: number }, void>,

  commitEdgeFeather: {
    id: P.CMD_COMMIT_EDGE_FEATHER,
    name: 'Commit Edge Feather',
    execute: (ctx: EditorContextValue) => {
      const { actions } = ctx;
      // `'layers'` flush: every buffered draft this gesture parked (fragment +
      // source hole) lands as ONE BATCH_UPDATE_LAYER group. The gesture's
      // `beginAdjustmentsEdit` checkpoint owns the undo step.
      actions.fast.commit(null, 'layers');
    },
  } as EditorCommand<void, void>,

  // ─── Edge Feather (落层后边缘羽化) ───────────────────────────────────────────
  //
  // One slider, three edge carriers — the write is ROUTED by the layer's
  // structure (`resolveEdgeFeatherRoute`), because a "fragment" carries its
  // edge in different places depending on how it was produced:
  //   • logical fragment → visibleShape re-pad (`buildFeatherRepadPatch`,
  //     lossless: the hard-cut-away pixels are still in the original asset);
  //   • vector-mask layer → every enabled mask's `feather` field (same
  //     semantics as selection-time feather);
  //   • otherwise → `adjustments.edgeFeather` (the `alphaFeather` filter).
  //
  // SOURCE-HOLE OWNERSHIP (the `hole` policy): when the layer is a cut
  // fragment (`metadata.assocMaskId`), the checkbox is the single source of
  // truth for whether the source hole is feathered AT ALL — the slider only
  // supplies the value:
  //   • `'match'`  — hole feather := radius (checkbox on: per-move or flush);
  //   • `'clear'`  — hole feather := 0 (checkbox off — including enforcement
  //                  during unchecked drags; guarded by `feather !== target`
  //                  so an already-clear hole never re-composites the source);
  //   • `'none'`   — leave the hole alone this dispatch (checked-drag moves
  //                  between throttle flushes; the flush lands the value).
  // Checkbox transitions dispatch `holeOnly` writes (no fragment-side edit),
  // wrapped in the panel's gesture so the transition is one undo step.
  //
  // NON-UNDOABLE by design: the slider gesture opens its undo checkpoint via
  // `beginAdjustmentsEdit` at pointerdown (same `useFilterGesture` bookending
  // as every other Basic slider), so one drag = exactly one undo step that
  // covers every routed write — including the hole writes above.
  setEdgeFeather: {
    id: P.CMD_SET_EDGE_FEATHER,
    name: 'Set Edge Feather',
    execute: (
      ctx: EditorContextValue,
      payload: { radius: number; cascade?: boolean; hole?: 'match' | 'clear' | 'none'; holeOnly?: boolean },
    ) => {
      const { activeFrame, activeLayer, actions } = ctx;
      if (!activeFrame || !activeLayer) return;
      const radius = Math.max(0, payload.radius);

      if (!payload.holeOnly) {
        const route = resolveEdgeFeatherRoute(activeLayer);
        if (route === 'geometry') {
          const patch = buildFeatherRepadPatch(activeLayer, radius);
          if (patch) {
            actions.updateLayer(activeFrame.id, activeLayer.id, patch);
          }
        } else if (route === 'vmask') {
          // Every enabled mask, uniformly — "feather this layer's edges" is one
          // intent; per-mask radii stay a selection-time concern.
          const masks = (activeLayer.vectorMasks ?? []).map(
            (m) => (m.enabled !== false ? { ...m, feather: radius } : m),
          );
          actions.updateLayer(activeFrame.id, activeLayer.id, { vectorMasks: masks });
        } else {
          const current = (activeLayer.adjustments ?? P.DEFAULT_ADJUSTMENTS_STATE) as AdjustmentState;
          actions.updateLayer(activeFrame.id, activeLayer.id, {
            adjustments: { ...current, edgeFeather: radius },
          });
        }
      }

      const holePolicy = payload.hole ?? (payload.cascade ? 'match' : 'none');
      if (holePolicy === 'none') return;

      // The hole write itself. A dangling assocMaskId (source layer or hole
      // deleted, e.g. after a heal) degrades SILENTLY — the pointer is
      // advisory metadata, never a hard dependency.
      const assocMaskId = activeLayer.metadata?.assocMaskId;
      const sourceLayerId = activeLayer.metadata?.sourceLayerId;
      if (!assocMaskId || !sourceLayerId) return;
      const source = activeFrame.layers.byId[sourceLayerId];
      const hole = source?.vectorMasks?.find((m) => m.id === assocMaskId);
      if (!source || !hole) return;
      const holeTarget = holePolicy === 'match' ? radius : 0;
      if (hole.feather === holeTarget) return; // guard: no redundant re-composite
      const masks = (source.vectorMasks ?? []).map(
        (m) => (m.id === assocMaskId ? { ...m, feather: holeTarget } : m),
      );
      actions.updateLayer(activeFrame.id, sourceLayerId, { vectorMasks: masks });
    },
  } as EditorCommand<{ radius: number; cascade?: boolean; hole?: 'match' | 'clear' | 'none'; holeOnly?: boolean }, void>,

  // ─── Color Balance commands ─────────────────────────────────────────
  //
  // Same gesture-coalescing shape as Curves / Levels / Channel-Mixer.
  // `beginColorBalanceEdit` is the undoable checkpoint (empty body — history
  // plugin snapshots layer state on any undoable dispatch).
  // `updateColorBalance` deep-merges its partial patch onto the current
  // `layer.colorBalance` (falling back to the identity state so a fresh
  // layer's first slider tweak produces a fully-formed `ColorBalanceState`).

  beginColorBalanceEdit: {
    id: P.CMD_BEGIN_COLOR_BALANCE_EDIT,
    name: 'Begin Color Balance Edit',
    undoable: true,
    execute: () => {},
  } as EditorCommand<void, void>,

  updateColorBalance: {
    id: P.CMD_UPDATE_COLOR_BALANCE,
    name: 'Update Color Balance',
    execute: (
      ctx: EditorContextValue,
      payload: { patch: ColorBalancePatch },
    ) => {
      const { activeFrame, activeLayer, actions } = ctx;
      if (!activeFrame || !activeLayer) return;
      const current = activeLayer.colorBalance ?? P.DEFAULT_COLOR_BALANCE_STATE;
      const next: ColorBalanceState = { ...current, ...payload.patch };
      actions.updateLayer(activeFrame.id, activeLayer.id, { colorBalance: next });
    },
  } as EditorCommand<{ patch: ColorBalancePatch }, void>,
} as const;



