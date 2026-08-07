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
 * LibRaw Worker wrapper + RAW → PNG conversion.
 *
 * Thin wrapper around the pre-copied libraw-worker.js.
 * Communicates via postMessage and serializes calls in order.
 *
 * Color conversion is strategy-driven via RawColorConfig.
 */

import type { WorkingColorSpace } from '@opengpex/editor/core/types';
import type { RawImageData, LibRawSettings } from 'libraw-wasm';
import { convertImageDataColorSpace } from '@opengpex/editor/core/color/matrices';

// ═══════════════════════════════════════════════════════════════════════════════
// LibRaw Worker Class
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Thin wrapper around libraw-worker.js Worker.
 * Serializes calls and handles Worker lifecycle.
 */
class LibRaw {
  private worker: Worker;
  private pending: Map<number, { resolve: (val: unknown) => void; reject: (err: Error) => void }>;
  private nextId: number = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private disposed: boolean = false;

  constructor() {
    this.worker = new Worker('/ext/wasm/libraw/libraw-worker.js', { type: 'module' });
    this.pending = new Map();
    this.worker.onmessage = ({ data: e }) => {
      const t = this.pending.get(e?.id);
      if (t) {
        this.pending.delete(e.id);
        if (e?.error) {
          t.reject(new Error(e.error));
        } else {
          t.resolve(e?.out);
        }
      }
    };
  }

  dispose() {
    this.disposed = true;
    this.worker.terminate();
    for (const { reject } of this.pending.values()) {
      reject(new Error('LibRaw disposed'));
    }
    this.pending.clear();
  }

  private runFn(fn: string, ...args: unknown[]): Promise<unknown> {
    const n = () => new Promise<unknown>((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('LibRaw disposed'));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });

      const transferables = args.map(r => {
        if (r && typeof r === 'object' && 'buffer' in r && r.buffer instanceof ArrayBuffer) {
          return r.buffer;
        }
        if (r instanceof ArrayBuffer) {
          return r;
        }
        return null;
      }).filter((r): r is ArrayBuffer => !!r);

      this.worker.postMessage({ id, fn, args }, transferables);
    });

    const a = this.tail.then(n, n);
    this.tail = a.then(() => {}, () => {});
    return a;
  }

  async open(bytes: BufferSource, settings?: LibRawSettings): Promise<void> {
    await this.runFn('open', bytes, settings);
  }

  async imageData(): Promise<RawImageData | undefined> {
    return (await this.runFn('imageData')) as RawImageData | undefined;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RAW → PNG Conversion
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Color conversion config for RAW decode, driven by ColorPipeline strategy.
 * Ensures convertRawToBlob stays in sync with strategy table changes.
 */
export interface RawColorConfig {
  sourceColorSpace: WorkingColorSpace;
  targetColorSpace: WorkingColorSpace;
  conversion: 'none' | 'matrix' | 'icc-engine';
}

/**
 * Converts a camera RAW file to a PNG Blob.
 *
 * Supports all LibRaw formats: CR2, CR3, NEF, NRW, ARW, DNG, ORF, RW2, RAF,
 * PEF, SRW, RAW, RWL, 3FR, FFF, IIQ, and more (1200+ cameras).
 *
 * @param file - RAW file to decode
 * @param colorConfig - Strategy-driven color conversion parameters
 */
export async function convertRawToBlob(file: File, colorConfig: RawColorConfig): Promise<Blob> {
  const instance = new LibRaw();

  try {
    const buffer = await file.arrayBuffer();

    await instance.open(new Uint8Array(buffer), {
      useCameraWb: true,
      outputColor: 5,        // ProPhoto RGB (preserves full sensor gamut)
      outputBps: 8,          // 8-bit output (libraw internal processing is full-precision)
      gamm: [2.4, 12.92],   // sRGB TRC encoding (matches convertImageDataColorSpace assumptions)
      userQual: 3,           // AHD interpolation
    });

    const imageData: RawImageData | undefined = await instance.imageData();
    if (!imageData) {
      throw new Error('Failed to decode RAW image: no image data returned');
    }

    const { width, height, data, colors } = imageData;

    let rgbaData: Uint8ClampedArray<ArrayBuffer>;

    if (colors === 3) {
      rgbaData = new Uint8ClampedArray(width * height * 4);
      const src = data as Uint8Array;
      for (let i = 0, j = 0; i < src.length; i += 3, j += 4) {
        rgbaData[j] = src[i];
        rgbaData[j + 1] = src[i + 1];
        rgbaData[j + 2] = src[i + 2];
        rgbaData[j + 3] = 255;
      }
    } else {
      rgbaData = new Uint8ClampedArray(width * height * 4);
      rgbaData.set(new Uint8Array(data.buffer, data.byteOffset, width * height * 4));
    }

    // Strategy-driven color space conversion
    if (colorConfig.conversion === 'matrix') {
      convertImageDataColorSpace(rgbaData, colorConfig.sourceColorSpace, colorConfig.targetColorSpace);
    }
    // 'none' → skip conversion (future: WebGPU may keep ProPhoto pixels as-is)
    // 'icc-engine' → not applicable for RAW (libraw outputs known RGB spaces)

    // Write to canvas with correct colorSpace tagging
    const canvasCS: PredefinedColorSpace = colorConfig.targetColorSpace === 'display-p3' ? 'display-p3' : 'srgb';
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { colorSpace: canvasCS })!;
    const imgData = new ImageData(rgbaData, width, height, { colorSpace: canvasCS });
    ctx.putImageData(imgData, 0, 0);

    const blob = await canvas.convertToBlob({ type: 'image/png' });

    console.debug('[ColorMgmt] RAW decode: conversion=%s %s→%s',
      colorConfig.conversion, colorConfig.sourceColorSpace, colorConfig.targetColorSpace);

    return blob;
  } catch (error) {
    console.error('[RawHandler] Conversion failed', error);
    throw error;
  } finally {
    instance.dispose();
  }
}
