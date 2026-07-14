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

import type { BgRemoverRequest, BgRemoverResponse, BgRemoverResult, BgRemoverProgress } from './worker.types';

/**
 * BgRemoverClient — Singleton wrapper around the BgRemover Worker.
 *
 * Mode B Persistent Singleton (per spec §2.5):
 *   - Lazy: Worker constructed on first `run()` — no cold-start cost for users
 *     who never use background removal.
 *   - Pipeline cached: The Worker holds the loaded model across invocations;
 *     subsequent calls skip the ~70MB model load entirely.
 *   - 30-second hard timeout (accounting for first-time model download).
 *   - Stale-response defense via monotonic `reqId`.
 *   - Progress callback: multi-message flow (download + inference progress).
 *   - Dispose: terminates Worker to release GPU/WASM memory. Next `run()` will
 *     lazy-recreate.
 *
 * Differences from MagicWandClient:
 *   - Multi-message progress (not just single response)
 *   - Longer timeout (30s vs 5s)
 *   - Speed estimation for download progress
 */
export class BgRemoverClient {
  private worker: Worker | null = null;
  private currentReqId = 0;

  /** Lazy-create or reuse the singleton worker. */
  private ensure(): Worker {
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined') {
      throw new Error('Web Worker is not available in this environment');
    }
    this.worker = new Worker(
      new URL('./worker.ts', import.meta.url),
      { type: 'module' }
    );
    return this.worker;
  }

  /**
   * Submit a background removal request.
   *
   * @param req - The image data and context (without reqId, auto-assigned)
   * @param opts.signal - AbortSignal for cancellation
   * @param opts.timeoutMs - Hard timeout (default 30s for first-time model download)
   * @param opts.onProgress - Called multiple times with download/inference progress
   * @returns Promise resolving with the final BgRemoverResult
   */
  run(
    req: Omit<BgRemoverRequest, 'reqId'>,
    opts?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      onProgress?: (progress: BgRemoverProgress) => void;
    },
  ): Promise<BgRemoverResult> {
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const reqId = ++this.currentReqId;

    let worker: Worker;
    try {
      worker = this.ensure();
    } catch (err) {
      return Promise.reject(err);
    }

    return new Promise<BgRemoverResult>((resolve, reject) => {
      const cleanup = () => {
        if (timer !== null) clearTimeout(timer);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        opts?.signal?.removeEventListener('abort', onAbort);
      };

      const onMessage = (ev: MessageEvent<BgRemoverResponse>) => {
        const msg = ev.data;
        // Stale-response guard
        if (msg?.reqId !== reqId) return;

        switch (msg.type) {
          case 'progress':
            opts?.onProgress?.(msg);
            break;
          case 'result':
            cleanup();
            resolve(msg);
            break;
          case 'error':
            cleanup();
            // Detect WebGPU/ORT runtime errors — these corrupt the ONNX Runtime's
            // internal WebGPU backend state, making ALL subsequent WebGPU inference
            // fail (even for different models that would otherwise work fine).
            // For these errors, dispose the worker to get a completely fresh ORT
            // environment on the next request. This allows other models (e.g. RMBG)
            // to still use WebGPU successfully after BiRefNet fails.
            //
            // For non-WebGPU errors (e.g., tensor shape mismatch, post-processing
            // errors), keep the worker alive — the internal cache invalidation is
            // sufficient and avoids unnecessary model re-downloads.
            {
              const errMsg = (msg.error ?? '').toLowerCase();
              const isWebGpuOrtError = (
                errMsg.includes('ortrun') ||
                errMsg.includes('webgpu') ||
                errMsg.includes('storage_buffer') ||
                errMsg.includes('shaderhelper') ||
                errMsg.includes('device lost') ||
                errMsg.includes('gpudevice')
              );
              if (isWebGpuOrtError) {
                console.warn('[BgRemoverClient] WebGPU ORT error detected — disposing worker for clean restart');
                this.dispose();
              }
            }
            reject(new Error(`BgRemover worker error: ${msg.error}`));
            break;
        }
      };

      const onError = (ev: ErrorEvent) => {
        cleanup();
        this.dispose();
        reject(new Error(`BgRemover worker crashed: ${ev.message ?? 'unknown error'}`));
      };

      const onAbort = () => {
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      };

      // timeoutMs <= 0 means "no timeout" (model download can take minutes)
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            cleanup();
            this.dispose();
            reject(new Error(`BgRemover timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;

      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      opts?.signal?.addEventListener('abort', onAbort);

      const message: BgRemoverRequest = { ...req, reqId };
      // Transfer the ArrayBuffer (zero-copy) if imageData is present
      if (req.imageData) {
        worker.postMessage(message, [req.imageData.data]);
      } else {
        worker.postMessage(message);
      }
    });
  }

  /** Terminate the worker and release GPU/WASM memory. Idempotent. */
  dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}

/**
 * Module-level singleton — one BgRemover worker per editor session.
 * The model stays warm in GPU/WASM memory for instant subsequent invocations.
 */
export const bgRemoverClient = new BgRemoverClient();
