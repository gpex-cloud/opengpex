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
 * - tiff/exif-inject.ts (EXIF SubIFD injection)
 * - tiff/ifd0-inject.ts (IFD0 metadata tag injection)
 * - raw/metadata.ts (RAW ICC extraction — RAW files are TIFF-based)
 *
 * Modeled after `isobmff-reader.ts` which serves HEIC/AVIF handlers.
 *
 * @module core/files/tiff-ifd
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
