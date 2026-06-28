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
import { computePolygonBounds } from '@opengpex/editor/core/geometry/operators/polygon';
import { imageCache } from '@opengpex/editor/core/engine/cache/ImageCache';
import { SettingsPanelAPI } from '../../panels/SettingsPanel/protocols';
import { bgRemovalClient } from './worker/client';
import { SpeedEstimator } from './hooks';
import type { BgRemovalProgress } from './worker/protocol';
import type { BgRemovalStatus, BgRemovalConfig } from './protocols';
import * as P from './protocols';

/** Auto-reset delay: how long to show "done" state before resetting to idle (ms) */
const DONE_DISPLAY_MS = 3000;

/**
 * Module-level AbortController for the current in-flight inference request.
 * Set before calling bgRemovalClient.run(), cleared on completion/abort.
 * Allows the abort command to cancel a long-running download or inference.
 */
let activeAbortController: AbortController | null = null;

/**
 * Helper: Update the BgRemoval status signal.
 */
function setStatus(ctx: EditorContextValue, patch: Partial<BgRemovalStatus>): void {
  const current = (ctx.scoped!.getSignal<BgRemovalStatus>(P.SIGNAL_STATUS, P.INITIAL_STATUS)) ?? P.INITIAL_STATUS;
  ctx.scoped!.setSignal(P.SIGNAL_STATUS, { ...current, ...patch });
}

/**
 * Helper: Get the active model ID from plugin config.
 *
 * Uses a two-phase lookup to handle migration scenarios where a built-in model
 * was added in a newer version but doesn't exist in the persisted config.models:
 *   1. Search the user's persisted models list (config.models)
 *   2. If not found, also search BUILTIN_MODELS (handles migration/newly-added builtins)
 *   3. Final fallback: first BUILTIN_MODELS entry
 */
function getActiveModelId(ctx: EditorContextValue): string {
  const pluginUid = `${P.PLUGIN_AUTHOR}.${P.PLUGIN_ID}`;
  const config = ctx.state.pluginConfig[pluginUid] as unknown as BgRemovalConfig | undefined;
  if (!config) return P.BUILTIN_MODELS[0].modelId;

  const activeId = config.activeModelId;

  // Phase 1: Check persisted models list
  const fromConfig = config.models?.find(m => m.id === activeId);
  if (fromConfig) return fromConfig.modelId;

  // Phase 2: Check built-in models (handles migration where config.models is stale)
  const fromBuiltins = P.BUILTIN_MODELS.find(m => m.id === activeId);
  if (fromBuiltins) return fromBuiltins.modelId;

  // Phase 3: Final fallback
  return P.BUILTIN_MODELS[0].modelId;
}

/**
 * BG_REMOVAL_COMMANDS: Declarative command configurations.
 */
