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
 * ModelPanel — Smart "model selection card" for all AI tool drawer panels.
 *
 * Renders:
 *   - Model dropdown selector + refresh button
 *   - Model info (size, description)
 *   - Deterministic cache status display (checking → nothing rendered)
 *   - Download / Delete action buttons
 *   - Download progress (DownloadPanel) when active
 *
 * Behavior (self-managed):
 *   - handleModelChange: updateModelList → setConfig → client.dispose → resetStore → onAfterModelChange
 *   - handleRefresh: updateModelList → validate activeId → setConfig → HUD
 *
 * Tool-specific side effects (e.g. bgremover clearing clipBox, upscaler
 * syncing targetScale) are supported via the optional `afterModelChange` callback.
 *
 * Cache state rendering follows the plugin_signal_stale_read_convention:
 *   - 'checking' → nothing rendered (avoids flash-of-incorrect-state)
 *   - 'cached'   → "✓ Cached locally"
 *   - 'not-cached' → "Not downloaded yet"
 *
 * @see docs/opengpex/plans/20260809_shared_model_panel_spec.md
 * @see docs/opengpex/02-conventions/plugin_signal_stale_read_convention.md
 */

import React, { useCallback, useRef } from 'react';
import { Download, Trash2, ChevronDown, CheckCircle2, RefreshCw, HardDriveDownload, HardDriveUpload } from 'lucide-react';
import ActionDropdown from '@opengpex/editor/widgets/ActionDropdown';
import Tooltip from '@opengpex/editor/widgets/Tooltip';
import { FancyButton } from '@opengpex/editor/widgets/FancyButton';
import { DownloadPanel } from './DownloadPanel';
import { updateModelList } from '../utils';
import type { ModelEntry, ModelCatalog } from '../types';
import type { ModelManagerReturn } from '../download/useModelManager';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Minimal model shape for display purposes (subset of ModelEntry). */
export interface ModelPanelModel {
  id: string;
  name: string;
  size: string;
  description: string;
}

export interface ModelPanelProps {
  /** useModelManager hook return value (provides cache state + download controls) */
  mgr: ModelManagerReturn;
  /** Whether the panel is in a busy state (disables all interactions) */
  isBusy: boolean;

  // ─── Behavior: model lifecycle (replaces manual onModelChange/onRefresh) ──

  /** Tool config from useToolConfig (must contain .models and .activeModelId) */
  config: Partial<ModelCatalog>;
  /**
   * setConfig from useToolConfig — used to persist model list + activeModelId.
   * Method syntax enables bivariant checking so tool-specific config types
   * (UpscaleConfig, SegConfig, etc.) are accepted without casts.
   */
  setConfig(patch: Partial<ModelCatalog>): void;
  /** Built-in model definitions for this tool (used for updateModelList) */
  builtins: ModelEntry[];
  /** Editor actions — for showing HUD toast on refresh */
  actions: ModelPanelActions;
  /** Client singleton to dispose on model switch (optional — e.g. segmentation omits this) */
  client?: { dispose: () => void } | null;
  /** Store reset function — called after model switch to clear stale results */
  resetStore: () => void;
  /**
   * Optional callback invoked during model-change.
   * Use for tool-specific side effects:
   *   - bgremover: clear clipBox from last result
   *   - upscaler: sync targetScale based on new model's scale property
   *
   * If extra config fields need to be persisted atomically with the model switch,
   * return a partial config object — it will be merged into the same setConfig call
   * (avoids stale-closure overwrites from a separate setConfig).
   */
  afterModelChange?: (newActiveId: string, models: ModelEntry[]) => Record<string, unknown> | void;
}

/**
 * Minimal actions interface for ModelPanel.
 * Uses method syntax for bivariant compatibility with EditorActions.
 */
