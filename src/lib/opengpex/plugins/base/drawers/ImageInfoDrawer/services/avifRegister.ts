/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * AVIF encoder registration — attaches the plugin-owned AVIF worker as an external
 * encoder on PixelService, so that `pixels.render.shapeToBlob({format:'image/avif'})`
 * routes through this plugin's dedicated wasm-avif worker.
 *
 * Registration is idempotent (guarded flag) and lazy — happens on first export attempt.
 *
 * See docs/opengpex/plans/20260710_export_pipeline_refactor_proposal.md §9.1
 * for the eventual promotion of AVIF into core FileService.
 */

import type { PixelService } from '@opengpex/editor/core/types';

let registered = false;

export function ensureAvifEncoderRegistered(pixels: PixelService) {
  if (registered) return;
  registered = true;

  pixels.render.registerEncoder('image/avif', (bitmap, options) => {
    const avifWorker = new Worker(new URL('../workers/avif.worker.ts', import.meta.url), { type: 'module' });
    return new Promise<Blob>((resolve, reject) => {
      avifWorker.onmessage = (e) => {
        if (e.data.success) {
          resolve(e.data.blob);
        } else {
          reject(new Error(e.data.error || 'AVIF Encoding failed in plugin worker'));
        }
        avifWorker.terminate();
      };
      avifWorker.postMessage(
        {
          action: 'ENCODE_AVIF',
          payload: {
            bitmap,
            quality: options.quality ?? 0.92,
          },
        },
        [bitmap], // Zero-copy transfer
      );
    });
  });
}
