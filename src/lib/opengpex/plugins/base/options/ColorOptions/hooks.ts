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

/* eslint-disable @typescript-eslint/ban-ts-comment */

'use client';

import { useMemo, useCallback } from 'react';
import { useEditorState, useEditorServices, usePluginSelfConfig, usePluginCommands } from '@opengpex/editor/core/context';
import { ColorOptionsConfig } from './protocols';
import type { ColorCommandsMap } from './commands.d';

/**
 * useColorOptions: Command Discovery Hook for the ColorOptions plugin.
 * Transparently passes fillAsLayerCmd reference, component layer explicitly calls .execute() and constructs payload.
 */
export const useColorOptions = () => {
  const { state, activeFrame, activeLayer } = useEditorState();
  const { actions } = useEditorServices();
  const { fillAsLayerCmd } = usePluginCommands<ColorCommandsMap>();

  // Global pending color for the next fill (persisted in plugin config)
  const [config, setConfig] = usePluginSelfConfig<ColorOptionsConfig>();
  const pendingColor = config.pendingColor || "#EAB308";

  const { currentColor, isColorLayer } = useMemo(() => {
    const isColorLayer = activeLayer?.type === "color";
    const currentColor = isColorLayer
      ? activeLayer?.metadata?.fillColor || "#EAB308"
      : pendingColor;
    return { currentColor, isColorLayer };
  }, [activeLayer, pendingColor]);

  const applyColor = useCallback((newColor: string) => {
    // Note: sync to plugin config for persistence
    setConfig({ pendingColor: newColor });

    // If a color layer is currently active, mutate it live
    if (isColorLayer && activeFrame && activeLayer) {
      actions.updateLayer(activeFrame.id, activeLayer.id, {
        metadata: { ...activeLayer.metadata, fillColor: newColor },
      });
    }
  }, [setConfig, isColorLayer, activeFrame, activeLayer, actions]);

  const sampleColor = useCallback(async () => {
    if (typeof window === "undefined" || !("EyeDropper" in window)) return;

    // @ts-ignore - EyeDropper is a modern API not yet in all TS global types
    const eyeDropper = new window.EyeDropper();
    try {
      const result = await eyeDropper.open();
      if (result.sRGBHex) {
        applyColor(result.sRGBHex);
      }
    } catch {
      console.log("Eyedropper cancelled or failed");
    }
  }, [applyColor]);

  return {
    state,
    currentColor,
    isColorLayer,
    applyColor,
    sampleColor,
    activeFrame,
    // Plugin Command (transparently passed Cmd reference, component layer explicitly calls .execute())
    fillAsLayerCmd,
  };
};
