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
import { segClient } from './client';
import { getActiveModelEntry } from '../_shared/useToolConfig';
import type { SegEncodePayload, SegEncodeResult, SegDecodePayload, SegDecodeResult, SegModelEntry } from './protocols';
import {
  BUILTIN_SEG_MODELS,
  DEFAULT_SEG_CONFIG,
  CMD_SEG_ENCODE,
  CMD_SEG_DECODE,
  CMD_SEG_ALL,
} from './protocols';
import { segStore } from './store';

// ─── Segmentation Commands ──────────────────────────────────────────────────────
//
// These commands wrap the segClient (SAM Worker) and expose encode/decode as
// cross-plugin callable async commands via the AIToolsDrawerAPI facade.
// They own the Worker interaction and embedding cache state so that external
// consumers (e.g. ClipOverlay/sam.ts) only depend on protocols.ts types.

/**
 * Track which asset currently has a warm embedding in the Worker.
 * Avoids redundant re-encode when clicking the same layer multiple times.
 *
 * Reset when the Worker is disposed (e.g. due to WebGPU ORT error auto-dispose)
 * to prevent using stale embedding references against a fresh Worker.
 */
let currentEmbeddingAssetId: string | null = null;

/**
 * Module-level AbortController for in-flight segmentation operations.
 * Supports cancellation of encode and segment-all operations.
 */
let segAbortController: AbortController | null = null;

/**
 * Reset embedding tracking. Called when the Worker is disposed to prevent
 * stale embedding references.
 */
export function resetEmbeddingCache(): void {
  currentEmbeddingAssetId = null;
}

/**
 * Abort any in-flight segmentation operation.
 * Safe to call even if no operation is in progress (no-op).
 */
export function abortSegmentation(): void {
  if (segAbortController) {
    segAbortController.abort();
    segAbortController = null;
  }
  segStore.reset();
}

/**
 * Helper: Get the active segmentation model ID from plugin config.
 * Uses the shared getActiveModelEntry utility.
 */
function getActiveSegModelId(ctx: EditorContextValue): string {
  const entry = getActiveModelEntry<SegModelEntry>(ctx, 'seg', DEFAULT_SEG_CONFIG, BUILTIN_SEG_MODELS);
  return entry.modelId;
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

      // Start — synchronous write to store
      segStore.setState({
        task: { message: 'Loading model...', progress: 0, device: null },
        error: null,
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
              const dlProgress = (p.loaded && p.total) ? p.loaded / p.total : 0;
              // Only show "Downloading..." with download details when actually fetching
              // from network (total > 0 implies real network transfer).
              // Otherwise stay with "Loading model..." (loading from cache).
              const isRealDownload = p.total != null && p.total > 0;
              segStore.setState({
                task: {
                  message: isRealDownload ? 'Downloading...' : 'Loading model...',
                  progress: dlProgress,
                  device: p.device ?? null,
                  download: isRealDownload ? {
                    loaded: p.loaded!,
                    total: p.total!,
                    speedBps: 0,
                  } : undefined,
                },
              });
            } else if (p.stage === 'detecting-device' && p.device) {
              segStore.setState({
                task: { message: 'Loading model...', progress: 0, device: p.device },
              });
            } else if (p.stage === 'encoding') {
              segStore.setState({
                task: { message: 'Analyzing image...', progress: p.progress ?? 0, device: null },
              });
            }
          },
        });

        currentEmbeddingAssetId = context.assetId;

        // Encoding done — clear task (embedding is ready for decode)
        segStore.setState({ task: null });

        return { success: true };
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const msg = humanizeSegError(raw);
        currentEmbeddingAssetId = null;
        segStore.setState({ task: null, error: msg });
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

      // Start decoding — synchronous write to store
      segStore.setState({
        task: { message: 'Generating mask...', progress: 0, device: null },
      });

      try {
        const result = await segClient.run({
          action: 'decode',
          modelId,
          prompts,
          context,
        });

        // Done — clear task, result will be set by caller (sam.ts) with frame projections
        segStore.setState({ task: null });

        return {
          success: true,
          masks: result.masks,
          debug: result.debug,
        };
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const msg = humanizeSegError(raw);
        segStore.setState({ task: null, error: msg });
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
      const assetId = activeLayer.assetId ?? `layer_${layerId}`;
      const modelId = getActiveSegModelId(ctx);

      let imageData: ImageData;
      try {
        imageData = await ctx.pixels.image.imageData(activeLayer.assetId!);
      } catch {
        actions.setInteraction({ hud: { message: 'Failed to read image data', type: 'error' } });
        return;
      }

      // Start — synchronous write to store
      segStore.setState({
        task: { message: 'Loading model...', progress: 0, device: null },
        error: null,
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
                const dlProgress = (p.loaded && p.total) ? p.loaded / p.total : 0;
                const isRealDownload = p.total != null && p.total > 0;
                segStore.setState({
                  task: {
                    message: isRealDownload ? 'Downloading...' : 'Loading model...',
                    progress: dlProgress,
                    device: p.device ?? null,
                    download: isRealDownload ? {
                      loaded: p.loaded!,
                      total: p.total!,
                      speedBps: 0,
                    } : undefined,
                  },
                });
              } else if (p.stage === 'detecting-device' && p.device) {
                segStore.setState({
                  task: { message: 'Loading model...', progress: 0, device: p.device },
                });
              } else if (p.stage === 'encoding') {
                segStore.setState({
                  task: { message: 'Analyzing image...', progress: p.progress ?? 0, device: null },
                });
              }
            },
          });
          currentEmbeddingAssetId = assetId;
        }

        // Run segment-all on the worker
        segStore.setState({
          task: { message: 'Segmenting all objects...', progress: 0, device: null },
        });

        const result = await segClient.run({
          action: 'segment-all',
          modelId,
          context: { frameId, layerId, assetId },
        }, {
          timeoutMs: 0,
          onProgress: (p) => {
            if (p.stage === 'decoding') {
              segStore.setState({
                task: { message: 'Generating masks...', progress: 0, device: null },
              });
            }
          },
        });

        // Process results
        const segments = result.segments ?? [];
        if (segments.length === 0) {
          segStore.setState({ task: null, lastResult: null });
          actions.setInteraction({ hud: { message: 'No objects detected in this image', type: 'info' } });
          return;
        }

        const candidates = segments.map(s => ({ rings: s.rings, score: s.score }));

        const framePolygons: Array<ReturnType<typeof asLocalPolygon>> = [];
        for (const candidate of candidates) {
          // Round SAM decoder output to integer pixel grid (consistent with sam.ts / wand).
          const layerRings = candidate.rings.map(ring =>
            ring.map(p => asLocalPoint({ x: Math.round(p.x), y: Math.round(p.y) }))
          );
          const layerBounds = asLocalRect(ctx.geometry.polygon.computePolygonBounds(layerRings));
          const layerPoly = asLocalPolygon(layerRings, layerBounds, true);
          const framePoly = ctx.geometry.polygon.layerLocalToFrameLocal(
            layerPoly, activeLayer!, activeFrame!
          );
          framePolygons.push(framePoly);
        }

        // Done — write result to store
        segStore.setState({
          task: null,
          lastResult: {
            candidates,
            activeCandidateIdx: 0,
            lastDecodeMs: result.debug?.totalMs ?? 0,
            samFrameId: frameId,
            candidateFramePolygons: framePolygons,
          },
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
        segStore.setState({ task: null, error: msg });
        actions.setInteraction({ hud: { message: 'Segment All failed — see error in panel', type: 'error' } });
      }
    },
  } as EditorCommand<void, Promise<void>>,
};
