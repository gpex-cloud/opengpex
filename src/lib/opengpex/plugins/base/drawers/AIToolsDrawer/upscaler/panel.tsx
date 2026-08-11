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
 */

import React, { useCallback, useMemo } from 'react';
import { Info, AlertTriangle } from 'lucide-react';
import Switch from '@opengpex/editor/widgets/Switch';
import Tooltip from '@opengpex/editor/widgets/Tooltip';
import { useEditorState, useEditorServices, usePluginCommands } from '@opengpex/editor/core/context';
import { FancyButton } from '@opengpex/editor/widgets/FancyButton';
import { upscaleStore } from './store';
import type { UpscaleResult } from './store';
import { ModelPanel, InferencePanel, ErrorPanel, ResultPanel } from '../_shared';
import { formatMs } from '../_shared/utils';
import { useAIToolPanel } from '../_shared/useToolPanel';
import { upscaleClient } from './client';
import type { UpscaleConfig, UpscaleModelEntry, UpscaleDpiMode } from './protocols';
import { BUILTIN_UPSCALE_MODELS, DEFAULT_UPSCALE_CONFIG } from './protocols';
import type { AIToolsDrawerCommandsMap } from '../commands.d';
import type { ModelEntry } from '../_shared/types';

// ─── UpscalerPanel ───────────────────────────────────────────────────────────

