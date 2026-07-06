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
 * JPEG Format Handler.
 *
 * Responsibilities:
 * - Decode: browser-native (no transcoding needed), extract EXIF metadata
 * - Encode: canvas.convertToBlob + piexifjs EXIF/DPI injection
 * - Metadata: exifr parsing + piexif raw object preservation
 *
 * Thread model: ALL operations run on main thread (<100ms for typical files).
 */

import ExifReader from 'exifreader';
// @ts-expect-error - piexifjs lacks official TypeScript declarations
import * as piexif from 'piexifjs';
import type { AssetService } from '@opengpex/editor/core/types';
import type {
  ImageFormatHandler,
  ImageMetadata,
  DecodeOptions,
  DecodeResult,
  EncodeOptions,
} from '../types';
import { bitmapToCanvas } from '../index';
import { iccToBase64, base64ToIcc, parseIccProfileName } from '../icc';

export class JpegHandler implements ImageFormatHandler {
  readonly format = 'jpeg';
  readonly mimeTypes = ['image/jpeg'];
  readonly extensions = ['jpg', 'jpeg'];

  constructor(private assets: AssetService) {}

  // ─── Decode ──────────────────────────────────────────────────────────────

  async decode(file: File, _options?: DecodeOptions): Promise<DecodeResult> {
    // JPEG is browser-native — no transcoding needed
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
    const quality = options.quality ?? 0.92;
    const canvas = source instanceof ImageBitmap ? bitmapToCanvas(source) : source;

    // 1. Get base JPEG blob from browser encoder
    const baseBlob = await (canvas as OffscreenCanvas).convertToBlob({
      type: 'image/jpeg',
      quality,
    });

    // 2. Inject EXIF metadata (DPI, camera info, software tag)
    const meta = options.metadata;
    const config = options.exportConfig;
    if (!meta && !config) return baseBlob;

    try {
      const base64 = await blobToBase64(baseBlob);

      // Start from original piexif object if preserving EXIF, else create fresh
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let exifObj: Record<string, any>;
      if (config?.preserveExif && meta?.raw?.piexifObj) {
        exifObj = JSON.parse(JSON.stringify(meta.raw.piexifObj));
      } else {
        exifObj = { '0th': {}, Exif: {}, GPS: {} };
      }

      // Ensure IFD objects exist
      if (!exifObj['0th']) exifObj['0th'] = {};
      if (!exifObj['Exif']) exifObj['Exif'] = {};

      // Inject DPI
      const dpi = config?.dpi || meta?.dpi;
      if (dpi && dpi > 0) {
        exifObj['0th'][piexif.ImageIFD.XResolution] = [dpi, 1];
        exifObj['0th'][piexif.ImageIFD.YResolution] = [dpi, 1];
        exifObj['0th'][piexif.ImageIFD.ResolutionUnit] = 2; // inches
      }

      // Inject software tag
      if (config?.writeSoftwareTag !== false) {
        exifObj['0th'][piexif.ImageIFD.Software] = 'OpenGPEX';
      }

      // Inject author/copyright
      const authorName = config?.author?.name || meta?.author?.name;
      const copyright = config?.author?.copyright || meta?.author?.copyright;
      if (authorName) {
        exifObj['0th'][piexif.ImageIFD.Artist] = authorName;
      }
      if (copyright) {
        exifObj['0th'][piexif.ImageIFD.Copyright] = copyright;
      }

      const exifStr = piexif.dump(exifObj);
      const newBase64 = piexif.insert(exifStr, base64);
      let resultBlob = base64ToBlob(newBase64, 'image/jpeg');

      // 3. Inject ICC Profile if embedding is requested
      if (config?.embedIcc && meta?.raw?.iccProfileData) {
        const iccBytes = base64ToIcc(meta.raw.iccProfileData);
        const jpegBytes = new Uint8Array(await resultBlob.arrayBuffer());
        const withIcc = injectJpegIcc(jpegBytes, iccBytes);
        resultBlob = new Blob([withIcc.buffer as ArrayBuffer], { type: 'image/jpeg' });
      }

      return resultBlob;
    } catch (e) {
      console.warn('[JpegHandler.encode] EXIF injection failed, returning raw blob:', e);
      return baseBlob;
    }
  }

  // ─── Metadata Extraction ─────────────────────────────────────────────────

  async extractMetadata(file: File): Promise<ImageMetadata> {
    const base: ImageMetadata = {
      version: 1,
      sourceFormat: 'jpeg',
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
          flash: tags.exif?.Flash?.value != null ? Boolean(Number(tags.exif.Flash.value)) : undefined,
        };
      }

      // Dates
      const created = parseDateToISO(tags.exif?.DateTimeOriginal?.description);
      const modified = parseDateToISO(tags.exif?.DateTime?.description);
      if (created || modified) {
        base.dates = { created, modified };
      }

      // GPS
      const lat = tags.gps?.Latitude;
      const lon = tags.gps?.Longitude;
      if (lat != null && lon != null) {
        base.gps = { latitude: Number(lat), longitude: Number(lon) };
      }

