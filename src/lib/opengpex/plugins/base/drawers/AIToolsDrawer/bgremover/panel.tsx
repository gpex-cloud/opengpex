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

import React, { useCallback, useEffect } from 'react';
import { Download, Trash2, Loader2, ChevronDown, CheckCircle2, RefreshCw } from 'lucide-react';
import { useEditorServices, useEditorState, usePluginSelfConfig, usePluginCommands, usePluginSignals } from '@opengpex/editor/core/context';
import ActionDropdown from '@opengpex/editor/widgets/ActionDropdown';
import { FancyButton } from '@opengpex/editor/widgets/FancyButton';
import { useBgRemoverStatus } from './hooks';
import { useModelManager, ModelDownloader } from '../shared';
import { bgRemoverClient } from './client';
import type { BgRemoverConfig, BgModelEntry } from '../protocols';
import type { AIToolsDrawerCommandsMap, AIToolsDrawerSignalsMap } from '../commands.d';
import * as P from '../protocols';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function ensureBuiltins(models: BgModelEntry[]): BgModelEntry[] {
  const builtinMap = new Map(P.BUILTIN_MODELS.map(b => [b.id, b]));
  const result = models
    .filter(m => !m.builtin || builtinMap.has(m.id))
    .map(m => {
      const latest = builtinMap.get(m.id);
      return latest ? { ...latest } : m;
    });
  for (const builtin of P.BUILTIN_MODELS) {
    if (!result.find(m => m.id === builtin.id)) {
      result.unshift(builtin);
    }
  }
  return result;
}

// ─── BgRemover Panel ─────────────────────────────────────────────────────────

