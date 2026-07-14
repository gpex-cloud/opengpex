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

import { EditorContextValue, EditorCommand } from '@opengpex/editor/core/types';
import { sourceBitmapCache } from '@opengpex/editor/core/engine/cache/SourceBitmapCache';
import { upscaleClient } from './client';
import { SpeedEstimator } from '../shared';
import { PLUGIN_AUTHOR, PLUGIN_ID } from '../protocols';
import type { AIToolsConfig } from '../protocols';
import type { UpscaleStatus, UpscaleConfig } from './protocols';
import {
  SIGNAL_UPSCALE_STATUS,
  INITIAL_UPSCALE_STATUS,
  BUILTIN_UPSCALE_MODELS,
  DEFAULT_UPSCALE_CONFIG,
  CMD_UPSCALE,
  CMD_UPSCALE_DOWNLOAD,
  CMD_UPSCALE_ABORT,
} from './protocols';

// ─── Upscale Commands ────────────────────────────────────────────────────────────

/** Auto-reset delay: how long to show "done" state before resetting to idle (ms) */
const DONE_DISPLAY_MS = 3000;

/** Module-level AbortController for the current upscale operation. */
let upscaleAbortController: AbortController | null = null;

/**
 * Helper: Get the active upscale model ID from plugin config.
 */
function getActiveUpscaleModelId(ctx: EditorContextValue): string {
  const pluginUid = `${PLUGIN_AUTHOR}.${PLUGIN_ID}`;
  const config = ctx.state.pluginConfig[pluginUid] as unknown as AIToolsConfig | undefined;
  const upConfig = config?.upscale as UpscaleConfig | undefined;
  if (!upConfig) return BUILTIN_UPSCALE_MODELS[0].modelId;

  const activeId = upConfig.activeModelId;
  const fromConfig = upConfig.models?.find(m => m.id === activeId);
  if (fromConfig) return fromConfig.modelId;

  const fromBuiltins = BUILTIN_UPSCALE_MODELS.find(m => m.id === activeId);
  if (fromBuiltins) return fromBuiltins.modelId;

  return BUILTIN_UPSCALE_MODELS[0].modelId;
}

/**
 * Helper: Update the Upscale status signal.
 */
function setUpscaleStatus(ctx: EditorContextValue, patch: Partial<UpscaleStatus>): void {
  const current = (ctx.scoped!.getSignal<UpscaleStatus>(SIGNAL_UPSCALE_STATUS, INITIAL_UPSCALE_STATUS)) ?? INITIAL_UPSCALE_STATUS;
  ctx.scoped!.setSignal(SIGNAL_UPSCALE_STATUS, { ...current, ...patch });
}

