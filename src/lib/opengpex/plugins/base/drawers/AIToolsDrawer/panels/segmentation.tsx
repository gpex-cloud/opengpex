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

import React, { useCallback, useMemo } from 'react';
import { Download, Trash2, Loader2, ChevronDown, CheckCircle2, RefreshCw, Zap } from 'lucide-react';
import { useEditorServices, useEditorState, usePluginCommands, usePluginSelfConfig, usePluginSignals } from '@opengpex/editor/core/context';
import ActionDropdown from '@opengpex/editor/widgets/ActionDropdown';
import { FancyButton } from '@opengpex/editor/widgets/FancyButton';
import { useSegStatus } from '../hooks';
import { useModelManager, ModelDownloadSection } from '../services';
import type { SegModelEntry } from '../protocols';
import type { AIToolsDrawerCommandsMap, AIToolsDrawerSignalsMap } from '../commands.d';
import * as P from '../protocols';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function ensureBuiltins(models: SegModelEntry[]): SegModelEntry[] {
  const builtinIds = new Set(P.BUILTIN_SEG_MODELS.map(m => m.id));
  const userModels = models.filter(m => !m.builtin || builtinIds.has(m.id));
  const result = [...userModels];
  for (const builtin of P.BUILTIN_SEG_MODELS) {
    if (!result.find(m => m.id === builtin.id)) {
      result.unshift(builtin);
    }
  }
  return result;
}

// ─── SegmentationPanel ───────────────────────────────────────────────────────

