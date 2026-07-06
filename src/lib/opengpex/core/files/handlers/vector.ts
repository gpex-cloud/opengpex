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
 * Vector Format Handler (SVG + EPS).
 *
 * Responsibilities:
 * - Decode: SVG/EPS → PNG rasterization via WorkerProxy (resvg-wasm / Ghostscript WASM)
 * - Encode: NOT supported (vector output requires dedicated export pipeline)
 * - Metadata: intrinsic size parsing from file header (main thread, <1ms)
 *
 * Thread model: Decode dispatches heavy rasterization to Worker.
 * Size detection runs on main thread (reads first 8KB header only).
 */

import type {
  ImageFormatHandler,
  ImageMetadata,
  DecodeOptions,
  DecodeResult,
  EncodeOptions,
} from '../types';

export class VectorHandler implements ImageFormatHandler {
  readonly format = 'vector';
  readonly needsTranscoding = true;
  readonly mimeTypes = ['image/svg+xml', 'application/postscript', 'application/eps', 'image/x-eps'];
  readonly extensions = ['svg', 'eps', 'epsf'];

  private transcoderWorker = new TranscoderWorker();

  // ─── Decode ──────────────────────────────────────────────────────────────

  async decode(file: File, options?: DecodeOptions): Promise<DecodeResult> {
    // 0. Mark internal codec (SVG/EPS → PNG rasterization)
    const metadata = await this.extractMetadata(file);
    metadata.internalCodec = 'image/png';

    // 1. Main thread: fast intrinsic size detection
    const intrinsicSize = await getVectorIntrinsicSize(file);

    // Determine target rasterization dimensions
    const targetW = options?.targetWidth || Math.round(intrinsicSize.w);
    const targetH = options?.targetHeight || Math.round(intrinsicSize.h);

    // 2. Worker thread: heavy rasterization
    const vectorFormat = detectVectorFormat(file);

    let pngBytes: Uint8Array;
    if (vectorFormat === 'svg') {
      const svgText = await file.text();
      pngBytes = await this.transcoderWorker.call('transcodeSvg', svgText, {
        width: targetW,
        height: targetH,
      });
    } else if (vectorFormat === 'eps') {
      const epsBytes = new Uint8Array(await file.arrayBuffer());
      pngBytes = await this.transcoderWorker.call('transcodeEps', epsBytes, {
        width: targetW,
        height: targetH,
        dpi: 72,
      });
    } else {
      throw new Error(`[VectorHandler] Unsupported vector format: ${file.type}`);
    }

    // 3. Wrap result
    const safeFile = new File(
      [pngBytes as BlobPart],
      file.name.replace(/\.(svg|eps|epsf)$/i, '.png'),
      { type: 'image/png' },
    );

    return {
      safeFile,
      dimensions: { w: targetW, h: targetH },
      metadata,
    };
  }

  // ─── Encode (not supported) ──────────────────────────────────────────────

  async encode(
    _source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
    _options: EncodeOptions,
  ): Promise<Blob> {
    throw new Error('[VectorHandler] Vector encoding requires dedicated SVG export pipeline.');
  }

  // ─── Metadata Extraction ─────────────────────────────────────────────────

