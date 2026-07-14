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
 * ModelSettingsShell — Shared layout shell for AI model settings panels.
 *
 * Renders the common structure (Add Custom toolbar + model card list) and
 * accepts a `renderFooter` prop so each tool can inject its own file-name
 * row (ONNX file for BG/Upscaler, encoder+decoder for Segmentation).
 *
 * This eliminates ~120 lines of duplicated JSX from each settings panel.
 */

import React from 'react';
import { Plus } from 'lucide-react';
import { ModelCard } from './ModelCard';
import type { UseModelSettingsStateReturn } from './useModelSettingsState';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Minimal model shape for the shell */
export interface ShellModel {
  id: string;
  modelId: string;
  name: string;
  size: string;
  description: string;
  builtin: boolean;
}

export interface ModelSettingsShellProps<T extends ShellModel> {
  /** Full model list (already ensured builtins) */
  models: T[];
  /** State from useModelSettingsState hook */
  state: UseModelSettingsStateReturn;
  /** Update a model's fields */
  onUpdateModel: (id: string, patch: Partial<T>) => void;
  /** Add a new custom model */
  onAddModel: () => void;
  /** Remove a custom model */
  onRemoveModel: (id: string) => void;
  /** Optional badge text derived from model (e.g. "Auto", "Interactive", "4x") */
  getBadge?: (model: T) => string | undefined;
  /**
   * Render a footer row below the ModelCard for file-name display/edit.
   * Return null to skip the footer for a model.
   */
  renderFooter?: (model: T) => React.ReactNode;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ModelSettingsShell<T extends ShellModel>(props: ModelSettingsShellProps<T>) {
  const {
    models,
    state,
    onUpdateModel,
    onAddModel,
    onRemoveModel,
    getBadge,
    renderFooter,
  } = props;
  const { cacheStatus, busyModels, isDownloading, task, handleDownload, handleCancelDownload, handleDeleteCache } = state;

  return (
    <div className="flex flex-col gap-3">
      {/* ─── Toolbar: Add custom model ─────────────────────────── */}
      <div className="flex items-center justify-end">
        <button
          onClick={onAddModel}
          className="flex items-center gap-1 text-[9px] font-bold text-[var(--text-secondary)] hover:text-[var(--text-main)] transition-colors uppercase tracking-wider"
        >
          <Plus size={10} /> Add Custom
        </button>
      </div>

      {/* ─── Model List ───────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        {models.map((model) => {
          const downloading = task?.modelId === model.modelId && isDownloading;
          const footer = renderFooter?.(model);
          return (
            <div key={model.id} className={footer ? 'flex flex-col gap-0' : ''}>
              <ModelCard
                model={{
                  ...model,
                  badge: getBadge?.(model),
                }}
                isCached={!!cacheStatus[model.modelId]}
                isBusy={!!busyModels[model.modelId]}
                isAnyDownloading={isDownloading}
                downloadProgress={downloading ? {
                  progress: task!.progress.overallTotal > 0 ? task!.progress.overallLoaded / task!.progress.overallTotal : 0,
                  loadedBytes: task!.progress.overallLoaded,
                  totalBytes: task!.progress.overallTotal,
                  speedBps: task!.progress.speedBps,
                  currentFile: task!.progress.currentFile,
                } : undefined}
                onNameChange={(name) => onUpdateModel(model.id, { name } as Partial<T>)}
                onModelIdChange={(modelId) => onUpdateModel(model.id, { modelId } as Partial<T>)}
                onDownload={() => handleDownload(model.modelId)}
                onDelete={() => handleDeleteCache(model.modelId)}
                onRemove={!model.builtin ? () => onRemoveModel(model.id) : undefined}
                onCancelDownload={handleCancelDownload}
              />
              {footer}
            </div>
          );
        })}
      </div>
    </div>
  );
}