export function BgRemoverPanel() {
  const { actions } = useEditorServices();
  const { state } = useEditorState();
  const { removeBgCmd } = usePluginCommands<AIToolsDrawerCommandsMap>();
  const { statusSignal } = usePluginSignals<AIToolsDrawerSignalsMap>();
  const status = useBgRemoverStatus();
  const [config, setConfig] = usePluginSelfConfig<BgRemoverConfig>();

  const models = ensureBuiltins(config.models || []);
  const activeModel = models.find(m => m.id === config.activeModelId) || models[0];

  const isLoading = status.stage === 'loading' || status.stage === 'downloading';
  const isProcessing = status.stage === 'processing';
  const isDone = status.stage === 'done';
  const isError = status.stage === 'error';

  // ─── Model Manager (download + cache + lifecycle) ────────────────────────
  const files = P.getBgRemoverModelFiles(activeModel);

  const mgr = useModelManager({
    modelId: activeModel?.modelId,
    modelName: activeModel?.name,
    files,
    actions,
    onDone: () => { statusSignal?.set({ ...P.INITIAL_STATUS }); },
    onCancelled: () => { statusSignal?.set({ ...P.INITIAL_STATUS }); },
    onError: (msg) => { statusSignal?.set({ ...P.INITIAL_STATUS, stage: 'error', errorMessage: msg }); },
  });

  const isBusy = isLoading || mgr.isDownloading || isProcessing;

  // Refresh cache after processing completes (model gets cached during inference too)
  const prevStageRef = React.useRef<string>(status.stage);
  useEffect(() => {
    const prev = prevStageRef.current;
    prevStageRef.current = status.stage;
    if (status.stage === 'done' && prev !== 'done') {
      // Model was just used — it's definitely cached now
    }
  }, [status.stage]);

  // ─── Handlers ──────────────────────────────────────────────────────────────

  const handleModelChange = useCallback((newActiveId: string) => {
    const ensuredModels = ensureBuiltins(config.models || []);
    setConfig({ models: ensuredModels, activeModelId: newActiveId });
    bgRemoverClient.dispose();
    if (status.context?.frameId) {
      actions.setClipBox(status.context.frameId as string, 'wand', null);
    }
    statusSignal?.set({ ...P.INITIAL_STATUS });
  }, [setConfig, config.models, status, actions, statusSignal]);

  const handleRemoveBg = useCallback(() => {
    removeBgCmd?.execute();
  }, [removeBgCmd]);

  const handleReapplyResult = useCallback(() => {
    const frameId = status.resultFrameId as string | null;
    const polygon = status.resultPolygon;
    if (!frameId || !polygon) return;

    // Ensure clip mode is active
    if (state.interaction.interactionMode !== 'clip') {
      actions.setInteraction({ interactionMode: 'clip' });
    }
    actions.updateFrame(frameId, { latestClipTool: 'wand' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    actions.setClipBox(frameId, 'wand', polygon as any);
  }, [status.resultFrameId, status.resultPolygon, state.interaction.interactionMode, actions]);

  const handleClearResult = useCallback(() => {
    statusSignal?.set({ ...P.INITIAL_STATUS });
  }, [statusSignal]);

  return (
    <div className="flex flex-col gap-1.5">
      {/* ─── Model Selection ────────────────────────────────────── */}
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
              className="p-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel)] hover:bg-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors disabled:opacity-50"
              title="Refresh model list (remove stale entries)"
            >
              <RefreshCw size={10} />
            </button>
          </div>
        </div>

        {/* Model info */}
        <div className="flex flex-col gap-0.5 pt-0.5">
          <span className="text-[10px] font-semibold text-[var(--text-main)]">{activeModel?.size}</span>
          <span className="text-[10px] text-[var(--text-muted)] italic">{activeModel?.description}</span>
        </div>

        {/* Cache status */}
        {!mgr.checkingCache && (
          <div className="flex items-center gap-1">
            {mgr.isCached ? (
              <span className="text-[9px] text-emerald-400 flex items-center gap-0.5">
                <CheckCircle2 size={9} /> Cached locally
              </span>
            ) : (
              <span className="text-[9px] text-[var(--text-muted)] italic">
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
            className="flex-1"
            onClick={mgr.startDownload}
            disabled={isBusy || mgr.isCached}
          >
            <Download size={10} />
            <span className="text-[9px]">Download</span>
          </FancyButton>
          <FancyButton
            variant="ghost"
            size="xs"
            shape="rect"
            className="flex-1"
            onClick={mgr.deleteCache}
            disabled={isBusy || !mgr.isCached}
          >
            <Trash2 size={10} />
            <span className="text-[9px]">Delete</span>
          </FancyButton>
        </div>
      </div>

      {/* ─── Download Progress ─────────────────────────────────── */}
      {mgr.isDownloading && (
        <ModelDownloader
          progress={mgr.downloadState.overallTotal > 0 ? mgr.downloadState.overallLoaded / mgr.downloadState.overallTotal : 0}
          loadedBytes={mgr.downloadState.overallLoaded}
          totalBytes={mgr.downloadState.overallTotal}
          speedBps={mgr.downloadState.speedBps}
          currentFile={mgr.downloadState.currentFile}
          onCancel={mgr.cancelDownload}
        />
      )}

      {/* ─── Processing Progress ──────────────────────────────── */}
      {(isLoading || isProcessing) && (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-stage)] px-2.5 py-2 space-y-1.5">
          <div className="flex justify-between items-center">
            <span className="text-[10px] text-[var(--text-muted)] font-medium flex items-center gap-1">
              <Loader2 size={10} className="animate-spin" />
              {isLoading ? 'Loading model...' : 'Processing...'}
            </span>
            <span className="text-[10px] text-[var(--text-muted)]">
              {isProcessing ? `${(status.processingProgress * 100).toFixed(0)}%` : ''}
            </span>
          </div>
          <div className="h-1 rounded-full bg-[var(--bg-panel)] overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-300 bg-purple-500/80"
              style={{ width: `${(isProcessing ? status.processingProgress * 100 : 0).toFixed(0)}%` }}
            />
          </div>
        </div>
      )}

      {/* ─── Results ──────────────────────────────────────────── */}
      {isDone && status.resultInfo && (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-stage)] px-2.5 py-2 space-y-1.5">
          <div className="flex justify-between items-center">
            <span className="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-wider">
              Result
            </span>
            <span className="text-[9px] text-[var(--text-muted)]">
              {formatMs(status.resultInfo.totalMs)}
            </span>
          </div>
          <button
            onClick={handleReapplyResult}
            className="flex items-center gap-2 px-2 py-1.5 rounded-xl bg-emerald-600/10 ring-1 ring-emerald-500/20 w-full text-left transition-all hover:bg-emerald-600/20 cursor-pointer"
          >
            <CheckCircle2 size={10} className="text-emerald-400 shrink-0" />
            <span className="text-[10px] font-medium text-[var(--text-main)]">
              Foreground Mask
            </span>
            <span className="text-[9px] text-[var(--text-muted)] ml-auto">
              {status.resultInfo.vertexCount}v
            </span>
          </button>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 text-[10px] text-[var(--text-muted)]">
              <span className="capitalize">{status.resultInfo.deviceUsed}</span>
              <span>Inference: {formatMs(status.resultInfo.inferenceMs)}</span>
              <span>Post: {formatMs(status.resultInfo.postProcessMs)}</span>
            </div>
            <button
              onClick={handleClearResult}
              className="text-[9px] text-[var(--text-muted)] hover:text-[var(--text-main)] flex items-center gap-0.5"
            >
              <Trash2 size={8} />
              Clear
            </button>
          </div>
        </div>
      )}

      {/* ─── Error Display ─────────────────────────────────────── */}
      {isError && status.errorMessage && (
        <div className="rounded-xl border border-rose-500/20 bg-rose-500/5 px-2.5 py-2">
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
        <FancyButton
          variant="amber"
          size="sm"
          shape="pill"
          className="w-full"
          onClick={handleRemoveBg}
          disabled={!mgr.isCached || isBusy}
        >
          Remove Background
        </FancyButton>
      </div>
    </div>
  );
}
