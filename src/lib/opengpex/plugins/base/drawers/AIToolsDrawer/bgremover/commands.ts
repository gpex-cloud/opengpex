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
import { sourceBitmapCache } from '@opengpex/editor/core/engine/cache/SourceBitmapCache';
import { SettingsPanelAPI } from '../../../panels/SettingsPanel/protocols';
import { bgRemoverClient } from './client';
import { SpeedEstimator } from '../shared';
import type { BgRemoverProgress } from './worker.types';
import { PLUGIN_AUTHOR, PLUGIN_ID } from '../protocols';
import type { BgRemoverStatus, BgRemoverConfig } from './protocols';
import {
  SIGNAL_STATUS,
  INITIAL_STATUS,
  BUILTIN_MODELS,
  CMD_REMOVE_BG,
  CMD_DOWNLOAD_MODEL,
  CMD_ABORT,
  CMD_OPEN_SETTINGS,
} from './protocols';

/** Auto-reset delay: how long to show "done" state before resetting to idle (ms) */
const DONE_DISPLAY_MS = 3000;

/**
 * Module-level AbortController for the current in-flight inference request.
 * Set before calling bgRemoverClient.run(), cleared on completion/abort.
 * Allows the abort command to cancel a long-running download or inference.
 */
let activeAbortController: AbortController | null = null;

/**
 * Helper: Update the BgRemover status signal.
 */
function setStatus(ctx: EditorContextValue, patch: Partial<BgRemoverStatus>): void {
  const current = (ctx.scoped!.getSignal<BgRemoverStatus>(SIGNAL_STATUS, INITIAL_STATUS)) ?? INITIAL_STATUS;
  ctx.scoped!.setSignal(SIGNAL_STATUS, { ...current, ...patch });
}

/**
 * Helper: Get the active model entry from plugin config.
 * Returns the full BgModelEntry so callers can access modelId, onnxFile, etc.
 */
function getActiveModelEntry(ctx: EditorContextValue): import('./protocols').BgModelEntry {
  const pluginUid = `${PLUGIN_AUTHOR}.${PLUGIN_ID}`;
  const config = ctx.state.pluginConfig[pluginUid] as unknown as BgRemoverConfig | undefined;
  if (!config) return BUILTIN_MODELS[0];

  const activeId = config.activeModelId;
  const fromConfig = config.models?.find(m => m.id === activeId);
  if (fromConfig) return fromConfig;

  const fromBuiltins = BUILTIN_MODELS.find(m => m.id === activeId);
  if (fromBuiltins) return fromBuiltins;

  return BUILTIN_MODELS[0];
}

/**
 * Helper: Get the active model ID from plugin config.
 */
function getActiveModelId(ctx: EditorContextValue): string {
  return getActiveModelEntry(ctx).modelId;
}

/**
 * BG_REMOVAL_COMMANDS: Declarative command configurations.
 */
