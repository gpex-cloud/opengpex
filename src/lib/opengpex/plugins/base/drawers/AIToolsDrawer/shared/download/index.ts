/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * Download Sub-module — Barrel re-export.
 *
 * All download-related infrastructure (fetch engine, cache utilities,
 * singleton manager, React hooks, UI component) lives in this directory.
 */

// Core download service + SpeedEstimator
export { downloadModel, INITIAL_DOWNLOAD_PROGRESS, SpeedEstimator } from './model-download';
export type { ModelFile, DownloadProgress, DownloadOptions } from './model-download';

// Cache utilities
export {
  CACHE_NAME,
  HF_BASE,
  getCacheUrl,
  isModelCached,
  areFilesCached,
  deleteModelCache,
  getModelCacheSize,
} from './model-cache';

// React hooks
export { useModelManager } from './useModelManager';
export type { ModelManagerOptions, ModelManagerReturn } from './useModelManager';
export { useDownloadTask } from './useDownloadTask';
export type { UseDownloadTaskReturn } from './useDownloadTask';

// Download singleton (imperative API)
export {
  subscribeDownload,
  getActiveDownload,
  startDownload,
  cancelDownload,
  clearDownloadTask,
  isDownloadActive,
  initBusySync,
} from './downloader';
export type { DownloadTask, DownloadListener } from './downloader';

// UI component
export { ModelDownloader, ModelDownloadSection } from './ModelDownloader';
export type { ModelDownloaderProps, ModelDownloadSectionProps } from './ModelDownloader';
