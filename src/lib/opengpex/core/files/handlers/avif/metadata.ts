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
 * AVIF metadata extraction — fills ImageMetadata from EXIF + ICC.
 *
 * Uses ExifReader for semantic field parsing (camera, capture, dates, GPS, DPI).
 * ICC Profile data is extracted from the AVIF colr box via ExifReader's `tags.icc.__raw`.
 *
 * V2: stores `raw.exif` and `raw.icc` in standard format.
 */

import ExifReader from 'exifreader';
import type { ImageMetadata, ColorSpaceId } from '../../metadata';
import { iccToBase64, parseIccProfileName } from '../../icc';
import { extractIsobmffIcc, extractIsobmffNclx, extractIsobmffExif, nclxToColorSpace } from '../../isobmff-reader';

/**
 * Extract full V2 metadata from an AVIF file.
 */
export async function extractAvifMetadata(file: File): Promise<ImageMetadata> {
  const meta: ImageMetadata = {
    sourceFormat: 'avif',
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
    const fileBuffer = await file.arrayBuffer();
    const tags = ExifReader.load(fileBuffer, { expanded: true });

    // ── DPI ──
    const xRes = tags.exif?.XResolution?.value;
    if (xRes) {
      const resUnit = tags.exif?.ResolutionUnit?.value;
      let dpi = Array.isArray(xRes) ? xRes[0] / (xRes[1] || 1) : Number(xRes);
      if (resUnit === 3) dpi = dpi * 2.54;
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

    // ── GPS ──
    const lat = tags.gps?.Latitude;
    const lon = tags.gps?.Longitude;
    if (lat != null && lon != null) {
      meta.gps = { latitude: Number(lat), longitude: Number(lon) };
    }

    // ── Dimensions ──
    const imgWidth = tags.exif?.ImageWidth?.value ?? tags.exif?.PixelXDimension?.value;
    const imgHeight = tags.exif?.ImageLength?.value ?? tags.exif?.PixelYDimension?.value;
    if (imgWidth) meta.width = Array.isArray(imgWidth) ? Number(imgWidth[0]) : Number(imgWidth);
    if (imgHeight) meta.height = Array.isArray(imgHeight) ? Number(imgHeight[0]) : Number(imgHeight);

    // ── Raw EXIF bytes (TIFF IFD from ISOBMFF Exif item — for round-trip preservation) ──
    const fileBytes = new Uint8Array(fileBuffer);
    const rawExif = extractIsobmffExif(fileBytes);
    if (rawExif && rawExif.length > 0) {
      meta.raw.exif = iccToBase64(rawExif); // reuse base64 helper
    }

    // ── ICC Profile (from ISOBMFF colr box — reliable binary extraction) ──
    const iccBytes = extractIsobmffIcc(fileBytes);
    if (iccBytes && iccBytes.length > 0) {
      const profileName = parseIccProfileName(iccBytes) || 'Embedded';
      meta.raw.icc = { data: iccToBase64(iccBytes), name: profileName };
      meta.colorSpace = inferColorSpaceFromIcc(profileName);
    } else {
      // nclx fallback — AVIF may use nclx for color space signaling
      const nclx = extractIsobmffNclx(fileBytes);
      if (nclx) {
        meta.colorSpace = nclxToColorSpace(nclx);
      }
    }

    // ── Bit depth (AVIF pixi box) ──
    const fileTags = tags.file as Record<string, { value?: unknown }> | undefined;
    const bitDepth = fileTags?.BitDepth?.value;
    if (bitDepth && Number(bitDepth) > 8) {
      meta.bitDepth = Number(bitDepth);
    }

    // ── Alpha ──
    const hasAlpha = fileTags?.NumberOfComponents?.value;
    if (hasAlpha && Number(hasAlpha) === 4) {
      meta.hasAlpha = true;
    }
  } catch {
    // Metadata extraction failed — non-critical
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