export function UpscalerPanel() {
  const { activeLayer } = useEditorState();
  const { actions, pixels } = useEditorServices();
  const { upscaleCmd, upscaleAbortCmd } = usePluginCommands<AIToolsDrawerCommandsMap>();

  const { config, setConfig, mgr, task, lastResult, error, isBusy } = useAIToolPanel<UpscaleConfig, UpscaleResult>({
    configKey: 'upscale',
    defaultConfig: DEFAULT_UPSCALE_CONFIG,
    builtins: BUILTIN_UPSCALE_MODELS,
    store: upscaleStore,
    actions,
  });

  const targetScale = config?.targetScale ?? 4;
  const outputMode = config?.outputMode ?? 'new-frame';
  const dpiMode = config?.dpiMode ?? 'increase-resolution';

  // ─── Dimension preview ───────────────────────────────────────────────────
  const dimensions = useMemo(() => {
    if (!activeLayer || activeLayer.type !== 'image') return null;
    const bitmap = activeLayer.src ? pixels.image.ensureBitmap(activeLayer.src) : undefined;
    const w = bitmap?.width ?? activeLayer.bounding?.w ?? 0;
    const h = bitmap?.height ?? activeLayer.bounding?.h ?? 0;
    if (w === 0 || h === 0) return null;
    return { w, h, outW: w * targetScale, outH: h * targetScale };
  }, [activeLayer, targetScale, pixels.image]);

  // ─── Handlers ──────────────────────────────────────────────────────────────

  const afterModelChange = useCallback((newActiveId: string, ensuredModels: ModelEntry[]) => {
    const newModel = ensuredModels.find(m => m.id === newActiveId) as UpscaleModelEntry | undefined;
    const newScale = (newModel?.scale === 2 ? 2 : 4) as 2 | 4;
    setConfig({ targetScale: newScale });
  }, [setConfig]);

  const handleScaleChange = useCallback((scale: 2 | 4) => {
    setConfig({ targetScale: scale });
  }, [setConfig]);

  const handleOutputModeChange = useCallback((mode: 'new-frame' | 'replace') => {
    setConfig({ outputMode: mode });
  }, [setConfig]);

  const handleDpiModeChange = useCallback((mode: UpscaleDpiMode) => {
    setConfig({ dpiMode: mode });
  }, [setConfig]);

  const noLayer = !activeLayer || activeLayer.type !== 'image';

  const sizeWarning = useMemo(() => {
    if (!dimensions) return null;
    const maxDim = Math.max(dimensions.w, dimensions.h);
    if (maxDim > 2048) return 'critical';
    if (maxDim > 1024) return 'caution';
    return null;
  }, [dimensions]);

  return (
    <div className="flex flex-col gap-1.5">
      <ModelPanel
        mgr={mgr}
        isBusy={isBusy}
        config={config}
        setConfig={setConfig}
        builtins={BUILTIN_UPSCALE_MODELS}
        actions={actions}
        client={upscaleClient}
        resetStore={upscaleStore.reset}
        afterModelChange={afterModelChange}
      />

      {/* ─── Scale + Output Options ────────────────────────────── */}
      <div className="px-0.5 space-y-2.5 pt-1">
        <div className="space-y-1">
          <span className="text-[10px] text-[var(--text-main)]">Scale</span>
          <div className="flex gap-1.5">
            <FancyButton variant="ghost" size="xs" shape="rect" className={`flex-1 ${targetScale === 2 ? 'ring-1 ring-indigo-500/60' : ''}`} onClick={() => handleScaleChange(2)} disabled={isBusy}>
              <span className="text-[9px]">2× Upscale</span>
            </FancyButton>
            <FancyButton variant="ghost" size="xs" shape="rect" className={`flex-1 ${targetScale === 4 ? 'ring-1 ring-indigo-500/60' : ''}`} onClick={() => handleScaleChange(4)} disabled={isBusy}>
              <span className="text-[9px]">4× Upscale</span>
            </FancyButton>
          </div>
        </div>

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

        {sizeWarning && (
          <div className={`flex items-start gap-1.5 rounded-md px-2 py-1.5 ${sizeWarning === 'critical' ? 'bg-amber-500/10 border border-amber-500/20' : 'bg-yellow-500/5 border border-yellow-500/10'}`}>
            <AlertTriangle size={10} className={`shrink-0 mt-0.5 ${sizeWarning === 'critical' ? 'text-amber-500 dark:text-amber-400' : 'text-yellow-500 dark:text-yellow-400/70'}`} />
            <div className="flex flex-col gap-0.5">
              <span className={`text-[9px] ${sizeWarning === 'critical' ? 'text-amber-700 dark:text-amber-300' : 'text-yellow-700 dark:text-yellow-300/80'}`}>
                {sizeWarning === 'critical' ? 'Very large image — may be slow or fail.' : 'Large image — processing will take longer.'}
              </span>
              {sizeWarning === 'critical' && (
                <span className="text-[8px] text-[var(--text-muted)] italic">For best results, use ComfyUI Upscale with GPU.</span>
              )}
            </div>
          </div>
        )}

        <div className="space-y-1">
          <span className="text-[10px] text-[var(--text-main)]">Output</span>
          <div className="flex gap-1.5">
            <FancyButton variant="ghost" size="xs" shape="rect" className={`flex-1 ${outputMode === 'new-frame' ? 'ring-1 ring-indigo-500/60' : ''}`} onClick={() => handleOutputModeChange('new-frame')} disabled={isBusy}>
              <span className="text-[9px]">New Frame</span>
            </FancyButton>
            <FancyButton variant="ghost" size="xs" shape="rect" className={`flex-1 ${outputMode === 'replace' ? 'ring-1 ring-indigo-500/60' : ''}`} onClick={() => handleOutputModeChange('replace')} disabled={isBusy}>
              <span className="text-[9px]">Replace</span>
            </FancyButton>
          </div>
        </div>

        <div className="flex justify-between items-center pt-1.5 pb-1 px-1 mt-1 border-t border-[var(--border-subtle)] dark:border-white/10">
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

      {task && (
        <InferencePanel
          message={task.message}
          progress={task.progress > 0 ? task.progress : null}
          onCancel={() => upscaleAbortCmd?.execute()}
        />
      )}

      {lastResult && (
        <ResultPanel elapsed={formatMs(lastResult.totalMs)} onClear={() => upscaleStore.setState({ lastResult: null })}>
          <div className="flex items-center gap-3 text-[10px] text-[var(--text-muted)]">
            <span className="capitalize">{lastResult.deviceUsed}</span>
            <span>{lastResult.scaleFactor}× → {lastResult.outputWidth}×{lastResult.outputHeight}</span>
          </div>
        </ResultPanel>
      )}

      {error && <ErrorPanel message={error} onDismiss={() => upscaleStore.setState({ error: null })} />}

      <div className="pt-0.5">
        <FancyButton
          variant="amber"
          size="sm"
          shape="pill"
          className="w-full"
          onClick={() => upscaleCmd?.execute()}
          disabled={!mgr.isCached || isBusy || noLayer}
        >
          Upscale {targetScale}× Current Layer
        </FancyButton>
      </div>

      {noLayer && mgr.isCached && (
        <div className="text-[9px] text-[var(--text-muted)] italic text-center">Select an image layer to upscale</div>
      )}
    </div>
  );
}
