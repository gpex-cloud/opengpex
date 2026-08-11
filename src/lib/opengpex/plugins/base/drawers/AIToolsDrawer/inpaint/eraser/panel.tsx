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
 * InpaintEraserPanel — AI Smart Eraser panel within AIToolsDrawer.
 */

import React, { useMemo } from 'react';
import { Info, Sparkles } from 'lucide-react';
import { useEditorState, useEditorServices, usePluginCommands } from '@opengpex/editor/core/context';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';
import { FancyButton } from '@opengpex/editor/widgets/FancyButton';
import { inpaintEraserStore } from './store';
import type { InpaintEraserResult } from './store';
import { ModelPanel, InferencePanel, ErrorPanel, ResultPanel } from '../../_shared';
import { formatMs } from '../../_shared/utils';
import { useAIToolPanel } from '../../_shared/useToolPanel';
import { inpaintEraserClient } from './client';
import type { InpaintEraserConfig } from './protocols';
import { BUILTIN_ERASER_MODELS, DEFAULT_INPAINT_ERASER_CONFIG } from './protocols';
import type { AIToolsDrawerCommandsMap } from '../../commands.d';

// ─── InpaintEraserPanel ──────────────────────────────────────────────────────

export function InpaintEraserPanel() {
  const { activeFrame, activeLayer, state } = useEditorState();
  const { actions } = useEditorServices();
  const { inpaintEraserCmd, inpaintEraserAbortCmd } = usePluginCommands<AIToolsDrawerCommandsMap>();

  const { config, setConfig, mgr, task, lastResult, error, isBusy } = useAIToolPanel<InpaintEraserConfig, InpaintEraserResult>({
    configKey: 'inpaintEraser',
    defaultConfig: DEFAULT_INPAINT_ERASER_CONFIG,
    builtins: BUILTIN_ERASER_MODELS,
    store: inpaintEraserStore,
    actions,
  });

  // ─── Selection state ────────────────────────────────────────────────────────
  const hasSelection = useMemo(() => {
    if (!activeFrame) return false;
    if (state.interaction.interactionMode !== 'clip') return false;
    const clipBox = getClipBox(activeFrame);
    return clipBox !== null && clipBox.rings && clipBox.rings.length > 0;
  }, [activeFrame, state.interaction.interactionMode]);

  const noLayer = !activeLayer || activeLayer.type !== 'image';

  return (
    <div className="flex flex-col gap-1.5">
      <ModelPanel
        mgr={mgr}
        isBusy={isBusy}
        config={config}
        setConfig={setConfig}
        builtins={BUILTIN_ERASER_MODELS}
        actions={actions}
        client={inpaintEraserClient}
        resetStore={inpaintEraserStore.reset}
      />

      {task && (
        <InferencePanel
          message={task.message}
          progress={task.progress > 0 ? task.progress : null}
          onCancel={() => inpaintEraserAbortCmd?.execute()}
        />
      )}

      {lastResult && (
        <ResultPanel elapsed={formatMs(lastResult.totalMs)} onClear={() => inpaintEraserStore.setState({ lastResult: null })}>
          <div className="flex items-center gap-3 text-[10px] text-[var(--text-muted)]">
            <span className="capitalize">{lastResult.deviceUsed}</span>
            <span>Inference: {formatMs(lastResult.inferenceMs)}</span>
            {lastResult.outputWidth > 0 && (
              <span>Patch: {lastResult.outputWidth}×{lastResult.outputHeight}</span>
            )}
          </div>
        </ResultPanel>
      )}

      {error && <ErrorPanel message={error} onDismiss={() => inpaintEraserStore.setState({ error: null })} />}

      <div className="pt-0.5">
        <FancyButton
          variant="amber"
          size="sm"
          shape="pill"
          className="w-full"
          onClick={() => inpaintEraserCmd?.execute()}
          disabled={!mgr.isCached || isBusy || noLayer || !hasSelection}
        >
          <Sparkles size={12} />
          Erase Selected Area
        </FancyButton>
      </div>

      {!hasSelection && mgr.isCached && !noLayer && (
        <div className="flex gap-1.5 items-start px-2 py-1.5 rounded-lg bg-[var(--bg-stage)] border border-[var(--border-subtle)]">
          <Info size={10} className="text-[var(--text-muted)] shrink-0 mt-0.5" />
          <p className="text-[9px] text-[var(--text-muted)] leading-relaxed">
            Select an area first using any clip tool (rect, lasso, wand, or SAM), then click Erase.
          </p>
        </div>
      )}

      {noLayer && mgr.isCached && (
        <div className="text-[9px] text-[var(--text-muted)] italic text-center">
          Select an image layer to erase from
        </div>
      )}
    </div>
  );
}
