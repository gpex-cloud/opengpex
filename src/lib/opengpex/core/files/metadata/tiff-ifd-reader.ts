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
 * TIFF IFD (Image File Directory) shared utilities.
 *
 * Low-level binary read/write helpers and IFD structure parsers used by:
 * - tiff/metadata.ts (ICC extraction)
 * - tiff/decode.ts (per-page colour tags for multi-page TIFF)
 * - tiff/exif-inject.ts (EXIF SubIFD injection)
 * - tiff/ifd0-inject.ts (IFD0 metadata tag injection)
 * - raw/metadata/icc.ts (RAW ICC extraction — RAW files are TIFF-based)
 *
 * Modeled after `isobmff-reader.ts` which serves HEIC/AVIF handlers.
 *
 * @module core/files/metadata/tiff-ifd-reader
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Byte Order Detection
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Detect TIFF byte order from file header.
 * @returns 'little' for Intel (II), 'big' for Motorola (MM), null if invalid.
 */
export function parseTiffByteOrder(bytes: Uint8Array): 'little' | 'big' | null {
  if (bytes.length < 2) return null;
  if (bytes[0] === 0x49 && bytes[1] === 0x49) return 'little'; // "II"
  if (bytes[0] === 0x4D && bytes[1] === 0x4D) return 'big';    // "MM"
  return null;
}

/**
 * Extract raw EXIF bytes from a TIFF file as a standalone TIFF container.
 *
 * Finds the ExifSubIFD (tag 0x8769 in IFD0) and serializes it along with all
 * referenced data into a self-contained TIFF container suitable for re-embedding.
 *
 * The output format is: [ByteOrder(2)][Magic42(2)][IFD0Offset=8(4)][IFD0(1 entry: ExifIFDPtr)][ExifSubIFD][data...]
 *
 * @param bytes - Complete TIFF file bytes
 * @returns TIFF container bytes with ExifSubIFD, or null if no EXIF found
 */
