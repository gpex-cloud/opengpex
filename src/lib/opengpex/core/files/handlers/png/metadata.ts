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
 * PNG metadata extraction — fills ImageMetadata by iterating chunks.
 *
 * Strategy:
 * 1. ExifReader full-file parse — extracts Orientation from any source
 *    (eXIf chunk, XMP in iTXt, etc.). Some PNGs (e.g. Gemini-generated)
 *    store Orientation only in XMP, not in a standard eXIf chunk.
 * 2. Chunk iteration — reads IHDR, pHYs, iCCP, eXIf, tEXt, iTXt, tIME, gAMA
 *    for dimensions, DPI, ICC, raw EXIF bytes, and other metadata.
 *
 * Does NOT decompress IDAT (no pixel decode).
 */

import ExifReader from 'exifreader';
import type { ImageMetadata, ColorSpaceId } from '../../metadata';
import { iterateChunks, verifySignature } from './chunks';
import { readIHDR, readpHYs, readiCCP, readeXIf, readtEXt, readiTXt, readtIME, readgAMA } from './readers';
import { iccToBase64, parseIccProfileName } from '../../icc';

/**
 * Extract full V2 metadata from a PNG file.
 * Uses ExifReader for orientation (covers XMP/eXIf/other sources),
 * then iterates chunks for remaining metadata fields.
 */
export async function extractPngMetadata(file: File): Promise<ImageMetadata> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  const meta: ImageMetadata = {
    sourceFormat: 'png',
    sourceFileName: file.name,
    sourceFileSize: file.size,
    width: 0,
    height: 0,
    dpi: 72,
    dpiSource: 'default',
    colorSpace: 'srgb',
    bitDepth: 8,
    hasAlpha: true,
    raw: {},
  };

  if (!verifySignature(bytes)) return meta;

  // ── ExifReader full-file parse: extract orientation from XMP/eXIf/etc. ──
  // Must run before chunk iteration because some PNGs lack an eXIf chunk
  // and store Orientation exclusively in XMP (iTXt). ExifReader handles both.
  extractOrientationFromFile(buffer, meta);

  for (const chunk of iterateChunks(bytes)) {
    switch (chunk.type) {
      case 'IHDR': {
        const info = readIHDR(chunk.data);
        meta.width = info.width;
        meta.height = info.height;
        meta.bitDepth = info.bitDepth;
        meta.hasAlpha = info.hasAlpha;
        if (info.isGrayscale) meta.colorSpace = 'grayscale';
        break;
      }

      case 'pHYs': {
        const phys = readpHYs(chunk.data);
        if (phys) {
          meta.dpi = phys.dpi;
          meta.dpiSource = 'png-phys';
        }
        break;
      }

      case 'iCCP': {
        const iccp = await readiCCP(chunk.data);
        if (iccp) {
          const resolvedName = parseIccProfileName(iccp.iccBytes) || iccp.profileName;
          meta.raw.icc = {
            data: iccToBase64(iccp.iccBytes),
            name: resolvedName,
          };
          meta.colorSpace = inferColorSpaceFromIcc(resolvedName);
        } else {
          // iCCP present but decompression failed — mark as unknown
          meta.colorSpace = 'unknown';
        }
        break;
      }

      case 'sRGB': {
        meta.colorSpace = 'srgb';
        break;
      }

      case 'eXIf': {
        if (chunk.data.length > 8) {
          const exifBytes = readeXIf(chunk.data);
          meta.raw.exif = iccToBase64(exifBytes); // reuse base64 helper
          parseExifToSemantic(exifBytes, meta);
        }
        break;
      }

      case 'tEXt': {
        const { key, value } = readtEXt(chunk.data);
        applyTextToMeta(key, value, meta);
        break;
      }

      case 'iTXt': {
        const entry = await readiTXt(chunk.data);
        if (entry) applyTextToMeta(entry.key, entry.value, meta);
        break;
      }

      case 'tIME': {
        const isoDate = readtIME(chunk.data);
        if (isoDate) {
          meta.dates = meta.dates || {};
          meta.dates.modified = isoDate;
        }
        break;
      }

      case 'gAMA': {
        const gamma = readgAMA(chunk.data);
        if (gamma) meta.raw.gamma = gamma;
        break;
      }

      case 'IEND':
        return meta;
    }
  }

  return meta;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Internal Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/** Infer color space from ICC profile name */
function inferColorSpaceFromIcc(profileName: string): ColorSpaceId {
  const name = profileName.toLowerCase();
  if (name.includes('adobe') && name.includes('rgb')) return 'adobe-rgb';
  if (name.includes('display p3') || name.includes('p3')) return 'display-p3';
  if (name.includes('prophoto')) return 'prophoto-rgb';
  if (name.includes('srgb')) return 'srgb';
  return 'unknown';
}

