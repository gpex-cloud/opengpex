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
 * UpscalerPanel — AI image upscaling panel within AIToolsDrawer.
 *
 * Follows the same pattern as BgRemoverPanel:
 *   - Model selection via ActionDropdown
 *   - Download / Delete model with FancyButton
 *   - ModelDownloader for progress
 *   - Action button gated by model cache status
 */

import React, { useCallback, useMemo } from 'react';
import { Download, Trash2, Loader2, ChevronDown, CheckCircle2, RefreshCw, Info, AlertTriangle, X } from 'lucide-react';
import Switch from '@opengpex/editor/widgets/Switch';
import Tooltip from '@opengpex/editor/widgets/Tooltip';
import { useEditorState, useEditorServices, usePluginSelfConfig, usePluginCommands, usePluginSignals } from '@opengpex/editor/core/context';
import ActionDropdown from '@opengpex/editor/widgets/ActionDropdown';
import { FancyButton } from '@opengpex/editor/widgets/FancyButton';
import { useModelManager, ModelDownloader } from '../shared';
import { sourceBitmapCache } from '@opengpex/editor/core/engine/cache/SourceBitmapCache';
import { upscaleClient } from './client';
import type { AIToolsConfig, UpscaleConfig, UpscaleModelEntry } from '../protocols';
import type { AIToolsDrawerCommandsMap, AIToolsDrawerSignalsMap } from '../commands.d';
import * as P from '../protocols';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ensureBuiltins(models: UpscaleModelEntry[]): UpscaleModelEntry[] {
  const builtinMap = new Map(P.BUILTIN_UPSCALE_MODELS.map(b => [b.id, b]));
  const result = models
    .filter(m => !m.builtin || builtinMap.has(m.id))
    .map(m => {
      const latest = builtinMap.get(m.id);
      return latest ? { ...latest } : m;
    });
  for (const builtin of P.BUILTIN_UPSCALE_MODELS) {
    if (!result.find(m => m.id === builtin.id)) {
      result.unshift(builtin);
    }
  }
  return result;
}

// ─── UpscalerPanel ───────────────────────────────────────────────────────────

