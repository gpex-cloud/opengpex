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
import { Sparkles, Download, Trash2, Loader2, ChevronDown, CheckCircle2, Settings, RefreshCw, X } from 'lucide-react';
import { useEditorServices, usePluginSelfConfig } from '@opengpex/editor/core/context';
import { FancyButton } from '@opengpex/editor/widgets/FancyButton';
import { useBgRemovalStatus } from './hooks';
import { bgRemovalClient } from './worker/client';
import type { BgRemovalConfig, BgModelEntry } from './protocols';
import * as P from './protocols';

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

/**
 * Check if a given HuggingFace model is FULLY cached in the browser's Cache Storage.
 *
 * Important: We specifically look for `.onnx` model weight files, not just any
 * file containing the model ID. During a cancelled download, small metadata files
 * (config.json, tokenizer.json) may be cached while the main ONNX weights are not.
 * Only consider the model "cached" if the actual weights file is present.
 */
async function isModelCached(modelId: string): Promise<boolean> {
  try {
    const cacheNames = await caches.keys();
    const transformersCaches = cacheNames.filter(
      name => name.includes('transformers') || name.includes('onnx') || name.includes('huggingface')
    );
    for (const cacheName of transformersCaches) {
      const cache = await caches.open(cacheName);
      const keys = await cache.keys();
      // Check for the actual ONNX model weights file (not just metadata like config.json)
      const hasOnnxModel = keys.some(req => {
        const url = req.url;
        const matchesModel = url.includes(modelId) || url.includes(modelId.replace('/', '%2F'));
        // Must be an ONNX weights file (the large model file that actually matters)
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

/**
 * Delete cached model files for a given model ID.
 */
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

    // Also try IndexedDB (some versions of transformers.js use it)
    const databases = await indexedDB.databases();
    const hfDbs = databases.filter(db =>
      db.name?.includes('transformers') || db.name?.includes('huggingface')
    );
    for (const db of hfDbs) {
      if (db.name) {
        // Only delete if this DB appears to be for the specific model
        // (conservative: we can't easily check inside without opening)
        // For now, if we found cache entries above, that's sufficient
      }
    }

    return deleted;
  } catch {
    return false;
  }
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function BgRemovalDrawerContent() {
  const { actions } = useEditorServices();
  const status = useBgRemovalStatus();
  const [config, setConfig] = usePluginSelfConfig<BgRemovalConfig>();

  // Model cache state
  const [modelCacheStatus, setModelCacheStatus] = useState<Record<string, boolean>>({});
  const [checkingCache, setCheckingCache] = useState(false);

  // Ensure built-in models are always present
  const models = ensureBuiltins(config.models || []);
  const activeModel = models.find(m => m.id === config.activeModelId) || models[0];

  const isLoading = status.stage === 'loading';
  const isDownloading = status.stage === 'downloading';
  const isProcessing = status.stage === 'processing';
  const isDone = status.stage === 'done';
  const isError = status.stage === 'error';
  const isBusy = isLoading || isDownloading || isProcessing;

  // isSubmitting: local flag to disable the button immediately on click,
  // bridging the gap before the async signal stage:'loading' propagates.
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Render-time state adjustment: clear the optimistic submitting flag once the
  // async status signal catches up (isBusy becomes true). This is React's documented
  // pattern for adjusting state based on changed values during render — it triggers
  // an immediate re-render of only this component without cascading effects.
  // See: https://react.dev/reference/react/useState#storing-information-from-previous-renders
  if (isBusy && isSubmitting) {
    setIsSubmitting(false);
  }

  // The button uses effectivelyBusy so it's disabled the instant the user clicks,
  // even before the async command sets the status signal to 'loading'.
  const effectivelyBusy = isBusy || isSubmitting;

  // Check cache status for active model on mount and when model changes
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

  // Re-check cache after inference completes (done stage means model was loaded successfully)
  // Only triggers on 'done' — NOT on every stage change to avoid interference with commands.
  const prevStageRef = React.useRef<string>(status.stage);
  useEffect(() => {
    const prev = prevStageRef.current;
    prevStageRef.current = status.stage;
    // Only re-check cache when transitioning INTO done (inference just completed)
    if (status.stage === 'done' && prev !== 'done') {
      const check = async () => {
        if (!activeModel?.modelId) return;
        const cached = await isModelCached(activeModel.modelId);
        setModelCacheStatus(prev => ({ ...prev, [activeModel.modelId]: cached }));
      };
      check();
    }
  }, [status.stage, activeModel?.modelId]);

  const isActiveModelCached = modelCacheStatus[activeModel?.modelId] ?? false;

  const handleModelChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const newActiveId = e.target.value;

    // Persist both the ensured models list AND the new activeModelId.
    const ensuredModels = ensureBuiltins(config.models || []);
    setConfig({ models: ensuredModels, activeModelId: newActiveId });

    // Dispose the Worker immediately — guarantees the new model starts with
    // a completely fresh ONNX Runtime environment (no cross-model contamination).
    bgRemovalClient.dispose();

    // Unconditionally reset status to idle when switching models.
    // Previously this was guarded by `stage !== 'idle'`, but that missed the
    // done → switch model → click path, leaving stale 'done' state visible.
    // Resetting unconditionally is safe (idempotent on already-idle status).
    if (status.context?.frameId) {
      actions.setClipBox(status.context.frameId as string, 'wand', null);
    }
    actions.setStateSignal(P.BG_REMOVAL_SIGNAL_STATUS, { ...P.INITIAL_STATUS });
  }, [setConfig, config.models, status, actions]);

  const handleRemoveBg = useCallback(() => {
    // Immediately mark as submitting so the button disables in the same render tick.
    // The command's own setStatus(stage:'loading') will arrive shortly after,
    // at which point isBusy becomes true and isSubmitting is cleared (see useEffect above).
    setIsSubmitting(true);
    actions.executeCommand(`${P.PLUGIN_AUTHOR}.${P.PLUGIN_ID}.${P.CMD_REMOVE_BG}`);
  }, [actions]);

  const handleOpenSettings = useCallback(() => {
    actions.executeCommand(`${P.PLUGIN_AUTHOR}.${P.PLUGIN_ID}.${P.CMD_OPEN_SETTINGS}`);
  }, [actions]);

  const handleDownloadModel = useCallback(() => {
    // Trigger the remove bg command which will download the model if needed
    // (the inference pipeline handles downloading automatically)
    actions.executeCommand(`${P.PLUGIN_AUTHOR}.${P.PLUGIN_ID}.${P.CMD_REMOVE_BG}`);
  }, [actions]);

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

  return (
    <div className="flex flex-col gap-2 px-2 pt-1 pb-1">
      {/* ─── Header ──────────────────────────────────────────────── */}
      <div className="flex justify-between items-center mb-1 shrink-0">
        <div className="flex items-center gap-2">
          <Sparkles size={12} className="text-amber-400 opacity-80" />
          <span className="text-[10px] font-black uppercase tracking-[0.15em] text-[var(--text-muted)]">
            AI Background Removal
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleOpenSettings}
            className="p-1 rounded hover:bg-white/5 text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors"
            title="Model Settings"
          >
            <Settings size={12} />
          </button>
        </div>
      </div>

      {/* ─── Model Selection Panel ────────────────────────────────── */}
      <div className="space-y-2">
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
                  // Force re-sync: persist the cleaned model list (removes stale built-ins)
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
          <div className="flex gap-1.5 pt-1">
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

        {/* ─── Progress Section — always in the DOM, never conditionally mounted.
             Eliminates layout-shift flash caused by the section appearing/disappearing
             during idle→loading transitions. Status is shown inline via text/bar updates. ─── */}
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
                      : 'Ready'}
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

          {/* Progress bar — always rendered; width=0% in idle/loading, fills during download/processing */}
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

          {/* Download stats — shown only during active download (minor conditional, no height reset) */}
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

        {/* ─── Error Display ─────────────────────────────────────── */}
        {isError && status.errorMessage && (
          <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 px-2.5 py-2">
            <p className="text-[10px] text-rose-400 select-text break-words">
              <span className="font-semibold">Error:</span> {status.errorMessage as string}
            </p>
            <button
              onClick={() => actions.setStateSignal(P.BG_REMOVAL_SIGNAL_STATUS, { ...P.INITIAL_STATUS })}
              className="mt-1 text-[9px] text-rose-400/70 hover:text-rose-300 underline"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>

      {/* ─── Action Buttons ─── */}
      <div className="pt-1">
        {effectivelyBusy ? (
          /* During busy state: downloading button fills space, cancel is a compact square */
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
              onClick={() => actions.executeCommand(`${P.PLUGIN_AUTHOR}.${P.PLUGIN_ID}.${P.CMD_ABORT}`)}
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
          >
            Remove Background
          </FancyButton>
        )}
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Synchronize models list with current BUILTIN_MODELS:
 *   - Add any missing built-ins
 *   - Remove stale built-ins (marked builtin:true but no longer in BUILTIN_MODELS)
 *   - Preserve user-added custom models (builtin:false)
 */
function ensureBuiltins(models: BgModelEntry[]): BgModelEntry[] {
  const builtinIds = new Set(P.BUILTIN_MODELS.map(m => m.id));

  // Keep user-added models + current built-ins only (remove stale built-ins)
  const userModels = models.filter(m => !m.builtin || builtinIds.has(m.id));

  // Add any missing built-ins at the front
  const result = [...userModels];
  for (const builtin of P.BUILTIN_MODELS) {
    if (!result.find(m => m.id === builtin.id)) {
      result.unshift(builtin);
    }
  }
  return result;
}
