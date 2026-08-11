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
 * createInference — Session Execution Orchestrator for AI Tool Workers
 *
 * Encapsulates the common lifecycle shared by all AI tool workers:
 *   1. Session creation / reuse / backend switching
 *   2. Model loading with download progress reporting
 *   3. Device detection progress
 *   4. Processing progress reporting
 *   5. Error handling with session invalidation
 *
 * Each worker only provides tool-specific logic via the `PipelineConfig`:
 *   - `loadArgs(req)`: How to configure session.load()
 *   - `execute(session, req, report)`: The actual inference + post-processing
 *
 * ⚠️ This module is imported by Web Workers — keep it free of DOM/React deps.
 */

import type { BackendType, InferenceArgs, InferenceSession, WorkerRequest } from './types';
import { OrtSession } from './ort-session';
import { TransformersSession } from './tfm-session';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Report utilities passed to the `execute` callback.
 */
export interface PipelineReport {
  /** Report processing progress (0-1). */
  progress(value: number): void;
  /** The actual device resolved after model loading. */
  device: 'webgpu' | 'wasm';
}

/**
 * Configuration for a worker pipeline instance.
 *
 * @template TReq - The worker request type (extends WorkerRequest)
 * @template TResultPayload - The tool-specific result payload (without type/reqId)
 */
export interface PipelineConfig<TReq extends WorkerRequest, TResultPayload> {
  /**
   * Optional pre-validation before session lifecycle begins.
   * Return an error message string to abort, or null to proceed.
   */
  validate?: (req: TReq) => string | null;

  /**
   * Build InferenceArgs for `session.load()` from the incoming request.
   * The `onDownloadProgress` callback is injected by the orchestrator — do NOT set it here.
   */
  loadArgs(req: TReq): Omit<InferenceArgs, 'onDownloadProgress'>;

  /**
   * The tool-specific core logic: inference + post-processing.
   *
   * Receives:
   *   - `session`: The loaded InferenceSession (ready to call .run() or cast to OrtSession)
   *   - `req`: The original worker request
   *   - `report`: Utilities for progress reporting and device info
   *
   * Returns the result payload (the orchestrator wraps it with `{ type: 'result', reqId }`).
   */
  execute(
    session: InferenceSession,
    req: TReq,
    report: PipelineReport,
  ): Promise<TResultPayload>;

  /**
   * Optional: Extract Transferable buffers from the result for zero-copy postMessage.
   * Return an array of ArrayBuffer instances to transfer ownership.
   */
  transferables?: (result: TResultPayload) => Transferable[];
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a session pipeline handler.
 *
 * Returns an async function that should be called for each incoming message.
 * The returned handler manages its own session singleton via closure scope.
 *
 * Usage:
 * ```ts
 * const handleRequest = createInference<MyRequest, MyResultPayload>({
 *   loadArgs: (req) => ({ backend: 'ort', modelId: req.modelId, ... }),
 *   execute: async (session, req, { progress, device }) => {
 *     progress(0.2);
 *     const output = await session.run(input);
 *     progress(0.8);
 *     return { ...resultPayload };
 *   },
 * });
 *
 * self.onmessage = (ev) => handleRequest(ev.data);
 * ```
 */
export function createInference<TReq extends WorkerRequest, TResultPayload>(
  config: PipelineConfig<TReq, TResultPayload>,
) {
  // Closure-scoped session singleton — each worker instance owns exactly one.
  let session: InferenceSession | null = null;
  let currentBackend: BackendType | null = null;

  return async function handleRequest(req: TReq): Promise<void> {
    const { reqId, backend: reqBackend } = req;
    const backend: BackendType = reqBackend ?? 'transformers';

    // 0. Pre-validation
    if (config.validate) {
      const err = config.validate(req);
      if (err) {
        self.postMessage({ type: 'error', reqId, error: err });
        return;
      }
    }

    try {
      // 1. Session lifecycle — create / reuse / switch backend
      if (!session || currentBackend !== backend) {
        if (session) await session.release();
        session = backend === 'ort' ? new OrtSession() : new TransformersSession();
        currentBackend = backend;
      }

      // 2. Load model with download progress reporting
      self.postMessage({ type: 'progress', reqId, stage: 'loading' });

      const loadArgs = config.loadArgs(req);
      await session.load({
        ...loadArgs,
        onDownloadProgress: (loaded: number, total: number, file?: string) => {
          self.postMessage({
            type: 'progress', reqId, stage: 'downloading',
            device: req.device, file, loaded, total,
          });
        },
      });

      // 3. Device detection
      const device: 'webgpu' | 'wasm' = session.device !== 'cpu'
        ? (session.device as 'webgpu' | 'wasm')
        : 'wasm';

      self.postMessage({ type: 'progress', reqId, stage: 'detecting-device', device });

      // 4. Execute tool-specific logic
      const report: PipelineReport = {
        progress: (value: number) => {
          self.postMessage({ type: 'progress', reqId, stage: 'processing', device, progress: value });
        },
        device,
      };

      const resultPayload = await config.execute(session, req, report);

      // 5. Send result
      const msg = { type: 'result' as const, reqId, ...resultPayload };
      const transfers = config.transferables?.(resultPayload) ?? [];
      if (transfers.length > 0) {
        (self as unknown as { postMessage(msg: unknown, transfer: Transferable[]): void }).postMessage(msg, transfers);
      } else {
        self.postMessage(msg);
      }

    } catch (err) {
      // Invalidate session on error to prevent broken state poisoning subsequent requests
      if (session) {
        await session.release().catch(() => {});
        session = null;
        currentBackend = null;
      }
      self.postMessage({
        type: 'error', reqId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
