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
 * useModelSettings — Unified hook for AI model settings panels.
 *
 * Single hook that provides everything a settings panel needs:
 *   - Flat config access (usePluginSelfConfig)
 *   - Model list sync with builtins (updateModelList)
 *   - CRUD callbacks (update/add/remove model)
 *   - Cache status checking (per model)
 *   - Download control (start/cancel/delete)
 *   - Download task subscription
 *
 * Each settings panel only needs to provide:
 *   - builtins: The built-in model list from code
 *   - defaultNewModel: Factory for creating a new custom model entry
 *   - getFiles: Function to get download manifest for a model
 *
 * Then render `<ModelSettingsShell>` with the returned `settings` object.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ModelEntry, ModelCatalog } from '../../types';
import type { ModelFile } from '../../download/model-download';
import { isModelCached, deleteModelCache, exportModelAsZip, importModelFromZip } from '../../download/model-cache';
import { useDownloadTask } from '../../download/useDownloadTask';
import { updateModelList } from '../../utils';
import { useToolConfig } from '../../useToolConfig';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UseModelSettingsOptions<TModel extends ModelEntry> {
  /** Config namespace key (e.g. 'bgremover', 'seg', 'upscale', 'inpaintEraser'). */
  configKey: string;
  /** Human-readable tool category name for export filename (e.g. "BG Remover", "Upscaler"). Spaces → hyphens. */
  toolDisplayName?: string;
  /** Default config for this tool (used when config key doesn't exist yet). */
  defaultConfig: ModelCatalog;
  /** Built-in models defined in code (used for sync). */
  builtins: TModel[];
  /** Factory to create a new blank custom model entry. */
  defaultNewModel: () => TModel;
  /** Function to get download file manifest for a model. */
  getFiles: (model: TModel) => ModelFile[];
}