export const UPSCALE_COMMANDS = {
  /**
   * upscale — Execute AI upscale on the active image layer.
   */
  upscale: {
    id: CMD_UPSCALE,
    name: 'AI Upscale Layer',
    execute: async (ctx: EditorContextValue) => {
      const { activeFrame, activeLayer, actions } = ctx;

      if (!activeFrame || !activeLayer) {
        actions.setInteraction({ hud: { message: 'No active image layer', type: 'error' } });
        return;
      }
      if (activeLayer.type !== 'image') {
        actions.setInteraction({ hud: { message: 'AI Upscaler only works on image layers', type: 'error' } });
        return;
      }

      const frameId = activeFrame.id;
      const modelId = getActiveUpscaleModelId(ctx);

      const pluginUid = `${PLUGIN_AUTHOR}.${PLUGIN_ID}`;
      const config = ctx.state.pluginConfig[pluginUid] as unknown as AIToolsConfig | undefined;
      const upConfig = config?.upscale ?? DEFAULT_UPSCALE_CONFIG;
      const scale = upConfig.targetScale ?? 4;
      const tileSize = upConfig.tileSize ?? 256;

      const imageSource = activeLayer.src;
      if (!imageSource) {
        actions.setInteraction({ hud: { message: 'Layer has no image source', type: 'error' } });
        return;
      }

      let imageData: ImageData;
      try {
        const cachedBitmap = sourceBitmapCache.get(imageSource);
        if (!cachedBitmap) {
          sourceBitmapCache.getOrFetch(imageSource);
          actions.setInteraction({ hud: { message: 'Image not loaded yet', type: 'error' } });
          return;
        }
        const canvas = new OffscreenCanvas(cachedBitmap.width, cachedBitmap.height);
        const ctx2d = canvas.getContext('2d')!;
        ctx2d.drawImage(cachedBitmap, 0, 0);
        imageData = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
      } catch {
        actions.setInteraction({ hud: { message: 'Failed to read image data', type: 'error' } });
        return;
      }

      const maxDim = Math.max(imageData.width, imageData.height);
      if (maxDim > 2048) {
        actions.setInteraction({ hud: { message: '⚠️ Large image — upscale may take a while. Consider using ComfyUI for best results.', type: 'info' } });
      }

      ctx.scoped!.setBusy(true);
      upscaleAbortController = new AbortController();
      const { signal } = upscaleAbortController;
      const speedEstimator = new SpeedEstimator();
      const start = performance.now();

      setUpscaleStatus(ctx, {
        stage: 'processing',
        device: null,
        downloadProgress: 0,
        processingProgress: 0,
        currentTile: 0,
        totalTiles: 0,
        errorMessage: null,
        elapsedMs: 0,
      });

      try {
        const result = await upscaleClient.run(
          {
            action: 'upscale',
            modelId,
            imageData: {
              data: imageData.data.buffer,
              width: imageData.width,
              height: imageData.height,
            },
            scale,
            tileSize,
          },
          {
            timeoutMs: 0,
            signal,
            onProgress: (p) => {
              if (p.stage === 'detecting-device' && p.device) {
                setUpscaleStatus(ctx, { device: p.device });
              } else if (p.stage === 'downloading') {
                if (p.loaded != null && p.total != null) {
                  speedEstimator.update(p.loaded, p.total);
                  setUpscaleStatus(ctx, {
                    stage: 'downloading',
                    downloadProgress: p.total > 0 ? p.loaded / p.total : 0,
                    downloadedBytes: p.loaded,
                    totalBytes: p.total,
                    speedBps: speedEstimator.bytesPerSecond,
                    etaSeconds: speedEstimator.etaSeconds,
                  });
                }
              } else if (p.stage === 'processing') {
                setUpscaleStatus(ctx, {
                  stage: 'processing',
                  processingProgress: p.progress ?? 0,
                  currentTile: p.currentTile ?? 0,
                  totalTiles: p.totalTiles ?? 0,
                });
              }
            },
          }
        );

        const elapsedMs = performance.now() - start;

        const targetFrame = ctx.state.frames.byId[frameId];
        if (!targetFrame) {
          actions.setInteraction({ hud: { message: 'Upscale complete, but target canvas was closed', type: 'info' } });
          setUpscaleStatus(ctx, { ...INITIAL_UPSCALE_STATUS });
          return;
        }

        if (result.imageData) {
          const { width: outW, height: outH, data: resultBuffer } = result.imageData;
          const outputMode = upConfig.outputMode ?? 'new-frame';
          const dpiMode = upConfig.dpiMode ?? 'increase-resolution';

          const sourceDpi = targetFrame.dpi || 72;
          const effectiveScale = outW / (targetFrame.canvas?.w || outW);
          const targetDpi = dpiMode === 'increase-dpi'
            ? Math.round(sourceDpi * effectiveScale)
            : sourceDpi;

          const outCanvas = new OffscreenCanvas(outW, outH);
          const outCtx2d = outCanvas.getContext('2d')!;
          const outImgData = new ImageData(new Uint8ClampedArray(resultBuffer), outW, outH);
          outCtx2d.putImageData(outImgData, 0, 0);
          const blob = await outCanvas.convertToBlob({ type: 'image/png' });
          const frameName = targetFrame.name || 'Untitled';
          const file = new File([blob], `${frameName}_upscaled_${scale}x.png`, { type: 'image/png' });

          if (outputMode === 'new-frame') {
            const newFrameId = await actions.adv.frame.create.trunk.execute({ source: file });
            if (newFrameId && targetDpi !== 72) {
              actions.updateFrame(newFrameId, { dpi: targetDpi });
            }
          } else {
            await actions.adv.frame.resize.replace.execute({ source: file, dpi: targetDpi });
          }

          const dpiInfo = dpiMode === 'increase-dpi' ? ` @ ${targetDpi} DPI` : '';
          actions.setInteraction({
            hud: { message: `✨ Upscale complete — ${outW}×${outH}${dpiInfo} (${(elapsedMs / 1000).toFixed(1)}s)`, type: 'success' },
          });
        }

        setUpscaleStatus(ctx, {
          stage: 'done',
          processingProgress: 1,
          elapsedMs,
        });

        setTimeout(() => {
          const current = ctx.scoped!.getSignal<UpscaleStatus>(SIGNAL_UPSCALE_STATUS, INITIAL_UPSCALE_STATUS);
          if (current?.stage === 'done') {
            setUpscaleStatus(ctx, { ...INITIAL_UPSCALE_STATUS });
          }
        }, DONE_DISPLAY_MS);

        if (result.debug) {
          console.log(`[Upscaler] ${result.debug.deviceUsed} | tiles: ${result.debug.tilesProcessed} | total: ${result.debug.totalMs.toFixed(0)}ms`);
        }

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Aborted')) {
          setUpscaleStatus(ctx, { ...INITIAL_UPSCALE_STATUS });
          actions.setInteraction({ hud: { message: 'Upscale cancelled', type: 'info' } });
        } else {
          setUpscaleStatus(ctx, { stage: 'error', errorMessage: msg });
          actions.setInteraction({ hud: { message: 'Upscale failed — see error in panel', type: 'error' } });
        }
      } finally {
        upscaleAbortController = null;
        ctx.scoped!.setBusy(false);
      }
    },
  } as EditorCommand<void, Promise<void>>,

  /**
   * downloadUpscaleModel — Pre-download the active upscale model.
   */
  downloadUpscaleModel: {
    id: CMD_UPSCALE_DOWNLOAD,
    name: 'Download Upscale Model',
    execute: async (ctx: EditorContextValue) => {
      const modelId = getActiveUpscaleModelId(ctx);
      ctx.scoped!.setBusy(true);
      upscaleAbortController = new AbortController();
      const { signal } = upscaleAbortController;
      const speedEstimator = new SpeedEstimator();

      setUpscaleStatus(ctx, {
        stage: 'downloading',
        downloadProgress: 0,
        errorMessage: null,
      });

      try {
        await upscaleClient.run(
          { action: 'download', modelId },
          {
            timeoutMs: 0,
            signal,
            onProgress: (p) => {
              if (p.stage === 'downloading' && p.loaded != null && p.total != null) {
                speedEstimator.update(p.loaded, p.total);
                setUpscaleStatus(ctx, {
                  stage: 'downloading',
                  downloadProgress: p.total > 0 ? p.loaded / p.total : 0,
                  downloadedBytes: p.loaded,
                  totalBytes: p.total,
                  speedBps: speedEstimator.bytesPerSecond,
                  etaSeconds: speedEstimator.etaSeconds,
                });
              }
              if (p.stage === 'detecting-device' && p.device) {
                setUpscaleStatus(ctx, { device: p.device });
              }
            },
          }
        );

        setUpscaleStatus(ctx, { stage: 'done', downloadProgress: 1 });
        ctx.actions.setInteraction({ hud: { message: '✨ Upscale model downloaded successfully', type: 'success' } });

        setTimeout(() => {
          const current = ctx.scoped!.getSignal<UpscaleStatus>(SIGNAL_UPSCALE_STATUS, INITIAL_UPSCALE_STATUS);
          if (current?.stage === 'done') {
            setUpscaleStatus(ctx, { ...INITIAL_UPSCALE_STATUS });
          }
        }, DONE_DISPLAY_MS);

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Aborted')) {
          setUpscaleStatus(ctx, { ...INITIAL_UPSCALE_STATUS });
        } else {
          setUpscaleStatus(ctx, { stage: 'error', errorMessage: msg });
          ctx.actions.setInteraction({ hud: { message: 'Model download failed', type: 'error' } });
        }
      } finally {
        upscaleAbortController = null;
        ctx.scoped!.setBusy(false);
      }
    },
  } as EditorCommand<void, Promise<void>>,

  /**
   * abortUpscale — Cancel an in-progress upscale operation.
   */
  abortUpscale: {
    id: CMD_UPSCALE_ABORT,
    name: 'Cancel Upscale',
    execute: (ctx: EditorContextValue) => {
      if (upscaleAbortController) {
        upscaleAbortController.abort();
        upscaleAbortController = null;
      }
      upscaleClient.dispose();
      setUpscaleStatus(ctx, { ...INITIAL_UPSCALE_STATUS });
      ctx.actions.setInteraction({ hud: { message: 'Upscale cancelled', type: 'info' } });
    },
  } as EditorCommand<void, void>,
};
