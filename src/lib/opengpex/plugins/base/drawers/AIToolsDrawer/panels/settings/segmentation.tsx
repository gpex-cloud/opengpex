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

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePluginSelfConfig } from '@opengpex/editor/core/context';
import { Plus, Trash2, Lock, Download, CheckCircle2, Loader2 } from 'lucide-react';
import { useDownloadTask, isModelCached, deleteModelCache, ModelDownloadSection } from '../../services';
import type { BgRemoverConfig } from '../../protocols';
import type { SegConfig, SegModelEntry } from '../../protocols';
import { BUILTIN_SEG_MODELS, DEFAULT_SEG_CONFIG } from '../../protocols';

/**
 * SegmentationModelSettings — Model list for segmentation.
 *
 * Uses the download singleton so downloads survive panel unmount.
 */
export function SegmentationModelSettings() {
  const [config, setConfig] = usePluginSelfConfig<BgRemoverConfig & { seg?: SegConfig }>();
  const segConfig = config.seg ?? DEFAULT_SEG_CONFIG;
  const [cacheStatus, setCacheStatus] = useState<Record<string, boolean>>({});
  const [busyModels, setBusyModels] = useState<Record<string, boolean>>({});

  // Ensure built-in models are always present
  const models = useMemo(() => ensureBuiltins(segConfig.models), [segConfig.models]);

  // Download singleton — survives unmount, shared with main panel
  const { task, isDownloading, start: startDownload, cancel: cancelDownload } = useDownloadTask();

  // Check cache status for all models on mount
  useEffect(() => {
    let cancelled = false;
    const checkAll = async () => {
      const result: Record<string, boolean> = {};
      for (const model of models) {
        if (model.modelId) {
          result[model.modelId] = await isModelCached(model.modelId);
        }
      }
      if (!cancelled) setCacheStatus(result);
    };
    checkAll();
    return () => { cancelled = true; };
  }, [models]);

  // When download finishes (singleton cleared by useModelManager), recheck cache
  useEffect(() => {
    if (task) return; // still active or has terminal state — wait
    // Task was cleared (by useModelManager) → recheck cache
    let cancelled = false;
    const recheck = async () => {
      const result: Record<string, boolean> = {};
      for (const model of models) {
        if (model.modelId) {
          result[model.modelId] = await isModelCached(model.modelId);
        }
      }
      if (!cancelled) {
        setCacheStatus(result);
        setBusyModels({});
      }
    };
    recheck();
    return () => { cancelled = true; };
  }, [task, models]);

  const handleDownload = useCallback((modelId: string) => {
    setBusyModels(prev => ({ ...prev, [modelId]: true }));
    startDownload(modelId, [
      { filename: 'encoder.with_runtime_opt.ort' },
      { filename: 'encoder.onnx' },
      { filename: 'decoder.onnx' },
    ]);
  }, [startDownload]);

  const handleCancelDownload = useCallback(() => {
    cancelDownload();
    setBusyModels({});
  }, [cancelDownload]);

  const handleDeleteCache = useCallback(async (modelId: string) => {
    setBusyModels(prev => ({ ...prev, [modelId]: true }));
    const deleted = await deleteModelCache(modelId);
    if (deleted) {
      setCacheStatus(prev => ({ ...prev, [modelId]: false }));
    }
    setBusyModels(prev => ({ ...prev, [modelId]: false }));
  }, []);

  const updateModel = (id: string, patch: Partial<SegModelEntry>) => {
    const nextModels = models.map((m) =>
      m.id === id ? { ...m, ...patch } : m,
    );
    setConfig({ ...config, seg: { ...segConfig, models: nextModels } });
  };

  const addModel = () => {
    const newId = `custom-seg-${Date.now()}`;
    const newModel: SegModelEntry = {
      id: newId,
      name: 'Custom SAM Model',
      modelId: '',
      size: 'Unknown',
      description: 'User-added custom segmentation model',
      builtin: false,
      type: 'interactive',
    };
    setConfig({ ...config, seg: { ...segConfig, models: [...models, newModel] } });
  };

  const removeModel = (id: string) => {
    const nextModels = models.filter((m) => m.id !== id);
    let nextActiveId = segConfig.activeModelId;
    if (nextActiveId === id && nextModels.length > 0) {
      nextActiveId = nextModels[0].id;
    }
    setConfig({ ...config, seg: { ...segConfig, models: nextModels, activeModelId: nextActiveId } });
  };

  return (
    <div className="flex flex-col gap-3">
      {/* ─── Toolbar: Add custom model ─────────────────────────── */}
      <div className="flex items-center justify-end">
        <button
          onClick={addModel}
          className="flex items-center gap-1 text-[9px] font-bold text-[var(--text-secondary)] hover:text-[var(--text-main)] transition-colors uppercase tracking-wider"
        >
          <Plus size={10} /> Add Custom
        </button>
      </div>

      {/* ─── Model List ───────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        {models.map((model) => (
          <div
            key={model.id}
            className="flex flex-col gap-2 rounded-lg p-2.5 border bg-[var(--bg-stage)] border-[var(--border-subtle)]"
          >
            {/* Row 1: Name + actions */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 flex-1 min-w-0">
                {model.builtin && (
                  <Lock size={9} className="text-[var(--text-muted)] shrink-0" />
                )}
                {model.builtin ? (
                  <span className="text-[11px] font-semibold text-[var(--text-main)] truncate">
                    {model.name}
                  </span>
                ) : (
                  <input
                    type="text"
                    value={model.name}
                    onChange={(e) => updateModel(model.id, { name: e.target.value })}
                    className="bg-transparent border-none text-[11px] font-semibold text-[var(--text-main)] focus:outline-none flex-1 min-w-0 focus:ring-1 focus:ring-[var(--border-subtle)] rounded px-1 -ml-1"
                  />
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {!model.builtin && (
                  <button
                    onClick={() => removeModel(model.id)}
                    className="text-[var(--text-muted)] hover:text-rose-500 transition-colors p-0.5"
                    title="Remove model"
                  >
                    <Trash2 size={11} />
                  </button>
                )}
              </div>
            </div>

            {/* Row 2: Model ID */}
            <div className="flex flex-col gap-0.5">
              {model.builtin ? (
                <span className="text-[10px] text-[var(--text-secondary)] font-mono truncate">
                  {model.modelId}
                </span>
              ) : (
                <input
                  type="text"
                  value={model.modelId}
                  onChange={(e) => updateModel(model.id, { modelId: e.target.value })}
                  placeholder="owner/model-name"
                  className="w-full bg-[var(--bg-panel)] border border-[var(--border-subtle)] rounded-md px-2 py-1 text-[10px] text-[var(--text-main)] font-mono focus:outline-none focus:border-[var(--text-secondary)] transition-colors placeholder:text-[var(--text-muted)]"
                />
              )}
            </div>

            {/* Row 3: Meta + Cache actions */}
            <div className="flex items-center justify-between">
              <span className="text-[9px] text-[var(--text-muted)]">
                {model.size} · {model.description}
              </span>
              {model.modelId && (
                <div className="flex items-center gap-1.5">
                  {cacheStatus[model.modelId] ? (
                    <>
                      <span className="text-emerald-400 flex items-center gap-0.5 text-[9px]">
                        <CheckCircle2 size={9} /> Cached
                      </span>
                      <button
                        onClick={() => handleDeleteCache(model.modelId)}
                        disabled={busyModels[model.modelId]}
                        className="text-[9px] font-semibold text-rose-400 hover:text-rose-300 disabled:opacity-40 transition-colors"
                        title="Delete cached model files"
                      >
                        {busyModels[model.modelId] ? <Loader2 size={9} className="animate-spin" /> : "Delete"}
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => handleDownload(model.modelId)}
                      disabled={busyModels[model.modelId] || isDownloading}
                      className="flex items-center gap-0.5 text-[9px] font-semibold text-[var(--text-secondary)] hover:text-[var(--text-main)] disabled:opacity-40 transition-colors"
                      title="Download model"
                    >
                      {busyModels[model.modelId] ? <Loader2 size={9} className="animate-spin" /> : <Download size={9} />}
                      <span>Download</span>
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* ─── Download Progress (inline per model) ─────────── */}
            {task?.modelId === model.modelId && isDownloading && (
              <ModelDownloadSection
                progress={task.progress.overallTotal > 0 ? task.progress.overallLoaded / task.progress.overallTotal : 0}
                loadedBytes={task.progress.overallLoaded}
                totalBytes={task.progress.overallTotal}
                speedBps={task.progress.speedBps}
                currentFile={task.progress.currentFile}
                onCancel={handleCancelDownload}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ensureBuiltins(models: SegModelEntry[]): SegModelEntry[] {
  const result = [...models];
  for (const builtin of BUILTIN_SEG_MODELS) {
    if (!result.find((m) => m.id === builtin.id)) {
      result.unshift(builtin);
    }
  }
  return result;
}
