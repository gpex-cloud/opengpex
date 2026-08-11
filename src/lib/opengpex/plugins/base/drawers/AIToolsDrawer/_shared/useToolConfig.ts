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

/**
 * useToolConfig — Namespaced config access for individual AI tools.
 *
 * Each AI tool stores its config under a sub-key of the shared plugin config:
 *   pluginConfig["opengpex.drawers.ai_tools"] = {
 *     bgremover: { models, activeModelId },
 *     upscale: { models, activeModelId, tileSize, ... },
 *     seg: { models, activeModelId },
 *     inpaintEraser: { models, activeModelId, ... },
 *   }
 *
 * This hook provides typed read/write access to a single tool's sub-namespace,
 * preventing cross-tool config conflicts.
 *
 * Usage:
 *   const [config, setConfig] = useToolConfig<SegConfig>('seg', DEFAULT_SEG_CONFIG);
 *   // config.models → SAM models only
 *   // setConfig({ activeModelId: newId }) → merges into config.seg only
 */

import { useCallback } from 'react';
import { usePluginSelfConfig } from '@opengpex/editor/core/context';

/**
 * Read and write a namespaced sub-key of the plugin config.
 *
 * @param key - The config sub-key (e.g. 'seg', 'upscale', 'bgremover', 'inpaintEraser')
 * @param defaultConfig - Default config if the key doesn't exist yet
 * @returns [toolConfig, setToolConfig] tuple (like useState)
 */
export function useToolConfig<T>(
  key: string,
  defaultConfig: T,
): [T, (patch: Partial<T>) => void] {
  const [config, setConfig] = usePluginSelfConfig<Record<string, unknown>>();

  const toolConfig = (config?.[key] as T | undefined) ?? defaultConfig;

  const setToolConfig = useCallback((patch: Partial<T>) => {
    const current = (config?.[key] as T | undefined) ?? defaultConfig;
    setConfig({ [key]: { ...current, ...patch } });
  }, [key, config, defaultConfig, setConfig]);

  return [toolConfig, setToolConfig];
}

/**
 * Read a namespaced sub-key of the plugin config from EditorContextValue (for commands).
 *
 * @param pluginConfig - ctx.state.pluginConfig
 * @param pluginUid - The plugin UID (e.g. "opengpex.drawers.ai_tools")
 * @param key - The config sub-key (e.g. 'seg', 'upscale')
 * @param defaultConfig - Default config if the key doesn't exist yet
 */
export function getToolConfig<T>(
  pluginConfig: Record<string, unknown>,
  pluginUid: string,
  key: string,
  defaultConfig: T,
): T {
  const allConfig = pluginConfig[pluginUid] as Record<string, unknown> | undefined;
  return (allConfig?.[key] as T | undefined) ?? defaultConfig;
}

// ─── Active Model Entry Resolver ─────────────────────────────────────────────

import type { EditorContextValue } from '@opengpex/editor/core/types';
import type { ModelEntry, ModelCatalog } from './types';

/** Plugin identity constants (avoid circular deps by inlining) */
const _PLUGIN_UID = 'opengpex.drawers.ai_tools';

/**
 * getActiveModelEntry — Generic resolver for the active model entry in any AI tool.
 *
 * All AI tool commands need to resolve which model the user has selected.
 * The pattern is identical across bgremover, upscaler, segmentation, inpaint/eraser:
 *   1. Read the tool's config from its namespaced sub-key
 *   2. Find the model matching `activeModelId` in config.models
 *   3. Fall back to builtins, then to builtins[0]
 *
 * This function extracts that common logic into a single reusable utility.
 *
 * @param ctx - Editor context (provides pluginConfig)
 * @param configKey - Config sub-key (e.g. 'bgremover', 'upscale', 'seg', 'inpaintEraser')
 * @param defaultConfig - Default config for this tool
 * @param builtins - Built-in model list (for fallback)
 * @returns The resolved active model entry
 *
 * @example
 * ```ts
 * const model = getActiveModelEntry<UpscaleModelEntry>(
 *   ctx, 'upscale', DEFAULT_UPSCALE_CONFIG, BUILTIN_UPSCALE_MODELS
 * );
 * ```
 */
export function getActiveModelEntry<T extends ModelEntry>(
  ctx: EditorContextValue,
  configKey: string,
  defaultConfig: ModelCatalog,
  builtins: T[],
): T {
  const allConfig = ctx.state.pluginConfig[_PLUGIN_UID] as Record<string, unknown> | undefined;
  const config = (allConfig?.[configKey] as ModelCatalog | undefined) ?? defaultConfig;

  const activeId = config.activeModelId;

  // Try from persisted config
  const fromConfig = config.models?.find(m => m.id === activeId);
  if (fromConfig) return fromConfig as T;

  // Try from builtins (handles case where config exists but model was removed)
  const fromBuiltins = builtins.find(m => m.id === activeId);
  if (fromBuiltins) return fromBuiltins;

  // Ultimate fallback
  return builtins[0];
}
