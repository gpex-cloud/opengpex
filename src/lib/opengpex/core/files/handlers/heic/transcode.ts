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
 * HEIC proxy container production (heic-worker + PNG iCCP tagging).
 *
 * Pipeline: heic-worker (libheif wasm, RGBA-8 direct — no canvas round-trip,
 * which was the wash-out mechanism of the retired JPEG-q0.95 transcode path) →
 * PNG encode via a dumb canvas (`putImageData` is a raw copy: values stay
 * verbatim source-encoded) → iCCP injection so the container TAG matches the
 * values. 数值保留 + 标签贴对.
 *
 * Gamut policy:
 *   - srgb / display-p3 (the only real-world HEIC sources): pixels pass
 *     through, the stock profile matching the source gamut is embedded;
 *   - adobe-rgb / prophoto-rgb (type-reachable, not seen in practice): the
 *     standing wide-gamut composition applies — pixels fold to Display P3 via
 *     {@link renderDisplayProxy} (f16 high-depth lift is the caller's concern,
 *     fed by the `rgba` returned here).
 */

import type { GamutId } from '@opengpex/editor/core/types';
import { getStockIccProfile, injectPngIccProfile } from '../../shared/icc';
import { renderDisplayProxy } from '../../shared/lib-custom';

/** Result of the HEIC proxy transcode — proxy container plus the raw pixels. */
export interface HeicTranscodeResult {
  /** 1:1 PNG proxy with the colour tag matching the pixel encoding. */
  displayBlob: Blob;
  width: number;
  height: number;
  /**
   * Source-encoded RGBA-8 pixels, verbatim from the worker (already upright:
   * libheif applies irot/imir + EXIF orientation). The wide-gamut caller
   * consumes this for the f16-linear lift; standard callers ignore it.
   */
  rgba: Uint8ClampedArray;
}

/**
 * Transcode a HEIC file to its display proxy: decode via heic-worker, then
 * produce the gamut-appropriate PNG container (iCCP-tagged for standard
 * gamuts, P3-folded for wide gamuts).
 */
export async function convertHeicToBlob(file: File, gamut: GamutId): Promise<HeicTranscodeResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const out = await heicWorkerCall<{ rgba: Uint8ClampedArray; width: number; height: number }>(
    'decodeProxy',
    [bytes],
    [bytes.buffer],
  );
  return { ...await buildGamutProxy(out.rgba, out.width, out.height, gamut), rgba: out.rgba };
}

/**
 * Gamut-appropriate proxy container from raw source-encoded pixels — the
 * shared tail of BOTH HEIC channels (libheif proxy and WebCodecs hard decode):
 * wide gamut folds to working P3; standard gamuts dumb-encode PNG (values
 * verbatim) and tag via iCCP.
 */
export async function buildGamutProxy(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  gamut: GamutId,
): Promise<{ displayBlob: Blob; width: number; height: number }> {
  if (gamut === 'adobe-rgb' || gamut === 'prophoto-rgb') {
    // Wide gamut: fold source → working P3 via the standing wide-gamut path.
    return { displayBlob: await renderDisplayProxy(rgba, width, height, gamut), width, height };
  }
  return { displayBlob: await encodeTaggedPng(rgba, width, height, gamut), width, height };
}

/**
 * Dumb-encode PNG (values verbatim) + inject the stock ICC profile matching
 * `gamut`. The single tagging path for every HEIC channel.
 */
export async function encodeTaggedPng(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  gamut: GamutId,
): Promise<Blob> {
  const png = await encodePngRaw(rgba, width, height);
  const profile = getStockIccProfile(gamut);
  const tagged = profile ? await injectPngIccProfile(png, profile) : png;
  return new Blob([tagged as BlobPart], { type: 'image/png' });
}

/**
 * Encode RGBA-8 pixels to PNG with NO colour management — the canvas is purely
 * a dumb encoder (`putImageData` copies values verbatim; it never converts).
 * The colour identity enters the container afterwards, via iCCP injection.
 */
async function encodePngRaw(rgba: Uint8ClampedArray, width: number, height: number): Promise<Uint8Array> {
  // Fresh Uint8ClampedArray over a plain ArrayBuffer — required by the
  // ImageData constructor (the transferred worker buffer types as SharedArrayBuffer-able).
  const clamped = new Uint8ClampedArray(width * height * 4);
  clamped.set(rgba);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(new ImageData(clamped, width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

// ═══════════════════════════════════════════════════════════════════════════════
// heic-worker client
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Thin wrapper around heic-worker.js (classic worker: it uses importScripts).
 * Protocol: { id, fn, args } → { id, out } | { id, error } — isomorphic with
 * the other files-layer workers. Not exported directly — callers share the
 * process-wide singleton (one worker serves BOTH HEIC channels; libheif's
 * ~3 MB wasm heap initializes lazily inside it, mirroring getLibVips's
 * sharing rationale).
 */
class HeicWorker {
  private worker: Worker;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 0;

  constructor() {
    this.worker = new Worker('/ext/wasm/libheif/heic-worker.js');
    this.worker.onmessage = ({ data: msg }) => {
      const pending = this.pending.get(msg?.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg?.error) pending.reject(new Error(msg.error));
      else pending.resolve(msg.out);
    };
  }

  call(fn: string, args: unknown[], transfer: ArrayBuffer[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, fn, args }, transfer);
    });
  }
}

let sharedHeicWorker: HeicWorker | null = null;

/** Call one function on the shared HEIC worker (both channels' single entry). */
export function heicWorkerCall<T>(fn: string, args: unknown[], transfer: ArrayBuffer[] = []): Promise<T> {
  if (!sharedHeicWorker) sharedHeicWorker = new HeicWorker();
  return sharedHeicWorker.call(fn, args, transfer) as Promise<T>;
}
