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
 * AVIF Format Handler — Dual-Engine Architecture.
 *
 * Encoding engines:
 * 1. @jsquash/avif (default) — isolated Worker, ALLOW_MEMORY_GROWTH, no ICC embed
 * 2. vips-heif (optional) — engine Worker, ICC embed + 10-bit, shares 2GB heap
 *
 * Routing: USE_VIPS_FOR_ICC_AVIF is a hard switch:
 *   true  → ALL encoding via vips-heif (ICC auto-embedded; sRGB if no source ICC)
 *   false → ALL encoding via @jsquash/avif (no ICC support)
 *
 * Thread model:
 * - Decode: main thread (browser-native createImageBitmap)
 * - Encode (@jsquash): static Worker at /ext/wasm/avif/avif-worker.js
 * - Encode (vips): engine Worker via FileIO.encodeAvif dispatch
 * - Metadata: main thread via ExifReader
 *
 * See docs/opengpex/plans/20260806_avif_dual_engine_encode.md
 */

import ExifReader from 'exifreader';
import type { PixelService, WorkingColorSpace } from '@opengpex/editor/core/types';
import type {
  ImageFormatHandler,
  ImageMetadata,
  DecodeOptions,
  DecodeResult,
  EncodeOptions,
} from '../types';
import { bitmapToCanvas } from '../index';
import { iccToBase64, parseIccProfileName } from '../icc';
import { convertImageDataColorSpace } from '@opengpex/editor/core/color/matrices';
import {
  resolveColorSpaceForFormat,
  getImportStrategy,
  getExportStrategy,
  shouldRetainSourceBlob,
  resolveExportPixelConversion,
} from '@opengpex/editor/core/color/ColorPipeline';

/**
 * When true, AVIF exports with embedIcc + ICC data route through vips-heif.
 * When false (default), ALL encoding uses @jsquash/avif in an isolated Worker.
 */
const USE_VIPS_FOR_ICC_AVIF = false;

export class AvifHandler implements ImageFormatHandler {
  readonly format = 'avif';
  readonly mimeTypes = ['image/avif'];
  readonly extensions = ['avif'];

  constructor(private pixels: PixelService) {}

  // ─── Decode ──────────────────────────────────────────────────────────────

  async decode(file: File, _options?: DecodeOptions): Promise<DecodeResult> {
    const metadata = await this.extractMetadata(file);

    const detectedCS = resolveColorSpaceForFormat('avif', metadata.colorSpace);
    const strategy = getImportStrategy(detectedCS);

    let displayBlob: Blob = file;
    let dimensions: { w: number; h: number };

    switch (strategy.conversion) {
      case 'none': {
        const img = await createImageBitmap(file);
        dimensions = { w: img.width, h: img.height };
        img.close();
        console.debug('[ColorMgmt] AVIF decode: %s conversion=none, detectedCS=%s, frameCS=%s',
          file.name, detectedCS, strategy.frameColorSpace);
        break;
      }

      case 'matrix': {
        const img = await createImageBitmap(file, { colorSpaceConversion: 'none' });
        const w = img.width;
        const h = img.height;
        dimensions = { w, h };

        const tmpCanvas = bitmapToCanvas(img);
        img.close();
        const tmpCtx = tmpCanvas.getContext('2d')!;
        const imageData = tmpCtx.getImageData(0, 0, w, h);

        convertImageDataColorSpace(imageData.data, detectedCS as WorkingColorSpace, strategy.frameColorSpace);

        const outCS: PredefinedColorSpace = strategy.frameColorSpace === 'display-p3' ? 'display-p3' : 'srgb';
        const outCanvas = new OffscreenCanvas(w, h);
        const outCtx = outCanvas.getContext('2d', { colorSpace: outCS })!;
        outCtx.putImageData(new ImageData(imageData.data, w, h, { colorSpace: outCS }), 0, 0);
        displayBlob = await outCanvas.convertToBlob({ type: 'image/png' });

        console.debug('[ColorMgmt] AVIF decode: %s matrix %s→%s',
          file.name, detectedCS, strategy.frameColorSpace);
        break;
      }

      case 'icc-engine': {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const { width, height, data, iccProfileData } = await this.pixels.fileIO.iccToSrgb(bytes);
        dimensions = { w: width, h: height };

        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d')!;
        const clamped = new Uint8ClampedArray(data.length);
        clamped.set(data);
        ctx.putImageData(new ImageData(clamped, width, height), 0, 0);
        displayBlob = await canvas.convertToBlob({ type: 'image/png' });

        if (iccProfileData && iccProfileData.length > 0) {
          metadata.hasIccProfile = true;
          metadata.raw = metadata.raw || {};
          if (!metadata.raw.iccProfileData) {
            metadata.raw.iccProfileData = iccToBase64(iccProfileData);
          }
          if (!metadata.raw.iccProfileName) {
            metadata.raw.iccProfileName = parseIccProfileName(iccProfileData) || 'Embedded';
          }
        }

        console.debug('[ColorMgmt] AVIF decode: %s icc-engine %s→%s',
          file.name, detectedCS, strategy.frameColorSpace);
        break;
      }
    }

    const sourceBlob = shouldRetainSourceBlob('avif', metadata, strategy.frameColorSpace) ? file : undefined;

    return {
      dimensions,
      metadata,
      subImages: [{ displayBlob, width: dimensions.w, height: dimensions.h, index: 0 }],
      sourceBlob,
    };
  }

