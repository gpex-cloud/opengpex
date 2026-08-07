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
 * @jsquash/avif Worker — Encode RGBA → AVIF off main thread.
 *
 * Uses a static Worker at /ext/wasm/avif/avif-worker.js.
 * ST encoder (avif_enc.js), ALLOW_MEMORY_GROWTH, crash-isolated from vips.
 */

let _avifWorker: Worker | null = null;
let _avifReqId = 0;

function getAvifWorker(): Worker {
  if (!_avifWorker) {
    _avifWorker = new Worker('/ext/wasm/avif/avif-worker.js', { type: 'module' });
  }
  return _avifWorker;
}

/**
 * Encode RGBA → AVIF via @jsquash/avif in a dedicated Worker.
 * Uses ST encoder (avif_enc.js), ALLOW_MEMORY_GROWTH, crash-isolated from vips.
 */
export async function encodeAvifJsquash(
  rgbaData: Uint8Array,
  width: number,
  height: number,
  options: { quality?: number; speed?: number },
): Promise<Uint8Array> {
  const worker = getAvifWorker();
  const id = ++_avifReqId;

  return new Promise<Uint8Array>((resolve, reject) => {
    const onMessage = (e: MessageEvent) => {
      if (e.data.id !== id) return;
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      if (e.data.error) {
        reject(new Error(e.data.error));
      } else {
        resolve(new Uint8Array(e.data.avifBytes));
      }
    };
    const onError = (e: ErrorEvent) => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      reject(new Error(`[AvifWorker] ${e.message || 'Unknown error'}`));
    };

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);

    const copy = new Uint8Array(rgbaData.byteLength);
    copy.set(new Uint8Array(rgbaData.buffer, rgbaData.byteOffset, rgbaData.byteLength));
    worker.postMessage({ id, rgbaData: copy, width, height, options }, [copy.buffer]);
  });
}
