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
import type {
  AdjustmentState,
  Layer,
  CurvePoints,
  CurvesState,
  LevelsState,
  ChannelMixState,
  ColorBalanceState,
} from '@opengpex/editor/core/types/models';
import { GRADE_ARM_KEY, dropManualCategoryMasks, dropPresetOwnedMasks } from '@opengpex/editor/core/layer/amask';

import { LayerFactory } from '@opengpex/editor/core/layer/factory';
import * as P from './protocols';
import { resolveEditableTail, toolCategory } from './utils-hotTail';
import {
  writeArm,
  nextMasksForArm,
  readPanelArm,
  mergeCurves,
  insertPointSorted,
} from './grading/manual-apply';
import { buildPresetMasks, resolvePresetForApply } from './grading/presets/preset-apply';
import { SettingsPanelAPI } from '../../panels/SettingsPanel/protocols';
import type {
  GradingTool,
  CurveChannel,
  LevelsPatch,
  ChannelMixPatch,
  ChannelMixPresetId,
  AdjustmentsPatch,
  ColorBalancePatch,
} from './protocols';

/**
 * Sets the active grading tool on the shared signal (so other plugins can
 * observe it via `usePluginSignals`).
 *
 * Kept as a signal (not pluginConfig) because switching panels must trigger
 * UI re-renders synchronously — pluginConfig by itself doesn't force an
 * immediate re-render of subscribers. The opening panel is governed by the
 * `openWithBasic` preference instead of a remembered last tool.
 */
