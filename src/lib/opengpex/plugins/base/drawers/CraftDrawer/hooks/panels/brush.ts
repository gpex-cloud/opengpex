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

import { useCallback, useMemo } from 'react';
import { useEditorServices, usePluginSignals, usePluginSelfConfig, usePluginConfig } from '@opengpex/editor/core/context';
import { ColorOptionsAPI } from '@opengpex/editor/plugins/base/options/ColorOptions/protocols';
import { ActiveCraft, BrushPreset, CraftDrawerConfig } from '../../protocols';
import { fromHex, convertColorGamut, WORKING_GAMUT, type ColorValue } from '@opengpex/editor/core/engine/color';
import { CraftDrawerSignalsMap } from '../../commands.d';

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
  // Eraser edge AA (panel keeps it two-way bound to hardness: AA on ⇒ 100).
  const eraserAntiAliased = selfConfig.eraserAntiAliased ?? true;
  // Brush edge AA (mirror of eraserAntiAliased; opposite hardness binding — see
  // CraftDrawerConfig.brushAntiAliased).
  const brushAntiAliased = selfConfig.brushAntiAliased ?? true;

  // Reads brush color (from pendingColor of ColorOptions).
  // PHASE 1 BRIDGE: brush colour stays a hex string (brush wide-gamut is out of
  // scope), so read `.hex` and wrap writes in fromHex.
  const [colorConfig] = usePluginConfig<{ pendingColor?: ColorValue }>(ColorOptionsAPI.configKey);
  const brushColor = colorConfig?.pendingColor?.hex || '#FFFFFF';

  const updateBrushParam = useCallback(
    (key: string, value: number) => {
      setSelfConfig({ [key]: value } as Partial<CraftDrawerConfig>);
    },
    [setSelfConfig]
  );

  const updateBrushColor = useCallback(
    (color: string) => {
      // The string-API bridge enters as sRGB; persist the WORKING_GAMUT storage
      // form like every other `pendingColor` writer.
      actions.updatePluginConfig(ColorOptionsAPI.configKey, {
        pendingColor: convertColorGamut(fromHex(color), WORKING_GAMUT),
      });
    },
    [actions]
  );

  const updateEraserAntiAliased = useCallback(
    (antiAliased: boolean) => {
      setSelfConfig({ eraserAntiAliased: antiAliased });
    },
    [setSelfConfig]
  );

  const updateBrushAntiAliased = useCallback(
    (antiAliased: boolean) => {
      setSelfConfig({ brushAntiAliased: antiAliased });
    },
    [setSelfConfig]
  );

  const updateBrushFlag = useCallback(
    (key: 'brushPressureOpacity' | 'brushVelocity' | 'brushTaperLink', value: boolean) => {
      setSelfConfig({ [key]: value });
    },
    [setSelfConfig]
  );

  const saveBrushPreset = useCallback(
    (name: string) => {
      const preset: BrushPreset = {
        id: `bp_${Date.now().toString(36)}`,
        name,
        size: brushSize,
        opacity: brushOpacity,
        hardness: brushHardness,
        antiAliased: brushAntiAliased,
        stabilizer: selfConfig.brushStabilizer ?? 0,
        pressureOpacity: selfConfig.brushPressureOpacity === true,
        taper: selfConfig.brushTaper ?? 0,
        taperStart: selfConfig.brushTaperStart ?? selfConfig.brushTaper ?? 0,
        taperEnd: selfConfig.brushTaperEnd ?? selfConfig.brushTaper ?? 0,
        velocity: selfConfig.brushVelocity === true,
      };
      setSelfConfig({ brushPresets: [...(selfConfig.brushPresets ?? []), preset].slice(-20) });
    },
    [setSelfConfig, selfConfig, brushSize, brushOpacity, brushHardness, brushAntiAliased],
  );

  const applyBrushPreset = useCallback(
    (id: string) => {
      const preset = (selfConfig.brushPresets ?? []).find((p) => p.id === id);
      if (!preset) return;
      setSelfConfig({
        brushSize: preset.size,
        brushOpacity: preset.opacity,
        brushHardness: preset.hardness,
        brushAntiAliased: preset.antiAliased,
        brushStabilizer: preset.stabilizer,
        brushPressureOpacity: preset.pressureOpacity,
        brushTaper: preset.taper,
        brushTaperStart: preset.taperStart ?? preset.taper,
        brushTaperEnd: preset.taperEnd ?? preset.taper,
        brushVelocity: preset.velocity,
      });
    },
    [setSelfConfig, selfConfig],
  );

  const deleteBrushPreset = useCallback(
    (id: string) => {
      setSelfConfig({ brushPresets: (selfConfig.brushPresets ?? []).filter((p) => p.id !== id) });
    },
    [setSelfConfig, selfConfig],
  );

  return useMemo(() => ({
    brushSize,
    brushOpacity,
    brushHardness,
    brushColor,
    isEraser,
    eraserAntiAliased,
    brushAntiAliased,
    updateBrushParam,
    updateBrushColor,
    updateEraserAntiAliased,
    updateBrushAntiAliased,
    brushStabilizer: selfConfig.brushStabilizer ?? 0,
    brushPressureOpacity: selfConfig.brushPressureOpacity === true,
    brushTaper: selfConfig.brushTaper ?? 0,
    brushTaperStart: selfConfig.brushTaperStart ?? selfConfig.brushTaper ?? 0,
    brushTaperEnd: selfConfig.brushTaperEnd ?? selfConfig.brushTaper ?? 0,
    brushTaperLink: selfConfig.brushTaperLink !== false,
    brushVelocity: selfConfig.brushVelocity === true,
    brushPresets: selfConfig.brushPresets ?? [],
    updateBrushFlag,
    saveBrushPreset,
    applyBrushPreset,
    deleteBrushPreset,
  }), [brushSize, brushOpacity, brushHardness, brushColor, isEraser, eraserAntiAliased, brushAntiAliased, updateBrushParam, updateBrushColor, updateEraserAntiAliased, updateBrushAntiAliased, selfConfig, updateBrushFlag, saveBrushPreset, applyBrushPreset, deleteBrushPreset]);
}
