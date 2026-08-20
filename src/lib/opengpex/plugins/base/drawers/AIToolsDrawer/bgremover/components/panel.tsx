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

import React, { useCallback } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { useEditorServices, useEditorState, usePluginCommands } from '@opengpex/editor/core/context';
import { FancyButton } from '@opengpex/editor/widgets/FancyButton';
import { bgRemoverStore } from '../store';
import { ModelPanel, InferencePanel, ErrorPanel, ResultPanel } from '../../_shared';
import { formatMs } from '../../_shared/utils';
import { useAIToolPanel } from '../../_shared/useToolPanel';
import { bgRemoverClient } from '../client';
import type { ModelCatalog } from '../../_shared/types';
import type { AIToolsDrawerCommandsMap } from '../../commands.d';
import type { BgRemoverResult } from '../store';
import { MODEL_TYPE_KEY, MODEL_TYPE_NAME, BUILTIN_MODELS } from '../protocols';


// ─── BgRemover Panel ─────────────────────────────────────────────────────────

export function BgRemoverPanel() {
  const { actions } = useEditorServices();
  const { state } = useEditorState();
  const { removeBgCmd, abortCmd } = usePluginCommands<AIToolsDrawerCommandsMap>();

  const { config, setConfig, mgr, task, lastResult, error, isBusy } = useAIToolPanel<ModelCatalog, BgRemoverResult>({
    configKey: MODEL_TYPE_KEY,
    toolDisplayName: MODEL_TYPE_NAME,
    defaultConfig: { models: BUILTIN_MODELS, activeModelId: BUILTIN_MODELS[0].id },
    builtins: BUILTIN_MODELS,
    store: bgRemoverStore,
    actions,
  });

  // ─── Handlers ──────────────────────────────────────────────────────────────

  const afterModelChange = useCallback(() => {
    if (lastResult?.frameId) {
      actions.setClipBox(lastResult.frameId, 'wand', null);
    }
  }, [lastResult, actions]);

  const handleReapplyResult = useCallback(() => {
    if (!lastResult?.frameId || !lastResult?.polygon) return;
    if (state.interaction.interactionMode !== 'clip') {
      actions.setInteraction({ interactionMode: 'clip' });
    }
    actions.updateFrame(lastResult.frameId, { latestClipTool: 'wand' });
    actions.setClipBox(lastResult.frameId, 'wand', lastResult.polygon);
  }, [lastResult, state.interaction.interactionMode, actions]);

  return (
    <div className="flex flex-col gap-1.5">
      <ModelPanel
        mgr={mgr}
        isBusy={isBusy}
        config={config}
        setConfig={setConfig}
        builtins={BUILTIN_MODELS}
        actions={actions}
        client={bgRemoverClient}
        resetStore={bgRemoverStore.reset}
        afterModelChange={afterModelChange}
      />

      {task && (
        <InferencePanel
          message={task.message}
          progress={task.progress > 0 ? task.progress : null}
          onCancel={() => abortCmd?.execute()}
        />
      )}

      {lastResult && (
        <ResultPanel elapsed={formatMs(lastResult.totalMs)} onClear={() => bgRemoverStore.setState({ lastResult: null })}>
          <button
            onClick={handleReapplyResult}
            className="flex items-center gap-2 px-2 py-1.5 rounded-xl bg-emerald-600/10 ring-1 ring-emerald-500/20 w-full text-left transition-all hover:bg-emerald-600/20 cursor-pointer"
          >
            <CheckCircle2 size={10} className="text-emerald-400 shrink-0" />
            <span className="text-[10px] font-medium text-[var(--text-main)]">Foreground Mask</span>
            <span className="text-[9px] text-[var(--text-muted)] ml-auto">{lastResult.vertexCount}v</span>
          </button>
          <div className="flex items-center gap-3 text-[10px] text-[var(--text-muted)]">
            <span className="capitalize">{lastResult.deviceUsed}</span>
            <span>Inference: {formatMs(lastResult.inferenceMs)}</span>
            <span>Post: {formatMs(lastResult.postProcessMs)}</span>
          </div>
        </ResultPanel>
      )}

      {error && <ErrorPanel message={error} onDismiss={() => bgRemoverStore.setState({ error: null })} />}

      <div className="pt-0.5">
        <FancyButton
          variant="amber"
          size="sm"
          shape="pill"
          className="w-full"
          onClick={() => removeBgCmd?.execute()}
          disabled={!mgr.isCached || isBusy}
        >
          Remove Background
        </FancyButton>
      </div>
    </div>
  );
}
