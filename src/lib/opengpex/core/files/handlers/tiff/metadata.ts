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
import { iccToBase64, parseIccProfileName, inferColorSpaceFromIcc } from '../../shared/icc';
import { extractTiffIcc, extractTiffExif, probeTiffPages } from '../../metadata/tiff-ifd-reader';

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

    // ── Sample format (TIFF tag 339: 1 = uint, 2 = int, 3 = IEEE float) ──
    // Per TIFF 6.0, an absent tag 339 defaults to 1 (unsigned int) — honor that
    // spec default instead of guessing float for high bit depths; a genuinely
    // float file that omits tag 339 would be unreadable by any conformant reader.
    const exifRecord = tags.exif as Record<string, { value?: unknown } | undefined> | undefined;
    const sampleFormatTag = exifRecord?.['SampleFormat']?.value;
    if (sampleFormatTag != null) {
      const sf = Array.isArray(sampleFormatTag) ? Number(sampleFormatTag[0]) : Number(sampleFormatTag);
      if (sf === 3) meta.sampleFormat = 'float';
      else if (sf === 1 || sf === 2) meta.sampleFormat = 'uint';
    } else {
      meta.sampleFormat = 'uint';
    }

    // ── Color space / photometric interpretation ──
    const photoInterp = tags.exif?.PhotometricInterpretation?.value;
    if (photoInterp != null) {
      meta.colorSpace = photometricToColorSpace(Number(photoInterp));
    }

    // ── Alpha ──
    if ((tags.exif as Record<string, unknown>)?.['ExtraSamples'] != null) meta.hasAlpha = true;
    const spp = tags.exif?.SamplesPerPixel?.value;
    if (Number(spp) === 4 && meta.colorSpace === 'srgb') meta.hasAlpha = true;

    // ── Raw EXIF extraction (for "Keep EXIF Data" re-embed support) ──
    const tiffBytes = new Uint8Array(fileBuffer);

    // ── Multi-page probe (Stage 1 authoritative isMultiFrame; reuses tiffBytes,
    //    no LibVips getPageCount round-trip) ──
    meta.isMultiFrame = probeTiffPages(tiffBytes).isMultiFrame;

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
// Shared tag → ColorSpaceId inference
//
// EXPORTED (not private) because the multi-page decode path in `tiff/decode.ts`
// must classify EACH page's own tags by the EXACT same rules the file-level
// extraction above uses. Two copies of these rules would let per-page and
// file-level colour drift apart silently.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Map a TIFF `PhotometricInterpretation` (tag 0x0106) to a `ColorSpaceId`.
 *
 * 5 = Separated (CMYK); 0 = WhiteIsZero, 1 = BlackIsZero (both grayscale);
 * everything else (2 = RGB, 3 = palette, 8 = Lab, …) is handled as RGB-ish and
 * folded to 'srgb' — the ICC profile, when present, is the finer authority and
 * takes precedence at both call sites.
 */
export function photometricToColorSpace(photoInterp: number): ColorSpaceId {
  switch (photoInterp) {
    case 5: return 'cmyk';
    case 1: case 0: return 'grayscale';
    default: return 'srgb';
  }
}

/**
 * Infer color space from ICC profile name.
 *
 * Re-exported from `shared/icc.ts` (not a local copy) so `tiff/decode.ts`'s
 * existing `import { inferColorSpaceFromIcc } from './metadata'` keeps working
 * unchanged while the actual implementation is shared across every raster handler.
 */
export { inferColorSpaceFromIcc } from '../../shared/icc';

