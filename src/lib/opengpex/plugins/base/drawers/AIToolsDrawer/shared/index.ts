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
 *   download/               — Core download infrastructure
 *     model-download.ts     — Core fetch + Cache Storage download engine
 *     model-cache.ts        — Cache utilities (check, delete, size)
 *     downloader.ts         — Module-level download manager (survives unmount)
 *     useDownloadTask.ts    — React hook subscribing to the singleton
 *     useModelManager.ts    — High-level hook (download + cache + lifecycle)
 *     ModelDownloader.tsx   — Compact progress UI component
 *   ModelCard.tsx            — Reusable model card UI
 *   ModelSettingsShell.tsx   — Shared settings panel layout
 *   useModelSettingsState.ts — Generic settings state hook
 */

// ─── Download infrastructure (re-exported from ./download) ───────────────────

export {
  // Core download service
  downloadModel,
  INITIAL_DOWNLOAD_PROGRESS,
  SpeedEstimator,
  // Cache utilities
  CACHE_NAME,
  HF_BASE,
  getCacheUrl,
  isModelCached,
  areFilesCached,
  deleteModelCache,
  getModelCacheSize,
  // React hooks
  useModelManager,
  useDownloadTask,
  // Download singleton (imperative API)
  subscribeDownload,
  getActiveDownload,
  startDownload,
  cancelDownload,
  clearDownloadTask,
  isDownloadActive,
  initBusySync,
  // UI component
  ModelDownloader,
  ModelDownloadSection,
} from './download';

export type {
  ModelFile,
  DownloadProgress,
  DownloadOptions,
  ModelManagerOptions,
  ModelManagerReturn,
  UseDownloadTaskReturn,
  DownloadTask,
  DownloadListener,
  ModelDownloaderProps,
  ModelDownloadSectionProps,
} from './download';

// ─── Settings abstractions (hook + shell) ────────────────────────────────────

export { useModelSettingsState } from './useModelSettingsState';
export type { SettingsModel, UseModelSettingsStateOptions, UseModelSettingsStateReturn } from './useModelSettingsState';
export { ModelSettingsShell } from './ModelSettingsShell';
export type { ShellModel, ModelSettingsShellProps } from './ModelSettingsShell';

// ─── UI components ───────────────────────────────────────────────────────────

export { ModelCard } from './ModelCard';
export type { ModelCardModel, ModelCardProps } from './ModelCard';