  // ─── Encode ──────────────────────────────────────────────────────────────

  async encode(
    source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
    options: EncodeOptions,
  ): Promise<Blob> {
    const quality = Math.round((options.quality ?? 0.80) * 100);
    const meta = options.metadata;
    const config = options.exportConfig;

    const frameCS: WorkingColorSpace = (config?.frameColorSpace as WorkingColorSpace) || 'srgb';
    const exportStrategy = getExportStrategy(frameCS, 'avif');
    const embedIcc = config?.embedIcc ?? false;

    const pixelConv = resolveExportPixelConversion(
      frameCS,
      { colorSpace: meta?.colorSpace, hasIccProfileData: !!meta?.raw?.iccProfileData },
      embedIcc,
      'avif',
    );

    // Pixel extraction with color space handling
    let canvas: OffscreenCanvas | HTMLCanvasElement;

    if (pixelConv === 'p3-to-srgb') {
      const srcCanvas = source instanceof ImageBitmap ? bitmapToCanvas(source, 'display-p3') : source as OffscreenCanvas;
      const w = srcCanvas.width;
      const h = srcCanvas.height;
      const tmpCanvas = new OffscreenCanvas(w, h);
      const tmpCtx = tmpCanvas.getContext('2d', { colorSpace: 'display-p3' })!;
      tmpCtx.drawImage(srcCanvas, 0, 0);
      const imgData = tmpCtx.getImageData(0, 0, w, h);
      convertImageDataColorSpace(imgData.data, 'display-p3', 'srgb');
      const outCanvas = new OffscreenCanvas(w, h);
      const outCtx = outCanvas.getContext('2d')!;
      outCtx.putImageData(new ImageData(imgData.data, w, h), 0, 0);
      canvas = outCanvas;
      console.debug('[ColorMgmt] AVIF Export: pixelConversion=p3-to-srgb');
    } else {
      canvas = source instanceof ImageBitmap
        ? bitmapToCanvas(source, exportStrategy.encodeColorSpace)
        : source as OffscreenCanvas;
    }

    const ctx = (canvas as OffscreenCanvas).getContext('2d')!;
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const rgbaData = new Uint8Array(imageData.data.buffer);

    // ICC profile preparation
    let iccProfileBytes: Uint8Array | undefined;

    if (embedIcc && meta?.raw?.iccProfileData) {
      const { base64ToIcc } = await import('../icc');
      iccProfileBytes = base64ToIcc(meta.raw.iccProfileData);

      if (pixelConv === 'srgb-to-icc') {
        const { data: convertedData } = await this.pixels.fileIO.srgbToIcc(
          rgbaData, canvas.width, canvas.height, iccProfileBytes,
        );
        rgbaData.set(convertedData);
        console.debug('[ColorMgmt] AVIF Export: pixelConversion=srgb-to-icc, profile=%s',
          meta.raw.iccProfileName || 'custom');
      }
    } else if (embedIcc && !meta?.raw?.iccProfileData) {
      console.debug('[ColorMgmt] AVIF Export: embedIcc=true but no source ICC data; sRGB assumed');
    }

    // Engine routing: USE_VIPS_FOR_ICC_AVIF is a hard switch — on = always vips-heif, off = always @jsquash/avif.
    // When vips is used, it always writes a correct ICC profile into the AVIF colr box:
    //   - If iccProfileBytes provided → embeds that profile
    //   - If not → vips auto-writes sRGB profile
    if (USE_VIPS_FOR_ICC_AVIF) {
      console.debug('[ColorMgmt] AVIF Export: vips-heif engine, frameCS=%s, hasSourceIcc=%s',
        frameCS, !!iccProfileBytes);
      const avifBytes = await this.pixels.fileIO.encodeAvif(rgbaData, canvas.width, canvas.height, {
        quality, lossless: false, effort: 4,
        iccProfileBytes: embedIcc ? iccProfileBytes : undefined,
        bitDepth: meta?.bitDepth, dpi: config?.dpi || meta?.dpi,
      });
      return new Blob([avifBytes.buffer as ArrayBuffer], { type: 'image/avif' });
    }

    // @jsquash/avif path — no ICC embedding support
    if (embedIcc) {
      console.warn('[AvifHandler] ICC embed not supported (USE_VIPS_FOR_ICC_AVIF=false). Colors preserved, profile omitted.');
    }
    console.debug('[ColorMgmt] AVIF Export: @jsquash/avif engine, frameCS=%s', frameCS);
    const avifBytes = await encodeAvifJsquash(rgbaData, canvas.width, canvas.height, { quality, speed: 6 });
    return new Blob([avifBytes.buffer as ArrayBuffer], { type: 'image/avif' });
  }

