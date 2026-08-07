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
