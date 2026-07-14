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

import type { SegRequest, SegResponse, SegResult, SegProgress } from './worker.types';

/**
 * SegmentationClient — Singleton wrapper around the Segmentation Worker.
 *
 * Mode B Persistent Singleton (consistent with BgRemoverClient):
 *   - Lazy: Worker constructed on first `run()`.
 *   - Sessions cached: Encoder/Decoder ONNX sessions persist across calls.
 *   - Embedding cached: Image embedding stays in Worker memory for instant decode.
 *   - reqId monotonic for stale-response defense.
 *   - Progress callback: multi-message flow.
 *   - Dispose: terminates Worker. Next `run()` lazy-recreates.
 *
 * Key differences from BgRemoverClient:
 *   - Supports multiple action types (download/encode/decode/segment-all)
 *   - Decode is very fast (~10ms) — uses shorter default timeout
 *   - Encode timeout is longer (~60s for first-time model download + encoding)
 */
export class SegmentationClient {
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
   * Submit a segmentation request.
   *
   * @param req - Request payload (without reqId, auto-assigned)
   * @param opts.signal - AbortSignal for cancellation
   * @param opts.timeoutMs - Hard timeout (default varies by action)
   * @param opts.onProgress - Called with download/encode/decode progress
   * @returns Promise resolving with the final SegResult
   */
  run(
    req: Omit<SegRequest, 'reqId'>,
    opts?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      onProgress?: (progress: SegProgress) => void;
    },
  ): Promise<SegResult> {
    // Default timeouts by action type:
    //   download: 0 (no timeout — user-controlled via network)
    //   encode: 60s (first-time may include download + encoding)
    //   decode: 10s (should be ~10ms normally)
    //   segment-all: 120s (full grid scan)
    const defaultTimeout: Record<string, number> = {
      'download': 0,
      'encode': 60_000,
      'decode': 10_000,
      'segment-all': 120_000,
    };
    const timeoutMs = opts?.timeoutMs ?? defaultTimeout[req.action] ?? 30_000;
    const reqId = ++this.currentReqId;

    let worker: Worker;
    try {
      worker = this.ensure();
    } catch (err) {
      return Promise.reject(err);
    }

    return new Promise<SegResult>((resolve, reject) => {
      const cleanup = () => {
        if (timer !== null) clearTimeout(timer);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        opts?.signal?.removeEventListener('abort', onAbort);
      };

      const onMessage = (ev: MessageEvent<SegResponse>) => {
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
            // Detect WebGPU/ORT runtime errors that corrupt internal state
            {
              const errMsg = (msg.error ?? '').toLowerCase();
              const isWebGpuOrtError = (
                errMsg.includes('ortrun') ||
                errMsg.includes('webgpu') ||
                errMsg.includes('storage_buffer') ||
                errMsg.includes('device lost') ||
                errMsg.includes('gpudevice')
              );
              if (isWebGpuOrtError) {
                console.warn('[SegClient] WebGPU ORT error — disposing worker for clean restart');
                this.dispose();
              }
            }
            reject(new Error(`Segmentation worker error: ${msg.error}`));
            break;
        }
      };

      const onError = (ev: ErrorEvent) => {
        cleanup();
        this.dispose();
        reject(new Error(`Segmentation worker crashed: ${ev.message ?? 'unknown error'}`));
      };

      const onAbort = () => {
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      };

      // timeoutMs <= 0 means "no timeout" (download can take minutes)
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            cleanup();
            this.dispose();
            reject(new Error(`Segmentation timed out after ${timeoutMs}ms (action: ${req.action})`));
          }, timeoutMs)
        : null;

      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      opts?.signal?.addEventListener('abort', onAbort);

      const message: SegRequest = { ...req, reqId };
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
 * Module-level singleton — one Segmentation worker per editor session.
 * Encoder embedding and decoder sessions stay warm for instant decode.
 */
export const segClient = new SegmentationClient();
