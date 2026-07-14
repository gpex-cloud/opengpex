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
import { segClient } from './client';
import { PLUGIN_AUTHOR, PLUGIN_ID } from '../protocols';
import type { AIToolsConfig } from '../protocols';
import type { SegEncodePayload, SegEncodeResult, SegDecodePayload, SegDecodeResult, SegConfig, SegStatus } from './protocols';
import {
  SIGNAL_SEG_STATUS,
  INITIAL_SEG_STATUS,
  BUILTIN_SEG_MODELS,
  CMD_SEG_ENCODE,
  CMD_SEG_DECODE,
  CMD_SEG_ALL,
} from './protocols';

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
  const pluginUid = `${PLUGIN_AUTHOR}.${PLUGIN_ID}`;
  const config = ctx.state.pluginConfig[pluginUid] as unknown as AIToolsConfig | undefined;
  const segConfig = config?.seg as SegConfig | undefined;
  if (!segConfig) return BUILTIN_SEG_MODELS[0].modelId;

  const activeId = segConfig.activeModelId;
  const fromConfig = segConfig.models?.find(m => m.id === activeId);
  if (fromConfig) return fromConfig.modelId;

  const fromBuiltins = BUILTIN_SEG_MODELS.find(m => m.id === activeId);
  if (fromBuiltins) return fromBuiltins.modelId;

  return BUILTIN_SEG_MODELS[0].modelId;
}

/**
 * Helper: Update the Segmentation status signal.
 */
function setSegStatus(ctx: EditorContextValue, patch: Partial<SegStatus>): void {
  const current = (ctx.scoped!.getSignal<SegStatus>(SIGNAL_SEG_STATUS, INITIAL_SEG_STATUS)) ?? INITIAL_SEG_STATUS;
  ctx.scoped!.setSignal(SIGNAL_SEG_STATUS, { ...current, ...patch });
}

/**
 * Translate opaque ONNX/WASM errors into user-friendly messages.
 */
function humanizeSegError(raw: string): string {
  const stripped = raw.replace(/^Segmentation worker error:\s*/i, '').trim();

  if (/^\d+$/.test(stripped)) {
    return 'Segmentation model failed to initialize. Try deleting and re-downloading the model, or switch to a different model.';
  }
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
  return raw;
}

export const SEG_COMMANDS = {
  /**
   * segEncode — Encode a layer image into SAM embedding.
   */
  segEncode: {
    id: CMD_SEG_ENCODE,
    name: 'SAM Encode Image',
    execute: async (ctx: EditorContextValue, payload: SegEncodePayload): Promise<SegEncodeResult> => {
      const { imageData, context } = payload;
      const modelId = getActiveSegModelId(ctx);

      if (currentEmbeddingAssetId === context.assetId) {
        return { success: true };
      }

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
              setSegStatus(ctx, {
                stage: 'encoding',
                encodeProgress: p.progress ?? 0,
              });
            }
          },
        });

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
   */
  segDecode: {
    id: CMD_SEG_DECODE,
    name: 'SAM Decode Prompts',
    execute: async (ctx: EditorContextValue, payload: SegDecodePayload): Promise<SegDecodeResult> => {
      const { prompts, context } = payload;
      const modelId = getActiveSegModelId(ctx);

      if (currentEmbeddingAssetId !== context.assetId) {
        return {
          success: false,
          error: `No embedding cached for asset "${context.assetId}". Call segEncode first.`,
        };
      }

      setSegStatus(ctx, { stage: 'decoding' });

      try {
        const result = await segClient.run({
          action: 'decode',
          modelId,
          prompts,
          context,
        });

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
   */
  segAll: {
    id: CMD_SEG_ALL,
    name: 'Auto Segment',
    execute: async (ctx: EditorContextValue): Promise<void> => {
      const { activeFrame, activeLayer, actions } = ctx;

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

      ctx.scoped!.setBusy(true);

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

        // Run segment-all on the worker
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

        // Process results
        const segments = result.segments ?? [];
        if (segments.length === 0) {
          setSegStatus(ctx, { ...INITIAL_SEG_STATUS, embeddingReady: true, embeddingAssetId: assetId });
          actions.setInteraction({ hud: { message: 'No objects detected in this image', type: 'info' } });
          ctx.scoped!.setBusy(false);
          return;
        }

        const candidates = segments.map(s => ({ rings: s.rings, score: s.score }));

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

        setSegStatus(ctx, {
          stage: 'ready',
          candidates,
          activeCandidateIdx: 0,
          embeddingReady: true,
          embeddingAssetId: assetId,
          lastDecodeMs: result.debug?.totalMs ?? 0,
          elapsedMs: result.debug?.totalMs ?? 0,
        });

        const segStatusSignalKey = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SIGNAL_SEG_STATUS}`;
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

        if (ctx.state.interaction.interactionMode !== 'clip') {
          actions.setInteraction({ interactionMode: 'clip' });
        }
        actions.updateFrame(frameId, { latestClipTool: 'sam' });

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
