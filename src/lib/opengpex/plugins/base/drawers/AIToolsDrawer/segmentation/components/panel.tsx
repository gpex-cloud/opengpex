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

import React, { useCallback, useMemo, useSyncExternalStore } from 'react';
import { Zap, Sparkles, Lightbulb } from 'lucide-react';
import { useEditorServices, useEditorState, usePluginCommands } from '@opengpex/editor/core/context';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';
import { FancyButton } from '@opengpex/editor/widgets/FancyButton';
import { segStore } from '../store';
import type { SegResult } from '../store';
import { ModelPanel, InferencePanel, ErrorPanel, ResultPanel } from '../../_shared';
import { formatMs } from '../../_shared/utils';
import { useAIToolPanel } from '../../_shared/useToolPanel';
import { inpaintEraserStore } from '../../inpaint/eraser/store';
import type { SegConfig } from '../protocols';
import { MODEL_TYPE_KEY, MODEL_TYPE_NAME, BUILTIN_SEG_MODELS, DEFAULT_SEG_CONFIG, getSegModelFiles } from '../protocols';
import type { AIToolsDrawerCommandsMap } from '../../commands.d';

// ─── SegmentationPanel ───────────────────────────────────────────────────────

export function SegmentationPanel() {
  const { actions } = useEditorServices();
  const { state, activeFrame, activeLayer } = useEditorState();
  const { segAllCmd, inpaintEraserCmd } = usePluginCommands<AIToolsDrawerCommandsMap>();

  const { config, setConfig, mgr, task, lastResult, error, isBusy } = useAIToolPanel<SegConfig, SegResult>({
    configKey: MODEL_TYPE_KEY,
    toolDisplayName: MODEL_TYPE_NAME,
    defaultConfig: DEFAULT_SEG_CONFIG,
    builtins: BUILTIN_SEG_MODELS,
    store: segStore,
    actions,
    getFiles: getSegModelFiles as (m: import('../../_shared/types').ModelEntry) => import('../../_shared/download/model-download').ModelFile[],
  });

  // ─── Handlers ──────────────────────────────────────────────────────────────

  const handleSelectCandidate = useCallback((idx: number) => {
    if (!lastResult || !lastResult.candidates[idx]) return;

    segStore.setState({ lastResult: { ...lastResult, activeCandidateIdx: idx } });

    const isClipSam =
      state.interaction.interactionMode === 'clip' &&
      activeFrame?.latestClipTool === 'sam';

    if (!isClipSam && state.activeFrameId) {
      actions.setInteraction({ interactionMode: 'clip' });
      actions.updateFrame(state.activeFrameId, { latestClipTool: 'sam' });
    }

    const framePolygons = lastResult.candidateFramePolygons;
    const frameId = lastResult.samFrameId;
    if (framePolygons && framePolygons[idx] && frameId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      actions.setClipBox(frameId, 'sam', framePolygons[idx] as any);
    }
  }, [lastResult, actions, state.interaction.interactionMode, state.activeFrameId, activeFrame]);

  // ─── AI Erase availability ─────────────────────────────────────────────────
  const hasSamSelection = useMemo(() => {
    if (!activeFrame) return false;
    if (!lastResult || lastResult.candidates.length === 0) return false;
    if (lastResult.activeCandidateIdx == null) return false;
    const clipBox = getClipBox(activeFrame);
    return clipBox !== null && clipBox.rings && clipBox.rings.length > 0;
  }, [activeFrame, lastResult]);

  const isClipSam = state.interaction.interactionMode === 'clip' && activeFrame?.latestClipTool === 'sam';

  const canErase = hasSamSelection && isClipSam && !!activeLayer && activeLayer.type === 'image';

  // ─── Inpaint Eraser task state (for progress display) ──────────────────────
  const eraserState = useSyncExternalStore(inpaintEraserStore.subscribe, inpaintEraserStore.getState);
  const eraserTask = eraserState.task;
  const eraserError = eraserState.error;
  const isErasing = eraserTask !== null;

  return (
    <div className="flex flex-col gap-1.5">
      <ModelPanel
        mgr={mgr}
        isBusy={isBusy}
        config={config}
        setConfig={setConfig}
        builtins={BUILTIN_SEG_MODELS}
        actions={actions}
        client={null}
        resetStore={segStore.reset}
      />

      {task && (
        <InferencePanel
          message={task.message}
          progress={task.progress > 0 ? task.progress : null}
          onCancel={segStore.reset}
        />
      )}

      {lastResult && lastResult.candidates.length > 0 && (
        <ResultPanel elapsed={formatMs(lastResult.lastDecodeMs)} onClear={() => segStore.setState({ lastResult: null })}>
          <div className="flex flex-col gap-1 max-h-[280px] overflow-y-auto pr-1">
            {lastResult.candidates.map((candidate, idx) => {
              const vertexCount = candidate.rings.reduce((sum, ring) => sum + ring.length, 0);
              const isActive = idx === lastResult.activeCandidateIdx;
              return (
                <button
                  key={idx}
                  onClick={() => handleSelectCandidate(idx)}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-xl text-left transition-all cursor-pointer ${
                    isActive
                      ? 'bg-purple-600/15 ring-1 ring-purple-500/30'
                      : 'bg-[var(--bg-panel)] hover:bg-[var(--border-subtle)]'
                  }`}
                >
                  <span className={`w-2 h-2 rounded-full shrink-0 ${isActive ? 'bg-purple-400' : 'bg-[var(--border-light)]'}`} />
                  <span className="text-[10px] font-medium text-[var(--text-main)]">Mask {idx + 1}</span>
                  <span className="text-[9px] text-[var(--text-muted)] ml-auto">{candidate.score.toFixed(2)} • {vertexCount}v</span>
                </button>
              );
            })}
          </div>
        </ResultPanel>
      )}

      {error && <ErrorPanel message={error} onDismiss={() => segStore.setState({ error: null })} />}

      {hasSamSelection && (
        <>
          {eraserTask && (
            <InferencePanel
              message={eraserTask.message}
              progress={eraserTask.progress > 0 ? eraserTask.progress : null}
              onCancel={() => inpaintEraserStore.reset()}
            />
          )}
          {eraserError && <ErrorPanel message={eraserError} onDismiss={() => inpaintEraserStore.setState({ error: null })} />}
          {!isErasing && (
            <p className="px-1 text-[10px] text-[var(--text-main)] leading-relaxed italic opacity-60">
              <Lightbulb size={11} className="inline -mt-px mr-0.5 text-amber-500" /> Tip: Use <strong>Offset Selection</strong> to expand the mask by a few pixels for cleaner erase results.
            </p>
          )}
          <FancyButton
            variant="indigo"
            size="sm"
            shape="pill"
            className="w-full"
            onClick={() => inpaintEraserCmd?.execute()}
            disabled={!canErase || isBusy || isErasing}
          >
            <Sparkles size={12} />
            AI Erase Selected
          </FancyButton>
        </>
      )}

      <div className="pt-0.5">
        <FancyButton
          variant="amber"
          size="sm"
          shape="pill"
          className="w-full"
          onClick={() => segAllCmd?.execute()}
          disabled={!mgr.isCached || isBusy || isErasing}
        >
          <Zap size={12} />
          Auto Segment
        </FancyButton>
      </div>

      {(!lastResult || lastResult.candidates.length === 0) && !isBusy && !error && (
        <p className="px-1 text-[8px] text-[var(--text-muted)] font-bold leading-relaxed uppercase tracking-tight italic opacity-60">
          Select the SAM tool in the toolbar, then click or drag on the canvas to segment objects.
          Or use &quot;Segment All&quot; to detect all objects automatically.
        </p>
      )}
    </div>
  );
}
