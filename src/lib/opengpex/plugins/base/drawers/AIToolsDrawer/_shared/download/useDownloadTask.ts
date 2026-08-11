'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  subscribeDownload,
  getActiveDownload,
  startDownload,
  cancelDownload,
  clearDownloadTask,
  type DownloadTask,
} from './downloader';
import type { ModelFile } from './model-download';

export interface UseDownloadTaskReturn {
  task: DownloadTask | null;
  isDownloading: boolean;
  start: (modelId: string, files: ModelFile[]) => void;
  cancel: () => void;
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

  // Auto-clear terminal states after a brief delay.
  // This ensures the task is cleaned up regardless of which component
  // is mounted (settings page, panel, or both). The useModelManager
  // hook may also call clear() — that's fine, double-clear is a no-op.
  useEffect(() => {
    if (!task) return;
    const stage = task.progress.stage;
    if (stage === 'done' || stage === 'error' || stage === 'cancelled') {
      const timer = setTimeout(() => clearDownloadTask(), 100);
      return () => clearTimeout(timer);
    }
  }, [task]);

  return { task, isDownloading, start, cancel, clear };
}
