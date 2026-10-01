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
 * Mosaic Bake Pipeline
 *
 * Executes the bake process for completed mosaic strokes: offloaded to a plugin
 * Worker (composite + bounds + encode), then finalized on the main thread
 * (register asset + writeBitmap + CMD_BAKE). Main thread blocking reduced from
 * ~80-220ms to <5ms.
 */

import type { InteractionEvent, Layer } from '@opengpex/editor/core/types';
import { asLocalShape } from '@opengpex/editor/core/types';
import { _CMD_BAKE_UID } from '../protocols';
import type { BakeRequest, PaintBakeRequest, BakeWorkerRequest, BakeWorkerResult } from './types';

/** Command UID (from protocols, Single Source of Truth) */
const CMD_BAKE_UID = _CMD_BAKE_UID;

// ─── BakeWorkerClient ──────────────────────────────────────────────────────────

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
const bakeWorkerClient = new BakeWorkerClient();

// ─── Main Entry ────────────────────────────────────────────────────────────────

/**
 * Executes the bake process for a completed mosaic stroke.
 */
export async function executeBake(request: BakeRequest, e: InteractionEvent): Promise<void> {
  await executePaintBake(request, e);
}

// ─── Paint Bake ────────────────────────────────────────────────────────────────

async function executePaintBake(request: PaintBakeRequest, e: InteractionEvent): Promise<void> {
  const { strokeBitmap, targetLayer, isNewLayer, canvasSize, strokeDirtyRect } = request;
  const frame = e.activeFrame;

  // ── Phase 1: Prepare transferables (main thread, <2ms) ──
  let existingBitmap: ImageBitmap | null = null;
  let existingLayerRect: { x: number; y: number; w: number; h: number } | null = null;
  let existingLayerBounding: { w: number; h: number; cx: number; cy: number } | null = null;

  if (targetLayer.src && !isNewLayer) {
    try {
      existingBitmap = await e.pixels.image.acquireOwned(targetLayer.src);
      if (existingBitmap) {
        const drawX = canvasSize.w / 2 + targetLayer.cx - targetLayer.bounding.w / 2;
        const drawY = canvasSize.h / 2 + targetLayer.cy - targetLayer.bounding.h / 2;
        existingLayerRect = { x: drawX, y: drawY, w: targetLayer.bounding.w, h: targetLayer.bounding.h };
        existingLayerBounding = { w: targetLayer.bounding.w, h: targetLayer.bounding.h, cx: targetLayer.cx, cy: targetLayer.cy };
      }
    } catch (loadErr) {
      console.warn('[MosaicOverlay] Failed to acquireOwned existing layer bitmap:', loadErr);
    }
  }

  // ── Phase 2: Plugin Worker (main thread free) ──
  const result = await bakeWorkerClient.execute({
    existingBitmap,
    existingLayerRect,
    strokeBitmap,
    canvasSize,
    isNewLayer,
    strokeDirtyRect,
    existingLayerBounding,
  });

  // ── Phase 3: Finalize on main thread (<2ms) ──
  const asset = await e.assets.register(result.blob, {
    width: result.cropW,
    height: result.cropH,
    precomputedHash: result.hash,
  });
  e.pixels.image.writeBitmap(asset.url, result.bitmap);

  const cropCenterLocalX = result.cropX + result.cropW / 2;
  const cropCenterLocalY = result.cropY + result.cropH / 2;

  const completeLayer: Layer = {
    ...targetLayer,
    assetId: asset.assetId,
    src: asset.url,
    bounding: { w: result.cropW, h: result.cropH },
    visibleShape: asLocalShape({ x: 0, y: 0, w: result.cropW, h: result.cropH }),
    cx: cropCenterLocalX - canvasSize.w / 2,
    cy: cropCenterLocalY - canvasSize.h / 2,
  };

  e.actions.executeCommand(CMD_BAKE_UID, {
    frameId: frame.id,
    layer: completeLayer,
    isNew: isNewLayer,
  });
}
