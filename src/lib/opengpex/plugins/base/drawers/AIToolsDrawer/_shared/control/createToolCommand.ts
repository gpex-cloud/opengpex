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

/**
 * createToolCommand — Factory for AI tool EditorCommand pairs (run + abort).
 *
 * This is the single entry point for creating inference commands. It contains
 * the full orchestration logic previously split across InferenceCommands.ts:
 *   - Pre-flight checks (activeFrame, activeLayer, image type)
 *   - Image data reading
 *   - AbortController lifecycle
 *   - GPU mutex (acquireInferenceLock)
 *   - Progress → store mapping (with built-in tile awareness)
 *   - Error handling (Aborted / timeout / general)
 *   - Model resolution via getActiveModelEntry
 *   - Abort with Worker dispose + cache cleanup
 *
 * Each tool only provides:
 *   - `setRequest(entry, imageData, ctx)` — build the worker request payload
 *   - `getResult(workerResult, ctx, elapsedMs)` — process the result
 *   - Optional: `preInferenceCheck` — validate before inference
 *
 * Does NOT apply to Segmentation (two-stage encode+decode flow).
 *
 * @example
 * ```ts
 * const { runCommand, abortCommand } = createToolCommand<...>({
 *   id: { run: CMD_REMOVE_BG, abort: CMD_ABORT },
 *   name: { run: 'AI Remove Background', abort: 'Cancel Background Removal' },
 *   store: bgRemoverStore,
 *   client: bgRemoverClient,
 *   configKey: 'bgremover',
 *   defaultConfig: DEFAULT_BG_REMOVAL_CONFIG,
 *   builtins: BUILTIN_MODELS,
 *   toolName: 'Background removal',
 *   setRequest: (entry, imageData, ctx) => ({ ... }),
 *   getResult: (workerResult, ctx, elapsedMs) => ({ ... }),
 * });
 * ```
 */

'use client';

import type { EditorContextValue, EditorCommand } from '@opengpex/editor/core/types';
import type { WorkerProgress } from '../inference/types';
import type { AIToolStore } from './createAIToolStore';
import type { ModelEntry, ModelCatalog } from '../types';
import { SpeedEstimator } from '../download';
import { cleanupPartialModelCache } from '../download/model-cache';
import { getActiveModelEntry } from '../useToolConfig';

// ─── Public Types ────────────────────────────────────────────────────────────

/**
 * The return value of `getResult` callbacks.
 */
export interface ProcessResultOutcome<TStoreResult> {
  /** The result to write into store.lastResult. */
  result: TStoreResult;
  /** Optional HUD message on success. */
  hudMessage?: string;
  /** HUD type for the success message. @default 'success' */
  hudType?: 'success' | 'info';
}

/**
 * Extended WorkerProgress with optional tile info (auto-detected for formatting).
 */
interface TileAwareProgress extends WorkerProgress {
  currentTile?: number;
  totalTiles?: number;
}

/**
 * Configuration for createToolCommand.
 */
export interface ToolCommandConfig<
  TRequest,
  TWorkerResult,
  TStoreResult,
  TModelEntry extends ModelEntry,
> {
  /** Command IDs. */
  id: { run: string; abort: string };
  /** Command display names. */
  name: { run: string; abort: string };

  /** The tool's AIToolStore instance. */
  store: AIToolStore<TStoreResult>;
  /** The tool's Worker client instance (must have `run` and `dispose`). */
  client: {
    run(req: TRequest, opts?: { signal?: AbortSignal; timeoutMs?: number; onProgress?: (p: TileAwareProgress) => void }): Promise<TWorkerResult>;
    dispose(): void;
  };

  /** Config sub-key (e.g. 'bgremover', 'upscale', 'inpaintEraser'). */
  configKey: string;
  /** Default config for this tool. */
  defaultConfig: ModelCatalog;
  /** Built-in models for this tool. */
  builtins: TModelEntry[];

  /** Tool display name for HUD messages (e.g. 'Background removal'). */
  toolName: string;

  /**
   * Build the tool-specific worker request from model entry and image data.
   */
  setRequest: (
    entry: TModelEntry,
    imageData: ImageData,
    ctx: EditorContextValue,
  ) => TRequest;

  /**
   * Process the raw worker result into the store result type.
   * Return `null` to indicate "no useful result" (e.g. no subject detected).
   *
   * Supports async processing (e.g. upscaler needs OffscreenCanvas → Blob → frame creation).
   */
  getResult: (
    workerResult: TWorkerResult,
    ctx: EditorContextValue,
    elapsedMs: number,
  ) => ProcessResultOutcome<TStoreResult> | Promise<ProcessResultOutcome<TStoreResult> | null> | null;

  /**
   * Optional pre-inference validation after imageData is obtained.
   * Return an error message string to abort with that error shown in store + HUD.
   * Return `null` to proceed normally.
   */
  preCheck?: (
    imageData: ImageData,
    entry: TModelEntry,
    ctx: EditorContextValue,
  ) => string | null;

  /**
   * Custom "no result" HUD message.
   * @default 'No result from inference'
   */
  noResultMessage?: string;

  /**
   * Timeout for the worker call in milliseconds.
   * @default 0 (no timeout)
   */
  timeoutMs?: number;
}