export interface UseModelSettingsReturn<TModel extends ModelEntry> {
  /** Synced model list (builtins refreshed + user customs preserved). */
  models: TModel[];
  /** Update a model entry (partial patch). */
  updateModel: (id: string, patch: Partial<TModel>) => void;
  /** Add a new custom model. */
  addModel: () => void;
  /** Remove a model by id. */
  removeModel: (id: string) => void;
  /** Cache status per modelId. */
  cacheStatus: Record<string, boolean>;
  /** Busy (loading) state per modelId. */
  busyModels: Record<string, boolean>;
  /** Whether any download is in progress. */
  isDownloading: boolean;
  /** Active download task (or null). */
  task: ReturnType<typeof useDownloadTask>['task'];
  /** Start downloading a model. */
  handleDownload: (modelId: string) => void;
  /** Cancel the active download. */
  handleCancelDownload: () => void;
  /** Delete cached model files. */
  handleDeleteCache: (modelId: string) => Promise<void>;
  /** Export a cached model as zip file download. */
  handleExport: (modelId: string) => Promise<void>;
  /** Import a model from a local zip file. */
  handleImport: (modelId: string, file: File) => Promise<void>;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useModelSettings<TModel extends ModelEntry>(
  options: UseModelSettingsOptions<TModel>,
): UseModelSettingsReturn<TModel> {
  const { configKey, toolDisplayName, defaultConfig, builtins, defaultNewModel, getFiles } = options;

  // ─── Config (namespaced access via useToolConfig) ──────────────────────
  const [config, setConfig] = useToolConfig<ModelCatalog>(configKey, defaultConfig);

  const models = useMemo(
    () => updateModelList((config?.models ?? []) as TModel[], builtins),
    [config?.models, builtins],
  );

  // ─── CRUD Callbacks ────────────────────────────────────────────────────
  const updateModel = useCallback((id: string, patch: Partial<TModel>) => {
    const nextModels = models.map(m => m.id === id ? { ...m, ...patch } : m);
    setConfig({ models: nextModels });
  }, [models, setConfig]);

  const addModel = useCallback(() => {
    setConfig({ models: [...models, defaultNewModel()] });
  }, [models, defaultNewModel, setConfig]);

  const removeModel = useCallback((id: string) => {
    const nextModels = models.filter(m => m.id !== id);
    let nextActiveId = config?.activeModelId;
    if (nextActiveId === id && nextModels.length > 0) nextActiveId = nextModels[0].id;
    setConfig({ models: nextModels, activeModelId: nextActiveId });
  }, [config?.activeModelId, models, setConfig]);

  // ─── Cache & Download State ────────────────────────────────────────────
  const [cacheStatus, setCacheStatus] = useState<Record<string, boolean>>({});
  const [busyModels, setBusyModels] = useState<Record<string, boolean>>({});

  const { task, isDownloading, start: startDownload, cancel: cancelDownload } = useDownloadTask();

  // Check cache status for all models on mount and when models change
  useEffect(() => {
    let cancelled = false;
    const checkAll = async () => {
      const result: Record<string, boolean> = {};
      for (const model of models) {
        if (model.modelId) {
          result[model.modelId] = await isModelCached(model.modelId);
        }
      }
      if (!cancelled) setCacheStatus(result);
    };
    checkAll();
    return () => { cancelled = true; };
  }, [models]);

  // When download finishes (task auto-cleared by hook), recheck cache
  useEffect(() => {
    if (task) return;
    let cancelled = false;
    const recheck = async () => {
      const result: Record<string, boolean> = {};
      for (const model of models) {
        if (model.modelId) {
          result[model.modelId] = await isModelCached(model.modelId);
        }
      }
      if (!cancelled) {
        setCacheStatus(result);
        setBusyModels({});
      }
    };
    recheck();
    return () => { cancelled = true; };
  }, [task, models]);

  const handleDownload = useCallback((modelId: string) => {
    const model = models.find(m => m.modelId === modelId);
    if (!model) return;
    setBusyModels(prev => ({ ...prev, [modelId]: true }));
    startDownload(modelId, getFiles(model));
  }, [startDownload, models, getFiles]);

  const handleCancelDownload = useCallback(() => {
    cancelDownload();
    setBusyModels({});
  }, [cancelDownload]);

  const handleDeleteCache = useCallback(async (modelId: string) => {
    setBusyModels(prev => ({ ...prev, [modelId]: true }));
    await deleteModelCache(modelId);
    const stillCached = await isModelCached(modelId);
    setCacheStatus(prev => ({ ...prev, [modelId]: stillCached }));
    setBusyModels(prev => ({ ...prev, [modelId]: false }));
  }, []);

  // ─── Export / Import ───────────────────────────────────────────────────
  const getFilesRef = useRef(getFiles);
  useEffect(() => { getFilesRef.current = getFiles; });

  const handleExport = useCallback(async (modelId: string) => {
    const model = models.find(m => m.modelId === modelId);
    if (!model) return;
    try {
      const files = getFilesRef.current(model);
      const blob = await exportModelAsZip(modelId, model.name, files);
      if (!blob) return;
      // Trigger browser download — filename: {modelName}.{categorySlug}.gpex.zip
      const safeName = model.name.replace(/[^a-zA-Z0-9._-]/g, '-');
      const categorySlug = (toolDisplayName ?? configKey).replace(/\s+/g, '-');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeName}.${categorySlug}.gpex.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      // Silently fail — HUD is only available in ModelPanel context
    }
  }, [models, configKey, toolDisplayName]);

  const handleImport = useCallback(async (modelId: string, file: File) => {
    const model = models.find(m => m.modelId === modelId);
    if (!model) return;
    setBusyModels(prev => ({ ...prev, [modelId]: true }));
    try {
      const files = getFilesRef.current(model);
      const result = await importModelFromZip(modelId, files, file);
      if (result.success) {
        setCacheStatus(prev => ({ ...prev, [modelId]: true }));
      }
    } catch {
      // Silently fail
    } finally {
      setBusyModels(prev => ({ ...prev, [modelId]: false }));
    }
  }, [models]);

  return {
    models,
    updateModel,
    addModel,
    removeModel,
    cacheStatus,
    busyModels,
    isDownloading,
    task,
    handleDownload,
    handleCancelDownload,
    handleDeleteCache,
    handleExport,
    handleImport,
  };
}
