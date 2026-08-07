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
 * WebP metadata extraction — fills ImageMetadata from EXIF + ICC.
 *
 * Uses ExifReader for semantic field parsing (camera, capture, dates, GPS, DPI).
 * Uses riff.ts for raw binary extraction (ICCP chunk, EXIF chunk).
 *
 * V2: stores `raw.exif` as base64 TIFF IFD bytes for round-trip passthrough.
 */

import ExifReader from 'exifreader';
import type { ImageMetadata, ColorSpaceId } from '../../metadata';
import { iccToBase64, parseIccProfileName } from '../../icc';
import { extractWebpIcc, extractWebpExif } from './riff';

/**
 * Extract full V2 metadata from a WebP file.
 * Parses EXIF semantics via ExifReader + extracts raw binaries via riff.ts.
 */
export async function extractWebpMetadata(file: File): Promise<ImageMetadata> {
  const fileBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(fileBuffer);

  const meta: ImageMetadata = {
    sourceFormat: 'webp',
    sourceFileName: file.name,
    sourceFileSize: file.size,
    width: 0,
    height: 0,
    dpi: 72,
    dpiSource: 'default',
    colorSpace: 'srgb',
    bitDepth: 8,
    hasAlpha: false,
    raw: {},
  };

  try {
    // ExifReader supports WebP RIFF container natively
    const tags = ExifReader.load(fileBuffer, { expanded: true });

    // ── DPI ──
    const xRes = tags.exif?.XResolution?.value;
    if (xRes) {
      const resUnit = tags.exif?.ResolutionUnit?.value;
      let dpi = Array.isArray(xRes) ? xRes[0] / (xRes[1] || 1) : Number(xRes);
      if (resUnit === 3) dpi = dpi * 2.54; // cm → inches
      if (dpi > 1 && dpi < 10000) {
        meta.dpi = Math.round(dpi);
        meta.dpiSource = 'exif';
      }
    }

    // ── Camera info ──
    const make = tags.exif?.Make?.description;
    const model = tags.exif?.Model?.description;
    if (make || model) {
      meta.camera = {
        make,
        model,
        lensMake: tags.exif?.LensMake?.description,
        lensModel: tags.exif?.LensModel?.description,
        software: tags.exif?.Software?.description,
      };
    }

    // ── Capture parameters ──
    const fNumber = tags.exif?.FNumber?.value;
    const exposureTime = tags.exif?.ExposureTime?.value;
    const iso = tags.exif?.ISOSpeedRatings?.value;
    if (fNumber || exposureTime || iso) {
      meta.capture = {
        fNumber: fNumber ? (Array.isArray(fNumber) ? fNumber[0] / (fNumber[1] || 1) : Number(fNumber)) : undefined,
        exposureTime: exposureTime ? (Array.isArray(exposureTime) ? exposureTime[0] / (exposureTime[1] || 1) : Number(exposureTime)) : undefined,
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

    // ── Dates ──
    const dateOriginal = tags.exif?.DateTimeOriginal?.description;
    if (dateOriginal) {
      try {
        const normalized = dateOriginal.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
        const d = new Date(normalized);
        if (!isNaN(d.getTime())) {
          meta.dates = { created: d.toISOString() };
        }
      } catch { /* non-critical */ }
    }
    const dateModified = tags.exif?.DateTime?.description;
    if (dateModified) {
      try {
        const normalized = dateModified.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
        const d = new Date(normalized);
        if (!isNaN(d.getTime())) {
          meta.dates = meta.dates || {};
          meta.dates.modified = d.toISOString();
        }
      } catch { /* non-critical */ }
    }

    // ── GPS ──
    const lat = tags.gps?.Latitude;
    const lon = tags.gps?.Longitude;
    if (lat != null && lon != null) {
      meta.gps = { latitude: Number(lat), longitude: Number(lon) };
    }

    // ── Dimensions from EXIF ──
    const imgWidth = tags.exif?.ImageWidth?.value ?? tags.exif?.PixelXDimension?.value;
    const imgHeight = tags.exif?.ImageLength?.value ?? tags.exif?.PixelYDimension?.value;
    if (imgWidth) meta.width = Array.isArray(imgWidth) ? Number(imgWidth[0]) : Number(imgWidth);
    if (imgHeight) meta.height = Array.isArray(imgHeight) ? Number(imgHeight[0]) : Number(imgHeight);
  } catch (err) {
    console.debug('[WebpHandler] ExifReader parsing failed:', (err as Error).message);
  }

  // ── Raw EXIF bytes (TIFF IFD from RIFF EXIF chunk) ──
  const rawExif = extractWebpExif(bytes);
  if (rawExif) {
    meta.raw.exif = iccToBase64(rawExif); // reuse base64 helper
  }

  // ── ICC Profile from ICCP chunk ──
  const rawIcc = extractWebpIcc(bytes);
  if (rawIcc) {
    const profileName = parseIccProfileName(rawIcc) || 'Embedded';
    meta.raw.icc = { data: iccToBase64(rawIcc), name: profileName };
    meta.colorSpace = inferColorSpaceFromIcc(profileName);
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