export function UpscalerPanel() {
  const { activeLayer } = useEditorState();
  const { actions } = useEditorServices();
  const { upscaleCmd, upscaleAbortCmd } = usePluginCommands<AIToolsDrawerCommandsMap>();
  const { upscaleStatusSignal } = usePluginSignals<AIToolsDrawerSignalsMap>();
  const [config, setConfig] = usePluginSelfConfig<AIToolsConfig>();

  const upConfig: UpscaleConfig = config?.upscale ?? P.DEFAULT_UPSCALE_CONFIG;
  const models = ensureBuiltins(upConfig.models ?? []);
  const activeModel = models.find(m => m.id === upConfig.activeModelId) ?? models[0];
  const targetScale = upConfig.targetScale ?? 4;
  const outputMode = upConfig.outputMode ?? 'new-frame';
  const dpiMode = upConfig.dpiMode ?? 'increase-resolution';

  // Read status signal
  const status = (upscaleStatusSignal?.value ?? P.INITIAL_UPSCALE_STATUS) as P.UpscaleStatus;
  const isProcessing = status.stage === 'processing';
  const isDone = status.stage === 'done';
  const isError = status.stage === 'error';

  // ─── Model Manager (download + cache + lifecycle) ────────────────────────
  const files = P.getUpscaleModelFiles(activeModel);

  const mgr = useModelManager({
    modelId: activeModel?.modelId,
    modelName: activeModel?.name,
    files,
    actions,
    onDone: () => { upscaleStatusSignal?.set({ ...P.INITIAL_UPSCALE_STATUS }); },
    onCancelled: () => { upscaleStatusSignal?.set({ ...P.INITIAL_UPSCALE_STATUS }); },
    onError: (msg) => { upscaleStatusSignal?.set({ ...P.INITIAL_UPSCALE_STATUS, stage: 'error', errorMessage: msg }); },
  });

  const isBusy = mgr.isDownloading || isProcessing;

  // ─── Dimension preview ───────────────────────────────────────────────────
  const dimensions = useMemo(() => {
    if (!activeLayer || activeLayer.type !== 'image') return null;
    // Prefer bitmap dimensions (exact), fall back to layer.bounding (always available)
    const bitmap = activeLayer.src ? sourceBitmapCache.get(activeLayer.src) : null;
    const w = bitmap?.width ?? activeLayer.bounding?.w ?? 0;
    const h = bitmap?.height ?? activeLayer.bounding?.h ?? 0;
    if (w === 0 || h === 0) return null;
    return { w, h, outW: w * targetScale, outH: h * targetScale };
  }, [activeLayer, targetScale]);

  // ─── Handlers ──────────────────────────────────────────────────────────────

  const handleModelChange = useCallback((newActiveId: string) => {
    const ensuredModels = ensureBuiltins(upConfig.models ?? []);
    // Auto-sync targetScale to match the selected model's native scale
    const newModel = ensuredModels.find(m => m.id === newActiveId);
    const newScale = (newModel?.scale === 2 ? 2 : 4) as 2 | 4;
    setConfig({ upscale: { ...upConfig, models: ensuredModels, activeModelId: newActiveId, targetScale: newScale } });
    upscaleClient.dispose();
    upscaleStatusSignal?.set({ ...P.INITIAL_UPSCALE_STATUS });
  }, [setConfig, upConfig, upscaleStatusSignal]);

  const handleScaleChange = useCallback((scale: 2 | 4) => {
    setConfig({ upscale: { ...upConfig, targetScale: scale } });
  }, [upConfig, setConfig]);

  const handleOutputModeChange = useCallback((mode: 'new-frame' | 'replace') => {
    setConfig({ upscale: { ...upConfig, outputMode: mode } });
  }, [upConfig, setConfig]);

  const handleDpiModeChange = useCallback((mode: P.UpscaleDpiMode) => {
    setConfig({ upscale: { ...upConfig, dpiMode: mode } });
  }, [upConfig, setConfig]);

  const handleUpscale = useCallback(() => {
    upscaleCmd?.execute();
  }, [upscaleCmd]);

  const handleCancel = useCallback(() => {
    upscaleAbortCmd?.execute();
  }, [upscaleAbortCmd]);

  const noLayer = !activeLayer || activeLayer.type !== 'image';

  // ─── Large image warning ─────────────────────────────────────────────────
  const sizeWarning = useMemo(() => {
    if (!dimensions) return null;
    const maxDim = Math.max(dimensions.w, dimensions.h);
    if (maxDim > 2048) return 'critical';  // > 2048px — strongly recommend ComfyUI
    if (maxDim > 1024) return 'caution';   // 1025–2048px — works but slow
    return null;
  }, [dimensions]);

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
                const synced = ensureBuiltins(upConfig.models ?? []);
                const validActiveId = synced.find(m => m.id === upConfig.activeModelId)
                  ? upConfig.activeModelId
                  : synced[0]?.id ?? P.BUILTIN_UPSCALE_MODELS[0].id;
                setConfig({ upscale: { ...upConfig, models: synced, activeModelId: validActiveId } });
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
          <span className="text-[10px] font-semibold text-[var(--text-main)]">{activeModel?.size} • {activeModel?.scale}× scale</span>
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

      {/* ─── Scale + Output Options ────────────────────────────── */}
      <div className="px-0.5 space-y-2.5 pt-1">
        <div className="space-y-1">
          <span className="text-[10px] text-[var(--text-main)]">
            Scale
          </span>
          <div className="flex gap-1.5">
            <FancyButton
              variant={targetScale === 2 ? 'ghost' : 'ghost'}
              size="xs"
              shape="rect"
              className={`flex-1 ${targetScale === 2 ? 'ring-1 ring-indigo-500/60' : ''}`}
              onClick={() => handleScaleChange(2)}
              disabled={isBusy}
            >
              <span className="text-[9px]">2× Upscale</span>
            </FancyButton>
            <FancyButton
              variant={targetScale === 4 ? 'ghost' : 'ghost'}
              size="xs"
              shape="rect"
              className={`flex-1 ${targetScale === 4 ? 'ring-1 ring-indigo-500/60' : ''}`}
              onClick={() => handleScaleChange(4)}
              disabled={isBusy}
            >
              <span className="text-[9px]">4× Upscale</span>
            </FancyButton>
          </div>
        </div>

        {/* Dimension preview */}
        {dimensions && (
          <div className="flex flex-col gap-0.5">
            <div className="flex justify-between text-[9px] text-[var(--text-muted)]">
              <span>Input</span>
              <span className="text-[var(--text-main)]">{dimensions.w} × {dimensions.h}</span>
            </div>
            <div className="flex justify-between text-[9px] text-[var(--text-muted)]">
              <span>Output</span>
              <span className="text-[var(--text-main)]">{dimensions.outW} × {dimensions.outH}</span>
            </div>
          </div>
        )}

        {/* Large image warning */}
        {sizeWarning && (
          <div className={`flex items-start gap-1.5 rounded-md px-2 py-1.5 ${
            sizeWarning === 'critical'
              ? 'bg-amber-500/10 border border-amber-500/20'
              : 'bg-yellow-500/5 border border-yellow-500/10'
          }`}>
            <AlertTriangle size={10} className={`shrink-0 mt-0.5 ${
              sizeWarning === 'critical' ? 'text-amber-400' : 'text-yellow-400/70'
            }`} />
            <div className="flex flex-col gap-0.5">
              <span className={`text-[9px] ${sizeWarning === 'critical' ? 'text-amber-300' : 'text-yellow-300/80'}`}>
                {sizeWarning === 'critical'
                  ? 'Very large image — may be slow or fail.'
                  : 'Large image — processing will take longer.'}
              </span>
              {sizeWarning === 'critical' && (
                <span className="text-[8px] text-[var(--text-muted)] italic">
                  For best results, use ComfyUI Upscale with GPU.
                </span>
              )}
            </div>
          </div>
        )}

        {/* Output mode */}
        <div className="space-y-1">
          <span className="text-[10px] text-[var(--text-main)]">
            Output
          </span>
          <div className="flex gap-1.5">
            <FancyButton
              variant="ghost"
              size="xs"
              shape="rect"
              className={`flex-1 ${outputMode === 'new-frame' ? 'ring-1 ring-indigo-500/60' : ''}`}
              onClick={() => handleOutputModeChange('new-frame')}
              disabled={isBusy}
            >
              <span className="text-[9px]">New Frame</span>
            </FancyButton>
            <FancyButton
              variant="ghost"
              size="xs"
              shape="rect"
              className={`flex-1 ${outputMode === 'replace' ? 'ring-1 ring-indigo-500/60' : ''}`}
              onClick={() => handleOutputModeChange('replace')}
              disabled={isBusy}
            >
              <span className="text-[9px]">Replace</span>
            </FancyButton>
          </div>
        </div>

        {/* Scale DPI toggle */}
        <div className="flex justify-between items-center pt-1.5 pb-1 px-1 mt-1 border-t border-[var(--border-subtle)]">
          <span className="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-widest flex items-center gap-1">
            Scale DPI
            <Tooltip content="When enabled, DPI scales with resolution so print size stays the same but sharper." position="bottom" uppercase={false} className="whitespace-normal max-w-[160px]">
              <Info size={10} className="text-[var(--text-muted)] opacity-60 cursor-help" />
            </Tooltip>
          </span>
          <Switch
            checked={dpiMode === 'increase-dpi'}
            onChange={(checked) => handleDpiModeChange(checked ? 'increase-dpi' : 'increase-resolution')}
            activeColor="bg-emerald-500"
            size="compact"
            disabled={isBusy}
          />
        </div>
      </div>

      {/* ─── Processing / Done Progress ───────────────────────── */}
      {(isProcessing || isDone) && (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-stage)] px-2.5 py-2 space-y-1.5">
          <div className="flex justify-between items-center">
            <span className="text-[10px] text-[var(--text-muted)] font-medium flex items-center gap-1">
              {isProcessing && <Loader2 size={10} className="animate-spin" />}
              {isDone && <CheckCircle2 size={10} className="text-emerald-400" />}
              {isProcessing ? `Tile ${status.currentTile}/${status.totalTiles}` : 'Complete'}
            </span>
            <span className="text-[10px] text-[var(--text-muted)]">
              {isDone
                ? `${(status.elapsedMs / 1000).toFixed(1)}s`
                : `${(status.processingProgress * 100).toFixed(0)}%`}
            </span>
          </div>
          <div className="h-1 rounded-full bg-[var(--bg-panel)] overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-300 ${isDone ? 'bg-emerald-500/80' : 'bg-purple-500/80'}`}
              style={{ width: `${(isDone ? 100 : status.processingProgress * 100).toFixed(0)}%` }}
            />
          </div>
          {isProcessing && (
            <button
              onClick={handleCancel}
              className="flex items-center gap-1 mt-1 text-[9px] text-rose-400/80 hover:text-rose-300 transition-colors"
            >
              <X size={9} />
              Cancel
            </button>
          )}
        </div>
      )}

      {/* ─── Error Display ─────────────────────────────────────── */}
      {isError && status.errorMessage && (
        <div className="rounded-xl border border-rose-500/20 bg-rose-500/5 px-2.5 py-2">
          <p className="text-[10px] text-rose-400 select-text break-words">
            <span className="font-semibold">Error:</span> {status.errorMessage}
          </p>
          <button
            onClick={() => upscaleStatusSignal?.set({ ...P.INITIAL_UPSCALE_STATUS })}
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
          onClick={handleUpscale}
          disabled={!mgr.isCached || isBusy || noLayer}
        >
          Upscale {targetScale}× Current Layer
        </FancyButton>
      </div>

      {/* ─── No Layer Hint ─── */}
      {noLayer && mgr.isCached && (
        <div className="text-[9px] text-[var(--text-muted)] italic text-center">
          Select an image layer to upscale
        </div>
      )}
    </div>
  );
}