export const BG_REMOVAL_COMMANDS = {
  removeBg: {
    id: CMD_REMOVE_BG,
    name: 'AI Remove Background',
    execute: async (ctx: EditorContextValue) => {
      const { activeFrame, activeLayer, actions } = ctx;

      if (!activeFrame || !activeLayer) {
        actions.setInteraction({ hud: { message: 'No active image layer', type: 'error' } });
        return;
      }

      if (activeLayer.type !== 'image') {
        actions.setInteraction({ hud: { message: 'AI background removal only works on image layers', type: 'error' } });
        return;
      }

      const frameId = activeFrame.id;
      const layerId = activeLayer.id;
      const activeModelEntry = getActiveModelEntry(ctx);
      const modelId = activeModelEntry.modelId;
      const onnxFile = activeModelEntry.onnxFile;

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
      } catch (_err) {
        actions.setInteraction({ hud: { message: 'Failed to read image data', type: 'error' } });
        return;
      }

      ctx.scoped!.setBusy(true);

      setStatus(ctx, {
        stage: 'loading',
        device: null,
        downloadProgress: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        speedBps: 0,
        etaSeconds: 0,
        processingProgress: 0,
        errorMessage: null,
        context: { frameId, layerId },
        elapsedMs: 0,
      });

      activeAbortController = new AbortController();
      const { signal } = activeAbortController;

      const speedEstimator = new SpeedEstimator();
      const inferenceStart = performance.now();

      const onProgress = (progress: BgRemoverProgress) => {
        switch (progress.stage) {
          case 'detecting-device':
            if (progress.device) {
              setStatus(ctx, { device: progress.device });
            }
            break;
          case 'loading':
            setStatus(ctx, { stage: 'loading' });
            break;
          case 'downloading':
            if (progress.loaded != null && progress.total != null) {
              speedEstimator.update(progress.loaded, progress.total);
              const dlProgress = progress.total > 0 ? progress.loaded / progress.total : 0;
              setStatus(ctx, {
                stage: 'downloading',
                downloadProgress: dlProgress,
                downloadedBytes: progress.loaded,
                totalBytes: progress.total,
                speedBps: speedEstimator.bytesPerSecond,
                etaSeconds: speedEstimator.etaSeconds,
              });
            }
            break;
          case 'processing':
            setStatus(ctx, {
              stage: 'processing',
              processingProgress: progress.progress ?? 0,
            });
            break;
        }
      };

      try {
        const result = await bgRemoverClient.run(
          {
            modelId,
            onnxFile,
            imageData: {
              data: imageData.data.buffer,
              width: imageData.width,
              height: imageData.height,
            },
            context: { frameId, layerId },
          },
          { timeoutMs: 0, onProgress, signal }
        );

        const elapsedMs = performance.now() - inferenceStart;

        const targetFrame = ctx.state.frames.byId[frameId];
        if (!targetFrame) {
          actions.setInteraction({ hud: { message: 'Background removed, but target canvas was closed', type: 'info' } });
          setStatus(ctx, { stage: 'idle', context: null });
          return;
        }

        const targetLayer = targetFrame.layers.byId[layerId];
        if (!targetLayer) {
          actions.setInteraction({ hud: { message: 'Background removed, but target layer was deleted', type: 'info' } });
          setStatus(ctx, { stage: 'idle', context: null });
          return;
        }

        if (result.rings.length === 0) {
          actions.setInteraction({ hud: { message: 'No subject detected in this image', type: 'info' } });
          setStatus(ctx, { stage: 'idle', context: null });
          return;
        }

        const localRings = result.rings.map(ring => ring.map(p => asLocalPoint({ x: p.x, y: p.y })));
        const bounds = asLocalRect(ctx.geometry.polygon.computePolygonBounds(localRings));
        const polygon = asLocalPolygon(localRings, bounds, true);
        actions.setClipBox(frameId, 'wand', polygon);

        actions.updateFrame(frameId, { latestClipTool: 'wand' });
        if (ctx.state.interaction.interactionMode !== 'clip') {
          actions.setInteraction({ interactionMode: 'clip' });
        }

        const vertexCount = result.rings.reduce((sum, ring) => sum + ring.length, 0);

        setStatus(ctx, {
          stage: 'done',
          processingProgress: 1,
          context: { frameId, layerId },
          elapsedMs,
          resultInfo: result.debug ? {
            deviceUsed: result.debug.deviceUsed,
            inferenceMs: result.debug.inferenceMs,
            postProcessMs: result.debug.postProcessMs,
            totalMs: result.debug.totalMs,
            vertexCount,
          } : null,
          resultPolygon: polygon,
          resultFrameId: frameId,
        });

        // NOTE: No auto-reset timer here — the result stays visible in the panel
        // until the user clicks "Clear" or runs a new inference. This allows
        // re-applying the clip by clicking the result item.

        actions.setInteraction({
          hud: { message: `✨ Background removed — foreground mask applied (${result.debug?.totalMs?.toFixed(0) ?? '?'}ms)`, type: 'success' },
        });

        if (result.debug) {
          console.log(`[BgRemover] ${result.debug.deviceUsed} | inference: ${result.debug.inferenceMs.toFixed(0)}ms | post: ${result.debug.postProcessMs.toFixed(0)}ms | total: ${result.debug.totalMs.toFixed(0)}ms`);
        }

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        if (msg.includes('Aborted')) {
          setStatus(ctx, { stage: 'idle', errorMessage: null, context: null });
        } else {
          setStatus(ctx, { stage: 'error', errorMessage: msg, context: null });
          actions.setInteraction({
            hud: {
              message: msg.includes('timed out')
                ? 'Background removal timed out — please try again'
                : 'Background removal failed — see error details in panel',
              type: 'error',
            },
          });
        }
      } finally {
        activeAbortController = null;
        ctx.scoped!.setBusy(false);
      }
    },
  } as EditorCommand<void, Promise<void>>,

  downloadModel: {
    id: CMD_DOWNLOAD_MODEL,
    name: 'Download AI Model',
    execute: async (ctx: EditorContextValue) => {
      const activeModelEntry = getActiveModelEntry(ctx);
      const modelId = activeModelEntry.modelId;
      const onnxFile = activeModelEntry.onnxFile;

      ctx.scoped!.setBusy(true);

      setStatus(ctx, {
        stage: 'loading',
        device: null,
        downloadProgress: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        speedBps: 0,
        etaSeconds: 0,
        processingProgress: 0,
        errorMessage: null,
        context: null,
        elapsedMs: 0,
      });

      activeAbortController = new AbortController();
      const { signal } = activeAbortController;

      const speedEstimator = new SpeedEstimator();
      const start = performance.now();

      const onProgress = (progress: BgRemoverProgress) => {
        switch (progress.stage) {
          case 'detecting-device':
            if (progress.device) {
              setStatus(ctx, { device: progress.device });
            }
            break;
          case 'loading':
            setStatus(ctx, { stage: 'loading' });
            break;
          case 'downloading':
            if (progress.loaded != null && progress.total != null) {
              speedEstimator.update(progress.loaded, progress.total);
              const dlProgress = progress.total > 0 ? progress.loaded / progress.total : 0;
              setStatus(ctx, {
                stage: 'downloading',
                downloadProgress: dlProgress,
                downloadedBytes: progress.loaded,
                totalBytes: progress.total,
                speedBps: speedEstimator.bytesPerSecond,
                etaSeconds: speedEstimator.etaSeconds,
              });
            }
            break;
        }
      };

      try {
        await bgRemoverClient.run(
          {
            action: 'download',
            modelId,
            onnxFile,
          },
          { timeoutMs: 0, onProgress, signal }
        );

        const elapsedMs = performance.now() - start;

        setStatus(ctx, {
          stage: 'done',
          processingProgress: 0,
          context: null,
          elapsedMs,
        });

        const pluginUid = `${PLUGIN_AUTHOR}.${PLUGIN_ID}`;
        const config = ctx.state.pluginConfig[pluginUid] as unknown as BgRemoverConfig | undefined;
        const models = config?.models || BUILTIN_MODELS;
        const activeModel = models.find(m => m.modelId === modelId) || models[0];
        ctx.actions.setInteraction({
          hud: {
            message: `✨ Model downloaded successfully: ${activeModel?.name || modelId}`,
            type: 'success',
          },
        });

        setTimeout(() => {
          const current = ctx.scoped!.getSignal<BgRemoverStatus>(SIGNAL_STATUS, INITIAL_STATUS);
          if (current?.stage === 'done') {
            setStatus(ctx, { ...INITIAL_STATUS });
          }
        }, DONE_DISPLAY_MS);

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        if (msg.includes('Aborted')) {
          setStatus(ctx, { stage: 'idle', errorMessage: null, context: null });
        } else {
          setStatus(ctx, { stage: 'error', errorMessage: msg, context: null });
          ctx.actions.setInteraction({
            hud: {
              message: msg.includes('timed out')
                ? 'Model download timed out — please try again'
                : 'Model download failed — see error details in panel',
              type: 'error',
            },
          });
        }
      } finally {
        activeAbortController = null;
        ctx.scoped!.setBusy(false);
      }
    },
  } as EditorCommand<void, Promise<void>>,

  abort: {
    id: CMD_ABORT,
    name: 'Cancel Background Removal',
    execute: async (ctx: EditorContextValue) => {
      const modelId = getActiveModelId(ctx);

      if (activeAbortController) {
        activeAbortController.abort();
        activeAbortController = null;
      }

      bgRemoverClient.dispose();

      setStatus(ctx, { ...INITIAL_STATUS });

      ctx.actions.setInteraction({ hud: { message: 'Background removal cancelled', type: 'info' } });

      try {
        const cacheNames = await caches.keys();
        const hfCaches = cacheNames.filter(
          n => n.includes('transformers') || n.includes('onnx') || n.includes('huggingface')
        );
        for (const cacheName of hfCaches) {
          const cache = await caches.open(cacheName);
          const keys = await cache.keys();
          for (const req of keys) {
            const url = req.url;
            const matchesModel = url.includes(modelId) || url.includes(modelId.replace('/', '%2F'));
            if (matchesModel) {
              await cache.delete(req);
            }
          }
        }
      } catch {
        // Cache cleanup is best-effort
      }
    },
  } as EditorCommand<void, Promise<void>>,

  openSettings: {
    id: CMD_OPEN_SETTINGS,
    name: 'Open BG Remover Settings',
    execute: (ctx: EditorContextValue) => {
      ctx.actions.setStateSignal(SettingsPanelAPI.signals.tab, 'AI Tools');
      ctx.actions.setStateSignal(SettingsPanelAPI.signals.open, true);
    },
  } as EditorCommand<void, void>,
};
