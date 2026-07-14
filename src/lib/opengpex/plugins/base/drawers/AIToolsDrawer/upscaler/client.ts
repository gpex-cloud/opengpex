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

import type { UpscaleRequest, UpscaleResponse, UpscaleResult, UpscaleProgress } from './worker.types';

/**
 * UpscaleClient — Singleton wrapper around the Upscale Worker.
 *
 * Mode B Persistent Singleton (consistent with BgRemoverClient / SegmentationClient):
 *   - Lazy: Worker constructed on first `run()`.
 *   - Model session cached: ONNX model stays warm across calls.
 *   - reqId monotonic for stale-response defense.
 *   - Progress callback: tile-level granularity.
 *   - Dispose: terminates Worker. Next `run()` lazy-recreates.
 */
export class UpscaleClient {
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
   * Submit an upscale request.
   *
   * @param req - Request payload (without reqId, auto-assigned)
   * @param opts.signal - AbortSignal for cancellation
   * @param opts.timeoutMs - Hard timeout (default: 0 = no timeout for upscale)
   * @param opts.onProgress - Called with download/processing progress
   * @returns Promise resolving with the final UpscaleResult
   */
  run(
    req: Omit<UpscaleRequest, 'reqId'>,
    opts?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      onProgress?: (progress: UpscaleProgress) => void;
    },
  ): Promise<UpscaleResult> {
    const defaultTimeout: Record<string, number> = {
      'download': 0,
      'upscale': 0, // No timeout — large images can take minutes
    };
    const timeoutMs = opts?.timeoutMs ?? defaultTimeout[req.action] ?? 120_000;
    const reqId = ++this.currentReqId;

    let worker: Worker;
    try {
      worker = this.ensure();
    } catch (err) {
      return Promise.reject(err);
    }

    return new Promise<UpscaleResult>((resolve, reject) => {
      const cleanup = () => {
        if (timer !== null) clearTimeout(timer);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        opts?.signal?.removeEventListener('abort', onAbort);
      };

      const onMessage = (ev: MessageEvent<UpscaleResponse>) => {
        const msg = ev.data;
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
            reject(new Error(`Upscale worker error: ${msg.error}`));
            break;
        }
      };

      const onError = (ev: ErrorEvent) => {
        cleanup();
        this.dispose();
        reject(new Error(`Upscale worker crashed: ${ev.message ?? 'unknown error'}`));
      };

      const onAbort = () => {
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      };

      const timer = timeoutMs > 0
        ? setTimeout(() => {
            cleanup();
            this.dispose();
            reject(new Error(`Upscale timed out after ${timeoutMs}ms (action: ${req.action})`));
          }, timeoutMs)
        : null;

      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      opts?.signal?.addEventListener('abort', onAbort);

      const message: UpscaleRequest = { ...req, reqId };
      // Transfer ArrayBuffer (zero-copy) if imageData present
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
 * Module-level singleton — one Upscale worker per editor session.
 * Model session stays warm for subsequent upscale operations.
 */
export const upscaleClient = new UpscaleClient();
