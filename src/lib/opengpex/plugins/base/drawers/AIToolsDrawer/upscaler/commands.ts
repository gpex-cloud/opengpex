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

import { EditorContextValue } from '@opengpex/editor/core/types';
import { createToolCommand } from '../_shared/control/createToolCommand';
import type { ProcessResultOutcome } from '../_shared/control/createToolCommand';
import { getToolConfig } from '../_shared/useToolConfig';
import { upscaleClient } from './client';
import type { UpscaleRequest, UpscaleResult as UpscaleWorkerResult } from './worker.types';
import { PLUGIN_AUTHOR, PLUGIN_ID } from '../protocols';
import type { UpscaleConfig, UpscaleModelEntry } from './protocols';
import {
  BUILTIN_UPSCALE_MODELS,
  DEFAULT_UPSCALE_CONFIG,
  CMD_UPSCALE,
  CMD_UPSCALE_ABORT,
} from './protocols';
import { upscaleStore } from './store';
import type { UpscaleResult } from './store';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PLUGIN_UID = `${PLUGIN_AUTHOR}.${PLUGIN_ID}`;
const MAX_CANVAS_AREA = 268_435_456;
const MAX_CANVAS_DIM = 32_767;

function getUpscaleConfig(ctx: EditorContextValue): UpscaleConfig {
  return getToolConfig<UpscaleConfig>(ctx.state.pluginConfig, PLUGIN_UID, 'upscale', DEFAULT_UPSCALE_CONFIG);
}

// ─── Tool Commands (via createToolCommand factory) ───────────────────────────

const { runCommand, abortCommand } = createToolCommand<
  Omit<UpscaleRequest, 'reqId'>,
  UpscaleWorkerResult,
  UpscaleResult,
  UpscaleModelEntry
>({
  id: { run: CMD_UPSCALE, abort: CMD_UPSCALE_ABORT },
  name: { run: 'AI Upscale Layer', abort: 'Cancel Upscale' },
  store: upscaleStore,
  client: upscaleClient,
  configKey: 'upscale',
  defaultConfig: DEFAULT_UPSCALE_CONFIG,
  builtins: BUILTIN_UPSCALE_MODELS,
  toolName: 'AI Upscaler',
  noResultMessage: 'Upscale produced no output',

  preCheck: (imageData, entry, ctx) => {
    const upConfig = getUpscaleConfig(ctx);
    const scale = upConfig.targetScale ?? 4;
    const expectedOutW = imageData.width * scale;
    const expectedOutH = imageData.height * scale;

    if (expectedOutW * expectedOutH > MAX_CANVAS_AREA ||
        expectedOutW > MAX_CANVAS_DIM || expectedOutH > MAX_CANVAS_DIM) {
      return `Output ${expectedOutW}×${expectedOutH} (${((expectedOutW * expectedOutH) / 1e6).toFixed(0)}M pixels) exceeds browser canvas limit. ` +
        `Max supported: ~${(MAX_CANVAS_AREA / 1e6).toFixed(0)}M pixels. ` +
        `Try a smaller image or use ComfyUI Bridge for large upscales.`;
    }

    // Large image warning (non-blocking)
    const maxDim = Math.max(imageData.width, imageData.height);
    if (maxDim > 2048) {
      ctx.actions.setInteraction({ hud: { message: '⚠️ Large image — upscale may take a while. Consider using ComfyUI for best results.', type: 'info' } });
    }

    return null;
  },

  setRequest: (entry, imageData, ctx) => {
    const upConfig = getUpscaleConfig(ctx);
    const scale = upConfig.targetScale ?? 4;
    const tileSize = upConfig.tileSize ?? 128;

    return {
      modelId: entry.modelId,
      onnxFile: entry.onnxFile,
      backend: entry.backend ?? 'ort',
      device: entry.device ?? 'webgpu',
      modelScale: entry.scale as 2 | 4,
      scale,
      tileSize,
      imageData: {
        data: imageData.data.buffer,
        width: imageData.width,
        height: imageData.height,
      },
    };
  },

  getResult: async (workerResult, ctx, elapsedMs): Promise<ProcessResultOutcome<UpscaleResult> | null> => {
    const { actions } = ctx;
    const frameId = ctx.activeFrame!.id;

    const targetFrame = ctx.state.frames.byId[frameId];
    if (!targetFrame) {
      actions.setInteraction({ hud: { message: 'Upscale complete, but target canvas was closed', type: 'info' } });
      return null;
    }

    if (!workerResult.imageData) return null;

    const { width: outW, height: outH, data: resultBuffer } = workerResult.imageData;
    const upConfig = getUpscaleConfig(ctx);
    const scale = upConfig.targetScale ?? 4;
    const outputMode = upConfig.outputMode ?? 'new-frame';
    const dpiMode = upConfig.dpiMode ?? 'increase-resolution';

    const sourceDpi = targetFrame.dpi || 72;
    const effectiveScale = outW / (targetFrame.canvas?.w || outW);
    const targetDpi = dpiMode === 'increase-dpi'
      ? Math.round(sourceDpi * effectiveScale)
      : sourceDpi;

    // Convert raw pixels to PNG file
    const outCanvas = new OffscreenCanvas(outW, outH);
    const outCtx2d = outCanvas.getContext('2d')!;
    const outImgData = new ImageData(new Uint8ClampedArray(resultBuffer), outW, outH);
    outCtx2d.putImageData(outImgData, 0, 0);
    const blob = await outCanvas.convertToBlob({ type: 'image/png' });
    const frameName = targetFrame.name || 'Untitled';
    const file = new File([blob], `${frameName}_upscaled_${scale}x.png`, { type: 'image/png' });

    // Create new frame or replace current
    if (outputMode === 'new-frame') {
      const newFrameId = await actions.adv.frame.create.trunk.execute({ source: file });
      if (newFrameId && targetDpi !== 72) {
        actions.updateFrame(newFrameId, { dpi: targetDpi });
      }
    } else {
      await actions.adv.frame.resize.replace.execute({ source: file, dpi: targetDpi });
    }

    const dpiInfo = dpiMode === 'increase-dpi' ? ` @ ${targetDpi} DPI` : '';

    if (workerResult.debug) {
      console.log(`[Upscaler] ${workerResult.debug.deviceUsed} | tiles: ${workerResult.debug.tilesProcessed} | total: ${workerResult.debug.totalMs.toFixed(0)}ms`);
    }

    return {
      result: {
        deviceUsed: workerResult.debug?.deviceUsed ?? 'wasm',
        inferenceMs: workerResult.debug?.totalMs ?? elapsedMs,
        totalMs: workerResult.debug?.totalMs ?? elapsedMs,
        scaleFactor: scale,
        outputWidth: outW,
        outputHeight: outH,
        frameId,
      },
      hudMessage: `✨ Upscale complete — ${outW}×${outH}${dpiInfo} (${(elapsedMs / 1000).toFixed(1)}s)`,
      hudType: 'success',
    };
  },
});

// ─── Exported Commands ───────────────────────────────────────────────────────

export const UPSCALE_COMMANDS = {
  upscale: runCommand,
  abortUpscale: abortCommand,
};
