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
 * JPEG metadata extraction — fills ImageMetadata from EXIF + ICC.
 *
 * Uses ExifReader for semantic field parsing (camera, capture, dates, GPS, DPI).
 * Uses jfif.ts for raw binary extraction (EXIF APP1 bytes, ICC APP2 bytes).
 *
 * Key V2 change: stores `raw.exif` as base64 TIFF IFD bytes (no piexifObj).
 */

import ExifReader from 'exifreader';
import type { ImageMetadata } from '../../types';
import { iccToBase64, parseIccProfileName, inferColorSpaceFromIcc } from '../../shared/icc';
import { extractJpegExif, extractJpegIcc } from './jfif';
import { parseDateToISO } from '../../utils';

/**
 * Extract full V2 metadata from a JPEG file.
 * Parses EXIF semantics via ExifReader + extracts raw binaries via jfif.ts.
 */
export async function extractJpegMetadata(file: File): Promise<ImageMetadata> {
  const fileBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(fileBuffer);

  const meta: ImageMetadata = {
    sourceFormat: 'jpeg',
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

  // Hoist EXIF ColorSpace value for use after the try block
  let exifColorSpaceValue: number | undefined;

  try {
    const tags = ExifReader.load(fileBuffer, { expanded: true });

    // ── EXIF ColorSpace tag (used as ICC fallback) ──
    exifColorSpaceValue = tags.exif?.ColorSpace?.value as number | undefined;

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
    const fNum = tags.exif?.FNumber?.value;
    const expTime = tags.exif?.ExposureTime?.value;
    const iso = tags.exif?.ISOSpeedRatings?.value;
    const focalLength = tags.exif?.FocalLength?.value;
    const orientation = tags.exif?.Orientation?.value;
    if (fNum != null || expTime != null || iso != null || focalLength != null || orientation != null) {
      meta.capture = {
        fNumber: fNum ? (Array.isArray(fNum) ? fNum[0] / (fNum[1] || 1) : Number(fNum)) : undefined,
        exposureTime: expTime ? (Array.isArray(expTime) ? expTime[0] / (expTime[1] || 1) : Number(expTime)) : undefined,
        iso: iso ? (Array.isArray(iso) ? Number(iso[0]) : Number(iso)) : undefined,
        focalLength: focalLength
          ? (Array.isArray(focalLength)
              ? focalLength[0] / (focalLength[1] || 1)
              : Number(focalLength))
          : undefined,
        orientation: orientation != null
          ? (Array.isArray(orientation) ? Number(orientation[0]) : Number(orientation))
          : undefined,
      };
    }

    // ── Dates ──
    const created = parseDateToISO(tags.exif?.DateTimeOriginal?.description);
    const modified = parseDateToISO(tags.exif?.DateTime?.description);
    if (created || modified) {
      meta.dates = { created, modified };
    }

    // ── GPS ──
    const lat = tags.gps?.Latitude;
    const lon = tags.gps?.Longitude;
    if (lat != null && lon != null) {
      meta.gps = { latitude: Number(lat), longitude: Number(lon) };
    }

    // ── Dimensions from EXIF (fallback; primary dimensions come from decode) ──
    const imgWidth = tags.exif?.ImageWidth?.value ?? tags.exif?.PixelXDimension?.value;
    const imgHeight = tags.exif?.ImageLength?.value ?? tags.exif?.PixelYDimension?.value;
    if (imgWidth) meta.width = Array.isArray(imgWidth) ? Number(imgWidth[0]) : Number(imgWidth);
    if (imgHeight) meta.height = Array.isArray(imgHeight) ? Number(imgHeight[0]) : Number(imgHeight);
  } catch {
    // ExifReader parsing failed — non-critical
  }

  // ── Raw EXIF bytes (TIFF IFD, without "Exif\0\0" prefix) ──
  const rawExif = extractJpegExif(bytes);
  if (rawExif) {
    meta.raw.exif = iccToBase64(rawExif); // reuse base64 helper
  }

  // ── ICC Profile from APP2 markers ──
  const rawIcc = extractJpegIcc(bytes);
  if (rawIcc) {
    const profileName = parseIccProfileName(rawIcc) || 'Embedded';
    meta.raw.icc = { data: iccToBase64(rawIcc), name: profileName };
    meta.colorSpace = inferColorSpaceFromIcc(profileName);
  } else if (exifColorSpaceValue != null) {
    // No embedded ICC binary — infer colorSpace from EXIF ColorSpace tag
    // EXIF ColorSpace: 1 = sRGB, 65535 = Uncalibrated (often means AdobeRGB)
    if (exifColorSpaceValue === 1) {
      meta.colorSpace = 'srgb';
    } else if (exifColorSpaceValue === 65535) {
      // "Uncalibrated" — often indicates AdobeRGB when InteropIndex = 'R03'
      meta.colorSpace = 'adobe-rgb';
    }
  }

  return meta;
}
