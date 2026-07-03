/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * ClipOptions Worker Client
 *
 * Manages the lifecycle and communication for:
 *   - alpha.worker.ts  (Select from Alpha)
 *   - offset.worker.ts (Selection expand/contract)
 *
 * This client is owned by ClipOptions and does NOT import from ClipOverlay,
 * maintaining proper plugin decoupling.
 */

import type {
  AlphaRequest, AlphaResponse,
  OffsetRequest, OffsetResponse,
} from './protocol';

let nextReqId = 1;

class ClipComputeClient {
  private alphaWorker: Worker | null = null;
  private offsetWorker: Worker | null = null;

  // ─── Alpha Worker ───────────────────────────────────────────────────────────

  private getAlphaWorker(): Worker {
    if (this.alphaWorker) return this.alphaWorker;
    this.alphaWorker = new Worker(
      new URL('./alpha.worker.ts', import.meta.url),
      { type: 'module' }
    );
    return this.alphaWorker;
  }

  /**
   * Runs "Select from Alpha" on a layer's RGBA pixel data.
   * Returns rings in layer-local coordinates, or null if no opaque region.
   */
  runAlpha(
    params: Omit<AlphaRequest, 'reqId'>
  ): Promise<AlphaResponse> {
    const reqId = nextReqId++;
    const worker = this.getAlphaWorker();

    return new Promise<AlphaResponse>((resolve) => {
      const handler = (ev: MessageEvent<AlphaResponse>) => {
        if (ev.data.reqId === reqId) {
          worker.removeEventListener('message', handler);
          resolve(ev.data);
        }
      };
      worker.addEventListener('message', handler);

      const msg: AlphaRequest = { ...params, reqId };
      worker.postMessage(msg, [msg.imageData.data]);
    });
  }

  // ─── Offset Worker ──────────────────────────────────────────────────────────

  private getOffsetWorker(): Worker {
    if (this.offsetWorker) return this.offsetWorker;
    this.offsetWorker = new Worker(
      new URL('./offset.worker.ts', import.meta.url),
      { type: 'module' }
    );
    return this.offsetWorker;
  }

  /**
   * Offsets (expands/contracts) polygon rings by a given distance.
   * Uses vertex-normal for regular selections and morphological EDT for irregular ones.
   */
  runOffset(
    params: Omit<OffsetRequest, 'reqId'>
  ): Promise<OffsetResponse> {
    const reqId = nextReqId++;
    const worker = this.getOffsetWorker();

    return new Promise<OffsetResponse>((resolve) => {
      const handler = (ev: MessageEvent<OffsetResponse>) => {
        if (ev.data.reqId === reqId) {
          worker.removeEventListener('message', handler);
          resolve(ev.data);
        }
      };
      worker.addEventListener('message', handler);

      const msg: OffsetRequest = { ...params, reqId };
      worker.postMessage(msg);
    });
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  /** Terminate all workers. Idempotent. */
  dispose(): void {
    if (this.alphaWorker) { this.alphaWorker.terminate(); this.alphaWorker = null; }
    if (this.offsetWorker) { this.offsetWorker.terminate(); this.offsetWorker = null; }
  }
}

/** Singleton instance — shared across all ClipOptions command invocations. */
export const clipComputeClient = new ClipComputeClient();
