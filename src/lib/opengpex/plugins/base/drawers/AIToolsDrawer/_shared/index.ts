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
 * AI Tools Shared Module — Barrel re-export.
 *
 * Only exports what is actually consumed by tool modules via this barrel.
 * Internal infrastructure (stores, commands, workers) import directly
 * from deep paths without going through this file.
 */

// ─── Composite panel hook (used by panel.tsx files) ──────────────────────────

export { useAIToolPanel } from './useToolPanel';
export type { UseAIToolPanelOptions, UseAIToolPanelReturn } from './useToolPanel';

// ─── Download hooks (used by panel.tsx files) ────────────────────────────────

export { useModelManager } from './download/useModelManager';
export type { ModelManagerReturn } from './download/useModelManager';

export { useDownloadTask } from './download/useDownloadTask';
export type { UseDownloadTaskReturn } from './download/useDownloadTask';

// ─── Download singleton busy sync (used by components.tsx) ───────────────────

export { initBusySync } from './download/downloader';

// ─── Shared panel UI components (used by panel.tsx files) ────────────────────

export { ModelPanel } from './ui';
export type { ModelPanelModel, ModelPanelProps, ModelPanelActions } from './ui';

export { InferencePanel } from './ui';
export type { InferencePanelProps } from './ui';

export { ErrorPanel } from './ui';
export type { ErrorPanelProps } from './ui';

export { ResultPanel } from './ui';
export type { ResultPanelProps } from './ui';
