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

import { useCallback, useMemo, useEffect, useRef } from 'react';
import { useEditorState, useEditorServices, usePluginCommands, usePluginSignals, usePluginSelfConfig, usePluginConfig } from '@opengpex/editor/core/context';
import { TextOverlayAPI } from '../../overlays/TextOverlay/protocols';
import { ColorOptionsAPI } from '../../options/ColorOptions/protocols';
import type { ActiveCraft, CraftType, CraftDrawerConfig } from './protocols';
import type { TextLayerData } from '@opengpex/editor/core/types/models';
import type { CraftCommandsMap, CraftSignalsMap } from './commands.d';

// ─── useCraftDrawer ────────────────────────────────────────────────────────────

/**
 * useCraftDrawer: Semantic Hook for CraftDrawer main panel
 *
 * Provides currently active craft tool type and type inference of currently selected layer.
 * Panel display uses mutually exclusive logic:
 * - activeCraft has highest priority (explicitly active tool type determines panel)
 * - activeCraft=null infers panel by selected layer type (text -> TextPanel, paint -> BrushPanel)
 */
export function useCraftDrawer() {
  const { activeCraftSignal } = usePluginSignals<CraftSignalsMap>();
  const { activeLayer } = useEditorState();

  const activeCraft = (activeCraftSignal?.value ?? null) as ActiveCraft;
  const activeLayerIsText = activeLayer?.type === 'text';
  const activeLayerIsPaint = activeLayer?.type === 'paint';

  return { activeCraft, activeLayerIsText, activeLayerIsPaint };
}

// ─── useCraftTrigger ───────────────────────────────────────────────────────────

/**
 * useCraftTrigger: Semantic Hook for CraftTriggerButtons
 *
 * Encapsulates states and commands required for tool button group.
 */
export function useCraftTrigger() {
  const { setCraftCmd } = usePluginCommands<CraftCommandsMap>();
  const { activeCraftSignal } = usePluginSignals<CraftSignalsMap>();

  const activeCraft = (activeCraftSignal?.value ?? null) as ActiveCraft;

  const selectCraft = useCallback(
    (craft: CraftType) => {
      setCraftCmd?.execute({ craft });
    },
    [setCraftCmd]
  );

  return { activeCraft, selectCraft };
}

// ─── useCraftButtonGroup ───────────────────────────────────────────────────────

/**
 * useCraftButtonGroup: Semantic Hook for ButtonGroup inside CraftDrawer
 *
 * Encapsulates state and click logic of [T] [B] [E] button group inside panel.
 *
 * Click rules:
 * 1. Click button of current activeCraft -> toggle off (deactivate)
 * 2. Click any button when no craft active -> activate this craft
 * 3. When another craft is active:
 *    - click button matching layer inference (text button + text layer, brush button + paint layer) -> deactivate ("go home")
 *    - otherwise -> switch to new craft
 */
export function useCraftButtonGroup() {
  const { setCraftCmd, deactivateCraftCmd } = usePluginCommands<CraftCommandsMap>();
  const { activeCraftSignal } = usePluginSignals<CraftSignalsMap>();
  const { activeLayer } = useEditorState();

  // Local control switch: true uses scheme 1 (go home logic), false uses scheme 2 (switch tool directly)
  const enableHomeBehavior = true;

  const activeCraft = (activeCraftSignal?.value ?? null) as ActiveCraft;
  const activeLayerIsText = activeLayer?.type === 'text';
  const activeLayerIsPaint = activeLayer?.type === 'paint';

  const handleButtonClick = useCallback(
    (buttonType: CraftType) => {
      if (activeCraft === buttonType) {
        // Rule 1: Toggle off — current tool -> deactivate
        deactivateCraftCmd?.execute();
      } else if (activeCraft === null) {
        // Rule 2: No tool active -> activate target tool
        setCraftCmd?.execute({ craft: buttonType });
      } else {
        // Rule 3: Another tool active -> determine if "go home"
        const isHomeButton =
          enableHomeBehavior && (
            (buttonType === 'text' && activeLayerIsText) ||
            (buttonType === 'brush' && activeLayerIsPaint)
          );

        if (isHomeButton) {
          // "go home": exit current tool, let layer inference take over panel
          deactivateCraftCmd?.execute();
        } else {
          // switch to new tool
          setCraftCmd?.execute({ craft: buttonType });
        }
      }
    },
    [activeCraft, activeLayerIsText, activeLayerIsPaint, setCraftCmd, deactivateCraftCmd, enableHomeBehavior]
  );

  return { activeCraft, activeLayerIsText, activeLayerIsPaint, handleButtonClick };
}

// ─── useTextPanel ──────────────────────────────────────────────────────────────

/**
 * useTextPanel: Semantic Hook for TextPanel text attribute panel
 *
 * Provides currently editing text layer data and attribute update methods.
 */
