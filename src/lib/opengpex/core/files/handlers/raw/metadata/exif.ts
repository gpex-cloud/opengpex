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
 * RAW EXIF block extraction — rebuilds a lean, export-ready TIFF EXIF
 * structure from a TIFF-container RAW file (DNG / CR2 / NEF / ARW / PEF).
 *
 * WHY: every other raster handler stores `meta.raw.exif` (base64 of a TIFF IFD
 * structure) so the export path can embed an `eXIf` chunk / APP1 segment and
 * the ImageInfoDrawer can show its "Keep EXIF Data" toggle. RAW metadata used
 * to parse the semantic fields only and left `raw.exif` empty, so a RAW source
 * exported to PNG/JPEG/TIFF/WebP silently lost Make/Model/exposure metadata.
 *
 * WHAT the rebuilt container keeps:
 *   - IFD0's descriptive tags (Make, Model, Software, Orientation, DateTime, …);
 *   - the Exif IFD (tag 0x8769) — exposure, lens, dates, maker notes;
 *   - the GPS IFD (tag 0x8825) and the Interoperability IFD (0xA005) when present.
 *
 * WHAT it strips (a RAW container is not a display TIFF):
 *   - pixel-storage tags (Strip/Tile offsets & counts, JPEGInterchangeFormat,
 *     Compression, PhotometricInterpretation, BitsPerSample, SamplesPerPixel,
 *     RowsPerStrip, PlanarConfiguration, SubIFDs) — they describe the preview /
 *     sensor strips and would dangle in a metadata-only blob;
 *   - the whole DNG-private tag range (tag ≥ 0xC612, where DNGVersion starts) —
 *     ProfileToneCurve, HueSatMap, LookTable and ProfileGainTableMap live here
 *     and can weigh megabytes per file;
 *   - the IFD0 "next IFD" chain — in a RAW that is the thumbnail IFD;
 *   - any single entry whose data exceeds 64 KiB — a runaway table (a gain map,
 *     an oversized maker note) must never inflate the exported file.
 *
 * The source byte order is preserved; every offset > 4 bytes is copied byte
 * for byte and rebased into the compact output layout:
 *   [header 8][IFD0'][ExifIFD'][GPS'][InteropIFD'][data…]
 *
 * @module core/files/handlers/raw/metadata/exif
 */

import {
  validateTiffHeader,
  readU16,
  readU32,
  writeU16,
  writeU32,
  TYPE_SIZES,
} from '../../../metadata/tiff-ifd-reader';

/** TIFF/EXIF pointer tags that name a sub-IFD we rebuild alongside IFD0. */
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_INTEROP_IFD = 0xa005;

/** TIFF tags describing the RAW's pixel storage — meaningless without strips. */
const PIXEL_STORAGE_TAGS = new Set([
  0x0100, // ImageWidth
  0x0101, // ImageLength
  0x0102, // BitsPerSample
  0x0103, // Compression
  0x0106, // PhotometricInterpretation
  0x0111, // StripOffsets
  0x0115, // SamplesPerPixel
  0x0116, // RowsPerStrip
  0x0117, // StripByteCounts
  0x011c, // PlanarConfiguration
  0x0142, // TileWidth
  0x0143, // TileLength
  0x0144, // TileOffsets
  0x0145, // TileByteCounts
  0x014a, // SubIFDs (preview / raw-image IFDs)
  0x0201, // JPEGInterchangeFormat
  0x0202, // JPEGInterchangeFormatLength
]);

/** First DNG-private tag (DNGVersion). Everything at/above is DNG-proprietary. */
const DNG_PRIVATE_TAG_START = 0xc612;

/** Hard ceiling for any single copied entry — keeps runaway tables out. */
const MAX_ENTRY_BYTES = 64 * 1024;

/** True when this IFD entry must NOT travel into the export EXIF block. */
function isDroppedEntry(bytes: Uint8Array, entryOffset: number, isLE: boolean): boolean {
  const tag = readU16(bytes, entryOffset, isLE);
  if (PIXEL_STORAGE_TAGS.has(tag)) return true;
  if (tag >= DNG_PRIVATE_TAG_START) return true;

  const type = readU16(bytes, entryOffset + 2, isLE);
  const count = readU32(bytes, entryOffset + 4, isLE);
  const totalSize = (TYPE_SIZES[type] || 1) * count;
  return totalSize > MAX_ENTRY_BYTES;
}

