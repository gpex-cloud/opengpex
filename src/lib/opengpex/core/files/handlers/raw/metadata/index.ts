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
 * FOLDER-AS-MODULE: this file was `handlers/raw/metadata.ts`
 * until the DNG tone-curve / HDR-transfer / MakerNotes seams made one flat file
 * untenable. It is now the ORCHESTRATOR of a sub-package:
 *
 *   ./icc.ts   — three-tier ICC byte probe (IFD → SubIFD → preview JPEG APP2)
 *   ./dng.ts   — Adobe DNG spec tags (ProfileName, ProfileToneCurve, transfer)
 *   ./index.ts — this file: arbitration + ImageMetadata assembly
 *
 * `import ... from './metadata'` resolves here unchanged, so no caller moved.
 *
 * Uses ExifReader for semantic field parsing (camera, capture, dates, GPS, DPI).
 *
 * Colour space is PROBED, not assumed (Route B / defect A): an embedded ICC
 * profile name or a DNG camera-profile name that names a known RGB gamut wins;
 * only when NOTHING is recognised do we fall back to `prophoto-rgb` (the widest
 * container for an untagged sensor). Bit depth is a hard fact for every RAW
 * (`BitsPerSample`), so it is read straight from the tag.
 *
 * @module core/files/handlers/raw/metadata
 */

import ExifReader from 'exifreader';
import type { ImageMetadata, ColorSpaceId } from '../../../types';
import { iccToBase64, parseIccProfileName, inferColorSpaceFromIcc } from '../../../shared/icc';
import { resolveRawIccBytes } from './icc';
import {
  readDngProfileName,
  detectTransfer,
  parseDngProfileToneCurve,
  parseDngHueSatMap,
  parseDngLookTable,
} from './dng';

export { resolveRawIccBytes } from './icc';
export {
  readDngProfileName,
  detectTransfer,
  parseDngProfileToneCurve,
  parseDngHueSatMap,
  parseDngLookTable,
  DNG_TAG_PROFILE_NAME,
  DNG_TAG_PROFILE_TONE_CURVE,
  DNG_TAG_HUE_SAT_MAP_DIMS,
  DNG_TAG_HUE_SAT_MAP_DATA1,
  DNG_TAG_HUE_SAT_MAP_DATA2,
  DNG_TAG_LOOK_TABLE_DIMS,
  DNG_TAG_LOOK_TABLE_DATA,
  type DngToneCurvePoint,
  type DngTableDims,
  type DngHueSatMap,
  type DngLookTable,
} from './dng';

/**
 * Classify a profile/description name into a RAW-meaningful RGB gamut, or
 * `null` when the name is not a recognised RGB gamut (cmyk / grayscale /
 * unknown all fall through — RAW is always tri-stimulus RGB after demosaic).
 *
 * Reuses the single shared `inferColorSpaceFromIcc` name matcher (the same one
 * every raster handler uses), so RAW gamut naming can never drift from it.
 */
function classifyGamutName(name: string | undefined): ColorSpaceId | null {
  if (!name) return null;
  const cs = inferColorSpaceFromIcc(name);
  return cs === 'display-p3' || cs === 'adobe-rgb' || cs === 'prophoto-rgb' || cs === 'srgb'
    ? cs
    : null;
}

/**
 * Detect the RAW's real colour identity (defect A core).
 *
 * Priority chain:
 *   1. embedded ICC profile name (`resolveRawIccBytes` → `parseIccProfileName`);
 *   2. DNG camera ProfileName (tag 50936) as a name clue;
 *   3. nothing recognised → `prophoto-rgb` fallback (traditional-DSLR behaviour
 *      does not regress — an untagged sensor keeps the widest container).
 *
 * Pure and exported for unit coverage; the `File`-level orchestration in
 * `extractRawMetadata` feeds it the two already-parsed name strings.
 */
export function detectRawColorIdentity(
  iccProfileName: string | undefined,
  dngProfileName: string | undefined,
): { colorSpace: ColorSpaceId; transfer: 'pq' | 'hlg' | 'sdr' | undefined } {
  const colorSpace =
    classifyGamutName(iccProfileName) ??
    classifyGamutName(dngProfileName) ??
    'prophoto-rgb';
  return { colorSpace, transfer: detectTransfer([iccProfileName, dngProfileName]) };
}

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
    colorSpace: 'prophoto-rgb', // pre-detection default; overwritten by detectRawColorIdentity below
    bitDepth: 14, // pre-detection default; overwritten by BitsPerSample below
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

    // ── ICC Profile (defect A deep probe — see ./icc.ts for the three tiers) ──
    const fileBytes = new Uint8Array(fileBuffer);
    const iccBytes = resolveRawIccBytes(fileBytes);
    let iccProfileName: string | undefined;
    const dngProfileName = readDngProfileName(
      tags.exif as Record<string, { description?: string }> | undefined,
    );
    if (iccBytes && iccBytes.length > 0) {
      iccProfileName = parseIccProfileName(iccBytes) || undefined;
      meta.raw.icc = { data: iccToBase64(iccBytes), name: iccProfileName || 'Embedded' };
    } else {
      // Fallback 1: DNG Camera Profile name (tag 50936 — not ICC, but useful for display)
      if (dngProfileName) {
        meta.raw.icc = { data: '', name: dngProfileName };
      } else {
        // Fallback 2: try ExifReader's parsed ICC fields for name-only storage
        const iccChunks = tags.icc;
        if (iccChunks && typeof iccChunks === 'object') {
          const iccDesc = (iccChunks as Record<string, { description?: string }>)['ICC Description']?.description
            || (iccChunks as Record<string, { description?: string }>).ProfileDescription?.description;
          if (iccDesc) {
            iccProfileName = String(iccDesc);
            meta.raw.icc = { data: '', name: iccProfileName };
          }
        }
      }
    }

    // ── Real colour identity + HDR transfer probe (defect A) ──
    // Priority: embedded ICC name → DNG ProfileName → prophoto-rgb fallback.
    const { colorSpace, transfer } = detectRawColorIdentity(iccProfileName, dngProfileName);
    meta.colorSpace = colorSpace;
    if (transfer) meta.raw.transfer = transfer; // write-only HDR seam (not consumed this phase)

    // ── DNG ProfileToneCurve (rendering-intent seam) ──
    // WRITE-ONLY: the GPU samples the generic filmic baseline today; a present
    // curve is what a later LUT-sampling intent would consume.
    const toneCurve = parseDngProfileToneCurve(fileBytes);
    if (toneCurve) meta.raw.dngToneCurve = toneCurve;

    // ── DNG camera-profile colour tables ──
    // WRITE-ONLY read-only infrastructure: HueSatMap (hue/sat/value warp) and
    // LookTable (creative Look). Nothing samples them this phase; the display
    // engine consumes them in future pipelines. Absent from most native DSLR RAW.
    const hueSatMap = parseDngHueSatMap(fileBytes);
    const lookTable = parseDngLookTable(fileBytes);
    if (hueSatMap || lookTable) {
      meta.raw.dngProfile = {
        ...(hueSatMap ? { hueSatMap } : {}),
        ...(lookTable ? { lookTable } : {}),
      };
    }
  } catch {
    // EXIF extraction failed — non-critical; keep the pre-detection defaults.
  }

  return meta;
}
