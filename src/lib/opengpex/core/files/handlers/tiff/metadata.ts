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
 * TIFF metadata extraction — fills ImageMetadata from IFD tags.
 *
 * Uses ExifReader for TIFF IFD tag parsing on main thread.
 * Lightweight header-only parse (<10ms for typical files).
 */

import ExifReader from 'exifreader';
import type { ImageMetadata, ColorSpaceId } from '../../types';
import { iccToBase64, parseIccProfileName } from '../../icc';
import { extractTiffIcc, extractTiffExif } from '../../metadata/tiff-ifd-reader';

/**
 * Extract full V2 metadata from a TIFF file.
 */
export async function extractTiffMetadata(file: File): Promise<ImageMetadata> {
  const meta: ImageMetadata = {
    sourceFormat: 'tiff',
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

    // ── Bit depth ──
    const bpsTag = tags.exif?.BitsPerSample?.value;
    if (bpsTag) {
      const bps = Array.isArray(bpsTag) ? Number(bpsTag[0]) : Number(bpsTag);
      if (bps > 0) meta.bitDepth = bps;
    }

    // ── Color space / photometric interpretation ──
    const photoInterp = tags.exif?.PhotometricInterpretation?.value;
    if (photoInterp != null) {
      switch (Number(photoInterp)) {
        case 5: meta.colorSpace = 'cmyk'; break;
        case 1: case 0: meta.colorSpace = 'grayscale'; break;
        default: meta.colorSpace = 'srgb';
      }
    }

    // ── Alpha ──
    if ((tags.exif as Record<string, unknown>)?.['ExtraSamples'] != null) meta.hasAlpha = true;
    const spp = tags.exif?.SamplesPerPixel?.value;
    if (Number(spp) === 4 && meta.colorSpace === 'srgb') meta.hasAlpha = true;

    // ── Raw EXIF extraction (for "Keep EXIF Data" re-embed support) ──
    const tiffBytes = new Uint8Array(fileBuffer);
    const exifRaw = extractTiffExif(tiffBytes);
    if (exifRaw && exifRaw.length > 0) {
      meta.raw.exif = iccToBase64(exifRaw); // reuse base64 helper
    }

    // ── ICC Profile (direct binary extraction from tag 34675, like JPEG/PNG/HEIC) ──
    const iccBytes = extractTiffIcc(tiffBytes);
    if (iccBytes && iccBytes.length > 0) {
      const profileName = parseIccProfileName(iccBytes) || 'Embedded';
      meta.raw.icc = { data: iccToBase64(iccBytes), name: profileName };
      meta.colorSpace = inferColorSpaceFromIcc(profileName);
    } else {
      // Fallback: try ExifReader's parsed ICC fields for colorSpace inference
      const iccChunks = tags.icc;
      if (iccChunks && typeof iccChunks === 'object') {
        const iccDesc = (iccChunks as Record<string, { description?: string }>)['ICC Description']?.description
          || (iccChunks as Record<string, { description?: string }>).ProfileDescription?.description;
        if (iccDesc) {
          meta.colorSpace = inferColorSpaceFromIcc(iccDesc);
        }
      }
    }

    // ── Dimensions ──
    const imgWidth = tags.exif?.ImageWidth?.value;
    const imgHeight = tags.exif?.ImageLength?.value;
    if (imgWidth) meta.width = Array.isArray(imgWidth) ? Number(imgWidth[0]) : Number(imgWidth);
    if (imgHeight) meta.height = Array.isArray(imgHeight) ? Number(imgHeight[0]) : Number(imgHeight);

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
      };
    }

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

    // ── Author ──
    const artist = tags.exif?.Artist?.description;
    const copyright = tags.exif?.Copyright?.description;
    if (artist || copyright) {
      meta.author = { name: artist, copyright };
    }
  } catch {
    // IFD metadata extraction failed — non-critical
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