/** Read one IFD's entries, returning the kept entry offsets in file order. */
function collectKeptEntries(
  bytes: Uint8Array,
  ifdOffset: number,
  isLE: boolean,
): number[] {
  const entryCount = readU16(bytes, ifdOffset, isLE);
  const entriesStart = ifdOffset + 2;
  if (entriesStart + entryCount * 12 > bytes.length) return [];

  const kept: number[] = [];
  for (let i = 0; i < entryCount; i++) {
    const entryOffset = entriesStart + i * 12;
    if (!isDroppedEntry(bytes, entryOffset, isLE)) kept.push(entryOffset);
  }
  return kept;
}

/** One rebuilt sub-IFD: its source entry list and its serialized location. */
interface RebuiltIfd {
  entries: number[];
  outputOffset: number;
  size: number;
}

/**
 * Serialize a rebuilt sub-IFD (Exif / GPS / Interop) at `at` in `out` and copy
 * its >4-byte values into the trailing data area, rebasing the offsets.
 * @returns the offset just past the written data.
 */
function serializeSubIfd(
  out: Uint8Array,
  src: Uint8Array,
  ifd: RebuiltIfd,
  isLE: boolean,
  dataStart: number,
  pointerTargets: Map<number, number>,
): number {
  const at = ifd.outputOffset;
  writeU16(out, at, ifd.entries.length, isLE);

  let cursor = dataStart;
  for (let i = 0; i < ifd.entries.length; i++) {
    const srcEntry = ifd.entries[i];
    const dstEntry = at + 2 + i * 12;
    out.set(src.slice(srcEntry, srcEntry + 12), dstEntry);

    const type = readU16(src, srcEntry + 2, isLE);
    const count = readU32(src, srcEntry + 4, isLE);
    const totalSize = (TYPE_SIZES[type] || 1) * count;
    if (totalSize > 4) {
      out.set(src.slice(readU32(src, srcEntry + 8, isLE), readU32(src, srcEntry + 8, isLE) + totalSize), cursor);
      writeU32(out, dstEntry + 8, cursor, isLE);
      cursor += totalSize;
    } else {
      // Inline pointer value (e.g. the Interop IFD pointer inside the Exif
      // IFD) — rebase it to the rebuilt sub-IFD's new location.
      const tag = readU16(src, srcEntry, isLE);
      if (pointerTargets.has(tag)) writeU32(out, dstEntry + 8, pointerTargets.get(tag)!, isLE);
    }
  }
  // Next-IFD pointer = 0 (no thumbnail chain in a metadata blob).
  writeU32(out, at + 2 + ifd.entries.length * 12, 0, isLE);
  return cursor;
}

/**
 * Rebuild a compact, export-ready EXIF TIFF structure from a TIFF-container
 * RAW. Returns `null` when the bytes are not a classic-TIFF header or carry no
 * keepable IFD0 tags — callers treat that as "no EXIF to embed".
 */
