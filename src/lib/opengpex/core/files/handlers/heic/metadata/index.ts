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
 * HEIC metadata extraction — fills ImageMetadata from the container parser +
 * ExifReader.
 *
 * Truths come from `parseHeicContainer` (one structural pass): bit depth
 * (pixi/hvcC), stored dimensions (grid output / ispe), colour identity
 * (colr ICC/nclx), orientation (irot/imir + EXIF tag), aux image structures
 * (gain map etc. — presence and shape only; the coded bytes stay in the
 * retained source blob), XMP text and multi-frame detection. ExifReader keeps
 * the SEMANTIC field parsing (camera, capture params, dates, GPS, DPI).
 *
 * The container parse is fallible on exotic files; on failure the phase-1
 * point extractors (isobmff-reader) still fill the critical fields.
 */

import ExifReader from 'exifreader';
import type { ImageMetadata } from '../../../types';
import { iccToBase64, parseIccProfileName, inferColorSpaceFromIcc } from '../../../shared/icc';
import {
  extractIsobmffIcc,
  extractIsobmffNclx,
  extractIsobmffExif,
  extractIsobmffPixiBitDepth,
  extractIsobmffHvcCBitDepth,
  nclxToColorSpace,
} from '../../../metadata/isobmff-reader';
import { parseHeicContainer, type HeicFileView } from './container';

/** Extract full V2 metadata from a HEIC file. */
export async function extractHeicMetadata(file: File): Promise<ImageMetadata> {
  const meta: ImageMetadata = {
    sourceFormat: 'heic',
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
    const fileBytes = new Uint8Array(fileBuffer);
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

    // ── Dimensions (EXIF as fallback) ──
    const imgWidth = tags.exif?.ImageWidth?.value ?? tags.exif?.PixelXDimension?.value;
    const imgHeight = tags.exif?.ImageLength?.value ?? tags.exif?.PixelYDimension?.value;
    if (imgWidth) meta.width = Array.isArray(imgWidth) ? Number(imgWidth[0]) : Number(imgWidth);
    if (imgHeight) meta.height = Array.isArray(imgHeight) ? Number(imgHeight[0]) : Number(imgHeight);

    // ── Raw EXIF bytes (TIFF IFD from ISOBMFF Exif item — for round-trip preservation) ──
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
      // nclx fallback — iPhone HEIC commonly uses nclx (primaries=12 → Display P3)
      const nclx = extractIsobmffNclx(fileBytes);
      if (nclx) {
        meta.colorSpace = nclxToColorSpace(nclx);
      }
    }

    // ── Bit depth truth (phase-1 point extractors as the fallback path) ──
    const pixiDepth = extractIsobmffPixiBitDepth(fileBytes);
    const hvcCDepth = extractIsobmffHvcCBitDepth(fileBytes);
    meta.bitDepth = pixiDepth ?? hvcCDepth ?? 8;

    // ── Full container view (supersedes the point reads where it parses) ──
    try {
      const view = parseHeicContainer(fileBytes);
      applyContainerView(meta, view);
    } catch {
      // Exotic container — the point-extractor fields above stand.
    }
  } catch {
    // EXIF extraction failed — non-critical
  }

  return meta;
}

/**
 * Overlay the container parser's truths onto the metadata. The point-extractor
 * results already on `meta` are equivalent, but the view adds what they cannot
 * see: orientation record, aux structures, XMP, multi-frame, true dimensions.
 */
function applyContainerView(meta: ImageMetadata, view: HeicFileView): void {
  // Stored dimensions: grid output size, else the single tile's ispe.
  const w = view.primary.grid?.outputWidth || view.primary.codedWidth;
  const h = view.primary.grid?.outputHeight || view.primary.codedHeight;
  if (w > 0) meta.width = w;
  if (h > 0) meta.height = h;

  meta.bitDepth = view.bitDepth;

  // Colour: prefer the ICC description, then nclx (same precedence as above).
  if (view.color.icc) {
    const profileName = parseIccProfileName(view.color.icc) || 'Embedded';
    meta.raw.icc = { data: iccToBase64(view.color.icc), name: profileName };
    meta.colorSpace = inferColorSpaceFromIcc(profileName);
  } else if (view.color.nclx) {
    meta.colorSpace = nclxToColorSpace(view.color.nclx);
  }

  meta.raw.heicProfileIdc = view.primary.profileIdc;
  meta.raw.heicOrientation = { ...view.orientation };
  meta.raw.xmp = view.metadata.xmp;
  meta.isMultiFrame = view.isMultiFrame;

  if (view.auxImages.length > 0) {
    meta.raw.heicAuxImages = view.auxImages.map((aux) => ({
      auxType: aux.auxType,
      kind: aux.payload.kind,
      grid: aux.payload.kind === 'grid' && aux.payload.grid.rows > 0
        ? {
            rows: aux.payload.grid.rows,
            cols: aux.payload.grid.cols,
            outputWidth: aux.payload.grid.outputWidth,
            outputHeight: aux.payload.grid.outputHeight,
          }
        : undefined,
      tileCount: aux.payload.kind === 'grid' ? aux.payload.tiles.length : undefined,
    }));
    meta.raw.hasGainmap = view.auxImages.some((a) => a.auxType.includes('hdrgainmap'));
  }
}
