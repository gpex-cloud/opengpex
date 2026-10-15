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
 * AVIF metadata extraction — fills ImageMetadata from the container parser
 * (`./metadata/container.ts`) plus ExifReader for the semantic EXIF fields.
 *
 * Truths come from the AVIF boxes themselves (probe-verified layout):
 *   - bit depth: pixi → av1C fallback — NEVER clamped, never defaulted to 8
 *     (the previous implementation read `tags.file?.BitDepth` from ExifReader,
 *     an API that does not exist for ISOBMFF — depth was always the default 8
 *     and the ingest matrix's >8-bit row never fired);
 *   - hasAlpha: alpha aux item (auxC URN + auxl reference) — the previous
 *     `NumberOfComponents` read was equally nonexistent, so alpha was always
 *     false and `skipContentBoundsScan` misfired on transparent AVIFs;
 *   - isMultiFrame: top-level `moov` (image sequence) — the previous handler
 *     never set it, so animated AVIFs silently decoded to their first frame;
 *   - colour: colr ICC → colr nclx (transfer-aware: PQ/HLG resolve to
 *     'unknown' and the matrix's HDR-negative row takes over);
 *   - dimensions: primary ispe (no longer dependent on an Exif item existing).
 *
 * ExifReader keeps the semantic EXIF fields (camera / capture / dates / GPS /
 * DPI) that it does parse correctly for ISOBMFF.
 */

import ExifReader from 'exifreader';
import type { ImageMetadata } from '../../types';
import { iccToBase64, parseIccProfileName, inferColorSpaceFromIcc } from '../../shared/icc';
import { extractIsobmffExif, extractIsobmffIcc, extractIsobmffNclx, nclxToColorSpace, nclxPrimariesToColorSpace } from '../../metadata/isobmff-reader';
import { parseAvifContainer } from './metadata/container';

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
    const bytes = new Uint8Array(fileBuffer);

    // ── container truths (authoritative; degrades gracefully on parse failure) ──
    let containerSucceeded = false;
    try {
      const view = parseAvifContainer(bytes);
      containerSucceeded = view.primaryItemId != null;

      if (view.primary.ispe) {
        meta.width = view.primary.ispe.width;
        meta.height = view.primary.ispe.height;
      }
      meta.bitDepth = view.bitDepth;
      meta.hasAlpha = view.hasAlpha;
      meta.isMultiFrame = view.isSequence;
      meta.raw.avifOrientation = {
        irotQuarterTurns: view.primary.irotQuarterTurns,
        imirAxis: view.primary.imirAxis,
      };
      if (view.primary.av1C) meta.raw.avifSeqProfile = view.primary.av1C.seqProfile;

      // Colour: ICC description, then nclx (transfer-aware). The ICC bytes on
      // the view are per-item; the pool-level extractor remains the fallback
      // for writers that skip per-item association.
      const iccBytes = view.primary.icc;
      if (iccBytes && iccBytes.length > 0) {
        const profileName = parseIccProfileName(iccBytes) || 'Embedded';
        meta.raw.icc = { data: iccToBase64(iccBytes), name: profileName };
        meta.colorSpace = inferColorSpaceFromIcc(profileName);
      } else if (view.primary.nclx) {
        const tc = view.primary.nclx.transferCharacteristics;
        if (tc === 16 || tc === 18) {
          // HDR (PQ/HLG): the transfer rides the `raw.transfer` seam (the HDR
          // decision rows match on it); the colorSpace records just the
          // PRIMARIES (a P3-PQ file is Display-P3 primaries carrying PQ
          // light, not 'unknown' — BT.2020 stays 'unknown' per gap #8).
          meta.raw.transfer = tc === 16 ? 'pq' : 'hlg';
          meta.colorSpace = nclxPrimariesToColorSpace(view.primary.nclx);
        } else {
          meta.colorSpace = nclxToColorSpace(view.primary.nclx);
        }
      }

      // ── metadata round-trip payloads ──
      if (view.metadata.exif && view.metadata.exif.length > 0) {
        meta.raw.exif = iccToBase64(view.metadata.exif); // base64 helper reuse
      }
      if (view.metadata.xmp) {
        meta.raw.xmp = view.metadata.xmp;
      }
    } catch {
      // container parse failure — fall through to the point extractors below
    }

    if (!containerSucceeded) {
      // Fallback colour path (pool-level extractors, unchanged behaviour)
      const iccBytes = extractIsobmffIcc(bytes);
      if (iccBytes && iccBytes.length > 0) {
        const profileName = parseIccProfileName(iccBytes) || 'Embedded';
        meta.raw.icc = { data: iccToBase64(iccBytes), name: profileName };
        meta.colorSpace = inferColorSpaceFromIcc(profileName);
      } else {
        const nclx = extractIsobmffNclx(bytes);
        if (nclx) {
          const tc = nclx.transferCharacteristics;
          if (tc === 16 || tc === 18) {
            meta.raw.transfer = tc === 16 ? 'pq' : 'hlg';
            meta.colorSpace = nclxPrimariesToColorSpace(nclx);
          } else {
            meta.colorSpace = nclxToColorSpace(nclx);
          }
        }
      }
      const rawExif = extractIsobmffExif(bytes);
      if (rawExif && rawExif.length > 0) meta.raw.exif = iccToBase64(rawExif);
    }

    // ── semantic EXIF fields (ExifReader handles these for ISOBMFF) ──
    const tags = ExifReader.load(fileBuffer, { expanded: true });

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
              ? tags.exif.FocalLength.value[0] / tags.exif.FocalLength.value[1]
              : Number(tags.exif.FocalLength.value))
          : undefined,
        orientation: tags.exif?.Orientation?.value
          ? Number(tags.exif.Orientation.value)
          : undefined,
      };
    }

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

    const lat = tags.gps?.Latitude;
    const lon = tags.gps?.Longitude;
    if (lat != null && lon != null) {
      meta.gps = { latitude: Number(lat), longitude: Number(lon) };
    }

    // Dimensions only fall back to the Exif item when ispe was absent —
    // never the other way around (ispe is the container truth).
    if (meta.width === 0) {
      const imgWidth = tags.exif?.ImageWidth?.value ?? tags.exif?.PixelXDimension?.value;
      const imgHeight = tags.exif?.ImageLength?.value ?? tags.exif?.PixelYDimension?.value;
      if (imgWidth) meta.width = Array.isArray(imgWidth) ? Number(imgWidth[0]) : Number(imgWidth);
      if (imgHeight) meta.height = Array.isArray(imgHeight) ? Number(imgHeight[0]) : Number(imgHeight);
    }
  } catch {
    // Metadata extraction failed — non-critical
  }

  return meta;
}