      // ICC Profile — extract from JPEG APP2 markers (binary)
      const fileBytes = new Uint8Array(fileBuffer);
      const rawIcc = extractJpegIccBytes(fileBytes);
      if (rawIcc) {
        base.hasIccProfile = true;
        base.raw = base.raw || {};
        base.raw.iccProfileData = iccToBase64(rawIcc);
        base.raw.iccProfileName = parseIccProfileName(rawIcc) || 'Embedded';

        const profileName = (base.raw.iccProfileName || '').toLowerCase();
        if (profileName.includes('adobe') && profileName.includes('rgb')) {
          base.colorSpace = 'adobe-rgb';
        } else if (profileName.includes('display p3') || profileName.includes('p3')) {
          base.colorSpace = 'display-p3';
        } else if (profileName.includes('prophoto')) {
          base.colorSpace = 'prophoto-rgb';
        }
      }

      // Preserve raw piexif object for lossless round-trip
      if (file.type === 'image/jpeg') {
        try {
          const b64 = await fileToBase64(file);
          const rawPiexifObj = piexif.load(b64);
          base.raw = { ...base.raw, piexifObj: rawPiexifObj };
        } catch {
          // piexif load failed — non-critical
        }
      }
    } catch (err) {
      console.debug('[JpegHandler] EXIF extraction failed:', (err as Error).message);
    }

    return base;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Private Utilities
// ═══════════════════════════════════════════════════════════════════════════════

function _findLensInParsed(parsed: Record<string, unknown>): string | undefined {
  for (const [key, val] of Object.entries(parsed)) {
    if (key.toLowerCase().includes('lens') && typeof val === 'string') {
      return val;
    }
  }
  return undefined;
}

function parseDateToISO(rawDate: unknown): string | undefined {
  if (!rawDate) return undefined;
  if (typeof rawDate === 'object' && rawDate !== null && 'getTime' in rawDate) {
    const time = (rawDate as Date).getTime();
    if (!isNaN(time)) return new Date(time).toISOString();
  }
  if (typeof rawDate === 'string') {
    const normalized = rawDate.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
    const d = new Date(normalized);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return undefined;
}

function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return fileToBase64(blob);
}

function base64ToBlob(base64: string, type: string): Blob {
  const parts = base64.split(';base64,');
  const raw = atob(parts[1] || parts[0]);
  const uInt8Array = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    uInt8Array[i] = raw.charCodeAt(i);
  }
  return new Blob([uInt8Array], { type });
}

// ═══════════════════════════════════════════════════════════════════════════════
// JPEG ICC Profile Injection (APP2 marker)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Inject ICC Profile into JPEG via APP2 markers.
 *
 * JPEG ICC Profile is stored in APP2 markers (0xFFE2) with header "ICC_PROFILE\0".
 * If the ICC data exceeds 64KB, it's split into multiple APP2 chunks.
 *
 * @param jpegBytes - The JPEG file bytes
 * @param iccBytes - The raw ICC Profile bytes to inject
 * @returns New JPEG bytes with ICC Profile embedded
 */
function injectJpegIcc(jpegBytes: Uint8Array, iccBytes: Uint8Array): Uint8Array {
  // ICC_PROFILE header: "ICC_PROFILE\0" (12 bytes) + seq_no(1) + num_chunks(1)
  const ICC_HEADER = new TextEncoder().encode('ICC_PROFILE\0');
  const MAX_CHUNK_DATA = 65519; // 65535(max marker) - 2(length) - 14(header+seq+count)

  const numChunks = Math.ceil(iccBytes.length / MAX_CHUNK_DATA);
  const app2Markers: Uint8Array[] = [];

  for (let i = 0; i < numChunks; i++) {
    const chunkData = iccBytes.slice(i * MAX_CHUNK_DATA, (i + 1) * MAX_CHUNK_DATA);

    // APP2 payload: "ICC_PROFILE\0" + seq_no(1) + num_chunks(1) + ICC_data
    const payload = new Uint8Array(ICC_HEADER.length + 2 + chunkData.length);
    payload.set(ICC_HEADER, 0);
    payload[ICC_HEADER.length] = i + 1;      // sequence number (1-based)
    payload[ICC_HEADER.length + 1] = numChunks;
    payload.set(chunkData, ICC_HEADER.length + 2);

    // Wrap in APP2 marker: 0xFF 0xE2 + length(2 bytes big-endian)
    const markerLen = payload.length + 2; // +2 for length field itself
    const marker = new Uint8Array(4 + payload.length);
    marker[0] = 0xFF;
    marker[1] = 0xE2;
    marker[2] = (markerLen >> 8) & 0xFF;
    marker[3] = markerLen & 0xFF;
    marker.set(payload, 4);
    app2Markers.push(marker);
  }

  // Find insertion position (after SOI and any existing APP0/APP1 markers)
  const _insertPos = findJpegIccInsertPosition(jpegBytes);

  // Remove any existing APP2 ICC_PROFILE markers first
  const cleanedJpeg = removeExistingIccMarkers(jpegBytes);
  const cleanInsertPos = findJpegIccInsertPosition(cleanedJpeg);

  // Build result
  const totalIccSize = app2Markers.reduce((s, m) => s + m.length, 0);
  const result = new Uint8Array(cleanedJpeg.length + totalIccSize);
  result.set(cleanedJpeg.slice(0, cleanInsertPos), 0);
  let offset = cleanInsertPos;
  for (const marker of app2Markers) {
    result.set(marker, offset);
    offset += marker.length;
  }
  result.set(cleanedJpeg.slice(cleanInsertPos), offset);
  return result;
}

