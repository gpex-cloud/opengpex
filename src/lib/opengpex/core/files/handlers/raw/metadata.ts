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
 * RAW metadata extraction — fills ImageMetadata from EXIF.
 *
 * Uses ExifReader for semantic field parsing (camera, capture, dates, GPS, DPI).
 * RAW files default to prophoto-rgb color space and 14-bit depth.
 *
 * Note: RAW ICC raw bytes are not typically accessible from the container header.
 */

import ExifReader from 'exifreader';
import type { ImageMetadata } from '../../metadata';
import { iccToBase64, parseIccProfileName } from '../../icc';
import { extractTiffIcc } from '../../tiff-ifd-reader';

/**
 * Extract full V2 metadata from a Camera RAW file.
 */
export async function extractRawMetadata(file: File): Promise<ImageMetadata> {
  const meta: ImageMetadata = {
    sourceFormat: 'raw',
    sourceFileName: file.name,
    sourceFileSize: file.size,
    width: 0,
    height: 0,
    dpi: 72,
    dpiSource: 'default',
    colorSpace: 'prophoto-rgb', // RAW sensor gamut → ProPhoto RGB
    bitDepth: 14, // Most modern RAW sensors are 14-bit
    hasAlpha: false,
    raw: {},
  };

  try {
    const fileBuffer = await file.arrayBuffer();
    const tags = ExifReader.load(fileBuffer, { expanded: true });

    // ── Camera info (most valuable for RAW) ──
    const make = tags.exif?.Make?.description;
    const model = tags.exif?.Model?.description;
    meta.camera = {
      make,
      model,
      lensMake: tags.exif?.LensMake?.description,
      lensModel: tags.exif?.LensModel?.description,
      software: tags.exif?.Software?.description,
    };

    // ── Capture parameters ──
    const fNum = tags.exif?.FNumber?.value;
    const expTime = tags.exif?.ExposureTime?.value;
    const iso = tags.exif?.ISOSpeedRatings?.value;
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

    // ── Dates ──
    const dateStr = tags.exif?.DateTimeOriginal?.description;
    if (dateStr) {
      try {
        const normalized = dateStr.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
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

    // ── Bit depth ──
    const bpsTag = tags.exif?.BitsPerSample?.value;
    if (bpsTag) {
      const bps = Array.isArray(bpsTag) ? Number(bpsTag[0]) : Number(bpsTag);
      if (bps > 0) meta.bitDepth = bps;
    }

    // ── Dimensions ──
    const imgWidth = tags.exif?.ImageWidth?.value ?? tags.exif?.PixelXDimension?.value;
    const imgHeight = tags.exif?.ImageLength?.value ?? tags.exif?.PixelYDimension?.value;
    if (imgWidth) meta.width = Array.isArray(imgWidth) ? Number(imgWidth[0]) : Number(imgWidth);
    if (imgHeight) meta.height = Array.isArray(imgHeight) ? Number(imgHeight[0]) : Number(imgHeight);

    // ── ICC Profile (direct binary extraction from TIFF IFD tag 34675) ──
    const iccBytes = extractTiffIcc(new Uint8Array(fileBuffer));
    if (iccBytes && iccBytes.length > 0) {
      const profileName = parseIccProfileName(iccBytes) || 'Embedded';
      meta.raw.icc = { data: iccToBase64(iccBytes), name: profileName };
    } else {
      // Fallback 1: DNG Camera Profile name (tag 50936 — not ICC, but useful for display)
      const dngProfileName = (tags.exif as Record<string, { description?: string }>)?.ProfileName?.description;
      if (dngProfileName) {
        meta.raw.icc = { data: '', name: dngProfileName };
      } else {
        // Fallback 2: try ExifReader's parsed ICC fields for name-only storage
        const iccChunks = tags.icc;
        if (iccChunks && typeof iccChunks === 'object') {
          const iccDesc = (iccChunks as Record<string, { description?: string }>)['ICC Description']?.description
            || (iccChunks as Record<string, { description?: string }>).ProfileDescription?.description;
          if (iccDesc) {
            meta.raw.icc = { data: '', name: String(iccDesc) };
          }
        }
      }
    }
  } catch {
    // EXIF extraction failed — non-critical
  }

  return meta;
}