export interface ModelPanelActions {
  setInteraction(patch: { hud?: { message: string; type: 'error' | 'info' | 'success' } }): void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ModelPanel({
  mgr, isBusy,
  config, setConfig, builtins, actions, client, resetStore, afterModelChange,
}: ModelPanelProps) {
  // Compute display list and active model from config + builtins
  const models = updateModelList((config.models ?? []) as ModelEntry[], builtins);
  const activeModel = models.find(m => m.id === config.activeModelId) || models[0];

  // ─── handleModelChange (standard flow + optional after-hook) ─────────────
  const handleModelChange = useCallback((newActiveId: string) => {
    const ensuredModels = updateModelList((config.models ?? []) as ModelEntry[], builtins);
    // Let afterModelChange return extra config patches to merge atomically
    const extraPatch = afterModelChange?.(newActiveId, ensuredModels);
    setConfig({ models: ensuredModels, activeModelId: newActiveId, ...extraPatch });
    client?.dispose();
    resetStore();
  }, [config.models, builtins, setConfig, client, resetStore, afterModelChange]);

  // ─── handleRefresh (identical across all tools) ─────────────────────────
  const handleRefresh = useCallback(() => {
    const synced = updateModelList((config.models ?? []) as ModelEntry[], builtins);
    const validActiveId = synced.find(m => m.id === config.activeModelId)
      ? config.activeModelId!
      : synced[0]?.id ?? builtins[0].id;
    setConfig({ models: synced, activeModelId: validActiveId });
    actions.setInteraction({ hud: { message: 'Model list refreshed', type: 'success' } });
  }, [config.models, config.activeModelId, builtins, setConfig, actions]);

  // ─── Import file input ref ────────────────────────────────────────────────
  const importInputRef = useRef<HTMLInputElement>(null);
  const handleImportClick = useCallback(() => {
    importInputRef.current?.click();
  }, []);
  const handleImportFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      mgr.importModel(file);
    }
    // Reset input so the same file can be re-selected
    e.target.value = '';
  }, [mgr]);

  return (
    <>
      {/* ─── Model Selection Card ────────────────────────────────── */}
      <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-stage)] px-2.5 py-2 space-y-1.5">
        <div className="flex flex-col gap-1">
          <span className="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-wider">
            Model
          </span>
          <div className="flex gap-1 items-center">
            <ActionDropdown
              className="flex-1"
              options={models.map(model => ({ value: model.id, label: model.name, checked: model.id === activeModel?.id && mgr.isCached }))}
              onSelect={handleModelChange}
              disabled={isBusy}
              trigger={(isOpen) => (
                <div className="flex items-center justify-between gap-1 w-full px-2 py-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel)] cursor-pointer hover:border-[var(--border-light)] transition-all">
                  <span className="text-[10px] text-[var(--text-main)] truncate">
                    {activeModel?.name}
                  </span>
                  <ChevronDown size={10} className={`text-[var(--text-muted)] shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                </div>
              )}
            />
            <Tooltip content="Refresh model list" position="bottom" align="end">
              <button
                onClick={handleRefresh}
                disabled={isBusy}
                className="p-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel)] hover:bg-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors disabled:opacity-50"
              >
                <RefreshCw size={10} />
              </button>
            </Tooltip>
            {mgr.cacheState === 'cached' && (
              <Tooltip content="Export model to local file" position="bottom" align="end">
                <button
                  onClick={mgr.exportModel}
                  disabled={isBusy}
                  className="p-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel)] hover:bg-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors disabled:opacity-50"
                >
                  <HardDriveDownload size={10} />
                </button>
              </Tooltip>
            )}
          </div>
        </div>

        {/* Model info */}
        <div className="flex flex-col gap-0.5 pt-0.5">
          <span className="text-[10px] font-semibold text-[var(--text-main)]">{activeModel?.size}</span>
          <span className="text-[10px] text-[var(--text-muted)] italic">{activeModel?.description}</span>
        </div>

        {/* Cache status — deterministic: 'checking' renders nothing (no flash) */}
        {mgr.cacheState === 'cached' && (
          <div className="flex items-center gap-1">
            <span className="text-[9px] text-emerald-400 flex items-center gap-0.5">
              <CheckCircle2 size={9} /> Cached locally
            </span>
          </div>
        )}
        {mgr.cacheState === 'not-cached' && (
          <div className="flex items-center gap-1">
            <span className="text-[9px] text-[var(--text-muted)] italic">
              Not downloaded yet
            </span>
          </div>
        )}
        {/* When cacheState === 'checking', nothing is rendered — no flash */}

        {/* Model management buttons */}
        <div className="flex gap-1.5">
          <FancyButton
            variant="ghost"
            size="xs"
            shape="rect"
            className="flex-1"
            onClick={mgr.startDownload}
            disabled={isBusy || mgr.cacheState === 'cached'}
          >
            <Download size={10} />
            <span className="text-[9px]">Download</span>
          </FancyButton>
          <FancyButton
            variant="ghost"
            size="xs"
            shape="rect"
            className="flex-1"
            onClick={handleImportClick}
            disabled={isBusy || mgr.isImporting || mgr.cacheState === 'cached'}
          >
            <HardDriveUpload size={10} />
            <span className="text-[9px]">Use Local</span>
          </FancyButton>
          {mgr.cacheState === 'cached' && (
            <Tooltip content="Delete cached model" position="bottom" align="end">
              <FancyButton
                variant="ghost"
                size="xs"
                shape="rect"
                onClick={mgr.deleteCache}
                disabled={isBusy}
              >
                <Trash2 size={10} />
              </FancyButton>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Hidden file input for import */}
      <input
        ref={importInputRef}
        type="file"
        accept=".zip"
        className="hidden"
        onChange={handleImportFile}
      />

      {/* ─── Download Progress (explicit pre-download) ──────────── */}
      {mgr.isDownloading && (
        <DownloadPanel
          progress={mgr.downloadState.overallTotal > 0 ? mgr.downloadState.overallLoaded / mgr.downloadState.overallTotal : 0}
          loadedBytes={mgr.downloadState.overallLoaded}
          totalBytes={mgr.downloadState.overallTotal}
          speedBps={mgr.downloadState.speedBps}
          currentFile={mgr.downloadState.currentFile}
          onCancel={mgr.cancelDownload}
        />
      )}

      {/* ─── Import Progress ─────────────────────────────────────── */}
      {mgr.isImporting && mgr.importProgress && (
        <DownloadPanel
          label="Importing..."
          progress={mgr.importProgress.total > 0 ? mgr.importProgress.current / mgr.importProgress.total : 0}
          loadedBytes={0}
          totalBytes={0}
          speedBps={0}
          currentFile={mgr.importProgress.currentFile}
        />
      )}
    </>
  );
}
