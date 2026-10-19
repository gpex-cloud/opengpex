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
 * @jsquash/avif Worker client — Encode RGBA → AVIF AND decode AVIF → raw
 * pixels, off main thread, in one dedicated crash-isolated Worker.
 *
 * Static Worker at /ext/wasm/avif/avif-worker.js (source:
 * core/files/workers/avif-worker.js, synced by postinstall-exts.mjs).
 * ST encoder (avif_enc.js) + libavif decoder (avif_dec.js), both
 * ALLOW_MEMORY_GROWTH, crash-isolated from the shared vips singleton.
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
 *
 * `rgbaData` is 8-bit (`Uint8Array`) for the SDR lane, or 10-bit (`Uint16Array`,
 * PQ code values 0..1023, BT.2020 primaries) for the HDR lane — the latter sets
 * `options.bitDepth: 10` so the encoder reads the buffer as 16-bit words.
 */
export async function encodeAvifJsquash(
  rgbaData: Uint8Array | Uint16Array,
  width: number,
  height: number,
  options: { quality?: number; speed?: number; bitDepth?: number },
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

    // Copy in the buffer's own element type — the structured clone must carry
    // the exact typed payload (a Uint16Array clone stays a Uint16Array).
    const Ctor = rgbaData.constructor as new (length: number) => Uint8Array | Uint16Array;
    const copy = new Ctor(rgbaData.length);
    copy.set(rgbaData);
    worker.postMessage({ id, rgbaData: copy, width, height, options }, [copy.buffer]);
  });
}

export interface AvifDecodedNative {
  /** RGBA pixels at NATIVE depth (0..2^bitDepth−1, probe-calibrated — NOT ×64). */
  pixels: Uint16Array | Uint8ClampedArray;
  width: number;
  height: number;
  isU16: boolean;
  bitDepth: number;
}

/**
 * Decode AVIF → raw RGBA at the requested bit depth via the shared codec
 * Worker. `bitDepth` 10/12 returns native-scale `Uint16Array`; 8 returns an
 * ImageData-shaped 8-bit buffer. The worker keeps the decoder module warm
 * after the first call (cold first-decode is ~5× steady-state — probe B6).
 */
export async function decodeAvifJsquash(
  avifBytes: ArrayBuffer,
  bitDepth: 8 | 10 | 12 | 16 = 8,
): Promise<AvifDecodedNative> {
  const worker = getAvifWorker();
  const id = ++_avifReqId;

  return new Promise<AvifDecodedNative>((resolve, reject) => {
    const onMessage = (e: MessageEvent) => {
      if (e.data.id !== id) return;
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      if (e.data.error) {
        reject(new Error(e.data.error));
      } else {
        resolve({
          pixels: e.data.pixels,
          width: e.data.width,
          height: e.data.height,
          isU16: e.data.isU16,
          bitDepth: e.data.bitDepth,
        });
      }
    };
    const onError = (e: ErrorEvent) => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      reject(new Error(`[AvifWorker] ${e.message || 'Unknown error'}`));
    };

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);

    // copy: the caller's buffer may be the File's — never detach it
    const copy = avifBytes.slice(0);
    worker.postMessage({ id, op: 'decode', avifBytes: copy, bitDepth }, [copy]);
  });
}