function setActiveTool(ctx: EditorContextValue, tool: GradingTool) {
  ctx.scoped!.setSignal(P.SIGNAL_ACTIVE_GRADING_TOOL, tool);
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

/**
 * Zero the layer's Edge Feather across ALL its carriers, honouring the route.
 * Reset semantics: this layer's feather back to identity — the source hole (a
 * different layer) stays owned by the cascade checkbox, not the reset button.
 * Returns `undefined` when there is nothing to clear (the routed carrier is
 * already at 0), so callers can spread it into their patch unconditionally.
 */
function clearEdgeFeatherPatch(layer: Layer): Partial<Layer> | undefined {
  const route = LayerFactory.resolveLayerEdgeType(layer);
  if (route === 'geometry') {
    // Re-pad to 0: restores the tight rect, bounding, pose and birthCenter in
    // one consistent patch; returns undefined when already unfeathered.
    return LayerFactory.patchEdgeFeatherRepad(layer, 0) ?? undefined;
  }
  if (route === 'vmask') {
    if (!layer.vectorMasks?.some((m) => m.enabled !== false && (m.feather ?? 0) !== 0)) {
      return undefined;
    }
    return {
      vectorMasks: layer.vectorMasks.map((m) => (m.enabled !== false ? { ...m, feather: 0 } : m)),
    };
  }
  // bitmap route: the value lives in the hot tail's basic arm, which the
  // reset patches already drop via `adjustMasks: undefined`.
  return undefined;
}


/**
 * ADJUSTMENT_COMMANDS: Command definitions for the AdjustmentDrawer.
 *
 * Every grade write goes through the hot-tail rules of `utils-hotTail.ts`: the
 * chain's last mask is edited in place while the user keeps working in the
 * same category against the same selection; otherwise a new mask appends to
 * the chain (commit order = render order). Editing follows the gesture-based
 * Undo coalescing pattern: `begin*Edit` is the ONLY undoable command in a
 * gesture — it takes a snapshot before the drag; the `update*` / `fast*`
 * commands run non-undoable so intermediate `pointermove` writes collapse
 * into a single history step at the final `commit*`.
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
      // The whole chain goes: every category's masks are deleted (their
      // filters — blur / edgeFeather — disappear with them, the translation
      // derives those from the masks).
      // Edge Feather's routed carriers (visibleShape pad / vectorMask
      // feather) don't live in the chain — clear them in the SAME write
      // so reset stays one undo step.
      actions.updateLayer(activeFrame.id, activeLayer.id, {
        adjustMasks: undefined,
        ...clearEdgeFeatherPatch(activeLayer),
      });
    },
  } as EditorCommand<void, void>,

  resetActivePanel: {
    id: P.CMD_RESET_ACTIVE_PANEL,
    name: 'Reset Current Panel',
    undoable: true,
    execute: (ctx: EditorContextValue) => {
      const { activeFrame, activeLayer, actions, scoped, state } = ctx;
      if (!activeFrame || !activeLayer) return;
      const pluginUid = `${P.PLUGIN_AUTHOR}.${P.PLUGIN_ID}`;
      // Optional chain: test-harness contexts may carry no pluginConfig.
      const config = ((state as EditorContextValue['state'] | undefined)?.pluginConfig as Record<string, P.AdjustmentDrawerConfig> | undefined)?.[pluginUid];
      const signalTool = scoped!.getSignal(P.SIGNAL_ACTIVE_GRADING_TOOL, null) as P.ActiveGradingTool | null;
      const tool = P.resolveActiveGradingTool(signalTool, config);
      const category = toolCategory(tool);
      // The presets tool spans several grade categories, so its reset is not
      // a single-category drop: it removes exactly the preset-owned masks
      // (`origin: 'preset'`) and keeps every hand-written grade intact
      // (see the reset-semantics comment above).
      // Edge Feather's routed carriers are not preset-written, so they are
      // left untouched here.
      if (tool === 'presets') {
        actions.updateLayer(activeFrame.id, activeLayer.id, dropPresetOwnedMasks(activeLayer));
        return;
      }
      // Every other tool resets ONE category, and only its hand-written
      // masks (see dropManualCategoryMasks) — the preset's contribution to
      // this category stays because it belongs to the applied look.
      // Basic owns the Edge Feather slider — its routed carriers must reset
      // with the panel (other tools never touched them).
      actions.updateLayer(
        activeFrame.id,
        activeLayer.id,
        tool === 'basic'
          ? { ...dropManualCategoryMasks(activeLayer, category), ...clearEdgeFeatherPatch(activeLayer) }
          : dropManualCategoryMasks(activeLayer, category),
      );
    },
  } as EditorCommand<void, void>,


  // ─── Curves-specific commands ───────────────────────────────────────
  //
  // Writes go to the curves arm of the editable hot tail (or a new mask).
  // `beginCurvesEdit` is the Undo checkpoint — its execute body is
  // intentionally empty because the history plugin snapshots layer state on
  // any undoable command dispatch.

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
      const current = readPanelArm(ctx, 'curves') as CurvesState | undefined;
      writeArm(ctx, 'curves', mergeCurves(current, payload.channel, payload.points));
    },
  } as EditorCommand<{ channel: CurveChannel; points: CurvePoints }, void>,

  addCurvePoint: {
    id: P.CMD_ADD_CURVE_POINT,
    name: 'Add Curve Control Point',
    execute: (
      ctx: EditorContextValue,
      payload: { channel: CurveChannel; x: number; y: number },
    ) => {
      // Read current channel points; fall back to identity endpoints so the
      // very first add creates a proper 3-point curve.
      const current = readPanelArm(ctx, 'curves') as CurvesState | undefined;
      const currentChannelPts =
        current?.[payload.channel] ??
        P.IDENTITY_CURVE_POINTS.map((p) => [p[0], p[1]] as [number, number]);
      const nextPts = insertPointSorted(currentChannelPts, payload.x, payload.y);
      writeArm(ctx, 'curves', mergeCurves(current, payload.channel, nextPts));
    },
  } as EditorCommand<{ channel: CurveChannel; x: number; y: number }, void>,

  removeCurvePoint: {
    id: P.CMD_REMOVE_CURVE_POINT,
    name: 'Remove Curve Control Point',
    execute: (
      ctx: EditorContextValue,
      payload: { channel: CurveChannel; index: number },
    ) => {
      const currentPts: CurvePoints | undefined = (readPanelArm(ctx, 'curves') as CurvesState | undefined)?.[payload.channel];
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
      const current = readPanelArm(ctx, 'curves') as CurvesState | undefined;
      writeArm(ctx, 'curves', mergeCurves(current, payload.channel, nextPts));
    },
  } as EditorCommand<{ channel: CurveChannel; index: number }, void>,

  // ─── Levels-specific commands ───────────────────────────────────────
  //
  // The interaction pattern mirrors Curves: `beginLevelsEdit` snapshots layer
  // state as the undoable checkpoint; `updateLevels` fires non-undoable during
  // pointer drags so the run of intermediate writes coalesces into a single
  // history entry at pointerup (gesture-based coalescing).
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
      // Merge onto whatever exists (starting from DEFAULT_LEVELS_STATE the
      // first time). This keeps a partial patch from accidentally dropping
      // the other fields.
      const current = (readPanelArm(ctx, 'levels') as LevelsState | undefined) ?? P.DEFAULT_LEVELS_STATE;
      writeArm(ctx, 'levels', { ...current, ...payload.patch });
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
      const current = (readPanelArm(ctx, 'levels') as LevelsState | undefined) ?? P.DEFAULT_LEVELS_STATE;
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
      writeArm(ctx, 'levels', { ...current, inputBlack: ib, inputWhite: iw });
    },
  } as EditorCommand<{ inputBlack: number; inputWhite: number }, void>,

  // ─── Channel Mixer commands ─────────────────────────────────────────
  //
  // Same gesture-coalescing shape as Curves & Levels. `applyChannelMixPreset`
  // is the one-shot preset switch — undoable so a preset click is a single
  // history entry; `'none'` is the category reset (the masks are dropped so
  // the layer short-circuits back to the no-grade fast path).

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
      const current = (readPanelArm(ctx, 'channelMix') as ChannelMixState | undefined) ?? P.DEFAULT_CHANNEL_MIX_STATE;
      // Shallow merge is enough because the patch's rows are whole triples —
      // callers write a full `[r,g,b]` per row rather than nudging a single
      // coefficient. Same for `constant`.
      writeArm(ctx, 'channelMix', { ...current, ...payload.patch });
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
      // `'none'` drops the mixer panel's MANUAL channelMix masks — the same
      // provenance-aware reset rule as resetActivePanel: masks the applied
      // look owns (`origin: 'preset'`) stay until the presets panel resets.
      if (payload.presetId === 'none') {
        actions.updateLayer(activeFrame.id, activeLayer.id, dropManualCategoryMasks(activeLayer, 'channelMix'));
        return;
      }
      const preset = P.CHANNEL_MIX_PRESETS[payload.presetId];
      if (!preset) return; // Silently ignore unknown IDs.
      // Wholesale replacement — presets are complete matrices, not diffs.
      // We deep-clone the tuples so subsequent shallow mutations on the
      // layer state can't leak into the shared preset table.
      writeArm(ctx, 'channelMix', {
        red: [preset.red[0], preset.red[1], preset.red[2]],
        green: [preset.green[0], preset.green[1], preset.green[2]],
        blue: [preset.blue[0], preset.blue[1], preset.blue[2]],
        constant: preset.constant
          ? [preset.constant[0], preset.constant[1], preset.constant[2]]
          : [0, 0, 0],
      });
    },
  } as EditorCommand<{ presetId: ChannelMixPresetId }, void>,

  // ─── Basic Adjustments commands ─────────────────────────────────────
  //
  // Writes go to the basic arm of the editable hot tail (or a new mask).
  // There is no "fast path" vs "advanced" split: the chain is translated by
  // `SceneAssembler` into `AdjustStageDesc[]` and evaluated once per frame by
  // the GPU. Double application is prevented structurally: the stage list IS
  // the single source, and the only place a grade is pre-baked (AdjustPrePass,
  // ahead of a compute filter) explicitly suppresses the inline evaluation.

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
      // Merge onto the editable hot tail's arm when one exists. When there is
      // NO tail (cold start, or an applied preset owns the chain head), the
      // appended manual mask carries ONLY the patch-defined fields: identity
      // fields are true no-ops in the chain composition, and extraction
      // ("Save as Preset" / Export) merges basic masks at FIELD level, so a
      // later manual mask overriding just brightness must not shadow the
      // preset's other basic values with identity numbers.
      const current = (readPanelArm(ctx, 'basic') as Partial<AdjustmentState> | undefined) ?? {};
      writeArm(ctx, 'basic', { ...current, ...payload.patch } as AdjustmentState);
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
  //
  // Hot-tail detection runs against the FRESHEST draft: after the first
  // override of a cold-start gesture appends a mask, the remaining moves edit
  // it in place, so the whole gesture is exactly one new chain entry.

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
      // draft replaces the chain wholesale, so a Redux baseline would
      // resurrect last frame's values mid-gesture.
      const latest = actions.fast.latestLayer(activeFrame.id, activeLayer.id) ?? activeLayer;
      const tail = resolveEditableTail(ctx.geometry, activeFrame, latest, 'basic');
      const key = GRADE_ARM_KEY.basic;
      // Partial-append baseline: with no editable tail, only the patch's
      // fields land in the new mask (see updateAdjustments) so a preset's
      // basic values earlier in the chain are neither double-applied nor
      // shadowed by identity numbers at extraction time. Chain arms are
      // effectively partial (`AdjustmentState` fields all carry identity
      // defaults downstream), hence the `Partial` read and the cast back —
      // the shared `AdjustmentState` type still models the fields as
      // required, and relaxing it ripples far beyond this drawer.
      const current = (tail?.grade[key] as Partial<AdjustmentState> | undefined) ?? {};
      const next = { ...current, ...payload.patch } as AdjustmentState;

      // ── Blur motion quantization (same cure as fastUpdateEdgeFeather) ──
      // The slider steps 0.1σ; a SLOW drag crosses a step on nearly every
      // ticker frame and each step re-runs the full pipeline. Quantize the
      // MOTION value to 0.5σ (adjacent frames differ imperceptibly while
      // moving) so a slow drag re-renders ~5× less often; `basic.tsx` lands
      // the EXACT slider value in one final `exact` write at drag end.
      const keys = Object.keys(payload.patch);
      if (!payload.exact && keys.length === 1 && keys[0] === 'blur') {
        const q = Math.round((payload.patch.blur as number) * 2) / 2;
        if (q === (current.blur ?? 0)) return; // already parked — byte-stable frame
        next.blur = q;
      }

      const masks = nextMasksForArm(ctx, activeFrame, latest, 'basic', next);
      if (!masks) return;
      actions.fast.overrideLayer(activeFrame.id, activeLayer.id, {
        adjustMasks: masks.length ? masks : undefined,
      });
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
  // the seam is structurally impossible — not just faster.
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
      const route = LayerFactory.resolveLayerEdgeType(latest);

      // Skip when the quantized value is already parked (a slow drag between
      // integer steps produces zero drafts — the merge stays byte-stable).
      const parkedFeather = route === 'geometry'
        ? ((latest.visibleShape as { featherPx?: number } | undefined)?.featherPx ?? 0)
        : route === 'vmask'
          ? (latest.vectorMasks?.find((m) => m.enabled !== false)?.feather ?? 0)
          : (latest.adjustMasks?.reduce((sum, m) => sum + (m.grade.adjustments?.edgeFeather ?? 0), 0) ?? 0);
      if (parkedFeather === radius) return;

      if (route === 'geometry') {
        const patch = LayerFactory.patchEdgeFeatherRepad(latest, radius);
        if (patch) actions.fast.overrideLayer(frameId, activeLayer.id, patch);
      } else if (route === 'vmask') {
        const masks = (latest.vectorMasks ?? []).map(
          (m) => (m.enabled !== false ? { ...m, feather: radius } : m),
        );
        actions.fast.overrideLayer(frameId, activeLayer.id, { vectorMasks: masks });
      } else {
        // Bitmap route: the value rides the editable hot tail's basic arm
        // (created on first write when none exists).
        const tail = resolveEditableTail(ctx.geometry, activeFrame, latest, 'basic');
        const key = GRADE_ARM_KEY.basic;
        // Partial-append baseline (see updateAdjustments).
        const current = (tail?.grade[key] as Partial<AdjustmentState> | undefined) ?? {};
        const masks = nextMasksForArm(
          ctx,
          activeFrame,
          latest,
          'basic',
          { ...current, edgeFeather: radius } as AdjustmentState,
        );
        if (masks) {
          actions.fast.overrideLayer(frameId, activeLayer.id, {
            adjustMasks: masks.length ? masks : undefined,
          });
        }
      }

      // ── Hole side (same tick, same buffer — lockstep with the fragment) ──
      // A dangling assocMaskId (source layer or hole deleted, e.g. after a
      // Merge Back / bake) degrades SILENTLY — advisory metadata, never a hard dependency.
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
  // structure (`LayerFactory.resolveLayerEdgeType`), because a "fragment" carries its
  // edge in different places depending on how it was produced:
  //   • logical fragment → visibleShape re-pad (`LayerFactory.patchEdgeFeatherRepad`,
  //     lossless: the hard-cut-away pixels are still in the original asset);
  //   • vector-mask layer → every enabled mask's `feather` field (same
  //     semantics as selection-time feather);
  //   • otherwise → the editable hot tail's basic `edgeFeather` (the
  //     `alphaFeather` filter).
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
        const route = LayerFactory.resolveLayerEdgeType(activeLayer);
        if (route === 'geometry') {
          const patch = LayerFactory.patchEdgeFeatherRepad(activeLayer, radius);
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
          // Partial-append baseline (see updateAdjustments): with no editable
          // tail the new mask carries only edgeFeather, so it neither
          // double-applies nor shadows earlier chain values.
          const current = (readPanelArm(ctx, 'basic') as Partial<AdjustmentState> | undefined) ?? {};
          writeArm(ctx, 'basic', { ...current, edgeFeather: radius } as AdjustmentState);
        }
      }

      const holePolicy = payload.hole ?? (payload.cascade ? 'match' : 'none');
      if (holePolicy === 'none') return;

      // The hole write itself. A dangling assocMaskId (source layer or hole
      // deleted, e.g. after a Merge Back / bake) degrades SILENTLY — the pointer is
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
  // `updateColorBalance` merges its partial patch onto the editable hot
  // tail's arm (falling back to the identity state so a fresh layer's first
  // slider tweak produces a fully-formed `ColorBalanceState`).

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
      const current = (readPanelArm(ctx, 'colorBalance') as ColorBalanceState | undefined) ?? P.DEFAULT_COLOR_BALANCE_STATE;
      writeArm(ctx, 'colorBalance', { ...current, ...payload.patch });
    },
  } as EditorCommand<{ patch: ColorBalancePatch }, void>,

  // ─── Filter Preset commands ────────────────────────────────────────
  //
  // A preset click is a PRESET-OWNED REPLACEMENT: the masks the previous
  // preset wrote (`origin: 'preset'`) are discarded and the chosen preset's
  // strength-resolved masks are appended, while every hand-written grade mask
  // on the layer survives untouched. Undo comes from the panel's
  // `beginAdjustmentsEdit` checkpoint, so both commands here are non-undoable.
  // Capturing a look that combines a preset with manual edits is the separate
  // "Save as Preset" flow (chain-snapshot extraction: one saved stage per
  // enabled grade mask, in chain order).
  //
  // `presetId: 'none'` is the second-click reset: only the preset-owned
  // masks are dropped — the layer keeps its manual grades.

  applyFilterPreset: {
    id: P.CMD_APPLY_FILTER_PRESET,
    name: 'Apply Filter Preset',
    execute: (
      ctx: EditorContextValue,
      payload: { presetId: string; strength: number },
    ) => {
      const { activeFrame, activeLayer, actions } = ctx;
      if (!activeFrame || !activeLayer) return;
      if (payload.presetId === 'none') {
        actions.updateLayer(activeFrame.id, activeLayer.id, dropPresetOwnedMasks(activeLayer));
        return;
      }
      const preset = resolvePresetForApply(ctx, payload.presetId);
      if (!preset) return; // Silently ignore unknown ids.
      const masks = buildPresetMasks(ctx, activeFrame, activeLayer, preset, payload.strength);
      if (!masks) return;
      actions.updateLayer(activeFrame.id, activeLayer.id, {
        adjustMasks: masks.length ? masks : undefined,
      });
    },
  } as EditorCommand<{ presetId: string; strength: number }, void>,

  updateFilterPreset: {
    id: P.CMD_UPDATE_FILTER_PRESET,
    name: 'Update Filter Preset Strength',
    execute: (
      ctx: EditorContextValue,
      payload: { presetId: string; strength: number },
    ) => {
      const { activeFrame, activeLayer, actions } = ctx;
      if (!activeFrame || !activeLayer) return;
      const preset = resolvePresetForApply(ctx, payload.presetId);
      if (!preset) return;
      const masks = buildPresetMasks(ctx, activeFrame, activeLayer, preset, payload.strength);
      if (!masks) return;
      actions.updateLayer(activeFrame.id, activeLayer.id, {
        adjustMasks: masks.length ? masks : undefined,
      });
    },
  } as EditorCommand<{ presetId: string; strength: number }, void>,

  openSettings: {
    id: P.CMD_OPEN_SETTINGS,
    name: 'Open Adjustment Settings',
    execute: (ctx: EditorContextValue) => {
      ctx.actions.setStateSignal(SettingsPanelAPI.signals.tab, 'Adjustments');
      ctx.actions.setStateSignal(SettingsPanelAPI.signals.open, true);
    },
  } as EditorCommand<void, void>,
} as const;
