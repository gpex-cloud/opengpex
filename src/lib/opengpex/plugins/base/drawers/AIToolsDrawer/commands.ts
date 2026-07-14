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
import { SettingsPanelAPI } from '../../panels/SettingsPanel/protocols';
import { bgRemoverClient } from './worker/client';
import { segClient } from './worker/seg-client';
import { SpeedEstimator } from './hooks';
import type { BgRemoverProgress } from './worker/protocol';
import type { BgRemoverStatus, BgRemoverConfig, SegEncodePayload, SegEncodeResult, SegDecodePayload, SegDecodeResult, SegConfig } from './protocols';
import * as P from './protocols';

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
  const current = (ctx.scoped!.getSignal<BgRemoverStatus>(P.SIGNAL_STATUS, P.INITIAL_STATUS)) ?? P.INITIAL_STATUS;
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
  const config = ctx.state.pluginConfig[pluginUid] as unknown as BgRemoverConfig | undefined;
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

      // Get ImageData from the global source-bitmap cache (SBC).
      // The bitmap is expected to be already resident because the layer
      // is currently rendered on screen; if not, we surface the same
      // "not loaded yet" HUD the legacy imageCache path used to show.
      let imageData: ImageData;
      try {
        const cachedBitmap = sourceBitmapCache.get(imageSource);
        if (!cachedBitmap) {
          // Kick a load so the bitmap is available on retry.
          sourceBitmapCache.getOrFetch(imageSource);
          actions.setInteraction({ hud: { message: 'Image not loaded yet', type: 'error' } });
          return;
        }
        // Draw to OffscreenCanvas to get ImageData
        const canvas = new OffscreenCanvas(cachedBitmap.width, cachedBitmap.height);
        const ctx2d = canvas.getContext('2d')!;
        ctx2d.drawImage(cachedBitmap, 0, 0);
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
        // Run inference (no timeout — model download can take several minutes)
        const result = await bgRemoverClient.run(
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
        const bounds = asLocalRect(ctx.geometry.polygon.computePolygonBounds(localRings));
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
          const current = ctx.scoped!.getSignal<BgRemoverStatus>(P.SIGNAL_STATUS, P.INITIAL_STATUS);
          // Only reset if still in 'done' state (avoid clobbering a new inference)
          if (current?.stage === 'done') {
            setStatus(ctx, { ...P.INITIAL_STATUS });
          }
        }, DONE_DISPLAY_MS);

        // Log performance
        if (result.debug) {
          console.log(`[BgRemover] ${result.debug.deviceUsed} | inference: ${result.debug.inferenceMs.toFixed(0)}ms | post: ${result.debug.postProcessMs.toFixed(0)}ms | total: ${result.debug.totalMs.toFixed(0)}ms`);
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
   * downloadModel — Pre-download the active model to the local cache.
   */
  downloadModel: {
    id: P.CMD_DOWNLOAD_MODEL,
    name: 'Download AI Model',
    execute: async (ctx: EditorContextValue) => {
      const modelId = getActiveModelId(ctx);

      // Mark plugin as busy (triggers DrawerBar icon animation)
      ctx.scoped!.setBusy(true);

      // Initialize status — start with 'loading' since model load happens first.
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

      // Create AbortController for this request
      activeAbortController = new AbortController();
      const { signal } = activeAbortController;

      // Speed estimator for download progress
      const speedEstimator = new SpeedEstimator();
      const start = performance.now();

      // Progress handler
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
        // Run download (no timeout — model download can take several minutes)
        await bgRemoverClient.run(
          {
            action: 'download',
            modelId,
          },
          { timeoutMs: 0, onProgress, signal }
        );

        const elapsedMs = performance.now() - start;

        // Update status to done
        setStatus(ctx, {
          stage: 'done',
          processingProgress: 0,
          context: null,
          elapsedMs,
        });

        // Notify user
        const pluginUid = `${P.PLUGIN_AUTHOR}.${P.PLUGIN_ID}`;
        const config = ctx.state.pluginConfig[pluginUid] as unknown as BgRemoverConfig | undefined;
        const models = config?.models || P.BUILTIN_MODELS;
        const activeModel = models.find(m => m.modelId === modelId) || models[0];
        ctx.actions.setInteraction({
          hud: {
            message: `✨ Model downloaded successfully: ${activeModel?.name || modelId}`,
            type: 'success',
          },
        });

        // Auto-reset to idle after a brief display period
        setTimeout(() => {
          const current = ctx.scoped!.getSignal<BgRemoverStatus>(P.SIGNAL_STATUS, P.INITIAL_STATUS);
          // Only reset if still in 'done' state
          if (current?.stage === 'done') {
            setStatus(ctx, { ...P.INITIAL_STATUS });
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
      bgRemoverClient.dispose();

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
      ctx.actions.setStateSignal(SettingsPanelAPI.signals.tab, 'AI Tools');
      ctx.actions.setStateSignal(SettingsPanelAPI.signals.open, true);
    },
  } as EditorCommand<void, void>,
};

// ─── Segmentation Commands ──────────────────────────────────────────────────────
//
// These commands wrap the segClient (SAM Worker) and expose encode/decode as
// cross-plugin callable async commands via the AIToolsDrawerAPI facade.
// They own the Worker interaction and embedding cache state so that external
// consumers (e.g. ClipOverlay/sam.ts) only depend on protocols.ts types.

/**
 * Track which asset currently has a warm embedding in the Worker.
 * Avoids redundant re-encode when clicking the same layer multiple times.
 */
let currentEmbeddingAssetId: string | null = null;

/**
 * Helper: Get the active segmentation model ID from plugin config.
 */
function getActiveSegModelId(ctx: EditorContextValue): string {
  const pluginUid = `${P.PLUGIN_AUTHOR}.${P.PLUGIN_ID}`;
  const config = ctx.state.pluginConfig[pluginUid] as unknown as P.AIToolsConfig | undefined;
  const segConfig = config?.seg as SegConfig | undefined;
  if (!segConfig) return P.BUILTIN_SEG_MODELS[0].modelId;

  const activeId = segConfig.activeModelId;
  const fromConfig = segConfig.models?.find(m => m.id === activeId);
  if (fromConfig) return fromConfig.modelId;

  const fromBuiltins = P.BUILTIN_SEG_MODELS.find(m => m.id === activeId);
  if (fromBuiltins) return fromBuiltins.modelId;

  return P.BUILTIN_SEG_MODELS[0].modelId;
}

/**
 * Helper: Update the Segmentation status signal.
 */
function setSegStatus(ctx: EditorContextValue, patch: Partial<P.SegStatus>): void {
  const current = (ctx.scoped!.getSignal<P.SegStatus>(P.SIGNAL_SEG_STATUS, P.INITIAL_SEG_STATUS)) ?? P.INITIAL_SEG_STATUS;
  ctx.scoped!.setSignal(P.SIGNAL_SEG_STATUS, { ...current, ...patch });
}

/**
 * Translate opaque ONNX/WASM errors into user-friendly messages.
 * The ONNX runtime sometimes throws raw numeric error codes (WASM addresses)
 * or cryptic internal messages that are meaningless to end users.
 */
function humanizeSegError(raw: string): string {
  // Strip "Segmentation worker error: " prefix if present (from seg-client.ts)
  const stripped = raw.replace(/^Segmentation worker error:\s*/i, '').trim();

  // Pure numeric (WASM address / ORT error code) — ONNX runtime crash
  if (/^\d+$/.test(stripped)) {
    return 'Segmentation model failed to initialize. Try deleting and re-downloading the model, or switch to a different model.';
  }
  // Common ORT/WebGPU failures
  if (raw.includes('Could not find') || raw.includes('no such file') || raw.includes('404')) {
    return 'Segmentation model not found. Please download the model first.';
  }
  if (raw.includes('out of memory') || raw.includes('OOM')) {
    return 'Out of memory. Try a smaller model or close other tabs.';
  }
  if (raw.includes('network') || raw.includes('fetch')) {
    return 'Network error while loading model. Check your internet connection.';
  }
  if (raw.includes('worker crashed')) {
    return 'Segmentation engine crashed. Please try again.';
  }
  // Default: return the raw message
  return raw;
}

export const SEG_COMMANDS = {
  /**
   * segEncode — Encode a layer image into SAM embedding.
   *
   * Manages the embedding cache: if the requested assetId already has a warm
   * embedding, skips re-encoding. On success, the Worker retains the embedding
   * in memory for instant subsequent decode calls.
   *
   * Returns: SegEncodeResult { success, error? }
   */
  segEncode: {
    id: P.CMD_SEG_ENCODE,
    name: 'SAM Encode Image',
    execute: async (ctx: EditorContextValue, payload: SegEncodePayload): Promise<SegEncodeResult> => {
      const { imageData, context } = payload;
      const modelId = getActiveSegModelId(ctx);

      // Check if embedding is already warm for this asset
      if (currentEmbeddingAssetId === context.assetId) {
        return { success: true };
      }

      // Update status to encoding
      setSegStatus(ctx, {
        stage: 'encoding',
        encodeProgress: 0,
        errorMessage: null,
        embeddingAssetId: null,
        embeddingReady: false,
      });

      try {
        await segClient.run({
          action: 'encode',
          modelId,
          imageData: {
            data: imageData.data,
            width: imageData.width,
            height: imageData.height,
          },
          context,
        }, {
          timeoutMs: 0, // No timeout for first-time model download + encode
          onProgress: (p) => {
            if (p.stage === 'downloading') {
              setSegStatus(ctx, {
                stage: 'downloading',
                downloadProgress: (p.loaded && p.total) ? p.loaded / p.total : 0,
                downloadedBytes: p.loaded ?? 0,
                totalBytes: p.total ?? 0,
                downloadFile: p.file ?? null,
              });
              if (p.device) setSegStatus(ctx, { device: p.device });
            } else if (p.stage === 'detecting-device' && p.device) {
              setSegStatus(ctx, { device: p.device });
            } else if (p.stage === 'encoding') {
              setSegStatus(ctx, {
                stage: 'encoding',
                encodeProgress: p.progress ?? 0,
              });
            }
          },
        });

        // Mark embedding as ready
        currentEmbeddingAssetId = context.assetId;
        setSegStatus(ctx, {
          stage: 'ready',
          embeddingReady: true,
          embeddingAssetId: context.assetId,
          encodeProgress: 1,
        });

        return { success: true };
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const msg = humanizeSegError(raw);
        currentEmbeddingAssetId = null;
        setSegStatus(ctx, {
          stage: 'error',
          errorMessage: msg,
          embeddingReady: false,
          embeddingAssetId: null,
        });
        return { success: false, error: msg };
      }
    },
  } as EditorCommand<SegEncodePayload, Promise<SegEncodeResult>>,

  /**
   * segDecode — Decode prompts against the cached embedding.
   *
   * Requires a prior successful encode for the same assetId.
   * Returns up to 3 candidate masks sorted by confidence score.
   *
   * Returns: SegDecodeResult { success, masks?, debug?, error? }
   */
  segDecode: {
    id: P.CMD_SEG_DECODE,
    name: 'SAM Decode Prompts',
    execute: async (ctx: EditorContextValue, payload: SegDecodePayload): Promise<SegDecodeResult> => {
      const { prompts, context } = payload;
      const modelId = getActiveSegModelId(ctx);

      // Guard: embedding must be ready for the requested asset
      if (currentEmbeddingAssetId !== context.assetId) {
        return {
          success: false,
          error: `No embedding cached for asset "${context.assetId}". Call segEncode first.`,
        };
      }

      // Update status to decoding
      setSegStatus(ctx, { stage: 'decoding' });

      try {
        const result = await segClient.run({
          action: 'decode',
          modelId,
          prompts,
          context,
        });

        // Update status back to ready
        setSegStatus(ctx, {
          stage: 'ready',
          candidates: result.masks ?? [],
          lastDecodeMs: result.debug?.decodeMs ?? 0,
          elapsedMs: result.debug?.totalMs ?? 0,
        });

        return {
          success: true,
          masks: result.masks,
          debug: result.debug,
        };
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const msg = humanizeSegError(raw);
        setSegStatus(ctx, { stage: 'error', errorMessage: msg });
        return { success: false, error: msg };
      }
    },
  } as EditorCommand<SegDecodePayload, Promise<SegDecodeResult>>,

  /**
   * segAll — Segment All Objects.
   *
   * Full pipeline: extracts active layer's pixels → ensures embedding is cached
   * → runs segment-all (8×8 grid + NMS) on the Worker → stores results as
   * candidates in the seg status signal. Enters clip+SAM mode with the best
   * segment written to clipBox.
   */
  segAll: {
    id: P.CMD_SEG_ALL,
    name: 'Auto Segment',
    execute: async (ctx: EditorContextValue): Promise<void> => {
      const { activeFrame, activeLayer, actions } = ctx;

      // Guard: require active frame + image layer
      if (!activeFrame || !activeLayer) {
        actions.setInteraction({ hud: { message: 'No active image layer', type: 'error' } });
        return;
      }
      if (activeLayer.type !== 'image') {
        actions.setInteraction({ hud: { message: 'Segment All only works on image layers', type: 'error' } });
        return;
      }

      const frameId = activeFrame.id;
      const layerId = activeLayer.id;
      const assetId = activeLayer.src ?? `layer_${layerId}`;
      const modelId = getActiveSegModelId(ctx);

      // Extract image data from the global source-bitmap cache
      let imageData: ImageData;
      try {
        const cachedBitmap = sourceBitmapCache.get(activeLayer.src!);
        if (!cachedBitmap) {
          sourceBitmapCache.getOrFetch(activeLayer.src!);
          actions.setInteraction({ hud: { message: 'Image not loaded yet — please try again', type: 'error' } });
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

      // Mark busy
      ctx.scoped!.setBusy(true);

      // Step 1: Ensure embedding is encoded
      setSegStatus(ctx, {
        stage: 'encoding',
        encodeProgress: 0,
        errorMessage: null,
        embeddingReady: false,
      });

      try {
        // Encode (skips if already warm for this asset)
        if (currentEmbeddingAssetId !== assetId) {
          await segClient.run({
            action: 'encode',
            modelId,
            imageData: {
              data: imageData.data.buffer,
              width: imageData.width,
              height: imageData.height,
            },
            context: { frameId, layerId, assetId },
          }, {
            timeoutMs: 0,
            onProgress: (p) => {
              if (p.stage === 'downloading') {
                setSegStatus(ctx, {
                  stage: 'downloading',
                  downloadProgress: (p.loaded && p.total) ? p.loaded / p.total : 0,
                  downloadedBytes: p.loaded ?? 0,
                  totalBytes: p.total ?? 0,
                  downloadFile: p.file ?? null,
                });
                if (p.device) setSegStatus(ctx, { device: p.device });
              } else if (p.stage === 'detecting-device' && p.device) {
                setSegStatus(ctx, { device: p.device });
              } else if (p.stage === 'encoding') {
                setSegStatus(ctx, { stage: 'encoding', encodeProgress: p.progress ?? 0 });
              }
            },
          });
          currentEmbeddingAssetId = assetId;
        }

        // Step 2: Run segment-all on the worker
        setSegStatus(ctx, { stage: 'decoding', embeddingReady: true, embeddingAssetId: assetId });

        const result = await segClient.run({
          action: 'segment-all',
          modelId,
          context: { frameId, layerId, assetId },
        }, {
          timeoutMs: 0,
          onProgress: (p) => {
            if (p.stage === 'decoding') {
              setSegStatus(ctx, { stage: 'decoding' });
            }
          },
        });

        // Step 3: Process results
        const segments = result.segments ?? [];
        if (segments.length === 0) {
          setSegStatus(ctx, { ...P.INITIAL_SEG_STATUS, embeddingReady: true, embeddingAssetId: assetId });
          actions.setInteraction({ hud: { message: 'No objects detected in this image', type: 'info' } });
          ctx.scoped!.setBusy(false);
          return;
        }

        // Convert segments to candidates format (reuse the candidates UI)
        const candidates = segments.map(s => ({ rings: s.rings, score: s.score }));

        // Project ALL candidate polygons to frame-local coordinates.
        // This allows the panel's handleSelectCandidate to switch clip boxes.
        const framePolygons: Array<ReturnType<typeof asLocalPolygon>> = [];
        for (const candidate of candidates) {
          const layerRings = candidate.rings.map(ring =>
            ring.map(p => asLocalPoint({ x: p.x, y: p.y }))
          );
          const layerBounds = asLocalRect(ctx.geometry.polygon.computePolygonBounds(layerRings));
          const layerPoly = asLocalPolygon(layerRings, layerBounds, true);
          const framePoly = ctx.geometry.polygon.layerLocalToFrameLocal(
            layerPoly, activeLayer!, activeFrame!
          );
          framePolygons.push(framePoly);
        }

        // Store in signal with candidateFramePolygons + samFrameId
        // (same shape as sam.ts click handler writes, so panel switching works)
        setSegStatus(ctx, {
          stage: 'ready',
          candidates,
          activeCandidateIdx: 0,
          embeddingReady: true,
          embeddingAssetId: assetId,
          lastDecodeMs: result.debug?.totalMs ?? 0,
          elapsedMs: result.debug?.totalMs ?? 0,
        });
        // Write candidateFramePolygons via global signal (same path as sam.ts)
        const segStatusSignalKey = `${P.PLUGIN_AUTHOR}.${P.PLUGIN_ID}.${P.SIGNAL_SEG_STATUS}`;
        actions.setStateSignal(segStatusSignalKey, {
          stage: 'ready',
          embeddingReady: true,
          candidates,
          candidateFramePolygons: framePolygons,
          samFrameId: frameId,
          activeCandidateIdx: 0,
          lastDecodeMs: result.debug?.totalMs ?? 0,
          elapsedMs: result.debug?.totalMs ?? 0,
        });

        // Enter clip+SAM mode and write the best segment to clipBox
        if (ctx.state.interaction.interactionMode !== 'clip') {
          actions.setInteraction({ interactionMode: 'clip' });
        }
        actions.updateFrame(frameId, { latestClipTool: 'sam' });

        // Write first candidate frame polygon to clipBox
        if (framePolygons.length > 0) {
          actions.setClipBox(frameId, 'sam', framePolygons[0]);
        }

        actions.setInteraction({
          hud: { message: `✨ Found ${segments.length} object${segments.length > 1 ? 's' : ''} — click candidates in panel to switch`, type: 'success' },
        });

        console.log(`[SegAll] ${segments.length} objects detected in ${result.debug?.totalMs?.toFixed(0) ?? '?'}ms (${result.debug?.deviceUsed ?? 'unknown'})`);

      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const msg = humanizeSegError(raw);
        setSegStatus(ctx, { stage: 'error', errorMessage: msg });
        actions.setInteraction({ hud: { message: 'Segment All failed — see error in panel', type: 'error' } });
      } finally {
        ctx.scoped!.setBusy(false);
      }
    },
  } as EditorCommand<void, Promise<void>>,
};
