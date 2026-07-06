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
 * GIF Format Handler.
 *
 * Responsibilities:
 * - Decode: single-frame GIF → browser-native (no transcoding);
 *           multi-frame GIF → gifuct-js parse + composite → individual frame PNG blobs
 * - Encode: RGBA frames → GIF binary via gifenc (NeuQuant + LZW)
 * - Metadata: frame count, total duration, loop count (main-thread header parse)
 *
 * Runtime loading model (heic-to pattern):
 * gifuct-js and gifenc are loaded from /ext/js/ at first use via <script> tag.
 * They are NOT bundled into the main JS bundle — avoiding wrangler bundle bloat.
 * postinstall-exts.mjs wraps their CJS builds into IIFE globals:
 *   - window.gifuctJs: { parseGIF, decompressFrames }
 *   - window.gifenc: { GIFEncoder, quantize, applyPalette, ... }
 */

import type {
  ImageFormatHandler,
  ImageMetadata,
  DecodeOptions,
  DecodeResult,
  EncodeOptions,
} from '../types';
import { bitmapToCanvas } from '../index';

// ═══════════════════════════════════════════════════════════════════════════════
// Dynamic Script Loading (same pattern as heic-to)
// ═══════════════════════════════════════════════════════════════════════════════

let gifuctLoaded = false;
let gifencLoaded = false;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('loadScript: no document (SSR context)'));
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.head.appendChild(script);
  });
}

interface GifuctJsGlobals {
  parseGIF: (buffer: ArrayBuffer) => unknown;
  decompressFrames: (gif: unknown, buildPatches: boolean) => Array<{
    patch: Uint8Array;
    dims: { left: number; top: number; width: number; height: number };
    delay: number;
    disposalType: number;
  }>;
}

interface GifencGlobals {
  GIFEncoder: (opts?: { auto?: boolean }) => {
    writeFrame(index: Uint8Array, width: number, height: number, opts?: Record<string, unknown>): void;
    finish(): void;
    bytes(): Uint8Array;
  };
  quantize: (rgba: Uint8Array, maxColors: number) => number[][];
  applyPalette: (rgba: Uint8Array, palette: number[][]) => Uint8Array;
}

async function ensureGifuctJs(): Promise<GifuctJsGlobals> {
  const win = window as unknown as Record<string, unknown>;
  if (!gifuctLoaded) {
    if (!win.gifuctJs) {
      await loadScript('/ext/js/gifuct-js.js');
      let retries = 0;
      while (!win.gifuctJs && retries < 50) {
        await new Promise(r => setTimeout(r, 50));
        retries++;
      }
    }
    gifuctLoaded = true;
  }
  if (!win.gifuctJs) throw new Error('[GifHandler] gifuct-js library not available');
  return win.gifuctJs as unknown as GifuctJsGlobals;
}

