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
 * TIFF Format Handler (wasm-vips powered).
 *
 * Supports: RGB/RGBA 8-bit (uncompressed / LZW / ZIP / JPEG), 16-bit (quantized to 8-bit),
 *           CMYK (basic conversion), BigTIFF, multi-page (first page only).
 *
 * Responsibilities:
 * - Decode: TIFF → PNG via wasm-vips Worker + IFD metadata extraction
 * - Encode: ImageData → TIFF via wasm-vips Worker (LZW/ZIP/none compression + DPI injection)
 * - Metadata: Main-thread IFD tag parsing for fast DPI/colorspace/compression info
 *
 * Thread model:
 * - Decode/Encode run heavy computation in a dedicated Worker (wasm-vips WASM ~3-5MB, loaded lazily)
 * - IFD metadata extraction runs on main thread (lightweight header-only parse, <10ms)
 *
 * Library: wasm-vips (libvips compiled to WebAssembly)
 * - Full TIFF support including JPEG compression, BigTIFF, multi-page
 * - ICC-accurate CMYK → sRGB conversion
 * - LGPL license (dynamically loaded WASM module, not statically linked)
 */

import ExifReader from 'exifreader';
import type { AssetService, WorkerProxy } from '@opengpex/editor/core/types';
import type {
  ImageFormatHandler,
  ImageMetadata,
  DecodeOptions,
  DecodeResult,
  EncodeOptions,
} from '../types';
// ICC utilities: base64ToIcc is dynamically imported in encode() for export injection

/** TIFF compression method for encoding */
export type TiffCompression = 'none' | 'lzw' | 'zip';

/** Extended encode options for TIFF */
export interface TiffEncodeOptions extends EncodeOptions {
  /** TIFF compression method (default: 'lzw') */
  tiffCompression?: TiffCompression;
}

export class TiffHandler implements ImageFormatHandler {
  readonly format = 'tiff';
  readonly needsTranscoding = true;
  readonly mimeTypes = ['image/tiff'];
  readonly extensions = ['tiff', 'tif'];

  constructor(
    private assets: AssetService,
    private workerProxy: WorkerProxy,
  ) {}

  // ─── Decode ──────────────────────────────────────────────────────────────

  async decode(file: File, _options?: DecodeOptions): Promise<DecodeResult> {
    // 1. Extract metadata first (lightweight, main thread — IFD tag parsing)
    const metadata = await this.extractMetadata(file);
    metadata.internalCodec = 'image/png';

    // 2. Decode TIFF → PNG via wasm-vips Worker
    const pngBlob = await convertTiffToBlob(file);
    const safeFile = new File(
      [pngBlob],
      file.name.replace(/\.(tiff?|tif)$/i, '.png'),
      { type: 'image/png' },
    );

    // 3. Get dimensions from transcoded result
    const img = await createImageBitmap(safeFile);
    const dimensions = { w: img.width, h: img.height };
    img.close();

    return { safeFile, dimensions, metadata };
  }

  // ─── Encode ──────────────────────────────────────────────────────────────

  async encode(
    source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
    options: EncodeOptions,
  ): Promise<Blob> {
    const tiffOpts = options as TiffEncodeOptions;
    const compression = tiffOpts.tiffCompression || 'lzw';
    const dpi = options.exportConfig?.dpi || options.metadata?.dpi || 72;

    // Get ImageData from source
    const canvas = source instanceof ImageBitmap
      ? bitmapToOffscreen(source)
      : source;

    const ctx = (canvas as OffscreenCanvas).getContext('2d')!;
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // ICC Profile for embedding
    let iccProfileBytes: Uint8Array | undefined;
    if (options.exportConfig?.embedIcc && options.metadata?.raw?.iccProfileData) {
      const { base64ToIcc: b64ToIcc } = await import('../icc');
      iccProfileBytes = b64ToIcc(options.metadata.raw.iccProfileData);
    }

    // Encode via wasm-vips Worker
    const tiffBlob = await encodeTiffFromImageData(imageData, {
      compression,
      dpi,
      width: canvas.width,
      height: canvas.height,
      iccProfileBytes,
    });

    return tiffBlob;
  }

  // ─── Metadata Extraction ─────────────────────────────────────────────────