export function extractTiffExif(bytes: Uint8Array): Uint8Array | null {
  const header = validateTiffHeader(bytes);
  if (!header) return null;

  const { isLE, ifd0Offset } = header;

  // Find ExifSubIFD pointer (tag 0x8769) in IFD0
  const entryCount = readU16(bytes, ifd0Offset, isLE);
  const entriesStart = ifd0Offset + 2;
  if (entriesStart + entryCount * 12 + 4 > bytes.length) return null;

  let exifSubIfdOffset = -1;
  for (let i = 0; i < entryCount; i++) {
    const entryOffset = entriesStart + i * 12;
    const tagId = readU16(bytes, entryOffset, isLE);
    if (tagId === 0x8769) { // ExifIFD pointer
      exifSubIfdOffset = readU32(bytes, entryOffset + 8, isLE);
      break;
    }
  }

  if (exifSubIfdOffset <= 0 || exifSubIfdOffset + 2 > bytes.length) return null;

  // Parse ExifSubIFD to collect all entries and their data ranges
  const exifEntryCount = readU16(bytes, exifSubIfdOffset, isLE);
  if (exifSubIfdOffset + 2 + exifEntryCount * 12 > bytes.length) return null;

  // Collect data ranges referenced by the ExifSubIFD entries
  interface DataRange { srcOffset: number; size: number }
  const dataRanges: DataRange[] = [];

  for (let i = 0; i < exifEntryCount; i++) {
    const entryOffset = exifSubIfdOffset + 2 + i * 12;
    const type = readU16(bytes, entryOffset + 2, isLE);
    const count = readU32(bytes, entryOffset + 4, isLE);
    const typeSize = TYPE_SIZES[type] || 1;
    const totalSize = typeSize * count;

    if (totalSize > 4) {
      // Data stored at an offset
      const dataOffset = readU32(bytes, entryOffset + 8, isLE);
      if (dataOffset + totalSize <= bytes.length) {
        dataRanges.push({ srcOffset: dataOffset, size: totalSize });
      }
    }
  }

  // Build output TIFF container:
  // [Header: 8 bytes] [IFD0: 2 + 1*12 + 4 = 18 bytes] [ExifSubIFD: 2 + N*12 + 4 bytes] [data...]
  const ifd0Size = 2 + 1 * 12 + 4; // 1 entry (ExifIFDPointer) + next-IFD ptr
  const exifIfdSize = 2 + exifEntryCount * 12 + 4; // entries + next-IFD ptr
  const dataStart = 8 + ifd0Size + exifIfdSize;

  // Calculate total data size
  let totalDataSize = 0;
  for (const r of dataRanges) totalDataSize += r.size;

  const outputSize = dataStart + totalDataSize;
  const out = new Uint8Array(outputSize);

  // Write TIFF header
  if (isLE) { out[0] = 0x49; out[1] = 0x49; }
  else { out[0] = 0x4D; out[1] = 0x4D; }
  writeU16(out, 2, 42, isLE);
  writeU32(out, 4, 8, isLE); // IFD0 at offset 8

  // Write IFD0 (1 entry: ExifIFDPointer)
  const ifd0Start = 8;
  const exifIfdStart = ifd0Start + ifd0Size;
  writeU16(out, ifd0Start, 1, isLE); // 1 entry
  // Entry: tag=0x8769, type=LONG(4), count=1, value=exifIfdStart
  writeU16(out, ifd0Start + 2, 0x8769, isLE);
  writeU16(out, ifd0Start + 4, 4, isLE); // LONG
  writeU32(out, ifd0Start + 6, 1, isLE); // count=1
  writeU32(out, ifd0Start + 10, exifIfdStart, isLE); // offset to ExifSubIFD
  writeU32(out, ifd0Start + 14, 0, isLE); // next IFD = 0 (none)

  // Write ExifSubIFD entries with rebased offsets
  writeU16(out, exifIfdStart, exifEntryCount, isLE);
  let currentDataOffset = dataStart;

  for (let i = 0; i < exifEntryCount; i++) {
    const srcEntry = exifSubIfdOffset + 2 + i * 12;
    const dstEntry = exifIfdStart + 2 + i * 12;

    // Copy 12-byte entry as-is first
    out.set(bytes.slice(srcEntry, srcEntry + 12), dstEntry);

    // Check if offset needs rebasing
    const type = readU16(bytes, srcEntry + 2, isLE);
    const count = readU32(bytes, srcEntry + 4, isLE);
    const typeSize = TYPE_SIZES[type] || 1;
    const totalSize = typeSize * count;

    if (totalSize > 4) {
      const srcDataOffset = readU32(bytes, srcEntry + 8, isLE);
      // Find this data range and copy it
      if (srcDataOffset + totalSize <= bytes.length) {
        out.set(bytes.slice(srcDataOffset, srcDataOffset + totalSize), currentDataOffset);
        writeU32(out, dstEntry + 8, currentDataOffset, isLE); // rebase offset
        currentDataOffset += totalSize;
      }
    }
  }

  // Write next-IFD pointer for ExifSubIFD (0 = none)
  writeU32(out, exifIfdStart + 2 + exifEntryCount * 12, 0, isLE);

  return out;
}

/**
 * Validate a TIFF file header (byte order + magic 42 + IFD0 offset).
 * @returns IFD0 offset if valid, or -1 if invalid header.
 */
export function validateTiffHeader(bytes: Uint8Array): { isLE: boolean; ifd0Offset: number } | null {
  if (bytes.length < 8) return null;

  const byteOrder = parseTiffByteOrder(bytes);
  if (!byteOrder) return null;

  const isLE = byteOrder === 'little';
  const magic = readU16(bytes, 2, isLE);
  if (magic !== 42) return null;

  const ifd0Offset = readU32(bytes, 4, isLE);
  if (ifd0Offset === 0 || ifd0Offset >= bytes.length - 2) return null;

  return { isLE, ifd0Offset };
}

/**
 * Probe a TIFF's multi-page property (and page count) by walking the IFD linked
 * list — pure main-thread binary offset hops (< 0.1ms), NO pixel decode and NO
 * cross-thread vips worker. Mirrors the IFD-chain walk in `extractTiffIcc`.
 *
 * Handles BOTH classic TIFF (magic 42, U16 entry count, 12-byte entries, U32
 * offsets) AND BigTIFF (magic 43, U64 entry count, 20-byte entries, U64 offsets),
 * so a multi-page BigTIFF is no longer mis-probed as single-page — the vips
 * `getPageCount` worker RPC it previously fell back to has been retired.
 * Any malformed / unrecognised header degrades to `{ isMultiFrame: false,
 * pageCount: 1 }`.
 */