async function ensureGifenc(): Promise<GifencGlobals> {
  const win = window as unknown as Record<string, unknown>;
  if (!gifencLoaded) {
    if (!win.gifenc) {
      await loadScript('/ext/js/gifenc.js');
      let retries = 0;
      while (!win.gifenc && retries < 50) {
        await new Promise(r => setTimeout(r, 50));
        retries++;
      }
    }
    gifencLoaded = true;
  }
  if (!win.gifenc) throw new Error('[GifHandler] gifenc library not available');
  return win.gifenc as unknown as GifencGlobals;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GIF Handler
// ═══════════════════════════════════════════════════════════════════════════════

export class GifHandler implements ImageFormatHandler {
  readonly format = 'gif';
  readonly mimeTypes = ['image/gif'];
  readonly extensions = ['gif'];
  readonly needsTranscoding = false;

  // ─── Decode ──────────────────────────────────────────────────────────────

  async decode(file: File, _options?: DecodeOptions): Promise<DecodeResult> {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const frameCount = quickFrameCount(bytes);

    // Get dimensions via browser-native decode
    const img = await createImageBitmap(file);
    const dimensions = { w: img.width, h: img.height };
    img.close();

    const metadata = await this.extractMetadata(file);

    // Single-frame GIF → return as-is
    if (frameCount <= 1) {
      return { safeFile: file, dimensions, metadata };
    }

    // Multi-frame GIF → decode via gifuct-js
    const gifuctJs = await ensureGifuctJs();
    const { width, height, frames: rawFrames } = decodeGifFrames(bytes, gifuctJs);

    // Convert each RGBA frame to PNG Blob
    const frames = await Promise.all(
      rawFrames.map(async (frame) => {
        const blob = await rgbaToBlob(frame.data, width, height);
        return { blob, delay: frame.delay, index: frame.index };
      }),
    );

    const firstFrameFile = new File(
      [frames[0].blob],
      file.name.replace(/\.gif$/i, '_frame0.png'),
      { type: 'image/png' },
    );

    return {
      safeFile: firstFrameFile,
      dimensions: { w: width, h: height },
      metadata,
      frames,
    };
  }

  // ─── Encode ──────────────────────────────────────────────────────────────

  async encode(
    source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
    _options: EncodeOptions,
  ): Promise<Blob> {
    const gifenc = await ensureGifenc();
    const canvas = source instanceof ImageBitmap ? bitmapToCanvas(source) : source;
    const ctx = (canvas as OffscreenCanvas).getContext('2d')!;
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const rgba = new Uint8Array(imageData.data.buffer);

    const gif = gifenc.GIFEncoder();
    const palette = gifenc.quantize(rgba, 256);
    const indexed = gifenc.applyPalette(rgba, palette);

    gif.writeFrame(indexed, canvas.width, canvas.height, { palette, delay: 100 });
    gif.finish();

    const output = gif.bytes();
    return new Blob([output.buffer as ArrayBuffer], { type: 'image/gif' });
  }

  // ─── Multi-frame Encode (Animated GIF) ───────────────────────────────────

  /**
   * Encode multiple RGBA frames into an animated GIF.
   * @param frames - Array of { rgba: Uint8Array, width, height, delay (ms) }
   * @param options - { loop?: number (0=infinite), maxColors?: number }
   * @returns Animated GIF Blob
   */
  async encodeSequence(
    frames: Array<{ rgba: Uint8Array; width: number; height: number; delay: number }>,
    options?: { loop?: number; maxColors?: number },
  ): Promise<Blob> {
    const gifenc = await ensureGifenc();
    const maxColors = options?.maxColors || 256;

    const gif = gifenc.GIFEncoder();

    for (const frame of frames) {
      const palette = gifenc.quantize(frame.rgba, maxColors);
      const indexed = gifenc.applyPalette(frame.rgba, palette);
      gif.writeFrame(indexed, frame.width, frame.height, {
        palette,
        delay: frame.delay,
      });
    }

    gif.finish();
    const output = gif.bytes();
    return new Blob([output.buffer as ArrayBuffer], { type: 'image/gif' });
  }

  // ─── Frame Rate Calculation ──────────────────────────────────────────────

  /**
   * Calculate the effective FPS from an array of frame delays (in ms).
   * Handles variable delays by computing the average.
   * @param delays - Array of per-frame delays in milliseconds
   * @returns Rounded FPS value, clamped to [1, 60]
   */
  static calculateFps(delays: number[]): number {
    if (!delays || delays.length === 0) return 10; // Default 10fps
    const totalDelay = delays.reduce((sum, d) => sum + (d || 100), 0);
    const avgDelay = totalDelay / delays.length;
    if (avgDelay <= 0) return 10;
    const fps = Math.round(1000 / avgDelay);
    return Math.max(1, Math.min(60, fps));
  }

  // ─── Metadata Extraction ─────────────────────────────────────────────────

  async extractMetadata(file: File): Promise<ImageMetadata> {
    return {
      version: 1,
      sourceFormat: 'gif',
      sourceFileName: file.name,
      sourceFileSize: file.size,
      dpi: 72,
      dpiSource: 'default',
      colorSpace: 'srgb',
      bitDepth: 8,
      hasAlpha: true,
      hasIccProfile: false,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GIF Decode: gifuct-js frame compositing
// ═══════════════════════════════════════════════════════════════════════════════

interface DecodedFrame {
  data: Uint8Array;
  delay: number;
  index: number;
}

function decodeGifFrames(bytes: Uint8Array, gifuctJs: GifuctJsGlobals): {
  width: number;
  height: number;
  frames: DecodedFrame[];
} {
  const gif = gifuctJs.parseGIF(bytes.buffer as ArrayBuffer) as { lsd: { width: number; height: number } };
  const rawFrames = gifuctJs.decompressFrames(gif, true);

  if (!rawFrames || rawFrames.length === 0) {
    throw new Error('GIF contains no frames');
  }

  const width = gif.lsd.width;
  const height = gif.lsd.height;

  const canvas = new Uint8Array(width * height * 4);
  const previousCanvas = new Uint8Array(width * height * 4);
  const frames: DecodedFrame[] = [];

  for (let i = 0; i < rawFrames.length; i++) {
    const frame = rawFrames[i];
    const { left, top, width: fw, height: fh } = frame.dims;
    const disposalType = frame.disposalType;

    if (disposalType === 3) {
      previousCanvas.set(canvas);
    }

    const patch = frame.patch;
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        const srcIdx = (y * fw + x) * 4;
        const dstIdx = ((top + y) * width + (left + x)) * 4;
        if (patch[srcIdx + 3] !== 0) {
          canvas[dstIdx] = patch[srcIdx];
          canvas[dstIdx + 1] = patch[srcIdx + 1];
          canvas[dstIdx + 2] = patch[srcIdx + 2];
          canvas[dstIdx + 3] = patch[srcIdx + 3];
        }
      }
    }

    const frameData = new Uint8Array(canvas.length);
    frameData.set(canvas);
    // gifuct-js decompressFrames already converts GCE delay to ms:
    // (gce.delay || 10) * 10. So frame.delay is already in ms.
    // Minimum 20ms (browsers cap at ~10ms for GIF rendering anyway).
    const delay = Math.max(frame.delay || 100, 20);
    frames.push({ data: frameData, delay, index: i });

    switch (disposalType) {
      case 2:
        for (let y = 0; y < fh; y++) {
          for (let x = 0; x < fw; x++) {
            const dstIdx = ((top + y) * width + (left + x)) * 4;
            canvas[dstIdx] = 0;
            canvas[dstIdx + 1] = 0;
            canvas[dstIdx + 2] = 0;
            canvas[dstIdx + 3] = 0;
          }
        }
        break;
      case 3:
        canvas.set(previousCanvas);
        break;
    }
  }

  return { width, height, frames };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Utility: RGBA → PNG Blob
// ═══════════════════════════════════════════════════════════════════════════════

async function rgbaToBlob(rgba: Uint8Array, width: number, height: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  const clamped = new Uint8ClampedArray(width * height * 4);
  clamped.set(rgba.subarray(0, width * height * 4));
  const imageData = new ImageData(clamped, width, height);
  ctx.putImageData(imageData, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Utility: Quick frame count (lightweight binary scan, no library needed)
// ═══════════════════════════════════════════════════════════════════════════════

function quickFrameCount(bytes: Uint8Array): number {
  if (bytes.length < 13) return 0;
  const sig = String.fromCharCode(bytes[0], bytes[1], bytes[2]);
  if (sig !== 'GIF') return 0;

  let count = 0;
  let pos = 13;

  const flags = bytes[10];
  const hasGCT = (flags & 0x80) !== 0;
  if (hasGCT) {
    pos += 3 * (1 << ((flags & 0x07) + 1));
  }

  while (pos < bytes.length) {
    const block = bytes[pos];

    if (block === 0x2C) {
      count++;
      pos += 10;
      if (pos < bytes.length) {
        const lctFlags = bytes[pos - 1];
        if ((lctFlags & 0x80) !== 0) {
          pos += 3 * (1 << ((lctFlags & 0x07) + 1));
        }
      }
      pos += 1;
      while (pos < bytes.length) {
        const blockSize = bytes[pos];
        pos += 1;
        if (blockSize === 0) break;
        pos += blockSize;
      }
    } else if (block === 0x21) {
      pos += 2;
      while (pos < bytes.length) {
        const blockSize = bytes[pos];
        pos += 1;
        if (blockSize === 0) break;
        pos += blockSize;
      }
    } else if (block === 0x3B) {
      break;
    } else {
      break;
    }
  }

  return count;
}
