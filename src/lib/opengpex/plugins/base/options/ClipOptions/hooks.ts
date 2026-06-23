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
import { asLocalRect, ShapeType, LocalShape } from '@opengpex/editor/core/types';
import { getActiveTarget } from './commands';
import { isRegularTool as isRegularToolFn, isIrregularTool as isIrregularToolFn } from './protocols';
import type { CropTool } from './protocols';

/**
 * useClipOptionsCommands: Command Discovery Hook.
 * Plugin commands are directly passed with Cmd suffix, explicitly called in component layer via .execute().
 * Non-command helper operations remain in bare function form.
 */
export const useClipOptionsCommands = () => {
  const { activeFrame } = useEditorState();
  const { actions } = useEditorServices();

  const {
    toggleModeCmd,
    reCanvasToggleCmd,
    reCanvasApplyCmd,
    setAspectCmd,
    resetAspectCmd,
    antiAliasToggleCmd,
    branchCreateCmd,
    boxResetCmd,
    cropToolSetCmd, // ← derived from CMD_SET_CROP_TOOL = 'cmd.crop_tool.set'
  } = usePluginCommands();
  const { reCanvasActiveSignal, cropToolSignal } = usePluginSignals();

  return useMemo(() => {
    const isReCanvas = !!reCanvasActiveSignal?.value;

    // Active crop tool (single source of truth for the UI). Falls back to 'rect'
    // before the signal is registered (defensive — usePluginSignals always
    // registers it once the plugin mounts).
    const cropTool = (cropToolSignal?.value as CropTool | undefined) ?? 'rect';
    // Pre-PR-6-2: derive from CROP_TOOL_STRATEGIES via the helper functions
    // exported from protocols.ts. This eliminates the previous duplicate
    // truth source (literal `cropTool === 'rect' || ...`) and makes the
    // tool family completely table-driven.
    const isRegularTool = isRegularToolFn(cropTool);
    const isIrregularTool = isIrregularToolFn(cropTool);
    const hasIrregularBox = !!activeFrame?.irregularCropBox;

    return {
      // Plugin Commands (transparently passed Cmd references, explicitly called in component layer via .execute())
      toggleModeCmd,
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
      // `core/advanced/commands/irregular/selection.ts::toLayerMask`.
      applyMaskCmd: actions.adv.irregular.selection.toLayerMask,

      // Tool / state derived helpers
      cropTool,
      isRegularTool,
      isIrregularTool,
      hasIrregularBox,

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
        const setter = isReCanvas ? actions.setCanvasCropBox : actions.setImageCropBox;
        const target = isReCanvas ? activeFrame.canvasCropBox : activeFrame.imageCropBox;
        const patch: LocalShape = { ...target, type };
        if (antiAliased !== undefined) {
          patch.antiAliased = antiAliased;
        }
        setter(activeFrame.id, patch);
      },
      closeReCanvas: () => reCanvasActiveSignal?.set(false),
    };
  }, [
    actions,
    activeFrame,
    reCanvasActiveSignal,
    cropToolSignal,
    toggleModeCmd,
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
