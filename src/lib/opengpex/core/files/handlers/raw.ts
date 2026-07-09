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
 * Camera RAW Format Handler.
 *
 * Supports: CR2, CR3, NEF, NRW, ARW, DNG, ORF, RW2, RAF, PEF, SRW, RAW, RWL, 3FR, FFF, IIQ
 *
 * Responsibilities:
 * - Decode: RAW → PNG via libraw-wasm Worker + EXIF extraction
 * - Encode: NOT supported (RAW is a capture format, not an output format)
 * - Metadata: exifr parsing for camera/lens/capture info
 *
 * Thread model: Decode runs heavy computation on Worker via WorkerProxy.
 * EXIF extraction runs on main thread (lightweight header-only parse).
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
// ICC utilities (used for display only — raw bytes not available from exifr for RAW)
import type { RawImageData, LibRawSettings } from 'libraw-wasm';

export class RawHandler implements ImageFormatHandler {
  readonly format = 'raw';
  readonly needsTranscoding = true;
  readonly mimeTypes = [
    'image/x-dcraw', 'image/x-adobe-dng',
    'image/x-canon-cr2', 'image/x-nikon-nef', 'image/x-sony-arw',
  ];
  readonly extensions = [
    'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2',
    'dng', 'orf', 'rw2', 'raf', 'pef', 'srw',
    'raw', 'rwl', '3fr', 'fff', 'iiq',
  ];

  constructor(
    private assets: AssetService,
    private workerProxy: WorkerProxy,
  ) {}

  // ─── Decode ──────────────────────────────────────────────────────────────

  async decode(file: File, _options?: DecodeOptions): Promise<DecodeResult> {
    // 1. Extract metadata first (lightweight, main thread)
    const metadata = await this.extractMetadata(file);
    metadata.internalCodec = 'image/png';

    // 2. Decode RAW → PNG via libraw-wasm (spawns its own internal Worker)
    // TODO: Migrate to workerProxy.transcodeRaw() when Worker channel is available
    const pngBlob = await convertRawToBlob(file);
    const safeFile = new File(
      [pngBlob],
      file.name.replace(/\.[^.]+$/, '.png'),
      { type: 'image/png' },
    );

    // 3. Get dimensions from transcoded result
    const img = await createImageBitmap(safeFile);
    const dimensions = { w: img.width, h: img.height };
    img.close();

    // 4. Phase 5: RAW files are always high bit-depth (12-16 bit) — preserve raw source
    const rawBlob = metadata.bitDepth > 8 ? file : undefined;

    return { dimensions, metadata, subImages: [{ displayBlob: safeFile, width: dimensions.w, height: dimensions.h, index: 0 }], sourceBlob: rawBlob };
  }

  // ─── Encode (not supported) ──────────────────────────────────────────────

  async encode(
    _source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
    _options: EncodeOptions,
  ): Promise<Blob> {
    throw new Error('[RawHandler] RAW encoding is not supported. RAW is a capture-only format.');
  }

  // ─── Metadata Extraction ─────────────────────────────────────────────────

  async extractMetadata(file: File): Promise<ImageMetadata> {
    const base: ImageMetadata = {
      version: 1,
      sourceFormat: 'raw',
      sourceFileName: file.name,
      sourceFileSize: file.size,
      dpi: 72,
      dpiSource: 'default',
      colorSpace: 'srgb',
      bitDepth: 14, // Most modern RAW sensors are 14-bit
      hasAlpha: false,
      hasIccProfile: false,
    };

    try {
      const fileBuffer = await file.arrayBuffer();
      const tags = ExifReader.load(fileBuffer, { expanded: true });

      // Camera info (most valuable for RAW)
      const make = tags.exif?.Make?.description;
      const model = tags.exif?.Model?.description;
      base.camera = {
        make, model,
        lensMake: tags.exif?.LensMake?.description,
        lensModel: tags.exif?.LensModel?.description,
        software: tags.exif?.Software?.description,
      };

      // Capture parameters
      const fNum = tags.exif?.FNumber?.value;
      const expTime = tags.exif?.ExposureTime?.value;
      const iso = tags.exif?.ISOSpeedRatings?.value;
      base.capture = {
        fNumber: fNum ? (Array.isArray(fNum) ? fNum[0] / (fNum[1] || 1) : Number(fNum)) : undefined,
        exposureTime: expTime ? (Array.isArray(expTime) ? expTime[0] / (expTime[1] || 1) : Number(expTime)) : undefined,
        iso: iso ? (Array.isArray(iso) ? Number(iso[0]) : Number(iso)) : undefined,
        focalLength: tags.exif?.FocalLength?.value
          ? (Array.isArray(tags.exif.FocalLength.value)
              ? tags.exif.FocalLength.value[0] / (tags.exif.FocalLength.value[1] || 1)
              : Number(tags.exif.FocalLength.value))
          : undefined,
        flash: tags.exif?.Flash?.value != null ? Boolean(Number(tags.exif.Flash.value)) : undefined,
      };

      // Dates
      const dateStr = tags.exif?.DateTimeOriginal?.description;
      if (dateStr) {
        try {
          const normalized = dateStr.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
          base.dates = { created: new Date(normalized).toISOString() };
        } catch { /* non-critical */ }
      }

      // GPS
      const lat = tags.gps?.Latitude;
      const lon = tags.gps?.Longitude;
      if (lat != null && lon != null) {
        base.gps = { latitude: Number(lat), longitude: Number(lon) };
      }

      // Bit depth
      const bpsTag = tags.exif?.BitsPerSample?.value;
      if (bpsTag) {
        const bps = Array.isArray(bpsTag) ? Number(bpsTag[0]) : Number(bpsTag);
        if (bps > 0) base.bitDepth = bps;
      }

      // ICC Profile
      const iccDesc = tags.icc?.['ICC Description']?.description
        || tags.icc?.ProfileDescription?.description;
      if (iccDesc) {
        base.hasIccProfile = true;
        base.raw = base.raw || {};
        base.raw.iccProfileName = String(iccDesc);
      }
    } catch (err) {
      console.debug('[RawHandler] EXIF extraction failed:', (err as Error).message);
    }

    return base;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RAW → PNG Conversion (libraw-wasm Worker)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Thin wrapper around our pre-copied libraw-worker.js.
 * Communicates via postMessage and serializes calls in order.
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

/**
 * Converts a camera RAW file to a PNG Blob.
 *
 * Supports all LibRaw formats: CR2, CR3, NEF, NRW, ARW, DNG, ORF, RW2, RAF,
 * PEF, SRW, RAW, RWL, 3FR, FFF, IIQ, and more (1200+ cameras).
 */
export async function convertRawToBlob(file: File): Promise<Blob> {
  const instance = new LibRaw();

  try {
    const buffer = await file.arrayBuffer();

    await instance.open(new Uint8Array(buffer), {
      useCameraWb: true,
      outputColor: 1,   // sRGB
      outputBps: 8,     // 8-bit output
      userQual: 3,      // AHD interpolation
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

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    const imgData = new ImageData(rgbaData, width, height);
    ctx.putImageData(imgData, 0, 0);

    const blob = await canvas.convertToBlob({ type: 'image/png' });
    // console.log(`[RawHandler] Conversion complete: ${width}×${height}`);
    return blob;
  } catch (error) {
    console.error('[RawHandler] Conversion failed', error);
    throw error;
  } finally {
    instance.dispose();
  }
}