/** Apply tEXt/iTXt key-value to metadata */
function applyTextToMeta(key: string, value: string, meta: ImageMetadata): void {
  if (!key || !value) return;
  if (key === 'Author') {
    meta.author = meta.author || {};
    meta.author.name = value;
  } else if (key === 'Copyright') {
    meta.author = meta.author || {};
    meta.author.copyright = value;
  } else if (key === 'Description' || key === 'Comment') {
    meta.author = meta.author || {};
    meta.author.description = value;
  } else if (key === 'Software') {
    meta.camera = meta.camera || {};
    meta.camera.software = value;
  }
}

/** Parse EXIF bytes into semantic metadata fields (camera, capture, dates, gps) */
function parseExifToSemantic(exifBytes: Uint8Array, meta: ImageMetadata): void {
  try {
    const exifBuffer = new ArrayBuffer(exifBytes.byteLength);
    new Uint8Array(exifBuffer).set(exifBytes);
    const tags = ExifReader.load(exifBuffer, { expanded: true });

    // Camera info
    const make = tags.exif?.Make?.description;
    const model = tags.exif?.Model?.description;
    if (make || model) {
      meta.camera = {
        make,
        model,
        lensMake: tags.exif?.LensMake?.description,
        lensModel: tags.exif?.LensModel?.description,
        software: tags.exif?.Software?.description || meta.camera?.software,
      };
    }

    // Capture parameters
    const fNum = tags.exif?.FNumber?.value;
    const expTime = tags.exif?.ExposureTime?.value;
    const iso = tags.exif?.ISOSpeedRatings?.value;
    const orientationVal = tags.exif?.Orientation?.value;
    if (fNum || expTime || iso || orientationVal) {
      meta.capture = {
        fNumber: fNum ? (Array.isArray(fNum) ? fNum[0] / (fNum[1] || 1) : Number(fNum)) : undefined,
        exposureTime: expTime ? (Array.isArray(expTime) ? expTime[0] / (expTime[1] || 1) : Number(expTime)) : undefined,
        iso: iso ? (Array.isArray(iso) ? Number(iso[0]) : Number(iso)) : undefined,
        focalLength: tags.exif?.FocalLength?.value
          ? (Array.isArray(tags.exif.FocalLength.value)
              ? tags.exif.FocalLength.value[0] / (tags.exif.FocalLength.value[1] || 1)
              : Number(tags.exif.FocalLength.value))
          : undefined,
        orientation: orientationVal
          ? Number(orientationVal)
          : undefined,
      };
    }

    // Dates from EXIF
    const dateStr = tags.exif?.DateTimeOriginal?.description;
    if (dateStr) {
      const normalized = dateStr.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
      const d = new Date(normalized);
      if (!isNaN(d.getTime())) {
        meta.dates = meta.dates || {};
        meta.dates.created = d.toISOString();
      }
    }
    const digitizedStr = tags.exif?.DateTimeDigitized?.description;
    if (digitizedStr) {
      const normalized = digitizedStr.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
      const d = new Date(normalized);
      if (!isNaN(d.getTime())) {
        meta.dates = meta.dates || {};
        meta.dates.digitized = d.toISOString();
      }
    }

    // GPS
    const lat = tags.gps?.Latitude;
    const lon = tags.gps?.Longitude;
    if (lat != null && lon != null) {
      meta.gps = { latitude: Number(lat), longitude: Number(lon) };
    }
  } catch (err) {
    console.debug('[PNG parseExif] ExifReader failed: %o', err);
  }
}

/**
 * Use ExifReader to parse the entire PNG file buffer for orientation.
 * ExifReader can extract Orientation from XMP (iTXt), eXIf, or other sources.
 * Called unconditionally — sets orientation on meta.capture if found.
 */
function extractOrientationFromFile(buffer: ArrayBuffer, meta: ImageMetadata): void {
  try {
    const tags = ExifReader.load(buffer, { expanded: true });

    // Try EXIF Orientation first
    let orientVal: unknown = tags.exif?.Orientation?.value;

    // Fallback to XMP tiff:Orientation
    if (!orientVal && (tags as Record<string, unknown>).xmp) {
      const xmp = (tags as Record<string, Record<string, { value?: unknown; description?: string }>>).xmp;
      const xmpOrientation = xmp['Orientation'] || xmp['tiff:Orientation'];
      if (xmpOrientation) {
        orientVal = xmpOrientation.value ?? xmpOrientation.description;
      }
    }

    if (orientVal) {
      const orientNum = Number(orientVal);
      if (orientNum >= 1 && orientNum <= 8) {
        meta.capture = meta.capture || {};
        meta.capture.orientation = orientNum;
      }
    }
  } catch {
    // ExifReader parse failed — non-critical, orientation remains unset
  }
}