export function extractRawExif(bytes: Uint8Array): Uint8Array | null {
  const header = validateTiffHeader(bytes);
  if (!header) return null;
  const { isLE, ifd0Offset } = header;

  const ifd0Entries = collectKeptEntries(bytes, ifd0Offset, isLE);
  if (ifd0Entries.length === 0) return null;

  // Locate the sub-IFDs inside IFD0 (and the Interop IFD inside the Exif IFD).
  const findPointer = (entries: number[], tag: number): number => {
    for (const e of entries) {
      if (readU16(bytes, e, isLE) === tag) return readU32(bytes, e + 8, isLE);
    }
    return -1;
  };
  const subIfdSources: { tag: number; entries: number[] }[] = [];
  const exifIfdOffset = findPointer(ifd0Entries, TAG_EXIF_IFD);
  if (exifIfdOffset > 0 && exifIfdOffset + 2 <= bytes.length) {
    const entries = collectKeptEntries(bytes, exifIfdOffset, isLE);
    if (entries.length > 0) subIfdSources.push({ tag: TAG_EXIF_IFD, entries });
    const interopOffset = findPointer(entries, TAG_INTEROP_IFD);
    if (interopOffset > 0 && interopOffset + 2 <= bytes.length) {
      const interopEntries = collectKeptEntries(bytes, interopOffset, isLE);
      if (interopEntries.length > 0) subIfdSources.push({ tag: TAG_INTEROP_IFD, entries: interopEntries });
    }
  }
  const gpsIfdOffset = findPointer(ifd0Entries, TAG_GPS_IFD);
  if (gpsIfdOffset > 0 && gpsIfdOffset + 2 <= bytes.length) {
    const entries = collectKeptEntries(bytes, gpsIfdOffset, isLE);
    if (entries.length > 0) subIfdSources.push({ tag: TAG_GPS_IFD, entries });
  }

  // Layout: header + IFD0 + sub-IFDs + shared trailing data area.
  const ifd0Size = 2 + ifd0Entries.length * 12 + 4;
  const ifd0Start = 8;
  let subIfdsStart = ifd0Start + ifd0Size;
  const rebuilt: RebuiltIfd[] = subIfdSources.map(({ entries }) => {
    const ifd: RebuiltIfd = { entries, outputOffset: 0, size: 0 };
    ifd.outputOffset = subIfdsStart;
    ifd.size = 2 + entries.length * 12 + 4;
    subIfdsStart += ifd.size;
    return ifd;
  });
  const pointerTargets = new Map(subIfdSources.map((s, i) => [s.tag, rebuilt[i].outputOffset]));
  const dataStart = subIfdsStart;
  let dataCursor = dataStart;

  // Total data footprint of every kept entry (sub-IFD pointers are 4-byte
  // inline LONGs, so they never land in the data area).
  let dataSize = 0;
  const dataOf = (entries: number[]): number =>
    entries.reduce((sum, srcEntry) => {
      const type = readU16(bytes, srcEntry + 2, isLE);
      const count = readU32(bytes, srcEntry + 4, isLE);
      const totalSize = (TYPE_SIZES[type] || 1) * count;
      return totalSize > 4 ? sum + totalSize : sum;
    }, 0);
  dataSize += dataOf(ifd0Entries);
  for (const ifd of rebuilt) dataSize += dataOf(ifd.entries);

  const out = new Uint8Array(dataStart + dataSize);

  // Header — byte order preserved from the source RAW.
  out[0] = isLE ? 0x49 : 0x4d;
  out[1] = isLE ? 0x49 : 0x4d;
  writeU16(out, 2, 42, isLE);
  writeU32(out, 4, ifd0Start, isLE);

  // IFD0: kept entries verbatim, then pointer tags rewritten to the new
  // sub-IFD locations.
  writeU16(out, ifd0Start, ifd0Entries.length, isLE);
  for (let i = 0; i < ifd0Entries.length; i++) {
    const srcEntry = ifd0Entries[i];
    const dstEntry = ifd0Start + 2 + i * 12;
    out.set(bytes.slice(srcEntry, srcEntry + 12), dstEntry);

    const tag = readU16(bytes, srcEntry, isLE);
    const type = readU16(bytes, srcEntry + 2, isLE);
    const count = readU32(bytes, srcEntry + 4, isLE);
    const totalSize = (TYPE_SIZES[type] || 1) * count;
    if (totalSize > 4) {
      const at = readU32(bytes, srcEntry + 8, isLE);
      out.set(bytes.slice(at, at + totalSize), dataCursor);
      writeU32(out, dstEntry + 8, dataCursor, isLE);
      dataCursor += totalSize;
    } else if (pointerTargets.has(tag)) {
      writeU32(out, dstEntry + 8, pointerTargets.get(tag)!, isLE);
    }
  }
  writeU32(out, ifd0Start + 2 + ifd0Entries.length * 12, 0, isLE); // drop IFD1 (thumbnail)

  // Sub-IFDs (Exif / Interop / GPS) with rebased entries.
  for (const ifd of rebuilt) {
    dataCursor = serializeSubIfd(out, bytes, ifd, isLE, dataCursor, pointerTargets);
  }

  return out;
}
