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
 * DenoisePanel — AI image denoising panel (NAFNet) within AIToolsDrawer.
 */

import React, { useCallback, useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useEditorState, useEditorServices, usePluginCommands } from '@opengpex/editor/core/context';
import { FancyButton } from '@opengpex/editor/widgets/FancyButton';
import { denoiserStore } from '../store';
import type { DenoiseResult } from '../store';
import { ModelPanel, InferencePanel, ErrorPanel, ResultPanel } from '../../_shared';
import { formatMs } from '../../_shared/utils';
import { useAIToolPanel } from '../../_shared/useToolPanel';
import { denoiserClient } from '../client';
import type { DenoiseConfig, NafNetModelEntry } from '../protocols';
import { MODEL_TYPE_KEY, MODEL_TYPE_NAME, BUILTIN_DENOISE_MODELS, DEFAULT_DENOISE_CONFIG } from '../protocols';
import type { AIToolsDrawerCommandsMap } from '../../commands.d';

// ─── DenoisePanel ────────────────────────────────────────────────────────────

export function DenoisePanel() {
  const { activeLayer } = useEditorState();
  const { actions } = useEditorServices();
  const { denoiserCmd, denoiserAbortCmd } = usePluginCommands<AIToolsDrawerCommandsMap>();

  const { config, setConfig, mgr, task, lastResult, error, isBusy } = useAIToolPanel<DenoiseConfig, DenoiseResult>({
    configKey: MODEL_TYPE_KEY,
    toolDisplayName: MODEL_TYPE_NAME,
    defaultConfig: DEFAULT_DENOISE_CONFIG,
    builtins: BUILTIN_DENOISE_MODELS,
    store: denoiserStore,
    actions,
  });

  const outputMode = config?.outputMode ?? 'new-layer';

  // ─── Handlers ──────────────────────────────────────────────────────────────

  // Denoising is resolution-preserving — no tool-specific model-change patch needed.
  const afterModelChange = useCallback((_newActiveId: string, _ensuredModels: NafNetModelEntry[]) => {
    return undefined;
  }, []);

  const handleOutputModeChange = useCallback((mode: 'new-layer' | 'new-frame') => {
    setConfig({ outputMode: mode });
  }, [setConfig]);

  const noLayer = !activeLayer || activeLayer.type !== 'image';

  // ─── Size warning ─────────────────────────────────────────────────────────
  // Tiled inference (256px tiles) keeps cost linear in megapixels, so judge
  // by AREA, not the max edge: ~6 MP ("caution") is where multi-tile runs
  // start taking noticeable seconds, ~16 MP ("critical") is where low-VRAM
  // devices may stall on the WebGPU backend. An 800×1145 scan (~0.9 MP) must
  // NOT warn — thresholds copied from the upscaler were wrong for this tool
  // (upscaling a 1MP image 4x is genuinely heavy; denoising it is not).
  const sizeWarning = useMemo(() => {
    if (!activeLayer || activeLayer.type !== 'image') return null;
    const w = activeLayer.bounding?.w ?? 0;
    const h = activeLayer.bounding?.h ?? 0;
    const mp = (w * h) / 1_000_000;
    if (mp > 16) return 'critical';
    if (mp > 6) return 'caution';
    return null;
  }, [activeLayer]);

  return (
    <div className="flex flex-col gap-1.5">
      <ModelPanel
        mgr={mgr}
        isBusy={isBusy}
        config={config}
        setConfig={setConfig}
        builtins={BUILTIN_DENOISE_MODELS}
        actions={actions}
        client={denoiserClient}
        resetStore={denoiserStore.reset}
        afterModelChange={afterModelChange}
      />

      {/* ─── Output Options ────────────────────────────────────── */}
      <div className="px-0.5 space-y-2.5 pt-1">
        {sizeWarning && (
          <div className={`flex items-start gap-1.5 rounded-md px-2 py-1.5 ${sizeWarning === 'critical' ? 'bg-amber-500/10 border border-amber-500/20' : 'bg-yellow-500/5 border border-yellow-500/10'}`}>
            <AlertTriangle size={10} className={`shrink-0 mt-0.5 ${sizeWarning === 'critical' ? 'text-amber-500 dark:text-amber-400' : 'text-yellow-500 dark:text-yellow-400/70'}`} />
            <div className="flex flex-col gap-0.5">
              <span className={`text-[9px] ${sizeWarning === 'critical' ? 'text-amber-700 dark:text-amber-300' : 'text-yellow-700 dark:text-yellow-300/80'}`}>
                {sizeWarning === 'critical' ? 'Very large image — may take a while.' : 'Large image — processing will take longer.'}
              </span>
            </div>
          </div>
        )}

        <div className="space-y-1">
          <span className="text-[10px] text-[var(--text-main)]">Output</span>
          <div className="flex gap-1.5">
            <FancyButton variant="ghost" size="xs" shape="rect" className={`flex-1 ${outputMode === 'new-layer' ? 'ring-1 ring-indigo-500/60' : ''}`} onClick={() => handleOutputModeChange('new-layer')} disabled={isBusy}>
              <span className="text-[9px]">New Layer</span>
            </FancyButton>
            <FancyButton variant="ghost" size="xs" shape="rect" className={`flex-1 ${outputMode === 'new-frame' ? 'ring-1 ring-indigo-500/60' : ''}`} onClick={() => handleOutputModeChange('new-frame')} disabled={isBusy}>
              <span className="text-[9px]">New Frame</span>
            </FancyButton>
          </div>
        </div>
      </div>

      {task && (
        <InferencePanel
          message={task.message}
          progress={task.progress > 0 ? task.progress : null}
          onCancel={() => denoiserAbortCmd?.execute()}
        />
      )}

      {lastResult && (
        <ResultPanel elapsed={formatMs(lastResult.totalMs)} onClear={() => denoiserStore.setState({ lastResult: null })}>
          <div className="flex items-center gap-3 text-[10px] text-[var(--text-muted)]">
            <span className="capitalize">{lastResult.deviceUsed}</span>
            <span>{lastResult.outputWidth}×{lastResult.outputHeight}</span>
          </div>
        </ResultPanel>
      )}

      {error && <ErrorPanel message={error} onDismiss={() => denoiserStore.setState({ error: null })} />}

      <div className="pt-0.5">
        <FancyButton
          variant="amber"
          size="sm"
          shape="pill"
          className="w-full"
          onClick={() => denoiserCmd?.execute()}
          disabled={!mgr.isCached || isBusy || noLayer}
        >
          Denoise Current Layer
        </FancyButton>
      </div>

      {noLayer && mgr.isCached && (
        <div className="text-[9px] text-[var(--text-muted)] italic text-center">Select an image layer to denoise</div>
      )}
    </div>
  );
}
