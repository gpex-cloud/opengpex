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

import { useMemo, useEffect } from 'react';
import { useEditorState, useEditorServices, usePluginCommands, usePluginSignals, usePluginSelfConfig } from '@opengpex/editor/core/context';
import { asLocalRect } from '@opengpex/editor/core/types';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';
import { getActiveTarget } from './commands';
import { isRegularTool as isRegularToolFn, isIrregularTool as isIrregularToolFn, CLIP_TOOL_STRATEGIES, DEFAULT_CLIP_TOOL_AA } from './protocols';
import type { ClipTool, ClipToolAAMap } from './protocols';
import type { ClipOptionsCommandsMap, ClipOptionsSignalsMap } from './commands.d';

/**
 * useClipOptionsCommands: Command Discovery Hook.
 * Plugin commands are directly passed with Cmd suffix, explicitly called in component layer via .execute().
 * Non-command helper operations remain in bare function form.
 */
export const useClipOptionsCommands = () => {
  const { activeFrame, activeLayer } = useEditorState();
  const { actions, geometry } = useEditorServices();

  const {
    toggleModeCmd,
    exitClipModeCmd, // ← derived from CMD_EXIT_CLIP_MODE = 'cmd.exit_clip_mode' (also bound to Esc)
    reCanvasToggleCmd,
    reCanvasApplyCmd,
    setAspectCmd,
    resetAspectCmd,
    antiAliasToggleCmd,
    branchCreateCmd,
    boxResetCmd,
    clipToolSetCmd, // ← derived from CMD_SET_CLIP_TOOL = 'cmd.clip_tool.set'
    clipToolCycleForwardCmd,
    clipToolCycleBackwardCmd,
    invertSelectionCmd, // ← derived from CMD_INVERT_SELECTION = 'cmd.invert_selection'
    selectFromAlphaCmd, // ← derived from CMD_SELECT_FROM_ALPHA = 'cmd.select_from_alpha'
    offsetSelectionCmd, // ← derived from CMD_OFFSET_SELECTION = 'cmd.offset_selection'
    clipboardCopyCmd, // ← derived from CMD_CLIPBOARD_COPY = 'cmd.clipboard_copy'
    clipboardCutCmd, // ← derived from CMD_CLIPBOARD_CUT = 'cmd.clipboard_cut'
  } = usePluginCommands<ClipOptionsCommandsMap>();

  const { reCanvasActiveSignal, clipFeatherValueSignal, clipToolAaMapSignal } = usePluginSignals<ClipOptionsSignalsMap>();

  // pluginConfig is the ONLY persistent feather store; the signal below is a
  // derived session mirror of it (single writer: the linkage effect).
  const [selfConfig, setSelfConfig] = usePluginSelfConfig<{ feather?: number }>();

  // ─── Feather input ↔ selection linkage (feather upgrade §A3.4) ─────────────
  // The input displays ONE derived value: the active selection's feather
  // while a selection exists, otherwise the persisted creation default.
  // This effect is the SIGNAL'S SINGLE WRITER — the signal is a pure session
  // mirror of that derived value (creation-time reads in the tool handlers
  // and this input's display both consume the mirror). One-way state →
  // signal, no feedback loop: the write path (commitFeather in
  // components.tsx) updates pluginConfig + selection only, and this effect
  // re-derives the mirror from them.
  const hasSelection = !!activeFrame?.confinement;
  const featherDisplay = hasSelection
    ? (activeFrame.confinement!.feather ?? 0)
    : (selfConfig.feather ?? 0);
  useEffect(() => {
    clipFeatherValueSignal?.set(featherDisplay);
  }, [clipFeatherValueSignal, featherDisplay]);

  // ─── Per-tool AA presets (reactive signal only, no persistence) ────────────
  // The per-tool AA map is a session-scoped tool preference: the signal starts
  // from the factory defaults each session and the toggle command mutates it
  // directly. Unlike feather there is deliberately NO pluginConfig hydration —
  // a refresh resets AA presets to defaults, which is accepted product
  // behaviour (the defaults table + the command's supportsAntiAlias guard keep
  // rect / wand pinned to false with no stale-record concern).

  return useMemo(() => {
    const isReCanvas = !!reCanvasActiveSignal?.value;

    // Active crop tool — read directly from the per-frame field.
    // Safety: if the stored value doesn't exist in CLIP_TOOL_STRATEGIES (e.g.
    // stale data from a removed tool), fall back to 'rect'.
    const rawClipTool = (activeFrame?.latestClipTool as ClipTool | undefined) ?? 'rect';
    const clipTool: ClipTool = CLIP_TOOL_STRATEGIES[rawClipTool] ? rawClipTool : 'rect';
    // Derive from CLIP_TOOL_STRATEGIES via the helper functions
    // exported from protocols.ts. This eliminates the previous duplicate
    // truth source (literal `clipTool === 'rect' || ...`) and makes the
    // tool family completely table-driven.
    const isRegularTool = isRegularToolFn(clipTool);
    const isIrregularTool = isIrregularToolFn(clipTool);

    // ─── Unified clip box read (Single Source of Truth) ────────────────────
    // `getClipBox` resolves the correct slot by `frame.latestClipTool` and
    // returns `{ regular, spatial }` or null. All downstream derivations
    // (hasIrregularBox, hasAnySelection, isAntiAliased) branch on this.
    const clipBox = activeFrame ? getClipBox(activeFrame) : null;
    const hasIrregularBox = isIrregularTool && clipBox !== null;
    const hasAnySelection = clipBox !== null;

    // ─── Anti-alias derivations (2026/06/23 redesign) ──────────────────────
    // Whether the active tool's projected shape *has* a meaningful AA mode.
    // Drives the AA button's `disabled` state so the button is greyed-out for
    // rect (always pixel-aligned).
    const supportsAntiAlias = CLIP_TOOL_STRATEGIES[clipTool].supportsAntiAlias;
    // The button reflects the tool's persistent preset (single source of truth),
    // not the selection's entity flag: the preset is configurable whether or
    // not a selection exists, and toggling keeps both in sync via the command.
    // Tools without AA support (rect/wand) are always hard-edged (false).
    const toolAAMap = (clipToolAaMapSignal?.value as ClipToolAAMap | undefined) ?? DEFAULT_CLIP_TOOL_AA;
    const isAntiAliased = supportsAntiAlias ? (toolAAMap[clipTool] ?? false) : false;


    return {
      // Plugin Commands (transparently passed Cmd references, explicitly called in component layer via .execute())
      toggleModeCmd,
      exitClipModeCmd,
      reCanvasToggleCmd,
      reCanvasApplyCmd,
      setAspectCmd,
      resetAspectCmd,
      antiAliasToggleCmd,
      branchCreateCmd,
      boxResetCmd,
      clipToolSetCmd,
      clipToolCycleForwardCmd,
      clipToolCycleBackwardCmd,
      invertSelectionCmd,
      selectFromAlphaCmd,
      offsetSelectionCmd,

      // System Commands (cross-plugin, via actions.adv API — AdvCommandRef)
      // Clipboard Copy / Cut go through the plugin wrapper commands, which
      // own the Cmd+C / Cmd+X shortcuts and read the persisted feather
      // signal — toolbar buttons and keyboard carry the same feathered
      // semantics.
      cutCmd: clipboardCutCmd,
      copyCmd: clipboardCopyCmd,
      pasteCmd: actions.adv.layer.clip.paste,
      drillCmd: actions.adv.layer.clip.drill,
      // Apply selection as bitmap mask on the active layer (purple "Apply Mask" button).
      // Atomic with selection-clear inside the command body — see
      // `core/advanced/commands/layer/clip.ts::toMask`.
      applyMaskCmd: actions.adv.layer.clip.toMask,

      // Tool / state derived helpers
      clipTool,
      isRegularTool,
      isIrregularTool,
      hasIrregularBox,
      hasAnySelection,
      supportsAntiAlias,
      isAntiAliased,
      isImageLayer: activeLayer?.type === 'image',

      // Helpers (plain functions — non-command logic)
      updateClipBox: (payload: { x?: number; y?: number; w?: number; h?: number }) => {
        const target = getActiveTarget({ activeFrame, actions, geometry }, isReCanvas);
        if (!target) return;

        // Smart anchor for Re-Canvas: when changing w/h via numeric input, infer
        // which edge is pinned to the canvas boundary and expand from the opposite side.
        // Rule: if exactly one edge aligns with the canvas edge, anchor that edge;
        // otherwise (both or neither aligned) expand symmetrically from center.
        const adjustedPayload = { ...payload };
        if (isReCanvas && activeFrame) {
          const { x: bx, y: by, w: bw, h: bh } = target.box;
          const { w: cw, h: ch } = activeFrame.canvas;

          if (payload.w !== undefined && payload.w !== bw) {
            const leftAligned = bx === 0;
            const rightAligned = bx + bw === cw;
            if (leftAligned && !rightAligned) {
              // Anchor left edge — keep x (default behavior)
            } else if (rightAligned && !leftAligned) {
              // Anchor right edge — adjust x so right edge stays at cw
              adjustedPayload.x = cw - payload.w;
            } else {
              // Both or neither aligned — expand symmetrically from center
              adjustedPayload.x = Math.round(bx + (bw - payload.w) / 2);
            }
          }

          if (payload.h !== undefined && payload.h !== bh) {
            const topAligned = by === 0;
            const bottomAligned = by + bh === ch;
            if (topAligned && !bottomAligned) {
              // Anchor top edge — keep y (default behavior)
            } else if (bottomAligned && !topAligned) {
              // Anchor bottom edge — adjust y so bottom edge stays at ch
              adjustedPayload.y = ch - payload.h;
            } else {
              // Both or neither aligned — expand symmetrically from center
              adjustedPayload.y = Math.round(by + (bh - payload.h) / 2);
            }
          }
        }

        const nextBox = asLocalRect({ ...target.box, ...adjustedPayload });
        const finalBox = target.clampRect(nextBox);
        target.updateShape({ rect: finalBox });
      },
      closeReCanvas: () => reCanvasActiveSignal?.set(false),

      // Feather display value — the signal is a derived session mirror (the
      // linkage effect above is its single writer); `persistFeather` writes
      // the ONLY persistent store (pluginConfig, IndexedDB).
      featherValue: (clipFeatherValueSignal?.value as number) || 0,
      persistFeather: (val: number) => setSelfConfig({ feather: val }),
    };
  }, [
    actions,
    geometry,
    activeFrame,
    reCanvasActiveSignal,
    clipFeatherValueSignal,
    clipToolAaMapSignal,
    setSelfConfig,
    toggleModeCmd,
    exitClipModeCmd,
    reCanvasToggleCmd,
    reCanvasApplyCmd,
    setAspectCmd,
    resetAspectCmd,
    antiAliasToggleCmd,
    branchCreateCmd,
    boxResetCmd,
    clipToolSetCmd,
    clipToolCycleForwardCmd,
    clipToolCycleBackwardCmd,
    invertSelectionCmd,
    selectFromAlphaCmd,
    offsetSelectionCmd,
    clipboardCopyCmd,
    clipboardCutCmd,
    activeLayer,
  ]);

};
