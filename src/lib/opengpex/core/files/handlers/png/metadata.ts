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
 * Traverses PNG chunks in order, dispatching to readers, and populates
 * the V2 metadata structure. Does NOT decompress IDAT (no pixel decode).
 */

import ExifReader from 'exifreader';
import type { ImageMetadata, ColorSpaceId } from '../../metadata';
import { iterateChunks, verifySignature } from './chunks';
import { readIHDR, readpHYs, readiCCP, readeXIf, readtEXt, readiTXt, readtIME, readgAMA } from './readers';
import { iccToBase64, parseIccProfileName } from '../../icc';

/**
 * Extract full V2 metadata from a PNG file.
 * Streaming chunk parser — reads headers only, no IDAT decompression.
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
    if (fNum || expTime || iso) {
      meta.capture = {
        fNumber: fNum ? (Array.isArray(fNum) ? fNum[0] / (fNum[1] || 1) : Number(fNum)) : undefined,
        exposureTime: expTime ? (Array.isArray(expTime) ? expTime[0] / (expTime[1] || 1) : Number(expTime)) : undefined,
        iso: iso ? (Array.isArray(iso) ? Number(iso[0]) : Number(iso)) : undefined,
        focalLength: tags.exif?.FocalLength?.value
          ? (Array.isArray(tags.exif.FocalLength.value)
              ? tags.exif.FocalLength.value[0] / (tags.exif.FocalLength.value[1] || 1)
              : Number(tags.exif.FocalLength.value))
          : undefined,
        orientation: tags.exif?.Orientation?.value
          ? Number(tags.exif.Orientation.value)
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
  } catch {
    // EXIF parsing failed — non-critical, semantic fields remain empty
  }
}