export function SegmentationPanel() {
  const { actions } = useEditorServices();
  const { state, activeFrame } = useEditorState();
  const { segAllCmd } = usePluginCommands<AIToolsDrawerCommandsMap>();
  const { segStatusSignal } = usePluginSignals<AIToolsDrawerSignalsMap & { segStatusSignal: { value: unknown; set: (v: unknown) => void } }>();
  const status = useSegStatus();
  const [config, setConfig] = usePluginSelfConfig<P.BgRemoverConfig & { seg?: P.SegConfig }>();

  const segConfig = config.seg ?? P.DEFAULT_SEG_CONFIG;
  const models = ensureBuiltins(segConfig.models || []);
  const activeModel = models.find(m => m.id === segConfig.activeModelId) || models[0];

  const isEncoding = status.stage === 'encoding';
  const isDecoding = status.stage === 'decoding';
  const isError = status.stage === 'error';

  // ─── Model Manager (download + cache + lifecycle) ────────────────────────
  const files = useMemo(() => [
    { filename: 'encoder.with_runtime_opt.ort' },
    { filename: 'encoder.onnx' },
    { filename: 'decoder.onnx' },
  ], []);

  const mgr = useModelManager({
    modelId: activeModel?.modelId,
    modelName: activeModel?.name,
    files,
    actions,
    onDone: () => { segStatusSignal?.set({ ...P.INITIAL_SEG_STATUS }); },
    onCancelled: () => { segStatusSignal?.set({ ...P.INITIAL_SEG_STATUS }); },
    onError: (msg) => { segStatusSignal?.set({ ...P.INITIAL_SEG_STATUS, stage: 'error', errorMessage: msg }); },
  });

  const isBusy = mgr.isDownloading || isEncoding || isDecoding;

  // ─── Handlers ──────────────────────────────────────────────────────────────

  const handleModelChange = useCallback((newActiveId: string) => {
    const ensuredModels = ensureBuiltins(segConfig.models || []);
    setConfig({ ...config, seg: { ...segConfig, models: ensuredModels, activeModelId: newActiveId } });
    segStatusSignal?.set({ ...P.INITIAL_SEG_STATUS });
  }, [setConfig, config, segConfig, segStatusSignal]);

  const handleSegmentAll = useCallback(async () => {
    segAllCmd?.execute();
  }, [segAllCmd]);

  const handleClearResults = useCallback(() => {
    segStatusSignal?.set({ ...P.INITIAL_SEG_STATUS });
  }, [segStatusSignal]);

  const handleSelectCandidate = useCallback((idx: number) => {
    if (!status.candidates[idx]) return;
    const current = (segStatusSignal?.value as P.SegStatus | undefined) ?? P.INITIAL_SEG_STATUS;
    segStatusSignal?.set({ ...current, activeCandidateIdx: idx });

    // Ensure clip+SAM mode is active before applying the polygon.
    // If user is on a different tool (e.g., wand/lasso), switch to SAM automatically.
    const isClipSam =
      state.interaction.interactionMode === 'clip' &&
      activeFrame?.latestClipTool === 'sam';

    if (!isClipSam && state.activeFrameId) {
      actions.setInteraction({ interactionMode: 'clip' });
      actions.updateFrame(state.activeFrameId, { latestClipTool: 'sam' });
    }

    // Apply the pre-projected frame polygon to the clip box
    const framePolygons = (current as unknown as { candidateFramePolygons?: unknown[] }).candidateFramePolygons;
    const frameId = (current as unknown as { samFrameId?: string }).samFrameId;
    if (framePolygons && framePolygons[idx] && frameId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      actions.setClipBox(frameId, 'sam', framePolygons[idx] as any);
    }
  }, [status.candidates, segStatusSignal, actions, state.interaction.interactionMode, state.activeFrameId, activeFrame]);

  return (
    <div className="flex flex-col gap-1.5">
      {/* ─── Model Selection ────────────────────────────────────── */}
      <div className="rounded-lg border border-white/[0.04] bg-white/[0.02] px-2.5 py-2 space-y-1.5">
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
                <div className="flex items-center justify-between gap-1 w-full px-2 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-panel)] cursor-pointer hover:border-[var(--text-secondary)] transition-all">
                  <span className="text-[10px] text-[var(--text-main)] truncate">
                    {activeModel?.name}
                  </span>
                  <ChevronDown size={10} className={`text-[var(--text-muted)] shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                </div>
              )}
            />
            <button
              onClick={() => {
                const synced = ensureBuiltins(segConfig.models || []);
                const validActiveId = synced.find(m => m.id === segConfig.activeModelId)
                  ? segConfig.activeModelId
                  : synced[0]?.id ?? P.BUILTIN_SEG_MODELS[0].id;
                setConfig({ ...config, seg: { ...segConfig, models: synced, activeModelId: validActiveId } });
                actions.setInteraction({ hud: { message: 'Model list refreshed', type: 'success' } });
              }}
              disabled={isBusy}
              className="p-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-panel)] hover:bg-white/5 text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors disabled:opacity-50"
              title="Refresh model list"
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

        {/* Cache status */}
        {!mgr.checkingCache && (
          <div className="flex items-center gap-1">
            {mgr.isCached ? (
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
            tooltipPosition="bottom"
          >
            <Trash2 size={10} />
            <span className="text-[9px]">Delete</span>
          </FancyButton>
        </div>
      </div>

      {/* ─── Download Progress ──────────────────────────────────── */}
      {mgr.isDownloading && (
        <ModelDownloadSection
          progress={mgr.downloadState.overallTotal > 0 ? mgr.downloadState.overallLoaded / mgr.downloadState.overallTotal : 0}
          loadedBytes={mgr.downloadState.overallLoaded}
          totalBytes={mgr.downloadState.overallTotal}
          speedBps={mgr.downloadState.speedBps}
          currentFile={mgr.downloadState.currentFile}
          onCancel={mgr.cancelDownload}
        />
      )}

      {/* ─── Encoding/Decoding Progress ────────────────────────── */}
      {(isEncoding || isDecoding) && (
        <div className="rounded-lg border border-white/[0.04] bg-white/[0.02] px-2.5 py-2 space-y-1.5">
          <div className="flex justify-between items-center">
            <span className="text-[10px] text-[var(--text-muted)] font-medium flex items-center gap-1">
              <Loader2 size={10} className="animate-spin" />
              {isEncoding ? 'Analyzing image...' : 'Generating mask...'}
            </span>
            <span className="text-[10px] text-[var(--text-secondary)]">
              {isEncoding ? `${(status.encodeProgress * 100).toFixed(0)}%` : ''}
            </span>
          </div>
          <div className="h-1 rounded-full bg-white/5 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-300 bg-purple-500/80"
              style={{ width: `${(isEncoding ? status.encodeProgress * 100 : 50).toFixed(0)}%` }}
            />
          </div>
        </div>
      )}

      {/* ─── Error Display ─────────────────────────────────────── */}
      {isError && status.errorMessage && (
        <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 px-2.5 py-2">
          <p className="text-[10px] text-rose-400 select-text break-words">
            <span className="font-semibold">Error:</span> {status.errorMessage as string}
          </p>
          <button
            onClick={() => segStatusSignal?.set({ ...P.INITIAL_SEG_STATUS })}
            className="mt-1 text-[9px] text-rose-400/70 hover:text-rose-300 underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ─── Results List ──────────────────────────────────────── */}
      {status.candidates.length > 0 && (
        <div className="rounded-lg border border-white/[0.04] bg-white/[0.02] px-2.5 py-2 space-y-1.5">
          <div className="flex justify-between items-center">
            <span className="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-wider">
              Results
            </span>
            {status.lastDecodeMs > 0 && (
              <span className="text-[9px] text-[var(--text-muted)]">
                {formatMs(status.lastDecodeMs)}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-1 max-h-[280px] overflow-y-auto pr-1">
            {status.candidates.map((candidate, idx) => {
              const vertexCount = candidate.rings.reduce((sum, ring) => sum + ring.length, 0);
              const isActive = idx === status.activeCandidateIdx;
              return (
                <button
                  key={idx}
                  onClick={() => handleSelectCandidate(idx)}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-all ${
                    isActive
                      ? 'bg-purple-600/15 ring-1 ring-purple-500/30'
                      : 'bg-white/[0.02] hover:bg-white/5'
                  }`}
                >
                  <span className={`w-2 h-2 rounded-full shrink-0 ${
                    isActive ? 'bg-purple-400' : 'bg-white/20'
                  }`} />
                  <span className="text-[10px] font-medium text-[var(--text-main)]">
                    Mask {idx + 1}
                  </span>
                  <span className="text-[9px] text-[var(--text-muted)] ml-auto">
                    {candidate.score.toFixed(2)} • {vertexCount}v
                  </span>
                </button>
              );
            })}
          </div>
          <FancyButton
            variant="ghost"
            size="xs"
            shape="rect"
            onClick={handleClearResults}
          >
            <Trash2 size={9} />
            <span className="text-[9px]">Clear</span>
          </FancyButton>
        </div>
      )}

      {/* ─── Action Button ─── */}
      <div className="pt-0.5">
        <FancyButton
          variant="amber"
          size="sm"
          shape="pill"
          className="w-full"
          onClick={handleSegmentAll}
          disabled={!mgr.isCached || isBusy}
        >
          <Zap size={12} />
          Auto Segment
        </FancyButton>
      </div>

      {/* ─── Usage Hint ─── */}
      {status.candidates.length === 0 && !isBusy && !isError && (
        <p className="px-1 text-[8px] text-[var(--text-muted)] font-bold leading-relaxed uppercase tracking-tight italic opacity-60">
          Select the SAM tool in the toolbar, then click or drag on the canvas to segment objects.
          Or use &quot;Segment All&quot; to detect all objects automatically.
        </p>
      )}
    </div>
  );
}