/**
 * Return value of createToolCommand.
 */
export interface ToolCommandResult {
  /** The "run inference" EditorCommand. */
  runCommand: EditorCommand<void, Promise<void>>;
  /** The "abort/cancel" EditorCommand. */
  abortCommand: EditorCommand<void, Promise<void>>;
}

// ─── Internal: AbortController Management ────────────────────────────────────

/**
 * Per-store AbortController tracking via WeakMap.
 * Ensures each tool's abort is independent.
 */
const activeAbortControllers = new WeakMap<AIToolStore<unknown>, AbortController>();

function setAbortController<T>(store: AIToolStore<T>, ctrl: AbortController): void {
  activeAbortControllers.set(store as AIToolStore<unknown>, ctrl);
}

function clearAbortController<T>(store: AIToolStore<T>): void {
  activeAbortControllers.delete(store as AIToolStore<unknown>);
}

function abortAndClear<T>(store: AIToolStore<T>): void {
  const ctrl = activeAbortControllers.get(store as AIToolStore<unknown>);
  if (ctrl) {
    ctrl.abort();
    activeAbortControllers.delete(store as AIToolStore<unknown>);
  }
}

// ─── Internal: Default Progress Formatter ────────────────────────────────────

function formatProcessingMessage(progress: TileAwareProgress): string {
  if (progress.currentTile && progress.totalTiles) {
    return `Processing... (tile ${progress.currentTile}/${progress.totalTiles})`;
  }
  return 'Processing...';
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a pair of EditorCommands (run + abort) for an AI inference tool.
 *
 * Encapsulates the entire command lifecycle including:
 *   - Pre-flight validation
 *   - Image data acquisition
 *   - Model resolution
 *   - GPU mutex acquisition
 *   - Worker invocation with progress tracking
 *   - Result processing
 *   - Error handling
 *   - Abort with cleanup
 */
export function createToolCommand<
  TRequest,
  TWorkerResult,
  TStoreResult,
  TModelEntry extends ModelEntry,
>(
  config: ToolCommandConfig<TRequest, TWorkerResult, TStoreResult, TModelEntry>,
): ToolCommandResult {
  const {
    id,
    name,
    store,
    client,
    configKey,
    defaultConfig,
    builtins,
    toolName,
    setRequest,
    getResult,
    preCheck,
    noResultMessage = 'No result from inference',
    timeoutMs = 0,
  } = config;

  // Bound model resolver
  const resolveModel = (ctx: EditorContextValue): TModelEntry =>
    getActiveModelEntry<TModelEntry>(ctx, configKey, defaultConfig, builtins);

  // ─── Run Command ─────────────────────────────────────────────────────────

  const runCommand: EditorCommand<void, Promise<void>> = {
    id: id.run,
    name: name.run,
    execute: async (ctx: EditorContextValue) => {
      const { activeFrame, activeLayer, actions } = ctx;

      // ── Pre-flight checks ────────────────────────────────────────────────

      if (!activeFrame || !activeLayer) {
        actions.setInteraction({ hud: { message: 'No active image layer', type: 'error' } });
        return;
      }

      if (activeLayer.type !== 'image') {
        actions.setInteraction({
          hud: { message: `${toolName} only works on image layers`, type: 'error' },
        });
        return;
      }

      if (!activeLayer.src) {
        actions.setInteraction({ hud: { message: 'Layer has no image source', type: 'error' } });
        return;
      }

      // ── Resolve model ────────────────────────────────────────────────────

      const modelEntry = resolveModel(ctx);

      // ── Start task ───────────────────────────────────────────────────────

      store.setState({ task: { message: 'Loading model...', progress: 0, device: null }, error: null });

      // ── Read image data ──────────────────────────────────────────────────

      let imageData: ImageData;
      try {
        imageData = await ctx.pixels.image.imageData(activeLayer.assetId!);
      } catch {
        actions.setInteraction({ hud: { message: 'Failed to read image data', type: 'error' } });
        store.reset();
        return;
      }

      // ── Pre-inference check (optional) ───────────────────────────────────

      if (preCheck) {
        const checkError = preCheck(imageData, modelEntry, ctx);
        if (checkError) {
          store.setState({ task: null, error: checkError });
          actions.setInteraction({ hud: { message: `${toolName} failed — see error details in panel`, type: 'error' } });
          return;
        }
      }

      // ── Setup abort + speed estimator ────────────────────────────────────

      const abortController = new AbortController();
      setAbortController(store, abortController);
      const { signal } = abortController;

      const speedEstimator = new SpeedEstimator();
      const inferenceStart = performance.now();

      // ── Progress handler ─────────────────────────────────────────────────

      const onProgress = (progress: TileAwareProgress) => {
        switch (progress.stage) {
          case 'detecting-device':
            if (progress.device) {
              store.setState({ task: { message: 'Loading model...', progress: 0, device: progress.device } });
            }
            break;
          case 'loading':
            store.setState({ task: { message: 'Loading model...', progress: 0, device: null } });
            break;
          case 'downloading':
            if (progress.loaded != null && progress.total != null) {
              speedEstimator.update(progress.loaded, progress.total);
              const dlProgress = progress.total > 0 ? progress.loaded / progress.total : 0;
              store.setState({
                task: {
                  message: 'Downloading...',
                  progress: dlProgress,
                  device: null,
                  download: {
                    loaded: progress.loaded,
                    total: progress.total,
                    speedBps: speedEstimator.bytesPerSecond,
                  },
                },
              });
            }
            break;
          case 'processing':
            store.setState({
              task: {
                message: formatProcessingMessage(progress),
                progress: progress.progress ?? 0,
                device: progress.device ?? null,
              },
            });
            break;
        }
      };

      // ── Execute inference ────────────────────────────────────────────────

      try {
        const request = setRequest(modelEntry, imageData, ctx);
        const workerResult = await client.run(request, { timeoutMs, onProgress, signal });

        const elapsedMs = performance.now() - inferenceStart;

        // ── Process result ──────────────────────────────────────────────────

        const outcome = await Promise.resolve(getResult(workerResult, ctx, elapsedMs));

        if (!outcome) {
          actions.setInteraction({ hud: { message: noResultMessage, type: 'info' } });
          store.reset();
          return;
        }

        store.setState({ task: null, lastResult: outcome.result });

        if (outcome.hudMessage) {
          actions.setInteraction({
            hud: { message: outcome.hudMessage, type: outcome.hudType ?? 'success' },
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        if (msg.includes('Aborted') || msg.includes('AbortError')) {
          store.reset();
        } else {
          store.setState({ task: null, error: msg });
          actions.setInteraction({
            hud: {
              message: msg.includes('timed out')
                ? `${toolName} timed out — please try again`
                : `${toolName} failed — see error details in panel`,
              type: 'error',
            },
          });
        }
      } finally {
        clearAbortController(store);
      }
    },
  };

  // ─── Abort Command ───────────────────────────────────────────────────────

  const abortCommand: EditorCommand<void, Promise<void>> = {
    id: id.abort,
    name: name.abort,
    execute: async (ctx: EditorContextValue) => {
      const modelId = resolveModel(ctx).modelId;

      // 1. Abort the in-flight inference
      abortAndClear(store);

      // 2. Terminate worker (release GPU/WASM memory)
      client.dispose();

      // 3. Reset store
      store.reset();

      // 4. HUD
      ctx.actions.setInteraction({ hud: { message: `${toolName} cancelled`, type: 'info' } });

      // 5. Best-effort cache cleanup for partially-downloaded model files
      await cleanupPartialModelCache(modelId);
    },
  };

  return { runCommand, abortCommand };
}
