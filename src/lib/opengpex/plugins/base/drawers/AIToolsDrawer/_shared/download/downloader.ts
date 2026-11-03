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

/**
 * Download Singleton — Module-level download manager.
 *
 * Keeps download state alive independent of React component lifecycle.
 * When a settings panel unmounts (user navigates away), the download
 * continues in the background. When the panel remounts, it subscribes
 * to the singleton and immediately receives the current state.
 *
 * Design:
 *   - Module-scoped state (survives component unmount)
 *   - Pub/sub pattern for UI subscribers
 *   - Single active download at a time (per model category)
 *   - AbortController for cancellation
 */

import { downloadModel, INITIAL_DOWNLOAD_PROGRESS } from './model-download';
import { deleteModelCache, areFilesCached } from './model-cache';
import type { ModelFile, DownloadProgress } from './model-download';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DownloadTask {
  /** Model ID currently being downloaded */
  modelId: string;
  /** Current download progress */
  progress: DownloadProgress;
}

export type DownloadListener = (task: DownloadTask | null) => void;

// ─── Busy Sync ───────────────────────────────────────────────────────────────

/** Stored reference to PluginService for busy state sync */
let pluginsRef: { setBusy(uid: string, busy: boolean): void } | null = null;
let pluginUid: string | null = null;

/**
 * Initialize busy-state sync. Call once from BgRemoverDrawerContent mount.
 * After this, the singleton auto-calls plugins.setBusy() on every state change.
 */
export function initBusySync(plugins: { setBusy(uid: string, busy: boolean): void }, uid: string): void {
  pluginsRef = plugins;
  pluginUid = uid;
  // Immediately sync current state
  plugins.setBusy(uid, activeTask?.progress.stage === 'downloading');
}

// ─── Module State ────────────────────────────────────────────────────────────

/** Current active download (null = idle) */
let activeTask: DownloadTask | null = null;

/** AbortController for the current download */
let controller: AbortController | null = null;

/** Set of subscribed listeners */
const listeners = new Set<DownloadListener>();

/** Throttle state */
const THROTTLE_MS = 400;
let lastNotifyTime = 0;
let pendingNotify: ReturnType<typeof setTimeout> | null = null;

// ─── Internal ────────────────────────────────────────────────────────────────

function notify() {
  lastNotifyTime = Date.now();
  // Auto-sync busy state
  if (pluginsRef && pluginUid) {
    pluginsRef.setBusy(pluginUid, activeTask?.progress.stage === 'downloading');
  }
  for (const fn of listeners) {
    fn(activeTask);
  }
}

function throttledNotify() {
  const now = Date.now();
  if (now - lastNotifyTime >= THROTTLE_MS) {
    notify();
  } else if (!pendingNotify) {
    pendingNotify = setTimeout(() => {
      pendingNotify = null;
      notify();
    }, THROTTLE_MS - (now - lastNotifyTime));
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Subscribe to download state changes.
 * Returns an unsubscribe function.
 * Immediately invokes the listener with the current state.
 */
export function subscribeDownload(listener: DownloadListener): () => void {
  listeners.add(listener);
  // Immediately provide current state
  listener(activeTask);
  return () => { listeners.delete(listener); };
}

/**
 * Get current download task (snapshot, non-reactive).
 */
export function getActiveDownload(): DownloadTask | null {
  return activeTask;
}

/**
 * Start a download. If one is already in progress, it will be cancelled first.
 */
export function startDownload(modelId: string, files: ModelFile[]): void {
  // Cancel any existing download
  if (controller) {
    controller.abort();
    controller = null;
  }
  if (pendingNotify) {
    clearTimeout(pendingNotify);
    pendingNotify = null;
  }

  // Set up new download
  controller = new AbortController();
  activeTask = {
    modelId,
    progress: {
      ...INITIAL_DOWNLOAD_PROGRESS,
      stage: 'downloading',
      totalFiles: files.length,
      currentFile: files[0]?.filename ?? null,
    },
  };
  notify();

  // Fire-and-forget
  downloadModel(modelId, files, {
    signal: controller.signal,
    onProgress: (progress) => {
      if (!activeTask || activeTask.modelId !== modelId) return;
      activeTask = { modelId, progress };
      // Terminal states flush immediately
      if (progress.stage !== 'downloading') {
        if (pendingNotify) { clearTimeout(pendingNotify); pendingNotify = null; }
        notify();
      } else {
        throttledNotify();
      }
    },
  }).catch((err) => {
    if (err instanceof DOMException && err.name === 'AbortError') {
      activeTask = { modelId, progress: { ...INITIAL_DOWNLOAD_PROGRESS, stage: 'cancelled' } };
      notify();
      // Clean up partial downloads
      deleteModelCache(modelId).catch(() => {});
    } else {
      activeTask = {
        modelId,
        progress: {
          ...INITIAL_DOWNLOAD_PROGRESS,
          stage: 'error',
          error: err instanceof Error ? err.message : String(err),
        },
      };
      notify();
    }
  }).finally(() => {
    controller = null;
  });
}

/**
 * Cancel the current download.
 */
export function cancelDownload(): void {
  if (pendingNotify) {
    clearTimeout(pendingNotify);
    pendingNotify = null;
  }
  if (controller) {
    controller.abort();
    controller = null;
  }
}

/**
 * Clear the download task state (after handling done/error/cancelled).
 */
export function clearDownloadTask(): void {
  activeTask = null;
  notify();
}

/**
 * Whether a download is currently in progress.
 */
export function isDownloadActive(): boolean {
  return activeTask?.progress.stage === 'downloading';
}

/**
 * Ensure a model is fully cached, downloading through the singleton if needed.
 *
 * This is the single entry point for lazy model acquisition (e.g. a canvas
 * interaction that needs a model the user never downloaded explicitly).
 * Downloads always flow through the singleton so every UI surface shows the
 * same progress panel; workers only ever load from Cache Storage.
 *
 * Behavior:
 *   - All files already cached → resolves immediately, no download task is
 *     created (the UI never flashes a progress panel).
 *   - Not cached → starts (or joins) the singleton download and resolves on
 *     'done', rejecting on 'error' / 'cancelled'.
 *   - Another model's download is active → rejects instead of cancelling the
 *     user's in-flight download (same-model joins are fine).
 */
export async function ensureModelDownloaded(modelId: string, files: ModelFile[]): Promise<void> {
  const filenames = files.map(f => f.filename);
  if (await areFilesCached(modelId, filenames)) return;

  const active = getActiveDownload();
  if (active && active.modelId !== modelId && active.progress.stage === 'downloading') {
    throw new Error('Another model download is in progress. Wait for it to finish or cancel it first.');
  }

  return new Promise<void>((resolve, reject) => {
    const unsubscribe = subscribeDownload((task) => {
      if (!task || task.modelId !== modelId) return;
      if (task.progress.stage === 'done') {
        unsubscribe();
        resolve();
      } else if (task.progress.stage === 'error') {
        unsubscribe();
        reject(new Error(task.progress.error ?? 'Download failed'));
      } else if (task.progress.stage === 'cancelled') {
        unsubscribe();
        reject(new DOMException('Download cancelled', 'AbortError'));
      }
    });
    // Join an already-running download for the same model; otherwise start one.
    if (!(active && active.modelId === modelId && active.progress.stage === 'downloading')) {
      startDownload(modelId, files);
    }
  });
}
