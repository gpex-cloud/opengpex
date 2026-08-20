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
 * useAIToolPanel — Composite hook that bundles all common AI tool panel setup.
 *
 * Combines:
 *   - useToolConfig (namespaced config read/write)
 *   - updateModelList (merge builtins with persisted models)
 *   - useSyncExternalStore (reactive store subscription)
 *   - useModelManager (download, cache, lifecycle)
 *   - isBusy derivation
 *
 * Each panel passes tool-specific constants (configKey, builtins, store, actions)
 * and gets back everything needed for rendering + ModelPanel props.
 *
 * @example
 * ```tsx
 * const { config, setConfig, mgr, task, lastResult, error, isBusy } = useAIToolPanel({
 *   configKey: 'bgremover',
 *   defaultConfig: { models: BUILTIN_MODELS, activeModelId: BUILTIN_MODELS[0].id },
 *   builtins: BUILTIN_MODELS,
 *   store: bgRemoverStore,
 *   actions,
 * });
 * ```
 */

import { useSyncExternalStore } from 'react';
import { useToolConfig } from './useToolConfig';
import { updateModelList } from './utils';
import { useModelManager } from './download/useModelManager';
import type { ModelEntry, ModelCatalog } from './types';
import type { AIToolStore, AIToolTask } from './control/createAIToolStore';
import type { ModelManagerReturn } from './download/useModelManager';
import type { ModelFile } from './download/model-download';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UseAIToolPanelOptions<TConfig extends ModelCatalog> {
  /** Config sub-key (e.g. 'bgremover', 'upscaler', 'seg', 'inpaintEraser') */
  configKey: string;
  /** Human-readable tool name for export filename (e.g. "Upscaler", "BG Remover"). Falls back to configKey. */
  toolDisplayName?: string;
  /** Default config for this tool */
  defaultConfig: TConfig;
  /** Built-in model definitions */
  builtins: ModelEntry[];
  /** The tool's AIToolStore instance */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store: AIToolStore<any>;
  /** Editor actions (for useModelManager HUD messages) */
  actions: { setInteraction(patch: { hud: { message: string; type: 'info' | 'success' | 'error' } }): void };
  /**
   * Custom files resolver for model download.
   * @default (model) => [{ filename: model.onnxFile ?? 'model.onnx', expectedBytes: model.expectedBytes }]
   */
  getFiles?: (model: ModelEntry) => ModelFile[];
}

export interface UseAIToolPanelReturn<TConfig extends ModelCatalog, TResult> {
  /** Tool config (models list + activeModelId + tool-specific fields) */
  config: TConfig;
  /** Patch-style config setter */
  setConfig: (patch: Partial<TConfig>) => void;
  /** useModelManager return (cache state, download controls) */
  mgr: ModelManagerReturn;
  /** Current task (non-null = show InferencePanel) */
  task: AIToolTask | null;
  /** Last inference result */
  lastResult: TResult | null;
  /** Error message (non-null = show ErrorPanel) */
  error: string | null;
  /** Whether the tool is busy (inference in progress OR downloading) */
  isBusy: boolean;
}

// ─── Default files resolver ──────────────────────────────────────────────────

const defaultGetFiles = (model: ModelEntry): ModelFile[] => [
  { filename: model.onnxFile ?? 'model.onnx', expectedBytes: model.expectedBytes },
];

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useAIToolPanel<TConfig extends ModelCatalog, TResult = unknown>(
  options: UseAIToolPanelOptions<TConfig>,
): UseAIToolPanelReturn<TConfig, TResult> {
  const { configKey, toolDisplayName, defaultConfig, builtins, store, actions, getFiles = defaultGetFiles } = options;

  // ─── Config ────────────────────────────────────────────────────────────────
  const [config, setConfig] = useToolConfig<TConfig>(configKey, defaultConfig);

  // ─── Models ────────────────────────────────────────────────────────────────
  const models = updateModelList((config.models ?? []) as ModelEntry[], builtins);
  const activeModel = models.find(m => m.id === config.activeModelId) || models[0];

  // ─── Store subscription ────────────────────────────────────────────────────
  const { task, lastResult, error } = useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getState,
  ) as { task: AIToolTask | null; lastResult: TResult | null; error: string | null };

  // ─── Model Manager ─────────────────────────────────────────────────────────
  const files = getFiles(activeModel);
  const mgr = useModelManager({
    modelId: activeModel?.modelId,
    modelName: activeModel?.name,
    toolId: toolDisplayName ?? configKey,
    files,
    actions,
    store,
  });

  // ─── Derived ───────────────────────────────────────────────────────────────
  const isBusy = task !== null || mgr.isDownloading;

  return { config, setConfig, mgr, task, lastResult, error, isBusy };
}
