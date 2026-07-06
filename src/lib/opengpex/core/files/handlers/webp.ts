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
 * WebP Format Handler.
 *
 * Responsibilities:
 * - Decode: browser-native (no transcoding needed), extract EXIF/ICC metadata
 * - Encode: canvas.convertToBlob with quality control
 * - Metadata: ExifReader parsing for EXIF + RIFF chunk parsing for ICC profile
 *
 * Note: exifr does NOT support WebP. We use ExifReader for EXIF and manual
 * RIFF container parsing for ICC profile extraction.
 *
 * Thread model: ALL operations run on main thread (<100ms for typical files).
 */

import ExifReader from 'exifreader';
import type {
  ImageFormatHandler,
  ImageMetadata,
  DecodeOptions,
  DecodeResult,
  EncodeOptions,
} from '../types';
import { bitmapToCanvas } from '../index';
import { parseIccProfileName } from '../icc';

export class WebpHandler implements ImageFormatHandler {
  readonly format = 'webp';
  readonly mimeTypes = ['image/webp'];
  readonly extensions = ['webp'];

  // ─── Decode ──────────────────────────────────────────────────────────────

  async decode(file: File, _options?: DecodeOptions): Promise<DecodeResult> {
    // WebP is browser-native — no transcoding needed
    const img = await createImageBitmap(file);
    const dimensions = { w: img.width, h: img.height };
    img.close();

    const metadata = await this.extractMetadata(file);

    return { safeFile: file, dimensions, metadata };
  }

  // ─── Encode ──────────────────────────────────────────────────────────────

  async encode(
    source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
    options: EncodeOptions,
  ): Promise<Blob> {
    const quality = options.quality ?? 0.80;
    const canvas = source instanceof ImageBitmap ? bitmapToCanvas(source) : source;

    return (canvas as OffscreenCanvas).convertToBlob({
      type: 'image/webp',
      quality,
    });
  }

  // ─── Metadata Extraction ─────────────────────────────────────────────────

  async extractMetadata(file: File): Promise<ImageMetadata> {
    const base: ImageMetadata = {
      version: 1,
      sourceFormat: 'webp',
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

      // 1. Parse EXIF with ExifReader (supports WebP RIFF container)
      const tags = ExifReader.load(fileBuffer, { expanded: true });

      // DPI
      const xRes = tags.exif?.XResolution?.value;
      if (xRes) {
        const resUnit = tags.exif?.ResolutionUnit?.value;
        let dpi = Array.isArray(xRes) ? xRes[0] / (xRes[1] || 1) : Number(xRes);
        if (resUnit === 3) dpi = dpi * 2.54; // cm → inches
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
          make,
          model,
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

      // 2. ICC Profile extraction from WebP RIFF ICCP chunk
      const iccBytes = extractWebpIccChunk(new Uint8Array(fileBuffer));
      if (iccBytes) {
        base.hasIccProfile = true;
        base.raw = base.raw || {};
        const profileName = parseIccProfileName(iccBytes);
        base.raw.iccProfileName = profileName || 'Embedded';

        // Detect known color spaces from ICC profile name
        const pName = (base.raw.iccProfileName || '').toLowerCase();
        if (pName.includes('adobe') && pName.includes('rgb')) {
          base.colorSpace = 'adobe-rgb';
        } else if (pName.includes('display p3') || pName.includes('p3')) {
          base.colorSpace = 'display-p3';
        } else if (pName.includes('prophoto')) {
          base.colorSpace = 'prophoto-rgb';
        }
      }
    } catch (err) {
      console.debug('[WebpHandler] EXIF extraction failed:', (err as Error).message);
    }

    return base;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WebP RIFF Container — ICCP Chunk Extraction
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extract ICC Profile bytes from WebP RIFF container.
 *
 * WebP extended format (VP8X) structure:
 * ```
 * RIFF [4B size] WEBP
 *   VP8X [4B size] [10B flags+dimensions] (flags bit 5 = ICC present)
 *   ICCP [4B size] [ICC profile bytes]
 *   ...
 * ```
 *
 * @returns Raw ICC profile bytes, or null if not found
 */
function extractWebpIccChunk(bytes: Uint8Array): Uint8Array | null {
  // Minimum valid RIFF WebP: "RIFF" + size(4) + "WEBP" = 12 bytes
  if (bytes.length < 12) return null;

  // Verify RIFF WebP signature
  const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const webp = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if (riff !== 'RIFF' || webp !== 'WEBP') return null;

  // Scan RIFF chunks starting at offset 12
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const chunkId = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
    // Chunk size (little-endian 32-bit)
    const chunkSize = bytes[pos + 4] | (bytes[pos + 5] << 8) | (bytes[pos + 6] << 16) | (bytes[pos + 7] << 24);

    if (chunkId === 'ICCP') {
      // Found ICC Profile chunk
      const dataStart = pos + 8;
      const dataEnd = dataStart + chunkSize;
      if (dataEnd <= bytes.length && chunkSize > 0) {
        return bytes.slice(dataStart, dataEnd);
      }
      return null;
    }

    // Move to next chunk (chunks are padded to even byte boundaries)
    pos += 8 + chunkSize + (chunkSize % 2);
  }

  return null;
}
