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

import React, { useCallback, useEffect, useState } from 'react';
import { Download, Trash2, Loader2, ChevronDown, CheckCircle2, RefreshCw, X } from 'lucide-react';
import { useEditorServices, usePluginSelfConfig, usePluginCommands, usePluginSignals } from '@opengpex/editor/core/context';
import { FancyButton } from '@opengpex/editor/widgets/FancyButton';
import { useBgRemovalStatus } from '../hooks';
import { bgRemovalClient } from '../worker/client';
import type { BgRemovalConfig, BgModelEntry } from '../protocols';
import type { BgRemovalCommandsMap, BgRemovalSignalsMap } from '../commands.d';
import * as P from '../protocols';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function formatSpeed(bps: number): string {
  if (bps === 0) return '';
  return `${formatBytes(bps)}/s`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

async function isModelCached(modelId: string): Promise<boolean> {
  try {
    const cacheNames = await caches.keys();
    const transformersCaches = cacheNames.filter(
      name => name.includes('transformers') || name.includes('onnx') || name.includes('huggingface')
    );
    for (const cacheName of transformersCaches) {
      const cache = await caches.open(cacheName);
      const keys = await cache.keys();
      const hasOnnxModel = keys.some(req => {
        const url = req.url;
        const matchesModel = url.includes(modelId) || url.includes(modelId.replace('/', '%2F'));
        const isWeightsFile = url.includes('.onnx');
        return matchesModel && isWeightsFile;
      });
      if (hasOnnxModel) return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function deleteModelCache(modelId: string): Promise<boolean> {
  try {
    let deleted = false;
    const cacheNames = await caches.keys();
    const transformersCaches = cacheNames.filter(
      name => name.includes('transformers') || name.includes('onnx') || name.includes('huggingface')
    );
    for (const cacheName of transformersCaches) {
      const cache = await caches.open(cacheName);
      const keys = await cache.keys();
      for (const req of keys) {
        if (req.url.includes(modelId) || req.url.includes(modelId.replace('/', '%2F'))) {
          await cache.delete(req);
          deleted = true;
        }
      }
    }
    const databases = await indexedDB.databases();
    const hfDbs = databases.filter(db =>
      db.name?.includes('transformers') || db.name?.includes('huggingface')
    );
    for (const db of hfDbs) {
      if (db.name) { /* conservative: skip */ }
    }
    return deleted;
  } catch {
    return false;
  }
}

function ensureBuiltins(models: BgModelEntry[]): BgModelEntry[] {
  const builtinIds = new Set(P.BUILTIN_MODELS.map(m => m.id));
  const userModels = models.filter(m => !m.builtin || builtinIds.has(m.id));
  const result = [...userModels];
  for (const builtin of P.BUILTIN_MODELS) {
    if (!result.find(m => m.id === builtin.id)) {
      result.unshift(builtin);
    }
  }
  return result;
}

// ─── BgRemover Panel ─────────────────────────────────────────────────────────

/**
 * BgRemoverPanel: Self-contained AI Background Removal tool panel.
 * Handles model selection, download, inference, and status display.
 */
export function BgRemoverPanel() {
  const { actions } = useEditorServices();
  const { removeBgCmd, downloadModelCmd, abortCmd } = usePluginCommands<BgRemovalCommandsMap>();
  const { statusSignal } = usePluginSignals<BgRemovalSignalsMap>();
  const status = useBgRemovalStatus();
  const [config, setConfig] = usePluginSelfConfig<BgRemovalConfig>();

  const [modelCacheStatus, setModelCacheStatus] = useState<Record<string, boolean>>({});
  const [checkingCache, setCheckingCache] = useState(false);

  const models = ensureBuiltins(config.models || []);
  const activeModel = models.find(m => m.id === config.activeModelId) || models[0];

  const isLoading = status.stage === 'loading';
  const isDownloading = status.stage === 'downloading';
  const isProcessing = status.stage === 'processing';
  const isDone = status.stage === 'done';
  const isError = status.stage === 'error';
  const isBusy = isLoading || isDownloading || isProcessing;

  const [isSubmitting, setIsSubmitting] = useState(false);
  if (isBusy && isSubmitting) {
    setIsSubmitting(false);
  }
  const effectivelyBusy = isBusy || isSubmitting;

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      if (!activeModel?.modelId) return;
      setCheckingCache(true);
      const cached = await isModelCached(activeModel.modelId);
      if (!cancelled) {
        setModelCacheStatus(prev => ({ ...prev, [activeModel.modelId]: cached }));
        setCheckingCache(false);
      }
    };
    check();
    return () => { cancelled = true; };
  }, [activeModel?.modelId]);

  const prevStageRef = React.useRef<string>(status.stage);
  useEffect(() => {
    const prev = prevStageRef.current;
    prevStageRef.current = status.stage;
    if (status.stage === 'done' && prev !== 'done') {
      const check = async () => {
        if (!activeModel?.modelId) return;
        await Promise.resolve();
        setModelCacheStatus(prevMap => ({ ...prevMap, [activeModel.modelId]: true }));
        const cached = await isModelCached(activeModel.modelId);
        setModelCacheStatus(prevMap => ({ ...prevMap, [activeModel.modelId]: cached }));
      };
      check();
    }
  }, [status.stage, activeModel?.modelId]);

  const isActiveModelCached = modelCacheStatus[activeModel?.modelId] ?? false;

  const handleModelChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const newActiveId = e.target.value;
    const ensuredModels = ensureBuiltins(config.models || []);
    setConfig({ models: ensuredModels, activeModelId: newActiveId });
    bgRemovalClient.dispose();
    if (status.context?.frameId) {
      actions.setClipBox(status.context.frameId as string, 'wand', null);
    }
    statusSignal?.set({ ...P.INITIAL_STATUS });
  }, [setConfig, config.models, status, actions, statusSignal]);

  const handleRemoveBg = useCallback(() => {
    setIsSubmitting(true);
    removeBgCmd?.execute();
  }, [removeBgCmd]);

  const handleDownloadModel = useCallback(() => {
    downloadModelCmd?.execute();
  }, [downloadModelCmd]);

  const activeModelId = activeModel?.modelId;
  const activeModelName = activeModel?.name;

  const handleDeleteModel = useCallback(async () => {
    if (!activeModelId) return;
    try {
      const deleted = await deleteModelCache(activeModelId);
      if (deleted) {
        setModelCacheStatus(prev => ({ ...prev, [activeModelId]: false }));
        actions.setInteraction({ hud: { message: `Model cache cleared: ${activeModelName}`, type: 'success' } });
      } else {
        actions.setInteraction({ hud: { message: 'No cached files found for this model', type: 'info' } });
      }
    } catch {
      actions.setInteraction({ hud: { message: 'Failed to clear model cache', type: 'error' } });
    }
  }, [actions, activeModelId, activeModelName]);

  // Determine if progress section should be visible (only when busy or just completed)
  const showProgress = isBusy || isDone || isError;

  return (
    <div className="flex flex-col gap-1.5">
      {/* ─── Model Selection ────────────────────────────────────── */}
      <div className="rounded-lg border border-white/[0.04] bg-white/[0.02] px-2.5 py-2 space-y-1.5">
        {/* Model dropdown + refresh */}
        <div className="flex flex-col gap-1">
          <span className="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-wider">
            Model
          </span>
          <div className="flex gap-1 items-center">
            <div className="relative flex-1">
              <select
                value={config.activeModelId}
                onChange={handleModelChange}
                disabled={isBusy}
                className="w-full appearance-none bg-[var(--bg-panel)] border border-[var(--border-subtle)] rounded-lg px-2 py-1.5 pr-7 text-[10px] text-[var(--text-main)] focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition-all disabled:opacity-50 cursor-pointer"
              >
                {models.map(model => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={10} className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
            </div>
            <button
              onClick={() => {
                const synced = ensureBuiltins(config.models || []);
                const validActiveId = synced.find(m => m.id === config.activeModelId)
                  ? config.activeModelId
                  : synced[0]?.id ?? P.BUILTIN_MODELS[0].id;
                setConfig({ models: synced, activeModelId: validActiveId });
                actions.setInteraction({ hud: { message: 'Model list refreshed', type: 'success' } });
              }}
              disabled={isBusy}
              className="p-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-panel)] hover:bg-white/5 text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors disabled:opacity-50"
              title="Refresh model list (remove stale entries)"
            >
              <RefreshCw size={10} />
            </button>
          </div>
        </div>

        {/* Model info */}
        <div className="flex flex-col gap-0.5">
          <span className="text-[9px] text-[var(--text-muted)]">{activeModel?.size}</span>
          <span className="text-[9px] text-[var(--text-muted)] italic">{activeModel?.description}</span>
        </div>

        {/* Cache status indicator */}
        {!checkingCache && (
          <div className="flex items-center gap-1">
            {isActiveModelCached ? (
              <span className="text-[8px] text-emerald-400 flex items-center gap-0.5">
                <CheckCircle2 size={8} /> Cached locally
              </span>
            ) : (
              <span className="text-[8px] text-[var(--text-muted)] italic">
                Not downloaded yet
              </span>
            )}
          </div>
        )}

        {/* Model management buttons */}
        <div className="flex gap-1.5">
          <FancyButton
            variant="ghost"
            size="xs"
            shape="rect"
            onClick={handleDownloadModel}
            disabled={isBusy || isActiveModelCached}
            title={isActiveModelCached ? "Model already cached" : "Download model"}
          >
            <Download size={10} />
            <span className="text-[9px]">Download</span>
          </FancyButton>
          <FancyButton
            variant="ghost"
            size="xs"
            shape="rect"
            onClick={handleDeleteModel}
            disabled={isBusy || !isActiveModelCached}
            title={!isActiveModelCached ? "Model not cached" : "Delete cached model"}
          >
            <Trash2 size={10} />
            <span className="text-[9px]">Delete</span>
          </FancyButton>
        </div>
      </div>

      {/* ─── Progress Section — only visible when busy/done/error ─── */}
      {showProgress && (
        <div className="rounded-lg border border-white/[0.04] bg-white/[0.02] px-2.5 py-2 space-y-1.5">
          <div className="flex justify-between items-center">
            <span className="text-[10px] text-[var(--text-muted)] font-medium flex items-center gap-1">
              {isBusy && <Loader2 size={10} className="animate-spin" />}
              {isDone && <CheckCircle2 size={10} className="text-emerald-400" />}
              {isLoading
                ? 'Loading model...'
                : isDownloading
                  ? 'Downloading...'
                  : isProcessing
                    ? 'Processing...'
                    : isDone
                      ? 'Complete'
                      : 'Error'}
            </span>
            <span className="text-[10px] text-[var(--text-secondary)]">
              {isDone
                ? formatMs(status.elapsedMs as number)
                : isDownloading
                  ? `${(status.downloadProgress * 100).toFixed(0)}%`
                  : (isBusy && !isLoading)
                    ? `${(status.processingProgress * 100).toFixed(0)}%`
                    : ''}
            </span>
          </div>

          {/* Progress bar */}
          <div className="h-1 rounded-full bg-white/5 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                isDone ? 'bg-emerald-500/80' : 'bg-amber-500/80'
              }`}
              style={{
                width: `${(isDone
                  ? 100
                  : isDownloading
                    ? status.downloadProgress * 100
                    : isProcessing
                      ? status.processingProgress * 100
                      : 0
                ).toFixed(0)}%`
              }}
            />
          </div>

          {/* Download stats */}
          {isDownloading && status.totalBytes > 0 && (
            <div className="flex justify-between text-[9px] text-[var(--text-muted)]">
              <span>{formatBytes(status.downloadedBytes)} / {formatBytes(status.totalBytes)}</span>
              {status.speedBps > 0 && <span>{formatSpeed(status.speedBps)}</span>}
            </div>
          )}

          {/* Done message */}
          {isDone && (
            <div className="text-[9px] text-emerald-400/80">
              Mask generated in {formatMs(status.elapsedMs as number)}
            </div>
          )}
        </div>
      )}

      {/* ─── Error Display ─────────────────────────────────────── */}
      {isError && status.errorMessage && (
        <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 px-2.5 py-2">
          <p className="text-[10px] text-rose-400 select-text break-words">
            <span className="font-semibold">Error:</span> {status.errorMessage as string}
          </p>
          <button
            onClick={() => statusSignal?.set({ ...P.INITIAL_STATUS })}
            className="mt-1 text-[9px] text-rose-400/70 hover:text-rose-300 underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ─── Action Button ─── */}
      <div className="pt-0.5">
        {effectivelyBusy ? (
          <div className="flex gap-1.5">
            <FancyButton
              variant="amber"
              size="sm"
              shape="rect"
              className="flex-1"
              disabled
              loading
            >
              {isLoading ? 'Loading Model...' : isDownloading ? 'Downloading...' : 'Processing...'}
            </FancyButton>
            <FancyButton
              variant="ghost"
              size="sm"
              shape="rect"
              className="shrink-0"
              onClick={() => abortCmd?.execute()}
              aria-label="Cancel"
            >
              <X size={14} />
            </FancyButton>
          </div>
        ) : (
          <FancyButton
            variant="amber"
            size="sm"
            shape="pill"
            className="w-full"
            onClick={handleRemoveBg}
            disabled={!isActiveModelCached}
          >
            Remove Background
          </FancyButton>
        )}
      </div>
    </div>
  );
}
