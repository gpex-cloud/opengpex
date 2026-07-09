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
 * HEIC/HEIF Format Handler.
 *
 * Responsibilities:
 * - Decode: HEIC → JPEG transcoding via heic-to dynamic script + EXIF extraction
 * - Encode: NOT supported (no browser HEIC encoder exists)
 * - Metadata: exifr parsing (HEIC carries EXIF in its container)
 *
 * Thread model: Decode runs on main thread via heic-to (uses browser decoder internally).
 * Future: migrate to Worker-based libheif-wasm for better perf.
 */

import ExifReader from 'exifreader';
import type { AssetService } from '@opengpex/editor/core/types';
import type {
  ImageFormatHandler,
  ImageMetadata,
  DecodeOptions,
  DecodeResult,
  EncodeOptions,
} from '../types';
// ICC utilities (used for display only — raw bytes not available from exifr for HEIC)

export class HeicHandler implements ImageFormatHandler {
  readonly format = 'heic';
  readonly needsTranscoding = true;
  readonly mimeTypes = ['image/heic', 'image/heif'];
  readonly extensions = ['heic', 'heif'];

  constructor(private assets: AssetService) {}

  // ─── Decode ──────────────────────────────────────────────────────────────

  async decode(file: File, _options?: DecodeOptions): Promise<DecodeResult> {
    // 1. Extract metadata before transcoding (HEIC container has EXIF)
    const metadata = await this.extractMetadata(file);
    metadata.internalCodec = 'image/jpeg';

    // 2. Transcode HEIC → JPEG via heic-to (quality 0.92)
    const jpegBlob = await convertHeicToBlob(file);
    const safeFile = new File(
      [jpegBlob],
      file.name.replace(/\.(heic|heif)$/i, '.jpg'),
      { type: 'image/jpeg' },
    );

    // 3. Get dimensions from transcoded result
    const img = await createImageBitmap(safeFile);
    const dimensions = { w: img.width, h: img.height };
    img.close();

    return { dimensions, metadata, subImages: [{ displayBlob: safeFile, width: dimensions.w, height: dimensions.h, index: 0 }] };
  }

  // ─── Encode (not supported) ──────────────────────────────────────────────

  async encode(
    _source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
    _options: EncodeOptions,
  ): Promise<Blob> {
    throw new Error('[HeicHandler] HEIC encoding is not supported in browsers. Use JPEG or PNG.');
  }

  // ─── Metadata Extraction ─────────────────────────────────────────────────

  async extractMetadata(file: File): Promise<ImageMetadata> {
    const base: ImageMetadata = {
      version: 1,
      sourceFormat: 'heic',
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

      // Capture
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

      // GPS
      const lat = tags.gps?.Latitude;
      const lon = tags.gps?.Longitude;
      if (lat != null && lon != null) {
        base.gps = { latitude: Number(lat), longitude: Number(lon) };
      }

      // ICC Profile
      const iccDesc = tags.icc?.['ICC Description']?.description
        || tags.icc?.ProfileDescription?.description;
      if (iccDesc) {
        base.hasIccProfile = true;
        base.raw = base.raw || {};
        base.raw.iccProfileName = String(iccDesc);

        const profileName = base.raw.iccProfileName.toLowerCase();
        if (profileName.includes('display p3') || profileName.includes('p3')) {
          base.colorSpace = 'display-p3';
        } else if (profileName.includes('adobe') && profileName.includes('rgb')) {
          base.colorSpace = 'adobe-rgb';
        }
      }
    } catch (err) {
      console.debug('[HeicHandler] EXIF extraction failed:', (err as Error).message);
    }

    return base;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HEIC → JPEG Conversion (dynamic script loading)
// ═══════════════════════════════════════════════════════════════════════════════

let heicToLoaded = false;

/**
 * Dynamically loads heic-to library and converts HEIC to JPEG.
 * heic-to uses the browser's native HEIC decoder where available,
 * falling back to a JS-based decoder.
 */
async function convertHeicToBlob(file: File): Promise<Blob> {
  // Ensure heic-to script is loaded
  if (!heicToLoaded && typeof window !== 'undefined') {
    if (!(window as unknown as Record<string, unknown>).heicTo
      && !(window as unknown as Record<string, unknown>).HeicTo) {
      await loadScript('/ext/js/heic-to.js');
      // Wait for global to initialize (heic-to may set up asynchronously)
      let retries = 0;
      while (retries < 50) {
        if ((window as unknown as Record<string, unknown>).heicTo
          || (window as unknown as Record<string, unknown>).HeicTo) break;
        await new Promise(r => setTimeout(r, 100));
        retries++;
      }
    }
    heicToLoaded = true;
  }

  // heic-to exposes as window.heicTo or window.HeicTo
  const heicToFn = ((window as unknown as Record<string, unknown>).heicTo
    || (window as unknown as Record<string, unknown>).HeicTo) as
    ((opts: { blob: Blob; type: string; quality: number }) => Promise<Blob>) | undefined;

  if (!heicToFn) {
    throw new Error('[HeicHandler] heic-to library not available');
  }

  const blob = await heicToFn({
    blob: file,
    type: 'image/jpeg',
    quality: 0.9,
  });

  if (!blob) throw new Error('HEIC conversion returned null');
  console.log('[HeicHandler] Conversion complete');
  return blob;
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.head.appendChild(script);
  });
}