/**
 * Find the position to insert APP2 ICC markers.
 * Should be after SOI (2 bytes) and after APP0/APP1 markers if present.
 */
function findJpegIccInsertPosition(jpegBytes: Uint8Array): number {
  // Start after SOI marker (0xFF 0xD8)
  let pos = 2;

  while (pos < jpegBytes.length - 1) {
    if (jpegBytes[pos] !== 0xFF) break;
    const marker = jpegBytes[pos + 1];

    // APP0 (0xE0) or APP1 (0xE1) — skip these, insert after them
    if (marker === 0xE0 || marker === 0xE1) {
      const len = (jpegBytes[pos + 2] << 8) | jpegBytes[pos + 3];
      pos += 2 + len;
      continue;
    }

    // Stop at any other marker — this is our insert position
    break;
  }

  return pos;
}

/**
 * Extract raw ICC Profile bytes from JPEG APP2 markers.
 * Multiple APP2 ICC_PROFILE chunks are reassembled in sequence order.
 */
function extractJpegIccBytes(jpegBytes: Uint8Array): Uint8Array | null {
  const ICC_HEADER_STR = 'ICC_PROFILE\0';
  const chunks: { seq: number; data: Uint8Array }[] = [];
  let pos = 2; // skip SOI

  while (pos < jpegBytes.length - 1) {
    if (jpegBytes[pos] !== 0xFF) break;
    const marker = jpegBytes[pos + 1];

    // SOS (0xDA) — end of markers
    if (marker === 0xDA) break;

    // Markers without length
    if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) {
      pos += 2;
      continue;
    }

    // Marker with length
    const len = (jpegBytes[pos + 2] << 8) | jpegBytes[pos + 3];
    const segmentEnd = pos + 2 + len;

    // Check for APP2 ICC_PROFILE marker
    if (marker === 0xE2 && len > 14) {
      const headerSlice = jpegBytes.slice(pos + 4, pos + 4 + 12);
      const headerStr = String.fromCharCode(...headerSlice);
      if (headerStr === ICC_HEADER_STR) {
        const seqNo = jpegBytes[pos + 16];    // sequence number (1-based)
        // const numChunks = jpegBytes[pos + 17]; // total chunk count
        const iccData = jpegBytes.slice(pos + 18, segmentEnd);
        chunks.push({ seq: seqNo, data: iccData });
      }
    }

    pos = segmentEnd;
  }

  if (chunks.length === 0) return null;

  // Sort by sequence number and concatenate
  chunks.sort((a, b) => a.seq - b.seq);
  const totalLen = chunks.reduce((s, c) => s + c.data.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk.data, offset);
    offset += chunk.data.length;
  }
  return result;
}

/**
 * Remove existing APP2 ICC_PROFILE markers from JPEG bytes.
 */
function removeExistingIccMarkers(jpegBytes: Uint8Array): Uint8Array {
  const ICC_HEADER_STR = 'ICC_PROFILE\0';
  const segments: Uint8Array[] = [];
  let pos = 0;

  // Copy SOI
  segments.push(jpegBytes.slice(0, 2));
  pos = 2;

  while (pos < jpegBytes.length - 1) {
    if (jpegBytes[pos] !== 0xFF) {
      // Not a marker — copy rest and break
      segments.push(jpegBytes.slice(pos));
      break;
    }

    const marker = jpegBytes[pos + 1];

    // SOS (0xDA) — end of markers, copy rest
    if (marker === 0xDA) {
      segments.push(jpegBytes.slice(pos));
      break;
    }

    // Markers without length (RST, SOI, EOI)
    if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) {
      segments.push(jpegBytes.slice(pos, pos + 2));
      pos += 2;
      continue;
    }

    // Marker with length
    const len = (jpegBytes[pos + 2] << 8) | jpegBytes[pos + 3];
    const segmentEnd = pos + 2 + len;

    // Check if this is an APP2 ICC_PROFILE marker to skip
    if (marker === 0xE2 && len > 14) {
      const headerSlice = jpegBytes.slice(pos + 4, pos + 4 + 12);
      const headerStr = String.fromCharCode(...headerSlice);
      if (headerStr === ICC_HEADER_STR) {
        // Skip this ICC marker
        pos = segmentEnd;
        continue;
      }
    }

    // Keep this segment
    segments.push(jpegBytes.slice(pos, segmentEnd));
    pos = segmentEnd;
  }

  // Concatenate segments
  const totalLen = segments.reduce((s, seg) => s + seg.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const seg of segments) {
    result.set(seg, offset);
    offset += seg.length;
  }
  return result;
}