  async extractMetadata(file: File): Promise<ImageMetadata> {
    const base: ImageMetadata = {
      version: 1,
      sourceFormat: 'tiff',
      sourceFileName: file.name,
      sourceFileSize: file.size,
      dpi: 72,
      dpiSource: 'default',
      colorSpace: 'srgb',
      bitDepth: 8,
      hasAlpha: false,
      hasIccProfile: false,
    };

    try {
      const fileBuffer = await file.arrayBuffer();
      const tags = ExifReader.load(fileBuffer, { expanded: true });

      // DPI
      const xRes = tags.exif?.XResolution?.value;
      if (xRes) {
        const resUnit = tags.exif?.ResolutionUnit?.value;
        let dpi = Array.isArray(xRes) ? xRes[0] / (xRes[1] || 1) : Number(xRes);
        if (resUnit === 3) dpi = dpi * 2.54;
        if (dpi > 1 && dpi < 10000) {
          base.dpi = Math.round(dpi);
          base.dpiSource = 'exif';
        }
      }

      // Bit depth
      const bpsTag = tags.exif?.BitsPerSample?.value;
      if (bpsTag) {
        const bps = Array.isArray(bpsTag) ? Number(bpsTag[0]) : Number(bpsTag);
        if (bps > 0) base.bitDepth = bps;
      }

      // Color space / photometric interpretation
      const photoInterp = tags.exif?.PhotometricInterpretation?.value;
      if (photoInterp != null) {
        switch (Number(photoInterp)) {
          case 5: base.colorSpace = 'cmyk'; break;
          case 1: case 0: base.colorSpace = 'grayscale'; break;
          default: base.colorSpace = 'srgb';
        }
      }

      // Alpha (use bracket access for non-standard ExifReader tags)
      if ((tags.exif as Record<string, unknown>)?.['ExtraSamples'] != null) base.hasAlpha = true;
      const spp = tags.exif?.SamplesPerPixel?.value;
      if (Number(spp) === 4 && base.colorSpace === 'srgb') base.hasAlpha = true;

      // ICC Profile
      const iccDesc = tags.icc?.['ICC Description']?.description
        || tags.icc?.ProfileDescription?.description;
      if (iccDesc) {
        base.hasIccProfile = true;
        base.raw = base.raw || {};
        base.raw.iccProfileName = String(iccDesc);

        const profileName = base.raw.iccProfileName.toLowerCase();
        if (profileName.includes('adobe') && profileName.includes('rgb')) {
          base.colorSpace = 'adobe-rgb';
        } else if (profileName.includes('display p3') || profileName.includes('p3')) {
          base.colorSpace = 'display-p3';
        } else if (profileName.includes('prophoto')) {
          base.colorSpace = 'prophoto-rgb';
        }
      }

      // Camera info
      const make = tags.exif?.Make?.description;
      const model = tags.exif?.Model?.description;
      if (make || model) {
        base.camera = {
          make, model,
          lensMake: tags.exif?.LensMake?.description,
          lensModel: tags.exif?.LensModel?.description,
          software: tags.exif?.Software?.description,
        };
      }

      // Capture parameters
      const fNum = tags.exif?.FNumber?.value;
      const expTime = tags.exif?.ExposureTime?.value;
      const iso = tags.exif?.ISOSpeedRatings?.value;
      if (fNum || expTime || iso) {
        base.capture = {
          fNumber: fNum ? (Array.isArray(fNum) ? fNum[0] / (fNum[1] || 1) : Number(fNum)) : undefined,
          exposureTime: expTime ? (Array.isArray(expTime) ? expTime[0] / (expTime[1] || 1) : Number(expTime)) : undefined,
          iso: iso ? (Array.isArray(iso) ? Number(iso[0]) : Number(iso)) : undefined,
          focalLength: tags.exif?.FocalLength?.value
            ? (Array.isArray(tags.exif.FocalLength.value)
                ? tags.exif.FocalLength.value[0] / (tags.exif.FocalLength.value[1] || 1)
                : Number(tags.exif.FocalLength.value))
            : undefined,
        };
      }

      // Dates
      const dateStr = tags.exif?.DateTimeOriginal?.description;
      if (dateStr) {
        try {
          const normalized = dateStr.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
          base.dates = { created: new Date(normalized).toISOString() };
        } catch { /* non-critical */ }
      }

      // Author
      const artist = tags.exif?.Artist?.description;
      const copyright = tags.exif?.Copyright?.description;
      if (artist || copyright) {
        base.author = { name: artist, copyright };
      }
    } catch (err) {
      console.debug('[TiffHandler] IFD metadata extraction failed:', (err as Error).message);
    }

    return base;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIFF → PNG Conversion (wasm-vips Worker)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Thin wrapper around our pre-copied vips-worker.js.
 * Communicates via postMessage and serializes calls in order.
 *
 * The worker script loads wasm-vips WASM module (~3-5MB) on first use,
 * then provides decode/encode operations via message passing.
 */
class VipsWorker {
  private worker: Worker;
  private pending: Map<number, { resolve: (val: unknown) => void; reject: (err: Error) => void }>;
  private nextId: number = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private disposed: boolean = false;

  constructor() {
    this.worker = new Worker('/ext/wasm/vips/vips-worker.js');
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
      reject(new Error('VipsWorker disposed'));
    }
    this.pending.clear();
  }

  private runFn(fn: string, ...args: unknown[]): Promise<unknown> {
    const n = () => new Promise<unknown>((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('VipsWorker disposed'));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });

      const transferables = args.map(r => {
        if (r && typeof r === 'object' && 'buffer' in r && (r as { buffer: unknown }).buffer instanceof ArrayBuffer) {
          return (r as { buffer: ArrayBuffer }).buffer;
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

  /**
   * Decode TIFF bytes → RGBA pixel data
   * Returns: { width, height, data: Uint8Array (RGBA) }
   */
  async decodeTiff(bytes: Uint8Array): Promise<{ width: number; height: number; data: Uint8Array }> {
    return (await this.runFn('decodeTiff', bytes)) as { width: number; height: number; data: Uint8Array };
  }

  /**
   * Encode RGBA pixel data → TIFF bytes
   */
  async encodeTiff(
    rgbaData: Uint8Array,
    width: number,
    height: number,
    options: { compression: string; dpi: number; iccProfileBytes?: Uint8Array },
  ): Promise<Uint8Array> {
    return (await this.runFn('encodeTiff', rgbaData, width, height, options)) as Uint8Array;
  }
}

/** Singleton-ish worker instance (lazily created, reused across calls) */
let vipsInstance: VipsWorker | null = null;
let vipsRefCount = 0;

function getVipsWorker(): VipsWorker {
  if (!vipsInstance) {
    vipsInstance = new VipsWorker();
  }
  vipsRefCount++;
  return vipsInstance;
}

function releaseVipsWorker(): void {
  vipsRefCount--;
  // Keep worker alive for reuse; dispose after idle timeout
  if (vipsRefCount <= 0) {
    setTimeout(() => {
      if (vipsRefCount <= 0 && vipsInstance) {
        vipsInstance.dispose();
        vipsInstance = null;
      }
    }, 30_000); // 30s idle timeout
  }
}

/**
 * Converts a TIFF file to a PNG Blob via wasm-vips Worker.
 *
 * Supports all TIFF variants that libvips handles:
 * - RGB/RGBA 8-bit/16-bit (any compression)
 * - CMYK → sRGB conversion (ICC-accurate when profile is embedded)
 * - BigTIFF, multi-page (first page only)
 */
export async function convertTiffToBlob(file: File): Promise<Blob> {
  const instance = getVipsWorker();

  try {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // Decode TIFF → RGBA via wasm-vips
    const result = await instance.decodeTiff(bytes);
    const { width, height, data } = result;

    if (!data || width <= 0 || height <= 0) {
      throw new Error('Failed to decode TIFF image: no image data returned');
    }

    // Convert RGBA pixels to PNG via OffscreenCanvas
    const rgbaData = new Uint8ClampedArray(width * height * 4);
    rgbaData.set(new Uint8Array(data.buffer, data.byteOffset, width * height * 4));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    const imgData = new ImageData(rgbaData, width, height);
    ctx.putImageData(imgData, 0, 0);

    const blob = await canvas.convertToBlob({ type: 'image/png' });
    // console.log(`[TiffHandler] Decode complete: ${width}×${height}`);
    return blob;
  } catch (error) {
    console.error('[TiffHandler] Decode failed:', error);
    throw error;
  } finally {
    releaseVipsWorker();
  }
}

/**
 * Encodes ImageData to a TIFF Blob via wasm-vips Worker.
 */
async function encodeTiffFromImageData(
  imageData: ImageData,
  options: {
    compression: TiffCompression;
    dpi: number;
    width: number;
    height: number;
    iccProfileBytes?: Uint8Array;
  },
): Promise<Blob> {
  const instance = getVipsWorker();

  try {
    const rgbaData = new Uint8Array(imageData.data.buffer);

    const tiffBytes = await instance.encodeTiff(
      rgbaData,
      options.width,
      options.height,
      { compression: options.compression, dpi: options.dpi, iccProfileBytes: options.iccProfileBytes },
    );

    const blob = new Blob([tiffBytes.buffer as ArrayBuffer], { type: 'image/tiff' });
    console.log(`[TiffHandler] Encode complete: ${options.width}×${options.height}, compression=${options.compression}, dpi=${options.dpi}`);
    return blob;
  } catch (error) {
    console.error('[TiffHandler] Encode failed:', error);
    throw error;
  } finally {
    releaseVipsWorker();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Utility: ImageBitmap → OffscreenCanvas
// ═══════════════════════════════════════════════════════════════════════════════

function bitmapToOffscreen(bitmap: ImageBitmap): OffscreenCanvas {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  return canvas;
}