export function useTextPanel() {
  const { state, activeFrame, activeLayer } = useEditorState();
  const { actions } = useEditorServices();

  const editingLayerId = state.interaction.signals[TextOverlayAPI.signals.editingTextLayerId] as string | null;

  // Gets text layer currently editing (prioritizes editing signal, followed by activeLayer)
  const targetLayerId = editingLayerId || (activeLayer?.type === 'text' ? activeLayer.id : null);
  const targetLayer = targetLayerId && activeFrame ? activeFrame.layers.byId[targetLayerId] : null;
  const textData = targetLayer?.textData;

  const updateTextData = useCallback(
    (patch: Partial<TextLayerData>) => {
      if (!activeFrame || !targetLayerId || !textData) return;

      if (editingLayerId) {
        // Editing state: directly updates via updateLayer (without creating independent undo point,
        // attribute modifications are included in the overall editing transaction, rolling back with checkpoint of cmd.edit_start)
        actions.updateLayer(activeFrame.id, targetLayerId, {
          textData: { ...textData, ...patch },
        });
      } else {
        // Non-editing state: updates via undoable command (generates independent undo point)
        actions.executeCommand(TextOverlayAPI.commands.updateProperties.uid, {
          frameId: activeFrame.id,
          layerId: targetLayerId,
          patch,
        });
      }
    },
    [actions, activeFrame, targetLayerId, textData, editingLayerId]
  );

  /**
   * updateTextDataLive: Always writes directly using non-undoable (used for continuous input scenarios like slider dragging).
   * When slider is released, call updateTextData to generate independent undo point (non-editing state).
   */
  const updateTextDataLive = useCallback(
    (patch: Partial<TextLayerData>) => {
      if (!activeFrame || !targetLayerId || !textData) return;
      actions.updateLayer(activeFrame.id, targetLayerId, {
        textData: { ...textData, ...patch },
      });
    },
    [actions, activeFrame, targetLayerId, textData]
  );

  // ─── Color Synchronization ──────────────────────────────────────────────────
  const [colorConfig] = usePluginConfig<{ pendingColor?: string }>(ColorOptionsAPI.configKey);
  const globalColor = colorConfig?.pendingColor || '#FFFFFF';
  const textColor = textData?.color || globalColor;

  const updateTextColor = useCallback(
    (color: string) => {
      actions.updatePluginConfig(ColorOptionsAPI.configKey, { pendingColor: color });
      if (targetLayerId && textData) {
        updateTextData({ color });
      }
    },
    [actions, targetLayerId, textData, updateTextData]
  );

  const updateTextColorLive = useCallback(
    (color: string) => {
      actions.updatePluginConfig(ColorOptionsAPI.configKey, { pendingColor: color });
      if (targetLayerId && textData) {
        updateTextDataLive({ color });
      }
    },
    [actions, targetLayerId, textData, updateTextDataLive]
  );

  const lastTargetLayerIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (targetLayerId !== lastTargetLayerIdRef.current) {
      // Layer selection changed
      lastTargetLayerIdRef.current = targetLayerId;
      if (targetLayerId && textData?.color) {
        // Synchronize color of selected layer to global ColorOptions
        actions.updatePluginConfig(ColorOptionsAPI.configKey, { pendingColor: textData.color });
      }
    } else {
      // Layer selection unchanged (only globalColor change or textData.color change could occur)
      if (targetLayerId && textData) {
        if (textData.color !== globalColor) {
          // If it is a global pendingColor change (e.g. user operated the top global color palette), synchronize to text layer
          updateTextData({ color: globalColor });
        }
      }
    }
  }, [targetLayerId, textData, globalColor, actions, updateTextData]);

  return useMemo(() => ({
    targetLayer,
    textData,
    updateTextData,
    updateTextDataLive,
    textColor,
    updateTextColor,
    updateTextColorLive,
  }), [targetLayer, textData, updateTextData, updateTextDataLive, textColor, updateTextColor, updateTextColorLive]);
}

// ─── useBrushPanel ─────────────────────────────────────────────────────────────

/**
 * useBrushPanel: Semantic Hook for BrushPanel brush attribute panel
 *
 * Provides ability to read and write brush parameters.
 * Parameters are stored in pluginConfig['opengpex.drawers.craft_drawer'].
 */
export function useBrushPanel() {
  const { activeCraftSignal } = usePluginSignals<CraftSignalsMap>();
  const { actions } = useEditorServices();
  const [selfConfig, setSelfConfig] = usePluginSelfConfig<CraftDrawerConfig>();

  const activeCraft = (activeCraftSignal?.value ?? null) as ActiveCraft;
  const isEraser = activeCraft === 'eraser';

  const brushSize = selfConfig.brushSize ?? 12;
  const brushOpacity = selfConfig.brushOpacity ?? 100;
  const brushHardness = selfConfig.brushHardness ?? 80;

  // Reads brush color (from pendingColor of ColorOptions)
  const [colorConfig] = usePluginConfig<{ pendingColor?: string }>(ColorOptionsAPI.configKey);
  const brushColor = colorConfig?.pendingColor || '#FFFFFF';

  const updateBrushParam = useCallback(
    (key: string, value: number) => {
      setSelfConfig({ [key]: value } as Partial<CraftDrawerConfig>);
    },
    [setSelfConfig]
  );

  const updateBrushColor = useCallback(
    (color: string) => {
      actions.updatePluginConfig(ColorOptionsAPI.configKey, { pendingColor: color });
    },
    [actions]
  );

  return useMemo(() => ({
    brushSize,
    brushOpacity,
    brushHardness,
    brushColor,
    isEraser,
    updateBrushParam,
    updateBrushColor,
  }), [brushSize, brushOpacity, brushHardness, brushColor, isEraser, updateBrushParam, updateBrushColor]);
}
