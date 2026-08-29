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
 * BakeWorkerClient — main-thread RPC wrapper for the paint bake Worker.
 *
 * Lazy-creates the Worker on first `execute()` call. The Worker is kept
 * alive for the editor session lifetime (idle cost: zero CPU, <1 MB RAM).
 *
 * Pattern mirrors `MagicWandClient` (ClipOverlay) — simple postMessage /
 * onmessage promise wrapper with Transferable management.
 */

// ── Shared Message Types (also imported by bake.worker.ts) ─────────────────

export interface BakeWorkerRequest {
  existingBitmap: ImageBitmap | null;
  existingLayerRect: { x: number; y: number; w: number; h: number } | null;
  strokeBitmap: ImageBitmap;
  canvasSize: { w: number; h: number };
  isNewLayer: boolean;
  strokeDirtyRect: { x: number; y: number; w: number; h: number } | null;
  existingLayerBounding: { w: number; h: number; cx: number; cy: number } | null;
}

export interface BakeWorkerResult {
  blob: Blob;
  bitmap: ImageBitmap;
  cropX: number;
  cropY: number;
  cropW: number;
  cropH: number;
  /** SHA-256 content hash of the blob, precomputed in Worker to avoid main-thread blocking. */
  hash: string;
}

// ── Client Class ───────────────────────────────────────────────────────────

class BakeWorkerClient {
  private worker: Worker | null = null;
  private pending: {
    resolve: (r: BakeWorkerResult) => void;
    reject: (e: Error) => void;
  } | null = null;

  /** Lazy-create or reuse the bake worker. */
  private ensure(): Worker {
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined') {
      throw new Error('Web Worker is not available in this environment');
    }
    this.worker = new Worker(
      new URL('./bake.worker.ts', import.meta.url),
      { type: 'module' },
    );
    this.worker.onmessage = (e: MessageEvent<BakeWorkerResult>) => {
      this.pending?.resolve(e.data);
      this.pending = null;
    };
    this.worker.onerror = (err: ErrorEvent) => {
      this.pending?.reject(new Error(`BakeWorker error: ${err.message}`));
      this.pending = null;
    };
    return this.worker;
  }

  /**
   * Send a bake request to the Worker and await the result.
   *
   * Both `strokeBitmap` and `existingBitmap` (if present) are transferred
   * (zero-copy). After this call, the caller's references are neutered.
   */
  execute(request: BakeWorkerRequest): Promise<BakeWorkerResult> {
    const worker = this.ensure();

    const transfer: Transferable[] = [request.strokeBitmap];
    if (request.existingBitmap) transfer.push(request.existingBitmap);

    return new Promise<BakeWorkerResult>((resolve, reject) => {
      this.pending = { resolve, reject };
      worker.postMessage(request, transfer);
    });
  }

  /** Terminate the Worker. Idempotent. */
  dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}

/** Module-level singleton — one bake worker per editor session. */
export const bakeWorkerClient = new BakeWorkerClient();

