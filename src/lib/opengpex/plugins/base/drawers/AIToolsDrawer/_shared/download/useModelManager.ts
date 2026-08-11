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
 * Redesigned to eliminate flash-of-incorrect-state (FOIS) on mount:
 *   - `cacheState` starts as 'checking' — UI shows nothing until resolved
 *   - Once resolved, transitions to 'cached' or 'not-cached' deterministically
 *   - During inference execution, the panel never re-checks cache state
 *
 * Now backed by the download singleton, so downloads persist across
 * component mounts/unmounts. All panels (main + settings) share the
 * same download state — progress syncs everywhere, cancel syncs everywhere.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDownloadTask } from './useDownloadTask';
import { areFilesCached, deleteModelCache } from './model-cache';
import { INITIAL_DOWNLOAD_PROGRESS } from './model-download';
import type { ModelFile, DownloadProgress } from './model-download';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Deterministic cache state — no ambiguous boolean combinations */
export type CacheState = 'checking' | 'cached' | 'not-cached';

export interface ModelManagerOptions {
  /** HuggingFace model ID (e.g. 'SharpAI/sam2-hiera-tiny-onnx') */
  modelId: string | undefined;
  /** Human-readable model name (for HUD messages) */
  modelName: string | undefined;
  /** Files to download */
  files: ModelFile[];
  /** Editor actions (for HUD messages) */
  actions: { setInteraction: (patch: { hud: { message: string; type: 'info' | 'success' | 'error' } }) => void };
  /**
   * AI tool store — when provided, auto-generates onDone/onCancelled/onError:
   *   - onDone:      store.setState({ task: null })
   *   - onCancelled: store.reset()
   *   - onError:     store.setState({ task: null, error: msg })
   *
   * Eliminates the need for repetitive callback definitions in each panel.
   */
  store?: { setState(patch: { task?: null; error?: string | null }): void; reset(): void };
  /** Called when download completes successfully (overrides store-derived) */
  onDone?: () => void;
  /** Called when download is cancelled (overrides store-derived) */
  onCancelled?: () => void;
  /** Called when download errors (overrides store-derived) */
  onError?: (message: string) => void;
}

export interface ModelManagerReturn {
  /** Deterministic cache state: 'checking' | 'cached' | 'not-cached' */
  cacheState: CacheState;
  /** Convenience: whether the active model is cached locally */
  isCached: boolean;
  /** Whether cache status is being checked (alias for cacheState === 'checking') */
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

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useModelManager(options: ModelManagerOptions): ModelManagerReturn {
  const { modelId, modelName, files, actions, store } = options;

  // Derive callbacks: explicit callbacks take priority over store-derived ones
  const onDoneRef = useRef(options.onDone ?? (store ? () => store.setState({ task: null }) : undefined));
  const onCancelledRef = useRef(options.onCancelled ?? (store ? () => store.reset() : undefined));
  const onErrorRef = useRef(options.onError ?? (store ? (msg: string) => store.setState({ task: null, error: msg }) : undefined));
  useEffect(() => {
    onDoneRef.current = options.onDone ?? (store ? () => store.setState({ task: null }) : undefined);
    onCancelledRef.current = options.onCancelled ?? (store ? () => store.reset() : undefined);
    onErrorRef.current = options.onError ?? (store ? (msg: string) => store.setState({ task: null, error: msg }) : undefined);
  });

  // ─── Download (singleton) ─────────────────────────────────────────────────
  const { task, isDownloading: singletonBusy, start, cancel, clear } = useDownloadTask();

  // Is this model being downloaded?
  const isThisModel = task?.modelId === modelId;
  const isDownloading = isThisModel && singletonBusy;
  const downloadState: DownloadProgress = isThisModel && task
    ? task.progress
    : INITIAL_DOWNLOAD_PROGRESS;

  // ─── Cache status (single deterministic state) ────────────────────────────
  // CRITICAL: Start as 'checking' so we NEVER show "Not downloaded yet"
  // before the async check completes. This eliminates the flash-of-incorrect-state.
  const [cacheState, setCacheState] = useState<CacheState>('checking');

  // Stable key derived from filenames — triggers re-check when files change
  // even if modelId stays the same (e.g. same HF repo, different ONNX variant)
  const filesKey = files.map(f => f.filename).join('|');

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      if (!modelId) {
        setCacheState('not-cached');
        return;
      }
      setCacheState('checking');
      const filenames = files.map(f => f.filename);
      const cached = await areFilesCached(modelId, filenames);
      if (!cancelled) {
        setCacheState(cached ? 'cached' : 'not-cached');
      }
    };
    check();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, filesKey]);

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
        // Download completed — model is definitely cached now
        setCacheState('cached');
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
      const filenames = files.map(f => f.filename);
      const deleted = await deleteModelCache(modelId, filenames);
      if (deleted) {
        setCacheState('not-cached');
        actions.setInteraction({ hud: { message: `Model cache cleared: ${modelName}`, type: 'success' } });
      } else {
        actions.setInteraction({ hud: { message: 'No cached files found for this model', type: 'info' } });
      }
    } catch {
      actions.setInteraction({ hud: { message: 'Failed to clear model cache', type: 'error' } });
    }
  }, [modelId, modelName, files, actions]);

  // ─── Derived convenience values ──────────────────────────────────────────
  const isCached = cacheState === 'cached';
  const checkingCache = cacheState === 'checking';

  return {
    cacheState,
    isCached,
    checkingCache,
    isDownloading: !!isDownloading,
    downloadState,
    startDownload,
    cancelDownload,
    deleteCache,
  };
}
