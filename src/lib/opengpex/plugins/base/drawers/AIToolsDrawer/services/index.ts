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
 * AI Model Services — Unified download & cache infrastructure.
 *
 * This module provides framework-agnostic download and cache management
 * for all AI model files (SAM, RMBG, future LLMs, etc).
 *
 * Architecture:
 *   model-download.ts      — Core fetch + Cache Storage download engine
 *   model-cache.ts         — Cache utilities (check, delete, size)
 *   download-singleton.ts  — Module-level download manager (survives unmount)
 *   useDownloadTask.ts     — React hook subscribing to the singleton
 *   useModelManager.ts     — High-level hook (download + cache + lifecycle)
 *   ModelDownloadSection   — Compact progress UI component
 */

// Core download service
export { downloadModel, INITIAL_DOWNLOAD_PROGRESS } from './model-download';
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
} from './download-singleton';
export type { DownloadTask, DownloadListener } from './download-singleton';

// UI components
export { ModelDownloadSection } from './ModelDownloadSection';
export type { ModelDownloadSectionProps } from './ModelDownloadSection';
