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
 * useModelSettingsState — Generic hook for AI model settings panels.
 *
 * Encapsulates the common state management pattern shared by all three
 * AI tool settings (BG Remover, Upscaler, Segmentation):
 *   - Cache status checking (per model)
 *   - Busy state management
 *   - Download initiation / cancellation
 *   - Delete with recheck
 *   - Download task subscription
 *
 * Each settings panel only needs to provide:
 *   - The model list
 *   - A function to get download files for a model
 */

import { useCallback, useEffect, useState } from 'react';
import { useDownloadTask } from './download/useDownloadTask';
import { isModelCached, deleteModelCache } from './download/model-cache';
import type { ModelFile } from './download/model-download';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Minimal model shape required by this hook */
export interface SettingsModel {
  id: string;
  modelId: string;
}

export interface UseModelSettingsStateOptions<T extends SettingsModel> {
  /** The current model list (already ensured builtins) */
  models: T[];
  /** Function to get the download file manifest for a model */
  getFiles: (model: T) => ModelFile[];
}

export interface UseModelSettingsStateReturn {
  /** Cache status per modelId */
  cacheStatus: Record<string, boolean>;
  /** Busy (loading) state per modelId */
  busyModels: Record<string, boolean>;
  /** Whether any download is in progress */
  isDownloading: boolean;
  /** Active download task (or null) */
  task: ReturnType<typeof useDownloadTask>['task'];
  /** Start downloading a model */
  handleDownload: (modelId: string) => void;
  /** Cancel the active download */
  handleCancelDownload: () => void;
  /** Delete cached model files */
  handleDeleteCache: (modelId: string) => Promise<void>;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useModelSettingsState<T extends SettingsModel>(
  options: UseModelSettingsStateOptions<T>,
): UseModelSettingsStateReturn {
  const { models, getFiles } = options;
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

  return {
    cacheStatus,
    busyModels,
    isDownloading,
    task,
    handleDownload,
    handleCancelDownload,
    handleDeleteCache,
  };
}
