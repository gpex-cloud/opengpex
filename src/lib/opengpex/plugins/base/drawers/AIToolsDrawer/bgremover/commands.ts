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

import { EditorContextValue, EditorCommand, asLocalPoint, asLocalPolygon, asLocalRect } from '@opengpex/editor/core/types';
import { SettingsPanelAPI } from '../../../panels/SettingsPanel/protocols';
import { createToolCommand } from '../_shared/control/createToolCommand';
import type { ProcessResultOutcome } from '../_shared/control/createToolCommand';
import { bgRemoverClient } from './client';
import type { BgRemoverRequest, BgRemoverResult as BgRemoverWorkerResult } from './worker.types';
import type { ModelEntry } from './protocols';
import {
  MODEL_TYPE_KEY,
  BUILTIN_MODELS,
  DEFAULT_BG_REMOVAL_CONFIG,
  CMD_REMOVE_BG,
  CMD_ABORT,
  CMD_OPEN_SETTINGS,
} from './protocols';
import { bgRemoverStore } from './store';
import type { BgRemoverResult } from './store';

// ─── Tool Commands (via createToolCommand factory) ───────────────────────────

const { runCommand, abortCommand } = createToolCommand<
  Omit<BgRemoverRequest, 'reqId'>,
  BgRemoverWorkerResult,
  BgRemoverResult,
  ModelEntry
>({
  id: { run: CMD_REMOVE_BG, abort: CMD_ABORT },
  name: { run: 'AI Remove Background', abort: 'Cancel Background Removal' },
  store: bgRemoverStore,
  client: bgRemoverClient,
  configKey: MODEL_TYPE_KEY,
  defaultConfig: DEFAULT_BG_REMOVAL_CONFIG,
  builtins: BUILTIN_MODELS,
  toolName: 'Background removal',
  noResultMessage: 'No subject detected in this image',

  setRequest: (entry, imageData, ctx) => ({
    modelId: entry.modelId,
    onnxFile: entry.onnxFile,
    backend: entry.backend ?? 'transformers',
    device: entry.device ?? 'webgpu',
    imageData: {
      data: imageData.data.buffer,
      width: imageData.width,
      height: imageData.height,
    },
    context: {
      frameId: ctx.activeFrame!.id,
      layerId: ctx.activeLayer!.id,
    },
  }),

  getResult: (workerResult, ctx, elapsedMs): ProcessResultOutcome<BgRemoverResult> | null => {
    const { actions } = ctx;
    const frameId = workerResult.context?.frameId ?? ctx.activeFrame!.id;
    const layerId = workerResult.context?.layerId ?? ctx.activeLayer!.id;

    // Validate target frame/layer still exists
    const targetFrame = ctx.state.frames.byId[frameId];
    if (!targetFrame) {
      actions.setInteraction({ hud: { message: 'Background removed, but target canvas was closed', type: 'info' } });
      return null;
    }
    const targetLayer = targetFrame.layers.byId[layerId];
    if (!targetLayer) {
      actions.setInteraction({ hud: { message: 'Background removed, but target layer was deleted', type: 'info' } });
      return null;
    }

    if (workerResult.rings.length === 0) return null;

    // Build polygon from contour rings
    const localRings = workerResult.rings.map(ring => ring.map(p => asLocalPoint({ x: p.x, y: p.y })));
    const bounds = asLocalRect(ctx.geometry.polygon.computePolygonBounds(localRings));
    const polygon = asLocalPolygon(localRings, bounds, true);

    // Apply clip box
    actions.setClipBox(frameId, 'wand', polygon);
    actions.updateFrame(frameId, { latestClipTool: 'wand' });
    if (ctx.state.interaction.interactionMode !== 'clip') {
      actions.setInteraction({ interactionMode: 'clip' });
    }

    const vertexCount = workerResult.rings.reduce((sum, ring) => sum + ring.length, 0);
    const totalMs = workerResult.debug?.totalMs ?? elapsedMs;

    if (workerResult.debug) {
      console.log(`[BgRemover] ${workerResult.debug.deviceUsed} | inference: ${workerResult.debug.inferenceMs.toFixed(0)}ms | post: ${workerResult.debug.postProcessMs.toFixed(0)}ms | total: ${workerResult.debug.totalMs.toFixed(0)}ms`);
    }

    return {
      result: {
        deviceUsed: workerResult.debug?.deviceUsed ?? 'wasm',
        inferenceMs: workerResult.debug?.inferenceMs ?? elapsedMs,
        postProcessMs: workerResult.debug?.postProcessMs ?? 0,
        totalMs,
        vertexCount,
        polygon,
        frameId,
      },
      hudMessage: `✨ Background removed — foreground mask applied (${totalMs.toFixed(0)}ms)`,
      hudType: 'success',
    };
  },
});

// ─── Exported Commands ───────────────────────────────────────────────────────

export const BG_REMOVAL_COMMANDS = {
  removeBg: runCommand,
  abort: abortCommand,
  openSettings: {
    id: CMD_OPEN_SETTINGS,
    name: 'Open BG Remover Settings',
    execute: (ctx: EditorContextValue) => {
      ctx.actions.setStateSignal(SettingsPanelAPI.signals.tab, 'AI Tools');
      ctx.actions.setStateSignal(SettingsPanelAPI.signals.open, true);
    },
  } as EditorCommand<void, void>,
};