  async extractMetadata(file: File): Promise<ImageMetadata> {
    const vectorFormat = detectVectorFormat(file);
    const sourceFormat = vectorFormat === 'eps' ? 'eps' as const : 'svg' as const;

    const base: ImageMetadata = {
      version: 1,
      sourceFormat,
      sourceFileName: file.name,
      sourceFileSize: file.size,
      dpi: 72, // Vector default (points-based)
      dpiSource: 'default',
      colorSpace: 'srgb',
      bitDepth: 8,
      hasAlpha: true, // SVG/EPS typically support transparency
      hasIccProfile: false,
    };

    return base;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TranscoderWorker — dedicated Worker proxy for SVG/EPS rasterization
// ═══════════════════════════════════════════════════════════════════════════════

const RESVG_WORKER_URL = '/ext/wasm/resvg/resvg-worker.js';
const GS_WORKER_URL = '/ext/wasm/gs/gs-worker.js';
const IDLE_TIMEOUT_MS = 30_000; // Release worker after 30s idle

/**
 * Lazy-loaded, self-managing Worker proxy for vector transcoding.
 * Routes SVG calls to resvg-worker, EPS calls to gs-worker.
 * Each worker spawns on first use and auto-terminates after idle timeout.
 * Protocol: { id, fn, args } → { id, out } | { id, error }
 */
class TranscoderWorker {
  private resvgWorker: Worker | null = null;
  private gsWorker: Worker | null = null;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private resvgIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private gsIdleTimer: ReturnType<typeof setTimeout> | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async call(fn: string, ...args: unknown[]): Promise<any> {
    const isEps = fn === 'transcodeEps';
    const worker = isEps ? this.ensureGsWorker() : this.ensureResvgWorker();
    this.resetIdleTimer(isEps);

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, fn, args });
    });
  }

  private ensureResvgWorker(): Worker {
    if (!this.resvgWorker) {
      this.resvgWorker = new Worker(RESVG_WORKER_URL, { type: 'module' });
      this.wireWorker(this.resvgWorker, 'resvg');
    }
    return this.resvgWorker;
  }

  private ensureGsWorker(): Worker {
    if (!this.gsWorker) {
      this.gsWorker = new Worker(GS_WORKER_URL, { type: 'module' });
      this.wireWorker(this.gsWorker, 'gs');
    }
    return this.gsWorker;
  }

  private wireWorker(worker: Worker, label: string) {
    worker.onmessage = (e: MessageEvent) => {
      const { id, out, error } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (error) p.reject(new Error(error));
      else p.resolve(out);
    };
    worker.onerror = (e) => {
      for (const p of this.pending.values()) {
        p.reject(new Error(`[TranscoderWorker:${label}] ${e.message}`));
      }
      this.pending.clear();
    };
  }

  private resetIdleTimer(isEps: boolean) {
    if (isEps) {
      if (this.gsIdleTimer) clearTimeout(this.gsIdleTimer);
      this.gsIdleTimer = setTimeout(() => this.terminateGs(), IDLE_TIMEOUT_MS);
    } else {
      if (this.resvgIdleTimer) clearTimeout(this.resvgIdleTimer);
      this.resvgIdleTimer = setTimeout(() => this.terminateResvg(), IDLE_TIMEOUT_MS);
    }
  }

  private terminateResvg() {
    if (this.resvgWorker) { this.resvgWorker.terminate(); this.resvgWorker = null; }
    this.resvgIdleTimer = null;
  }

  private terminateGs() {
    if (this.gsWorker) { this.gsWorker.terminate(); this.gsWorker = null; }
    this.gsIdleTimer = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Vector Intrinsic Size Helpers (inlined from helpers/vector.ts)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Gets the intrinsic (natural) size of a vector file in points.
 * Reads only the first 8KB header — no WASM or Worker needed.
 */
export async function getVectorIntrinsicSize(file: File): Promise<{ w: number; h: number }> {
  const format = detectVectorFormat(file);
  const headerSlice = file.slice(0, 8192);
  const headerText = await headerSlice.text();

  if (format === 'svg') return parseSvgSize(headerText);
  if (format === 'eps') return parseEpsBoundingBox(headerText);

  throw new Error(`[vector] Unsupported vector format: ${file.type || file.name}`);
}

/**
 * Detects vector format from MIME type or file extension.
 */
export function detectVectorFormat(file: File): 'svg' | 'eps' | null {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();

  if (type === 'image/svg+xml' || name.endsWith('.svg')) return 'svg';
  if (
    type === 'application/postscript' ||
    type === 'application/eps' ||
    type === 'image/x-eps' ||
    name.endsWith('.eps') ||
    name.endsWith('.epsf')
  ) return 'eps';

  return null;
}

function parseSvgSize(headerText: string): { w: number; h: number } {
  try {
    const doc = new DOMParser().parseFromString(headerText, 'image/svg+xml');
    const svg = doc.querySelector('svg');
    if (svg) {
      const widthAttr = svg.getAttribute('width');
      const heightAttr = svg.getAttribute('height');
      const viewBox = svg.getAttribute('viewBox');

      if (widthAttr && heightAttr) {
        const w = parseSvgLength(widthAttr);
        const h = parseSvgLength(heightAttr);
        if (w > 0 && h > 0) return { w, h };
      }

      if (viewBox) {
        const parts = viewBox.trim().split(/[\s,]+/).map(Number);
        if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
          return { w: parts[2], h: parts[3] };
        }
      }
    }
  } catch { /* DOMParser failed, try regex */ }

  return parseSvgSizeRegex(headerText);
}

function parseSvgSizeRegex(text: string): { w: number; h: number } {
  const vbMatch = text.match(/viewBox\s*=\s*["']([^"']+)["']/i);
  if (vbMatch) {
    const parts = vbMatch[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return { w: parts[2], h: parts[3] };
    }
  }

  const wMatch = text.match(/\bwidth\s*=\s*["']([^"']+)["']/i);
  const hMatch = text.match(/\bheight\s*=\s*["']([^"']+)["']/i);
  if (wMatch && hMatch) {
    const w = parseSvgLength(wMatch[1]);
    const h = parseSvgLength(hMatch[1]);
    if (w > 0 && h > 0) return { w, h };
  }

  return { w: 300, h: 150 };
}

function parseSvgLength(value: string): number {
  const numMatch = value.trim().match(/^([0-9]*\.?[0-9]+)\s*(px|pt|in|cm|mm|em|ex|%)?$/i);
  if (!numMatch) return 0;

  const num = parseFloat(numMatch[1]);
  const unit = (numMatch[2] || 'px').toLowerCase();

  switch (unit) {
    case 'px': return num;
    case 'pt': return num * (96 / 72);
    case 'in': return num * 96;
    case 'cm': return num * (96 / 2.54);
    case 'mm': return num * (96 / 25.4);
    case 'em': return num * 16;
    case 'ex': return num * 8;
    case '%': return 0;
    default: return num;
  }
}

function parseEpsBoundingBox(headerText: string): { w: number; h: number } {
  const hiresBBMatch = headerText.match(/%%HiResBoundingBox:\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (hiresBBMatch) {
    const [, llx, lly, urx, ury] = hiresBBMatch.map(Number);
    const w = urx - llx;
    const h = ury - lly;
    if (w > 0 && h > 0) return { w, h };
  }

  const bbMatch = headerText.match(/%%BoundingBox:\s*(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/);
  if (bbMatch) {
    const [, llx, lly, urx, ury] = bbMatch.map(Number);
    const w = urx - llx;
    const h = ury - lly;
    if (w > 0 && h > 0) return { w, h };
  }

  throw new Error('[vector] EPS file missing %%BoundingBox comment');
}
