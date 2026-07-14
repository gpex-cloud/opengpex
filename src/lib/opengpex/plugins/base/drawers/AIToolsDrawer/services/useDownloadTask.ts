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
 * useDownloadTask — React hook subscribing to the download singleton.
 *
 * Provides reactive access to the module-level download state.
 * The download continues even if the component unmounts. When it remounts,
 * it immediately receives the current state via the subscription.
 *
 * Usage:
 * ```tsx
 * const { task, start, cancel, clear } = useDownloadTask();
 *
 * // task?.modelId — which model is downloading
 * // task?.progress — full DownloadProgress object
 * // start(modelId, files) — trigger download
 * // cancel() — abort current download
 * // clear() — clear terminal state (done/error/cancelled)
 * ```
 */

import { useCallback, useSyncExternalStore } from 'react';
import {
  subscribeDownload,
  getActiveDownload,
  startDownload,
  cancelDownload,
  clearDownloadTask,
  type DownloadTask,
} from './download-singleton';
import type { ModelFile } from './model-download';

export interface UseDownloadTaskReturn {
  /** Current download task (null = idle) */
  task: DownloadTask | null;
  /** Whether a download is actively in progress */
  isDownloading: boolean;
  /** Start downloading a model */
  start: (modelId: string, files: ModelFile[]) => void;
  /** Cancel the current download */
  cancel: () => void;
  /** Clear terminal state (after handling done/error/cancelled) */
  clear: () => void;
}

function subscribe(onStoreChange: () => void): () => void {
  return subscribeDownload(() => onStoreChange());
}

function getSnapshot(): DownloadTask | null {
  return getActiveDownload();
}

export function useDownloadTask(): UseDownloadTaskReturn {
  const task = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const start = useCallback((modelId: string, files: ModelFile[]) => {
    startDownload(modelId, files);
  }, []);

  const cancel = useCallback(() => {
    cancelDownload();
  }, []);

  const clear = useCallback(() => {
    clearDownloadTask();
  }, []);

  const isDownloading = task?.progress.stage === 'downloading';

  return { task, isDownloading, start, cancel, clear };
}
