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
 * WorkerBridge — typed communication bridge between main thread and Engine V2 Worker.
 *
 * Adapted from v1 `worker/WorkerBridge.ts` with the following changes:
 * - `request<T>` is now generically typed for return values.
 * - New `ensureAsset` method for transferring blobs to Worker cache.
 * - Removed all ad-hoc methods (mergeLayersToLayer, resample, etc.) —
 *   callers use `request<T>(job)` directly with typed Job payloads.
 * - Uses numeric IDs for lower overhead (v1 used string `req_${id}_${timestamp}`).
 *
 * Architecture: facade → dispatch → WorkerBridge → Worker
 * Single-directional dependency, no cycles.
 */

import type { Job } from '../../protocol/jobs';

// ─── Worker response envelope ───

interface WorkerResponseEnvelope {
  id: number;
  result?: unknown;
  error?: string;
}

// ─── WorkerBridge ───

export class WorkerBridge {
  private worker: Worker;
  private pending: Map<number, { resolve: (val: unknown) => void; reject: (err: Error) => void }>;
  private nextId = 0;

  constructor(worker: Worker) {
    this.worker = worker;
    this.pending = new Map();
    this.worker.onmessage = this.handleMessage.bind(this);
    this.worker.onerror = (err) => {
      console.error('[WorkerBridge] Worker error:', err);
    };
  }

  /**
   * Send a typed Job to the Worker and wait for the result.
   * The Worker router will dispatch to the appropriate handler.
   */
  async request<T>(job: Job, transfer: Transferable[] = []): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (val: unknown) => void,
        reject,
      });
      this.worker.postMessage({ id, job }, { transfer });
    });
  }

  /**
   * Ensure the Worker's cache has the specified blob (idempotent).
   * Transfers the blob to Worker for decode & caching under `hash`.
   */
  async ensureAsset(hash: string, blob: Blob): Promise<void> {
    await this.request<boolean>({
      type: 'ENSURE_ASSET',
      hash,
      blob,
    });
  }

  /**
   * Terminate the underlying Worker. After this, the bridge is unusable.
   */
  terminate(): void {
    this.worker.terminate();
    // Reject all pending requests
    for (const [, { reject }] of this.pending) {
      reject(new Error('[WorkerBridge] Worker terminated'));
    }
    this.pending.clear();
  }

  // ────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────

  private handleMessage(e: MessageEvent<WorkerResponseEnvelope>): void {
    const { id, result, error } = e.data;
    const request = this.pending.get(id);
    if (!request) return;

    this.pending.delete(id);
    if (error) {
      request.reject(new Error(error));
    } else {
      request.resolve(result);
    }
  }
}
