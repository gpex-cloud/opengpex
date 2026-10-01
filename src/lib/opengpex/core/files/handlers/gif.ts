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
  DecodeOptions,
  DecodedPayload,
  EncodeOptions,
} from '../types';
import type { ImageMetadata } from '../types';
import type { IngestDecision } from '../strategy';
import { bitmapToCanvas } from '../index';
import { rgbaToBlob } from '../utils';

// ═══════════════════════════════════════════════════════════════════════════════
// Header Probe (Stage 1 — lightweight, main-thread, NO gifuct-js load)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fast-probe a GIF's logical canvas size and multi-frame flag by scanning the
 * block structure — pure in-memory parse (typically < 0.1ms), short-circuits the
 * instant a 2nd Image Descriptor (0x2C) is seen, so a multi-frame GIF need not be
 * fully walked. Distinct from `quickFrameCount` (which counts every frame): this
 * only answers "≥ 2 frames?" and additionally recovers width/height, fixing the
 * long-standing `extractMetadata` returning `0 × 0`.
 */
export function probeGifHeader(bytes: Uint8Array): {
  width: number;
  height: number;
  isMultiFrame: boolean;
} {
  if (bytes.length < 13) return { width: 0, height: 0, isMultiFrame: false };
  const sig = String.fromCharCode(bytes[0], bytes[1], bytes[2]);
  if (sig !== 'GIF') return { width: 0, height: 0, isMultiFrame: false };

  // Logical Screen Descriptor: bytes 6-9 little-endian screen width/height.
  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);

  // Skip the Global Color Table if the packed flags (byte 10) declare one.
  let pos = 13;
  const flags = bytes[10];
  if ((flags & 0x80) !== 0) {
    pos += 3 * (1 << ((flags & 0x07) + 1));
  }

  // Walk data blocks; stop at the 2nd Image Descriptor or the trailer.
  let imageCount = 0;
  while (pos < bytes.length) {
    const block = bytes[pos];
    if (block === 0x2c) {
      imageCount++;
      if (imageCount > 1) {
        return { width, height, isMultiFrame: true };
      }
      // Image Descriptor is 10 bytes; its final (packed) byte declares an LCT.
      pos += 10;
      if (pos < bytes.length) {
        const lctFlags = bytes[pos - 1];
        if ((lctFlags & 0x80) !== 0) {
          pos += 3 * (1 << ((lctFlags & 0x07) + 1));
        }
      }
      pos += 1; // LZW minimum code size byte
      while (pos < bytes.length) {
        const blockSize = bytes[pos];
        pos += 1;
        if (blockSize === 0) break;
        pos += blockSize;
      }
    } else if (block === 0x21) {
      pos += 2; // extension introducer + label
      while (pos < bytes.length) {
        const blockSize = bytes[pos];
        pos += 1;
        if (blockSize === 0) break;
        pos += blockSize;
      }
    } else {
      break; // trailer (0x3B) or corrupt/truncated stream
    }
  }

  return { width, height, isMultiFrame: false };
}

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

  // Direct-passthrough format (pure-producer contract): GIF is always 8-bit sRGB, so
  // there is no colour-strategy branching. Single vs multi-frame is decided by the
  // Stage 1 authority `metadata.isMultiFrame` (probed by `probeGifHeader`) — the
  // handler no longer re-counts frames itself. Returns naked pixels; the entry mounts
  // per-page `colorIdentity` / `sourceBlob`.
  async decode(
    file: File,
    metadata: ImageMetadata,
    _decision: IngestDecision,
    _options?: DecodeOptions,
  ): Promise<DecodedPayload[]> {
    // Single-frame GIF → return the source file as the sole page (canvas size from
    // the Stage 1 header probe; no browser decode needed).
    if (!metadata.isMultiFrame) {
      return [{ displayBlob: file, width: metadata.width, height: metadata.height, index: 0 }];
    }

    // Multi-frame GIF → composite every frame via gifuct-js.
    const bytes = new Uint8Array(await file.arrayBuffer());
    const gifuctJs = await ensureGifuctJs();
    const { width, height, frames: rawFrames } = decodeGifFrames(bytes, gifuctJs);

    // Convert each RGBA frame to a PNG Blob → a page carrying its per-frame delay.
    return Promise.all(
      rawFrames.map(async (frame) => {
        const blob = await rgbaToBlob(frame.data, width, height);
        return { displayBlob: blob, width, height, index: frame.index, delay: frame.delay };
      }),
    );
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
        repeat: options?.loop ?? 0,
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
    const probe = probeGifHeader(new Uint8Array(await file.arrayBuffer()));
    return {
      sourceFormat: 'gif',
      sourceFileName: file.name,
      sourceFileSize: file.size,
      width: probe.width,
      height: probe.height,
      dpi: 72,
      dpiSource: 'default',
      colorSpace: 'srgb',
      bitDepth: 8,
      hasAlpha: true,
      isMultiFrame: probe.isMultiFrame,
      raw: {},
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
