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

import type { WandRequest, WandResponse } from './protocol';

/**
 * MagicWandClient — singleton wrapper around the Magic-Wand Worker.
 *
 * Lifecycle (per phase1_irregular_clip_spec §6.4):
 *   - Lazy: the Worker is constructed on first `run()`. Editor cold-start does
 *     not pay a worker spin-up tax for users who never use the wand tool.
 *   - 5-second hard timeout. On timeout we `terminate()` the worker (releases
 *     the BFS mask + ImageData copy, ~50 MB on 4K) and surface an error;
 *     the next call lazy-recreates a fresh worker.
 *   - Stale-response defense: each `postMessage` carries a monotonic `reqId`,
 *     and the listener ignores responses whose `reqId` doesn't match the
 *     active request (defensive — Phase 1 only ever has one in-flight
 *     request at a time).
 *   - Hot-reload / plugin uninstall: callers can `dispose()` to release the
 *     worker process. The next `run()` will lazy-create another.
 *
 * Failure semantics: `run()` rejects with a descriptive `Error` for every
 * recoverable failure (timeout / aborted / load failure / worker error).
 * Callers (typically `interactions.ts::createWandHandler`) should catch and
 * trigger `selectionErrorPulse` plus a toast. We deliberately do NOT
 * implicitly fall back here — surfacing the failure lets the UI decide.
 */
export class MagicWandClient {
  private worker: Worker | null = null;
  private currentReqId = 0;

  /** Lazy-create or reuse the wand worker. */
  private ensure(): Worker {
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined') {
      throw new Error('Web Worker is not available in this environment');
    }
    this.worker = new Worker(new URL('./wand.worker.ts', import.meta.url), { type: 'module' });
    return this.worker;
  }


  /**
   * Submit a wand request and resolve with the response.
   *
   * `req.imageData.data` is a Transferable ArrayBuffer; on send we hand
   * ownership to the worker (zero-copy). The caller MUST NOT use the buffer
   * after `run()` is invoked.
   */
  run(
    req: Omit<WandRequest, 'reqId'>,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<WandResponse> {
    const timeoutMs = opts?.timeoutMs ?? 5_000;
    const reqId = ++this.currentReqId;

    let worker: Worker;
    try {
      worker = this.ensure();
    } catch (err) {
      return Promise.reject(err);
    }

    return new Promise<WandResponse>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        opts?.signal?.removeEventListener('abort', onAbort);
      };

      const onMessage = (ev: MessageEvent<WandResponse>) => {
        // Stale-response guard.
        if (ev.data?.reqId !== reqId) return;
        cleanup();
        if (ev.data.error) {
          reject(new Error(`MagicWand worker error: ${ev.data.error}`));
        } else {
          resolve(ev.data);
        }
      };

      const onError = (ev: ErrorEvent) => {
        cleanup();
        // The worker may be in an inconsistent state after a thrown error;
        // terminate so the next run() spins up a fresh one.
        this.dispose();
        reject(new Error(`MagicWand worker crashed: ${ev.message ?? 'unknown error'}`));
      };

      const onAbort = () => {
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      };

      const timer = setTimeout(() => {
        cleanup();
        // Long-running wand on huge images is an unrecoverable hang in our
        // single-worker model; kill it to free memory.
        this.dispose();
        reject(new Error(`MagicWand timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      opts?.signal?.addEventListener('abort', onAbort);

      const message: WandRequest = { ...req, reqId };
      worker.postMessage(message, [req.imageData.data]);
    });
  }

  /** Terminate the wand worker and release its memory. Idempotent. */
  dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}

/**
 * Module-level singleton — one wand worker per editor session.
 * Wand invocations are mutually exclusive (a click triggers one run); we do
 * not need a worker pool. If hot-reload / plugin unload becomes a concern
 * later, expose a `disposeMagicWand()` and call it from the plugin teardown.
 */
export const magicWandClient = new MagicWandClient();
