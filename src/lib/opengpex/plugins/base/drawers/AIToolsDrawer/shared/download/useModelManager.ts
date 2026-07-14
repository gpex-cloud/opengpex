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
 * useModelManager — High-level hook combining download, cache, and lifecycle.
 *
 * Now backed by the download singleton, so downloads persist across
 * component mounts/unmounts. All panels (main + settings) share the
 * same download state — progress syncs everywhere, cancel syncs everywhere.
 *
 * Usage:
 * ```tsx
 * const mgr = useModelManager({
 *   modelId: activeModel?.modelId,
 *   modelName: activeModel?.name,
 *   files: [{ filename: 'encoder.onnx' }, { filename: 'decoder.onnx' }],
 *   actions,
 *   onDone: () => { statusSignal?.set(INITIAL); },
 *   onCancelled: () => { statusSignal?.set(INITIAL); },
 *   onError: (msg) => { statusSignal?.set({ stage: 'error', errorMessage: msg }); },
 * });
 * ```
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDownloadTask } from './useDownloadTask';
import { isModelCached, deleteModelCache } from './model-cache';
import { INITIAL_DOWNLOAD_PROGRESS } from './model-download';
import type { ModelFile, DownloadProgress } from './model-download';

export interface ModelManagerOptions {
  /** HuggingFace model ID (e.g. 'SharpAI/sam2-hiera-tiny-onnx') */
  modelId: string | undefined;
  /** Human-readable model name (for HUD messages) */
  modelName: string | undefined;
  /** Files to download */
  files: ModelFile[];
  /** Editor actions (for HUD messages) */
  actions: { setInteraction: (patch: { hud: { message: string; type: 'info' | 'success' | 'error' } }) => void };
  /** Called when download completes successfully */
  onDone?: () => void;
  /** Called when download is cancelled */
  onCancelled?: () => void;
  /** Called when download errors */
  onError?: (message: string) => void;
}

export interface ModelManagerReturn {
  /** Whether the active model is cached locally */
  isCached: boolean;
  /** Whether cache status is being checked */
  checkingCache: boolean;
  /** Whether a download is actively in progress (for this model) */
  isDownloading: boolean;
  /** Full download state (for ModelDownloadSection props) */
  downloadState: DownloadProgress;
  /** Start downloading the model */
  startDownload: () => void;
  /** Cancel the current download */
  cancelDownload: () => void;
  /** Delete cached model files */
  deleteCache: () => Promise<void>;
}

export function useModelManager(options: ModelManagerOptions): ModelManagerReturn {
  const { modelId, modelName, files, actions } = options;

  // Keep callbacks in refs so they're always fresh
  const onDoneRef = useRef(options.onDone);
  const onCancelledRef = useRef(options.onCancelled);
  const onErrorRef = useRef(options.onError);
  useEffect(() => {
    onDoneRef.current = options.onDone;
    onCancelledRef.current = options.onCancelled;
    onErrorRef.current = options.onError;
  });

  // ─── Download (singleton) ─────────────────────────────────────────────────
  const { task, isDownloading: singletonBusy, start, cancel, clear } = useDownloadTask();

  // Is this model being downloaded?
  const isThisModel = task?.modelId === modelId;
  const isDownloading = isThisModel && singletonBusy;
  const downloadState: DownloadProgress = isThisModel && task
    ? task.progress
    : INITIAL_DOWNLOAD_PROGRESS;

  // ─── Cache status ────────────────────────────────────────────────────────
  const [isCached, setIsCached] = useState(false);
  const [checkingCache, setCheckingCache] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      if (!modelId) return;
      setCheckingCache(true);
      const cached = await isModelCached(modelId);
      if (!cancelled) {
        setIsCached(cached);
        setCheckingCache(false);
      }
    };
    check();
    return () => { cancelled = true; };
  }, [modelId]);

  // ─── Lifecycle callbacks on state transitions ────────────────────────────
  const prevStageRef = useRef<string>('idle');
  useEffect(() => {
    if (!isThisModel || !task) return;

    const stage = task.progress.stage;
    const prev = prevStageRef.current;
    prevStageRef.current = stage;
    if (prev === stage) return; // only fire on transitions

    const handleTransition = async () => {
      if (stage === 'done') {
        if (modelId) {
          const cached = await isModelCached(modelId);
          setIsCached(cached);
        }
        actions.setInteraction({ hud: { message: `Model downloaded: ${modelName ?? 'unknown'}`, type: 'success' } });
        onDoneRef.current?.();
        clear();
      } else if (stage === 'cancelled') {
        actions.setInteraction({ hud: { message: 'Download cancelled', type: 'info' } });
        onCancelledRef.current?.();
        clear();
      } else if (stage === 'error') {
        const msg = task.progress.error ?? 'Download failed';
        onErrorRef.current?.(msg);
        clear();
      }
    };
    handleTransition();
  }, [task, isThisModel, actions, modelName, modelId, clear]);

  // ─── Actions ─────────────────────────────────────────────────────────────
  const startDownload = useCallback(() => {
    if (!modelId) return;
    start(modelId, files);
  }, [modelId, files, start]);

  const cancelDownload = useCallback(() => {
    cancel();
  }, [cancel]);

  const deleteCache = useCallback(async () => {
    if (!modelId) return;
    try {
      const deleted = await deleteModelCache(modelId);
      if (deleted) {
        setIsCached(false);
        actions.setInteraction({ hud: { message: `Model cache cleared: ${modelName}`, type: 'success' } });
      } else {
        actions.setInteraction({ hud: { message: 'No cached files found for this model', type: 'info' } });
      }
    } catch {
      actions.setInteraction({ hud: { message: 'Failed to clear model cache', type: 'error' } });
    }
  }, [modelId, modelName, actions]);

  return {
    isCached,
    checkingCache,
    isDownloading: !!isDownloading,
    downloadState,
    startDownload,
    cancelDownload,
    deleteCache,
  };
}