export const BG_REMOVAL_COMMANDS = {
  /**
   * removeBg — One-click background removal.
   *
   * Extracts the active image layer's pixel data, sends it to the BgRemoval
   * Worker for AI inference, and writes the resulting polygon selection into
   * `clipBoxes['bg-removal']` on the target frame.
   *
   * Per spec §3.5: The request carries a context snapshot (frameId, layerId)
   * so that result validation works even if the user switches context mid-inference.
   */
  removeBg: {
    id: P.CMD_REMOVE_BG,
    name: 'AI Remove Background',
    execute: async (ctx: EditorContextValue) => {
      const { activeFrame, activeLayer, actions } = ctx;

      // Guard: require active frame + image layer
      if (!activeFrame || !activeLayer) {
        actions.setInteraction({ hud: { message: 'No active image layer', type: 'error' } });
        return;
      }

      if (activeLayer.type !== 'image') {
        actions.setInteraction({ hud: { message: 'AI background removal only works on image layers', type: 'error' } });
        return;
      }

      // Snapshot context for post-inference validation
      const frameId = activeFrame.id;
      const layerId = activeLayer.id;

      // Get active model from config
      const modelId = getActiveModelId(ctx);

      // Extract image data from the layer source
      const imageSource = activeLayer.src;
      if (!imageSource) {
        actions.setInteraction({ hud: { message: 'Layer has no image source', type: 'error' } });
        return;
      }

      // Get ImageData from the global image cache
      let imageData: ImageData;
      try {
        const cachedImage = imageCache.get(imageSource);
        if (!cachedImage) {
          actions.setInteraction({ hud: { message: 'Image not loaded yet', type: 'error' } });
          return;
        }
        // Draw to OffscreenCanvas to get ImageData
        const canvas = new OffscreenCanvas(cachedImage.width, cachedImage.height);
        const ctx2d = canvas.getContext('2d')!;
        ctx2d.drawImage(cachedImage, 0, 0);
        imageData = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
      } catch (_err) {
        actions.setInteraction({ hud: { message: 'Failed to read image data', type: 'error' } });
        return;
      }

      // Mark plugin as busy (triggers DrawerBar icon animation)
      ctx.scoped!.setBusy(true);

      // Initialize status — start with 'loading' since model load happens first.
      // This prevents the text flash: "Processing..." → "Loading..." → "Processing..."
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

      // Create AbortController for this request
      activeAbortController = new AbortController();
      const { signal } = activeAbortController;

      // Speed estimator for download progress
      const speedEstimator = new SpeedEstimator();
      const inferenceStart = performance.now();

      // Progress handler — directly maps Worker stages to UI status.
      // No debounce needed: Worker correctly distinguishes 'loading' (cache read)
      // from 'downloading' (genuine network fetch).
      const onProgress = (progress: BgRemovalProgress) => {
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
        // Run inference (no timeout — model download can take several minutes)
        const result = await bgRemovalClient.run(
          {
            modelId,
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

        // Post-inference validation (per spec §3.5)
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

        // Check if we got valid contours
        if (result.rings.length === 0) {
          actions.setInteraction({ hud: { message: 'No subject detected in this image', type: 'info' } });
          setStatus(ctx, { stage: 'idle', context: null });
          return;
        }

        // Write the polygon selection to clipBoxes['bg-removal']
        // Map raw {x,y} to branded LocalPoint, compute bounds, wrap as LocalPolygon
        const localRings = result.rings.map(ring => ring.map(p => asLocalPoint({ x: p.x, y: p.y })));
        const bounds = asLocalRect(computePolygonBounds(localRings));
        const polygon = asLocalPolygon(localRings, bounds, true);
        actions.setClipBox(frameId, 'wand', polygon);

        // Activate the wand tool so the overlay renders the selection,
        // and enter clip mode so the selection is visible.
        actions.updateFrame(frameId, { latestClipTool: 'wand' });
        if (ctx.state.interaction.interactionMode !== 'clip') {
          actions.setInteraction({ interactionMode: 'clip' });
        }

        // Update status to done (keep progress visible with elapsed time)
        setStatus(ctx, {
          stage: 'done',
          processingProgress: 1,
          context: { frameId, layerId },
          elapsedMs,
        });

        // Notify user
        if (ctx.activeFrame?.id !== frameId) {
          actions.setInteraction({ hud: { message: '✨ Background removal complete! Switch back to see the result.', type: 'success' } });
        } else {
          actions.setInteraction({ hud: { message: '✨ Background removed — use "Apply Mask" in clip toolbar to confirm', type: 'success' } });
        }

        // Auto-reset to idle after a brief display period
        setTimeout(() => {
          const current = ctx.scoped!.getSignal<BgRemovalStatus>(P.SIGNAL_STATUS, P.INITIAL_STATUS);
          // Only reset if still in 'done' state (avoid clobbering a new inference)
          if (current?.stage === 'done') {
            setStatus(ctx, { ...P.INITIAL_STATUS });
          }
        }, DONE_DISPLAY_MS);

        // Log performance
        if (result.debug) {
          console.log(`[BgRemoval] ${result.debug.deviceUsed} | inference: ${result.debug.inferenceMs.toFixed(0)}ms | post: ${result.debug.postProcessMs.toFixed(0)}ms | total: ${result.debug.totalMs.toFixed(0)}ms`);
        }

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        if (msg.includes('Aborted')) {
          // User-cancelled — just reset to idle, no error display needed
          setStatus(ctx, { stage: 'idle', errorMessage: null, context: null });
        } else {
          // Set error state in status signal — the drawer panel shows the full
          // technical error in a selectable, scrollable error section.
          // HUD only shows a brief user-friendly notification (not the raw error).
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
        // Clear abort controller and busy state regardless of outcome
        activeAbortController = null;
        ctx.scoped!.setBusy(false);
      }
    },
  } as EditorCommand<void, Promise<void>>,

  /**
   * abort — Cancel an in-progress download or inference.
   *
   * Aborts the AbortController (causing the run() promise to reject with AbortError)
   * and terminates the worker to stop the actual network download / ONNX inference.
   * The worker will be lazily recreated on the next invocation.
   *
   * Also cleans up partial model cache entries: when a download is interrupted
   * mid-transfer, transformers.js may have written partial/truncated blobs to
   * Cache Storage. On the next attempt, it incorrectly treats these as complete,
   * causing the pipeline to hang. We proactively purge them here.
   */
  abort: {
    id: P.CMD_ABORT,
    name: 'Cancel Background Removal',
    execute: async (ctx: EditorContextValue) => {
      // Snapshot the active model BEFORE we reset anything
      const modelId = getActiveModelId(ctx);

      // Abort the in-flight request
      if (activeAbortController) {
        activeAbortController.abort();
        activeAbortController = null;
      }

      // Terminate the worker to actually stop the download/inference
      bgRemovalClient.dispose();

      // Reset status to idle
      setStatus(ctx, { ...P.INITIAL_STATUS });

      ctx.actions.setInteraction({ hud: { message: 'Background removal cancelled', type: 'info' } });

      // Clean up partial cache entries left by the interrupted download.
      // transformers.js uses Cache Storage with names containing 'transformers'.
      // Partial .onnx blobs can be megabytes of incomplete data that will
      // confuse subsequent download attempts.
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
        // Cache cleanup is best-effort; don't surface errors to user
      }
    },
  } as EditorCommand<void, Promise<void>>,

  /**
   * openSettings — Navigate directly to the BG Removal model settings panel.
   */
  openSettings: {
    id: P.CMD_OPEN_SETTINGS,
    name: 'Open BG Removal Settings',
    execute: (ctx: EditorContextValue) => {
      ctx.actions.setStateSignal(SettingsPanelAPI.signals.tab, 'BG Remover');
      ctx.actions.setStateSignal(SettingsPanelAPI.signals.open, true);
    },
  } as EditorCommand<void, void>,
};
