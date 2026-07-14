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
import { getReferenceFontSize } from './protocols';
import type { ActiveCraft, CraftType, CraftDrawerConfig, PendingTextData } from './protocols';
import type { TextLayerData } from '@opengpex/editor/core/types/models';
import type { CraftDrawerCommandsMap, CraftDrawerSignalsMap } from './commands.d';

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
  const { activeCraftSignal } = usePluginSignals<CraftDrawerSignalsMap>();
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
  const { setCraftCmd } = usePluginCommands<CraftDrawerCommandsMap>();
  const { activeCraftSignal } = usePluginSignals<CraftDrawerSignalsMap>();

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
  const { setCraftCmd, deactivateCraftCmd } = usePluginCommands<CraftDrawerCommandsMap>();
  const { activeCraftSignal } = usePluginSignals<CraftDrawerSignalsMap>();
  const { activeLayer } = useEditorState();

  // Local control switch: true uses scheme 1 (go home logic), false uses scheme 2 (switch tool directly)
  const enableHomeBehavior = true;

  const activeCraft = (activeCraftSignal?.value ?? null) as ActiveCraft;
  const activeLayerIsText = activeLayer?.type === 'text';
  const activeLayerIsPaint = activeLayer?.type === 'paint';

  const handleButtonClick = useCallback(
    (buttonType: CraftType) => {
      if (activeCraft === buttonType || (buttonType === 'eraser' && activeCraft === 'restore')) {
        // Rule 1: Toggle off — current tool -> deactivate (restore is sub-mode of eraser)
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

// ─── Default text style constants ──────────────────────────────────────────────

const DEFAULT_TEXT_STYLE: Required<PendingTextData> = {
  fontFamily: 'Inter',
  fontSize: 24,
  fontWeight: 400,
  align: 'left',
  lineHeight: 1.4,
  italic: false,
  underline: false,
  strikethrough: false,
};

// ─── useTextPanel ──────────────────────────────────────────────────────────────

/**
 * useTextPanel: Semantic Hook for TextPanel text attribute panel
 *
 * Provides currently editing text layer data and attribute update methods.
 * When no target layer exists (pre-edit state), reads/writes from pendingTextData
 * in pluginConfig to persist user's text style choices across layer creation.
 */
export function useTextPanel() {
  const { state, activeFrame, activeLayer } = useEditorState();
  const { actions } = useEditorServices();
  const [selfConfig, setSelfConfig] = usePluginSelfConfig<CraftDrawerConfig>();

  const editingLayerId = state.interaction.signals[TextOverlayAPI.signals.editingTextLayerId] as string | null;
  const editingLayerExists = !!(editingLayerId && activeFrame?.layers.byId[editingLayerId]);

  // Gets text layer currently editing (prioritizes editing signal, followed by activeLayer)
  const targetLayerId = (editingLayerExists ? editingLayerId : null) || (activeLayer?.type === 'text' ? activeLayer.id : null);
  const targetLayer = targetLayerId && activeFrame ? activeFrame.layers.byId[targetLayerId] : null;
  const layerTextData = targetLayer?.textData;

  // ─── Pending Text Data (pre-edit state persistence) ─────────────────────────
  const pendingTextData = selfConfig.pendingTextData || DEFAULT_TEXT_STYLE;

  // Resolution-adaptive reference font size (used as fallback when user hasn't explicitly set a preference)
  const referenceFontSize = activeFrame
    ? getReferenceFontSize(activeFrame.canvas.w, activeFrame.canvas.h)
    : 24;

  // Read fontSize directly from raw config (bypasses DEFAULT_TEXT_STYLE fallback).
  // Only truthy when user has explicitly changed font size in the panel.
  const userExplicitFontSize = selfConfig.pendingTextData?.fontSize;

  /**
   * Synthesized textData: When a target layer exists, use layer's textData;
   * otherwise use pendingTextData to drive the panel UI.
   *
   * For fontSize: uses explicit user preference if set,
   * otherwise falls back to resolution-adaptive reference size.
   */
  const textData: TextLayerData | undefined = useMemo(() => {
    if (layerTextData) return layerTextData;
    return {
      content: '',
      fontFamily: pendingTextData.fontFamily ?? DEFAULT_TEXT_STYLE.fontFamily,
      fontSize: userExplicitFontSize ?? referenceFontSize,
      fontWeight: pendingTextData.fontWeight ?? DEFAULT_TEXT_STYLE.fontWeight,
      align: pendingTextData.align ?? DEFAULT_TEXT_STYLE.align,
      lineHeight: pendingTextData.lineHeight ?? DEFAULT_TEXT_STYLE.lineHeight,
      italic: pendingTextData.italic ?? DEFAULT_TEXT_STYLE.italic,
      underline: pendingTextData.underline ?? DEFAULT_TEXT_STYLE.underline,
      strikethrough: pendingTextData.strikethrough ?? DEFAULT_TEXT_STYLE.strikethrough,
      color: '#FFFFFF', // placeholder, actual color managed by ColorOptions
      boxMode: 'auto',
    } as TextLayerData;
  }, [layerTextData, pendingTextData, userExplicitFontSize, referenceFontSize]);

  const updateTextData = useCallback(
    (patch: Partial<TextLayerData>) => {
      if (!targetLayerId || !layerTextData) {
        // Pre-edit state: persist to pendingTextData in pluginConfig
        const pendingPatch: Partial<PendingTextData> = {};
        if (patch.fontFamily !== undefined) pendingPatch.fontFamily = patch.fontFamily;
        if (patch.fontSize !== undefined) pendingPatch.fontSize = patch.fontSize;
        if (patch.fontWeight !== undefined) pendingPatch.fontWeight = patch.fontWeight;
        if (patch.align !== undefined) pendingPatch.align = patch.align;
        if (patch.lineHeight !== undefined) pendingPatch.lineHeight = patch.lineHeight;
        if (patch.italic !== undefined) pendingPatch.italic = patch.italic;
        if (patch.underline !== undefined) pendingPatch.underline = patch.underline;
        if (patch.strikethrough !== undefined) pendingPatch.strikethrough = patch.strikethrough;

        if (Object.keys(pendingPatch).length > 0) {
          setSelfConfig({
            pendingTextData: { ...pendingTextData, ...pendingPatch },
          } as Partial<CraftDrawerConfig>);
        }
        return;
      }

      if (!activeFrame) return;

      if (editingLayerId) {
        // Editing state: directly updates via updateLayer (without creating independent undo point,
        // attribute modifications are included in the overall editing transaction, rolling back with checkpoint of cmd.edit_start)
        actions.updateLayer(activeFrame.id, targetLayerId, {
          textData: { ...layerTextData, ...patch },
        });
      } else {
        // Non-editing state: updates via undoable command (generates independent undo point)
        actions.executeCommand(TextOverlayAPI.commands.updateProperties.uid, {
          frameId: activeFrame.id,
          layerId: targetLayerId,
          patch,
        });
      }

      // Also sync to pendingTextData so next layer creation uses latest settings
      const pendingSync: Partial<PendingTextData> = {};
      if (patch.fontFamily !== undefined) pendingSync.fontFamily = patch.fontFamily;
      if (patch.fontSize !== undefined) pendingSync.fontSize = patch.fontSize;
      if (patch.fontWeight !== undefined) pendingSync.fontWeight = patch.fontWeight;
      if (patch.align !== undefined) pendingSync.align = patch.align;
      if (patch.lineHeight !== undefined) pendingSync.lineHeight = patch.lineHeight;
      if (patch.italic !== undefined) pendingSync.italic = patch.italic;
      if (patch.underline !== undefined) pendingSync.underline = patch.underline;
      if (patch.strikethrough !== undefined) pendingSync.strikethrough = patch.strikethrough;

      if (Object.keys(pendingSync).length > 0) {
        setSelfConfig({
          pendingTextData: { ...pendingTextData, ...pendingSync },
        } as Partial<CraftDrawerConfig>);
      }
    },
    [actions, activeFrame, targetLayerId, layerTextData, editingLayerId, pendingTextData, setSelfConfig]
  );

  /**
   * updateTextDataLive: Always writes directly using non-undoable (used for continuous input scenarios like slider dragging).
   * When slider is released, call updateTextData to generate independent undo point (non-editing state).
   */
  const updateTextDataLive = useCallback(
    (patch: Partial<TextLayerData>) => {
      if (!targetLayerId || !layerTextData) {
        // Pre-edit state: same as updateTextData (write to pendingTextData)
        const pendingPatch: Partial<PendingTextData> = {};
        if (patch.fontFamily !== undefined) pendingPatch.fontFamily = patch.fontFamily;
        if (patch.fontSize !== undefined) pendingPatch.fontSize = patch.fontSize;
        if (patch.fontWeight !== undefined) pendingPatch.fontWeight = patch.fontWeight;
        if (patch.align !== undefined) pendingPatch.align = patch.align;
        if (patch.lineHeight !== undefined) pendingPatch.lineHeight = patch.lineHeight;
        if (patch.italic !== undefined) pendingPatch.italic = patch.italic;
        if (patch.underline !== undefined) pendingPatch.underline = patch.underline;
        if (patch.strikethrough !== undefined) pendingPatch.strikethrough = patch.strikethrough;

        if (Object.keys(pendingPatch).length > 0) {
          setSelfConfig({
            pendingTextData: { ...pendingTextData, ...pendingPatch },
          } as Partial<CraftDrawerConfig>);
        }
        return;
      }

      if (!activeFrame) return;
      actions.updateLayer(activeFrame.id, targetLayerId, {
        textData: { ...layerTextData, ...patch },
      });
    },
    [actions, activeFrame, targetLayerId, layerTextData, pendingTextData, setSelfConfig]
  );

  // ─── Color Synchronization ──────────────────────────────────────────────────
  const [colorConfig] = usePluginConfig<{ pendingColor?: string }>(ColorOptionsAPI.configKey);
  const globalColor = colorConfig?.pendingColor || '#FFFFFF';
  const textColor = layerTextData?.color || globalColor;

  const updateTextColor = useCallback(
    (color: string) => {
      actions.updatePluginConfig(ColorOptionsAPI.configKey, { pendingColor: color });
      if (targetLayerId && layerTextData) {
        updateTextData({ color });
      }
    },
    [actions, targetLayerId, layerTextData, updateTextData]
  );

  const updateTextColorLive = useCallback(
    (color: string) => {
      actions.updatePluginConfig(ColorOptionsAPI.configKey, { pendingColor: color });
      if (targetLayerId && layerTextData) {
        updateTextDataLive({ color });
      }
    },
    [actions, targetLayerId, layerTextData, updateTextDataLive]
  );

  // ─── Mount-time cleanup: clear stale fontSize from legacy sync behavior ─────
  // Old code always synced fontSize to pendingTextData; new adaptive logic requires
  // fontSize to only be present when user explicitly sets it via the panel.
  const didCleanupRef = useRef(false);
  useEffect(() => {
    if (!didCleanupRef.current && selfConfig.pendingTextData?.fontSize !== undefined && !targetLayerId) {
      didCleanupRef.current = true;
      setSelfConfig({
        pendingTextData: { ...selfConfig.pendingTextData, fontSize: undefined },
      } as Partial<CraftDrawerConfig>);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Layer Selection Change: Sync color and pendingTextData ─────────────────
  const lastTargetLayerIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (targetLayerId !== lastTargetLayerIdRef.current) {
      // Layer selection changed
      lastTargetLayerIdRef.current = targetLayerId;
      if (targetLayerId && layerTextData) {
        // Synchronize color of selected layer to global ColorOptions
        if (layerTextData.color) {
          actions.updatePluginConfig(ColorOptionsAPI.configKey, { pendingColor: layerTextData.color });
        }
        // Sync selected layer's text style to pendingTextData.
        // fontSize is intentionally CLEARED on layer selection change:
        // - Only persisted when user explicitly changes it in the panel (updateTextData)
        // - This allows getReferenceFontSize() to serve as the adaptive default
        //   for new layer creation on different canvas sizes
        // - Handles migration from old code that always synced fontSize: 24
        setSelfConfig({
          pendingTextData: {
            fontSize: undefined,  // Clear: adaptive default will be used for new layers
            fontFamily: layerTextData.fontFamily || DEFAULT_TEXT_STYLE.fontFamily,
            fontWeight: layerTextData.fontWeight || DEFAULT_TEXT_STYLE.fontWeight,
            align: layerTextData.align || DEFAULT_TEXT_STYLE.align,
            lineHeight: layerTextData.lineHeight || DEFAULT_TEXT_STYLE.lineHeight,
            italic: layerTextData.italic ?? DEFAULT_TEXT_STYLE.italic,
            underline: layerTextData.underline ?? DEFAULT_TEXT_STYLE.underline,
            strikethrough: layerTextData.strikethrough ?? DEFAULT_TEXT_STYLE.strikethrough,
          },
        } as Partial<CraftDrawerConfig>);
      }
    } else {
      // Layer selection unchanged (only globalColor change or textData.color change could occur)
      if (targetLayerId && layerTextData) {
        if (layerTextData.color !== globalColor) {
          // If it is a global pendingColor change (e.g. user operated the top global color palette), synchronize to text layer
          updateTextData({ color: globalColor });
        }
      }
    }
  }, [targetLayerId, layerTextData, globalColor, actions, updateTextData, setSelfConfig]);

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
  const { activeCraftSignal } = usePluginSignals<CraftDrawerSignalsMap>();
  const { actions } = useEditorServices();
  const [selfConfig, setSelfConfig] = usePluginSelfConfig<CraftDrawerConfig>();

  const activeCraft = (activeCraftSignal?.value ?? null) as ActiveCraft;
  const isEraser = activeCraft === 'eraser' || activeCraft === 'restore';

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
