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

import { useMemo } from 'react';
import { useEditorState, useEditorServices, usePluginCommands, usePluginSignals } from '@opengpex/editor/core/context';
import { asLocalRect, asLocalShape, ShapeType, LocalShape } from '@opengpex/editor/core/types';
import { getClipBox, getRegularClipShape } from '@opengpex/editor/core/helpers/selection';
import { getActiveTarget } from './commands';
import { isRegularTool as isRegularToolFn, isIrregularTool as isIrregularToolFn, CROP_TOOL_STRATEGIES } from './protocols';
import type { CropTool } from './protocols';

/**
 * useClipOptionsCommands: Command Discovery Hook.
 * Plugin commands are directly passed with Cmd suffix, explicitly called in component layer via .execute().
 * Non-command helper operations remain in bare function form.
 */
export const useClipOptionsCommands = () => {
  const { activeFrame, state } = useEditorState();
  const { actions } = useEditorServices();

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
    cropToolSetCmd, // ← derived from CMD_SET_CROP_TOOL = 'cmd.crop_tool.set'
  } = usePluginCommands();

  const { reCanvasActiveSignal } = usePluginSignals();

  return useMemo(() => {
    const isReCanvas = !!reCanvasActiveSignal?.value;

    // Active crop tool — read directly from the per-frame field.
    const cropTool = (activeFrame?.latestClipTool as CropTool | undefined) ?? 'rect';
    // Pre-PR-6-2: derive from CROP_TOOL_STRATEGIES via the helper functions
    // exported from protocols.ts. This eliminates the previous duplicate
    // truth source (literal `cropTool === 'rect' || ...`) and makes the
    // tool family completely table-driven.
    const isRegularTool = isRegularToolFn(cropTool);
    const isIrregularTool = isIrregularToolFn(cropTool);

    // ─── Unified clip box read (Single Source of Truth) ────────────────────
    // `getClipBox` resolves the correct slot by `frame.latestClipTool` and
    // returns `{ regular, spatial }` or null. All downstream derivations
    // (hasIrregularBox, hasAnySelection, isAntiAliased) branch on this.
    const clipBox = activeFrame ? getClipBox(activeFrame) : null;
    const hasIrregularBox = isIrregularTool && clipBox !== null && !clipBox.regular;
    const hasAnySelection = clipBox !== null;

    // ─── Anti-alias derivations (2026/06/23 redesign) ──────────────────────
    // Whether the active tool's projected shape *has* a meaningful AA mode.
    // Drives the AA button's `disabled` state so the button is greyed-out for
    // rect (always pixel-aligned).
    const supportsAntiAlias = CROP_TOOL_STRATEGIES[cropTool].supportsAntiAlias;
    // All tools default to AA ON (true) when no explicit value is set.
    const isAntiAliased = clipBox?.spatial.antiAliased ?? true;


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
      cropToolSetCmd,


      // System Commands (cross-plugin, via actions.adv API — AdvCommandRef)
      cutCmd: actions.adv.layer.clip.cut,
      copyCmd: actions.adv.layer.clip.copy,
      pasteCmd: actions.adv.layer.clip.paste,
      drillCmd: actions.adv.layer.clip.drill,
      // Apply selection as bitmap mask on the active layer (purple "Apply Mask" button).
      // Atomic with selection-clear inside the command body — see
      // `core/advanced/commands/layer/clip.ts::toMask`.
      applyMaskCmd: actions.adv.layer.clip.toMask,

      // Tool / state derived helpers
      cropTool,
      isRegularTool,
      isIrregularTool,
      hasIrregularBox,
      hasAnySelection,
      supportsAntiAlias,
      isAntiAliased,

      // Helpers (plain functions — non-command logic)
      updateClipBox: (payload: { x?: number; y?: number; w?: number; h?: number }) => {
        const target = getActiveTarget({ activeFrame, actions }, isReCanvas);
        if (!target) return;
        const nextBox = asLocalRect({ ...target.box, ...payload });
        const finalBox = target.clampRect(nextBox);
        target.updateShape({ rect: finalBox });
      },
      /**
       * setShapeType — preserved for backward compatibility (internal callers still
       * use it via the legacy shape dropdown path). New code should call
       * `cropToolSetCmd.execute({ tool })` instead, which is the unified entry
       * for tool switching (covers regular + irregular branches per §3.2.3).
       */
      setShapeType: (type: ShapeType, antiAliased?: boolean) => {
        if (!activeFrame) return;
        if (isReCanvas) {
          const patch: LocalShape = { ...activeFrame.canvasCropBox, type };
          if (antiAliased !== undefined) patch.antiAliased = antiAliased;
          actions.setCanvasCropBox(activeFrame.id, patch);
        } else {
          const currentClip = getRegularClipShape(activeFrame) || asLocalShape({ x: 0, y: 0, w: 0, h: 0 });
          const patch: LocalShape = { ...currentClip, type };
          if (antiAliased !== undefined) patch.antiAliased = antiAliased;
          const toolId = type === 'circle' ? 'ellipse' : 'rect';
          actions.setClipBox(activeFrame.id, toolId, patch);
        }
      },
      closeReCanvas: () => reCanvasActiveSignal?.set(false),
    };
  }, [
    actions,
    activeFrame,
    reCanvasActiveSignal,
    toggleModeCmd,
    exitClipModeCmd,
    reCanvasToggleCmd,
    reCanvasApplyCmd,
    setAspectCmd,
    resetAspectCmd,
    antiAliasToggleCmd,
    branchCreateCmd,
    boxResetCmd,
    cropToolSetCmd,
  ]);

};