export function probeTiffPages(bytes: Uint8Array): { isMultiFrame: boolean; pageCount: number } {
  const byteOrder = parseTiffByteOrder(bytes);
  if (!byteOrder || bytes.length < 8) return { isMultiFrame: false, pageCount: 1 };

  const isLE = byteOrder === 'little';
  const magic = readU16(bytes, 2, isLE);

  // Header layout differs between classic TIFF and BigTIFF.
  let ifdOffset: number;
  let isBig = false;
  if (magic === 42) {
    ifdOffset = readU32(bytes, 4, isLE);
  } else if (magic === 43) {
    // BigTIFF: [4-5] offset bytesize (must be 8), [6-7] reserved 0, [8-15] U64 IFD0.
    if (bytes.length < 16 || readU16(bytes, 4, isLE) !== 8) {
      return { isMultiFrame: false, pageCount: 1 };
    }
    isBig = true;
    ifdOffset = readU64(bytes, 8, isLE);
  } else {
    return { isMultiFrame: false, pageCount: 1 };
  }

  // Per-variant IFD field widths: [count][entries...][nextIFD].
  const countSize = isBig ? 8 : 2;
  const entrySize = isBig ? 20 : 12;
  const ptrSize = isBig ? 8 : 4;

  let pageCount = 0;
  const maxPages = 1000; // guard against a malformed / cyclic IFD chain

  while (ifdOffset > 0 && ifdOffset + countSize <= bytes.length && pageCount < maxPages) {
    pageCount++;
    const entryCount = isBig ? readU64(bytes, ifdOffset, isLE) : readU16(bytes, ifdOffset, isLE);
    const nextIfdPtrOffset = ifdOffset + countSize + entryCount * entrySize;
    if (nextIfdPtrOffset + ptrSize > bytes.length) break;

    const nextIfdOffset = isBig
      ? readU64(bytes, nextIfdPtrOffset, isLE)
      : readU32(bytes, nextIfdPtrOffset, isLE);
    if (nextIfdOffset === 0 || nextIfdOffset === ifdOffset) break;
    ifdOffset = nextIfdOffset;
  }

  return {
    isMultiFrame: pageCount > 1,
    pageCount: Math.max(1, pageCount),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Binary Read/Write Primitives
// ═══════════════════════════════════════════════════════════════════════════════
/** Read 16-bit unsigned integer with specified byte order. */
export function readU16(bytes: Uint8Array, offset: number, isLE: boolean): number {
  if (isLE) return bytes[offset] | (bytes[offset + 1] << 8);
  return (bytes[offset] << 8) | bytes[offset + 1];
}

/** Read 32-bit unsigned integer with specified byte order. */
export function readU32(bytes: Uint8Array, offset: number, isLE: boolean): number {
  if (isLE) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  }
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

/**
 * Read a 64-bit unsigned integer (BigTIFF offsets / counts) as a JS number.
 *
 * Composed from two U32 halves — safe for any real file, whose byte length is
 * itself a JS number well under 2^53; a value beyond that only ever fails the
 * caller's `< bytes.length` bound check and stops the walk.
 */
export function readU64(bytes: Uint8Array, offset: number, isLE: boolean): number {
  const lo = readU32(bytes, isLE ? offset : offset + 4, isLE);
  const hi = readU32(bytes, isLE ? offset + 4 : offset, isLE);
  return hi * 0x1_0000_0000 + lo;
}

/** Write 16-bit unsigned integer with specified byte order. */
export function writeU16(bytes: Uint8Array, offset: number, value: number, isLE: boolean): void {
  if (isLE) {
    bytes[offset] = value & 0xFF;
    bytes[offset + 1] = (value >> 8) & 0xFF;
  } else {
    bytes[offset] = (value >> 8) & 0xFF;
    bytes[offset + 1] = value & 0xFF;
  }
}

/** Write 32-bit unsigned integer with specified byte order. */
export function writeU32(bytes: Uint8Array, offset: number, value: number, isLE: boolean): void {
  if (isLE) {
    bytes[offset] = value & 0xFF;
    bytes[offset + 1] = (value >> 8) & 0xFF;
    bytes[offset + 2] = (value >> 16) & 0xFF;
    bytes[offset + 3] = (value >> 24) & 0xFF;
  } else {
    bytes[offset] = (value >> 24) & 0xFF;
    bytes[offset + 1] = (value >> 16) & 0xFF;
    bytes[offset + 2] = (value >> 8) & 0xFF;
    bytes[offset + 3] = value & 0xFF;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// IFD Tag Readers
// ═══════════════════════════════════════════════════════════════════════════════

/** TIFF tag ID for ICC Profile (InterColorProfile) */
export const ICC_PROFILE_TAG = 0x8773; // 34675

/** TIFF IFD entry type sizes in bytes */
export const TYPE_SIZES: Record<number, number> = {
  1: 1,  // BYTE
  2: 1,  // ASCII
  3: 2,  // SHORT
  4: 4,  // LONG
  5: 8,  // RATIONAL
  6: 1,  // SBYTE
  7: 1,  // UNDEFINED
  8: 2,  // SSHORT
  9: 4,  // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
};

/**
 * Extract raw ICC Profile bytes directly from TIFF IFD structure.
 *
 * Parses the TIFF header and walks IFD chain to find tag 34675 (ICC Profile),
 * then extracts the raw bytes.
 *
 * Works for standard TIFF files and TIFF-based RAW formats (CR2, NEF, ARW, DNG).
 *
 * @param bytes - Complete TIFF/RAW file bytes
 * @returns Raw ICC profile bytes, or null if not found
 */
export function extractTiffIcc(bytes: Uint8Array): Uint8Array | null {
  const header = validateTiffHeader(bytes);
  if (!header) return null;

  const { isLE } = header;
  let ifdOffset = header.ifd0Offset;

  // Walk through IFDs (typically just IFD0, but check linked IFDs too)
  const maxIfdIterations = 10; // safety limit
  for (let iter = 0; iter < maxIfdIterations && ifdOffset > 0 && ifdOffset < bytes.length - 2; iter++) {
    const entryCount = readU16(bytes, ifdOffset, isLE);
    const entriesStart = ifdOffset + 2;

    if (entriesStart + entryCount * 12 + 4 > bytes.length) break;

    // Search for ICC Profile tag in this IFD
    for (let i = 0; i < entryCount; i++) {
      const entryOffset = entriesStart + i * 12;
      const tagId = readU16(bytes, entryOffset, isLE);

      if (tagId === ICC_PROFILE_TAG) {
        const count = readU32(bytes, entryOffset + 4, isLE);
        if (count === 0 || count > bytes.length) return null;

        // If data fits in 4 bytes, it's inline (extremely unlikely for ICC)
        if (count <= 4) {
          return bytes.slice(entryOffset + 8, entryOffset + 8 + count);
        }

        // Otherwise, value field is an offset to the data
        const dataOffset = readU32(bytes, entryOffset + 8, isLE);
        if (dataOffset + count > bytes.length) return null;

        return bytes.slice(dataOffset, dataOffset + count);
      }
    }

    // Move to next IFD (linked list)
    const nextIfdOffset = readU32(bytes, entriesStart + entryCount * 12, isLE);
    if (nextIfdOffset === 0 || nextIfdOffset === ifdOffset) break;
    ifdOffset = nextIfdOffset;
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Deep ICC candidate collection (DNG SubIFD + embedded preview JPEG)
// ═══════════════════════════════════════════════════════════════════════════════

/** DNG / TIFF tags used by the deep ICC walk. */
const TAG_SUBIFDS = 0x014A;              // SubIFDs (array of IFD offsets)
const TAG_JPEG_INTERCHANGE = 0x0201;     // JPEGInterchangeFormat (thumbnail JPEG offset)
const TAG_JPEG_INTERCHANGE_LEN = 0x0202; // JPEGInterchangeFormatLength
const TAG_COMPRESSION = 0x0103;          // Compression (7 = JPEG)
const TAG_STRIP_OFFSETS = 0x0111;        // StripOffsets
const TAG_STRIP_BYTE_COUNTS = 0x0117;    // StripByteCounts

/** Candidate ICC sources found across a TIFF/DNG's full IFD tree. */
export interface TiffIccCandidates {
  /** First raw ICC (`ICC_PROFILE_TAG`) found in ANY IFD (top-level or SubIFD). */
  directIcc: Uint8Array | null;
  /** Embedded JPEG streams (preview / thumbnail) — each may carry an APP2 ICC. */
  jpegPreviews: Uint8Array[];
}

/**
 * Collect every ICC candidate in a TIFF/DNG by walking the FULL IFD tree, not
 * just the top-level chain that `extractTiffIcc` covers.
 *
 * Why RAW/DNG needs this: iPhone ProRAW carries no top-level ICC and no
 * `ColorSpace` tag — its only colour-space signal is the embedded preview JPEG
 * (Display P3 in the APP2 ICC), which lives in a **SubIFD** (tag 0x014A). This
 * walker BFS-visits IFD0's chain plus all SubIFDs and, per IFD, captures:
 *   • a direct `ICC_PROFILE_TAG` (first wins), and
 *   • any embedded JPEG stream — old-style `JPEGInterchangeFormat` (0x0201/0x0202)
 *     or a `Compression == 7` single-strip preview (0x0111/0x0117).
 * Callers then run `extractJpegIcc` on the previews to recover the profile name.
 *
 * Classic TIFF only (12-byte entries, U32 offsets), matching `extractTiffIcc`.
 */
export function collectTiffIccCandidates(bytes: Uint8Array): TiffIccCandidates {
  const result: TiffIccCandidates = { directIcc: null, jpegPreviews: [] };
  const header = validateTiffHeader(bytes);
  if (!header) return result;

  const { isLE } = header;
  const visited = new Set<number>();
  const queue: number[] = [header.ifd0Offset];
  let guard = 0;
  const maxIfds = 64; // ProRAW has a handful of IFDs; guard against cyclic/malformed

  while (queue.length > 0 && guard++ < maxIfds) {
    const ifdOffset = queue.shift()!;
    if (ifdOffset <= 0 || ifdOffset + 2 > bytes.length || visited.has(ifdOffset)) continue;
    visited.add(ifdOffset);

    const entryCount = readU16(bytes, ifdOffset, isLE);
    const entriesStart = ifdOffset + 2;
    if (entriesStart + entryCount * 12 + 4 > bytes.length) continue;

    let jpegOffset = -1, jpegLen = -1;
    let compression = -1, stripOffset = -1, stripByteCount = -1;

    for (let i = 0; i < entryCount; i++) {
      const e = entriesStart + i * 12;
      switch (readU16(bytes, e, isLE)) {
        case ICC_PROFILE_TAG:
          if (!result.directIcc) {
            const icc = readIccFromEntry(bytes, e, isLE);
            if (icc) result.directIcc = icc;
          }
          break;
        case TAG_SUBIFDS: {
          const type = readU16(bytes, e + 2, isLE);
          const count = readU32(bytes, e + 4, isLE);
          const size = (TYPE_SIZES[type] || 4) * count;
          const base = size <= 4 ? e + 8 : readU32(bytes, e + 8, isLE);
          for (let k = 0; k < count; k++) {
            const off = base + k * 4 + 4 <= bytes.length ? readU32(bytes, base + k * 4, isLE) : 0;
            if (off > 0) queue.push(off);
          }
          break;
        }
        case TAG_JPEG_INTERCHANGE: jpegOffset = readU32(bytes, e + 8, isLE); break;
        case TAG_JPEG_INTERCHANGE_LEN: jpegLen = readU32(bytes, e + 8, isLE); break;
        case TAG_COMPRESSION: compression = readFirstNumericValue(bytes, e, isLE) ?? -1; break;
        case TAG_STRIP_OFFSETS: stripOffset = readFirstNumericValue(bytes, e, isLE) ?? -1; break;
        case TAG_STRIP_BYTE_COUNTS: stripByteCount = readFirstNumericValue(bytes, e, isLE) ?? -1; break;
      }
    }

    // Old-style embedded JPEG thumbnail (offset + length pair).
    if (jpegOffset > 0 && jpegLen > 0 && jpegOffset + jpegLen <= bytes.length) {
      result.jpegPreviews.push(bytes.slice(jpegOffset, jpegOffset + jpegLen));
    }
    // JPEG-compressed preview stored as a (typically single) strip.
    if (compression === 7 && stripOffset > 0 && stripByteCount > 0 && stripOffset + stripByteCount <= bytes.length) {
      result.jpegPreviews.push(bytes.slice(stripOffset, stripOffset + stripByteCount));
    }

    const next = readU32(bytes, entriesStart + entryCount * 12, isLE);
    if (next > 0) queue.push(next);
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Per-page Colour Tags
// ═══════════════════════════════════════════════════════════════════════════════

/** The colour-defining tags of ONE TIFF page (one IFD). @see readTiffPageColorInfo */
export interface TiffPageColorInfo {
  /** Tag 0x0106 PhotometricInterpretation. 0/1 = grayscale, 5 = CMYK, else RGB-ish. */
  photometricInterpretation: number | null;
  /** Tag 0x8773 (`ICC_PROFILE_TAG`) — THIS IFD's own ICC, not the chain's first. */
  iccBytes: Uint8Array | null;
  /**
   * Tag 0x0102 BitsPerSample, sample 0. TIFF permits per-sample depths, which do
   * not occur in practice; taking sample 0 matches the file-level
   * `extractTiffMetadata` reading of `bpsTag[0]`.
   */
  bitsPerSample: number | null;
  /** Tag 0x0153 SampleFormat, sample 0: 1 = uint, 2 = int, 3 = IEEE float. */
  sampleFormat: number | null;
}

/**
 * Read one page's own colour-defining tags from the Nth IFD only (0-based).
 *
 * Walks the same IFD linked list `probeTiffPages` counts, but stops AT
 * `pageIndex` instead of counting to the end — so a multi-page TIFF whose page 3
 * is CMYK / 16-bit reports that, rather than page 0's identity. Neither existing
 * reader can serve this: `probeTiffPages` only counts IFDs and never reads tag
 * content, and `extractTiffIcc` means "the chain's FIRST ICC", not "the Nth
 * IFD's ICC".
 *
 * Classic TIFF only (12-byte entries, U32 offsets) — BigTIFF is out of scope,
 * matching the existing scope of `extractTiffIcc` / `extractTiffExif` (only
 * `probeTiffPages` handles BigTIFF, and only for page counting). A BigTIFF or any
 * malformed input yields all-null, which callers treat as "no per-page info →
 * fall back to file-level", i.e. today's behaviour.
 */
export function readTiffPageColorInfo(bytes: Uint8Array, pageIndex: number): TiffPageColorInfo {
  const EMPTY: TiffPageColorInfo = {
    photometricInterpretation: null,
    iccBytes: null,
    bitsPerSample: null,
    sampleFormat: null,
  };

  const header = validateTiffHeader(bytes);
  if (!header) return EMPTY;

  const { isLE } = header;
  let ifdOffset = header.ifd0Offset;
  let idx = 0;
  const maxPages = 1000; // same self-cycle guard magnitude as probeTiffPages

  while (ifdOffset > 0 && ifdOffset + 2 <= bytes.length && idx < maxPages) {
    const entryCount = readU16(bytes, ifdOffset, isLE);
    const entriesStart = ifdOffset + 2;
    if (entriesStart + entryCount * 12 + 4 > bytes.length) break;

    if (idx === pageIndex) {
      const out: TiffPageColorInfo = { ...EMPTY };
      for (let i = 0; i < entryCount; i++) {
        const entryOffset = entriesStart + i * 12;
        switch (readU16(bytes, entryOffset, isLE)) {
          case 0x0106: out.photometricInterpretation = readFirstNumericValue(bytes, entryOffset, isLE); break;
          case 0x0102: out.bitsPerSample = readFirstNumericValue(bytes, entryOffset, isLE); break;
          case 0x0153: out.sampleFormat = readFirstNumericValue(bytes, entryOffset, isLE); break;
          case ICC_PROFILE_TAG: out.iccBytes = readIccFromEntry(bytes, entryOffset, isLE); break;
        }
      }
      return out;
    }

    const nextIfdOffset = readU32(bytes, entriesStart + entryCount * 12, isLE);
    if (nextIfdOffset === 0 || nextIfdOffset === ifdOffset) break;
    ifdOffset = nextIfdOffset;
    idx++;
  }

  return EMPTY;
}

/**
 * Read the FIRST value of a numeric IFD entry, handling BOTH storage modes.
 *
 * ⚠️ The easiest thing to get wrong here: TIFF stores a value of ≤4 bytes INLINE
 * in the 12-byte entry's value field (offset +8, left-aligned), and treats that
 * same field as a U32 OFFSET to the data when the value exceeds 4 bytes.
 * `BitsPerSample`'s count equals SamplesPerPixel — RGB(3)/RGBA(4) means 3×2=6 or
 * 4×2=8 bytes, BOTH over 4, so both take the offset branch; grayscale(1) is
 * 2 bytes and takes the inline branch. Handling only one branch reproduces the
 * very defect this reader exists to fix (a 16-bit page read as 8-bit).
 * `extractTiffIcc` already handles the same pair of branches for the ICC tag;
 * this is that rule reused, not a second rule.
 */
function readFirstNumericValue(bytes: Uint8Array, entryOffset: number, isLE: boolean): number | null {
  const type = readU16(bytes, entryOffset + 2, isLE);
  const count = readU32(bytes, entryOffset + 4, isLE);
  const typeSize = TYPE_SIZES[type];
  if (!typeSize || count === 0) return null;

  const inline = typeSize * count <= 4;
  const at = inline ? entryOffset + 8 : readU32(bytes, entryOffset + 8, isLE);
  if (at + typeSize > bytes.length) return null;

  switch (type) {
    case 1: case 7: return bytes[at];        // BYTE / UNDEFINED
    case 3: return readU16(bytes, at, isLE); // SHORT
    case 4: return readU32(bytes, at, isLE); // LONG
    default: return null;                    // any other type is invalid for these tags
  }
}

/**
 * ICC bytes from ONE already-located entry (logic line-for-line with
 * `extractTiffIcc`'s inner block, minus the chain walk).
 */
function readIccFromEntry(bytes: Uint8Array, entryOffset: number, isLE: boolean): Uint8Array | null {
  const count = readU32(bytes, entryOffset + 4, isLE);
  if (count === 0 || count > bytes.length) return null;
  const at = count <= 4 ? entryOffset + 8 : readU32(bytes, entryOffset + 8, isLE);
  if (at + count > bytes.length) return null;
  return bytes.slice(at, at + count);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Orientation Reset
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Reset the EXIF Orientation tag to 1 (Normal) in raw TIFF IFD bytes.
 *
 * This is necessary when exporting pixels that have already been orientation-
 * corrected (e.g. from HEIC transcode or createImageBitmap with EXIF applied).
 * Without this reset, viewers would double-rotate the image.
 *
 * Mutates the input array in-place and also returns it for chaining.
 * If the Orientation tag is not found, the bytes are returned unmodified.
 */
export function resetExifOrientation(bytes: Uint8Array): Uint8Array {
  const byteOrder = parseTiffByteOrder(bytes);
  if (!byteOrder) return bytes;
  const isLE = byteOrder === 'little';

  // Validate TIFF magic
  if (bytes.length < 8) return bytes;
  const magic = readU16(bytes, 2, isLE);
  if (magic !== 0x002A) return bytes;

  const ifdOffset = readU32(bytes, 4, isLE);

  // Search IFD0 for Orientation tag (0x0112)
  if (ifdOffset > 0 && ifdOffset + 2 <= bytes.length) {
    const entryCount = readU16(bytes, ifdOffset, isLE);
    const entriesStart = ifdOffset + 2;
    if (entriesStart + entryCount * 12 > bytes.length) return bytes;

    for (let i = 0; i < entryCount; i++) {
      const entryOffset = entriesStart + i * 12;
      const tagId = readU16(bytes, entryOffset, isLE);
      if (tagId === 0x0112) { // Orientation
        // Type is SHORT (3), count is 1, value is at entryOffset + 8
        // Write 1 (Normal) as a SHORT value
        if (isLE) {
          bytes[entryOffset + 8] = 1;
          bytes[entryOffset + 9] = 0;
        } else {
          bytes[entryOffset + 8] = 0;
          bytes[entryOffset + 9] = 1;
        }
        return bytes;
      }
    }

  }

  return bytes;
}