  // ─── Metadata Extraction ─────────────────────────────────────────────────

  async extractMetadata(file: File): Promise<ImageMetadata> {
    const base: ImageMetadata = {
      version: 1,
      sourceFormat: 'avif',
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

      // Camera
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
      const fNumber = tags.exif?.FNumber?.value;
      const exposureTime = tags.exif?.ExposureTime?.value;
      const iso = tags.exif?.ISOSpeedRatings?.value;
      if (fNumber || exposureTime || iso) {
        base.capture = {
          fNumber: fNumber ? (Array.isArray(fNumber) ? fNumber[0] / (fNumber[1] || 1) : Number(fNumber)) : undefined,
          exposureTime: exposureTime ? (Array.isArray(exposureTime) ? exposureTime[0] / (exposureTime[1] || 1) : Number(exposureTime)) : undefined,
          iso: iso ? (Array.isArray(iso) ? iso[0] : Number(iso)) : undefined,
          focalLength: tags.exif?.FocalLength?.value
            ? (Array.isArray(tags.exif.FocalLength.value)
                ? tags.exif.FocalLength.value[0] / (tags.exif.FocalLength.value[1] || 1)
                : Number(tags.exif.FocalLength.value))
            : undefined,
        };
      }

      // Dates
      const dateOriginal = tags.exif?.DateTimeOriginal?.description;
      if (dateOriginal) {
        try {
          const normalized = dateOriginal.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
          base.dates = { created: new Date(normalized).toISOString() };
        } catch { /* non-critical */ }
      }

      // GPS
      const lat = tags.gps?.Latitude;
      const lon = tags.gps?.Longitude;
      if (lat != null && lon != null) {
        base.gps = { latitude: Number(lat), longitude: Number(lon) };
      }

      // ICC Profile (from AVIF colr box)
      const iccDesc = tags.icc?.['ICC Description']?.description
        || tags.icc?.ProfileDescription?.description;
      if (iccDesc) {
        base.hasIccProfile = true;
        base.raw = base.raw || {};
        base.raw.iccProfileName = String(iccDesc);

        const pName = base.raw.iccProfileName.toLowerCase();
        if (pName.includes('adobe') && pName.includes('rgb')) {
          base.colorSpace = 'adobe-rgb';
        } else if (pName.includes('display p3') || pName.includes('p3')) {
          base.colorSpace = 'display-p3';
        } else if (pName.includes('prophoto')) {
          base.colorSpace = 'prophoto-rgb';
        }
      }

      // Raw ICC profile bytes
      const iccChunks = tags.icc;
      if (iccChunks && typeof iccChunks === 'object') {
        const rawIcc = (iccChunks as Record<string, unknown>).__raw;
        if (rawIcc instanceof Uint8Array && rawIcc.length > 0) {
          base.raw = base.raw || {};
          base.raw.iccProfileData = iccToBase64(rawIcc);
          if (!base.raw.iccProfileName) {
            base.raw.iccProfileName = parseIccProfileName(rawIcc) || 'Embedded';
          }
        }
      }

      // Bit depth (AVIF pixi box)
      const fileTags = tags.file as Record<string, { value?: unknown }> | undefined;
      const bitDepth = fileTags?.BitDepth?.value;
      if (bitDepth && Number(bitDepth) > 8) {
        base.bitDepth = Number(bitDepth);
      }

      // Alpha
      const hasAlpha = fileTags?.NumberOfComponents?.value;
      if (hasAlpha && Number(hasAlpha) === 4) {
        base.hasAlpha = true;
      }
    } catch (err) {
      console.debug('[AvifHandler] Metadata extraction failed:', (err as Error).message);
    }

    return base;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// @jsquash/avif Worker — Encode RGBA → AVIF off main thread
// ═══════════════════════════════════════════════════════════════════════════════

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
async function encodeAvifJsquash(
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
