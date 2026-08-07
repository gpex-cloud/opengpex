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
 * TIFF EXIF injection — post-encode binary IFD manipulation.
 *
 * Injects raw EXIF data into a TIFF file after encoding.
 *
 * The input `exifIfdBytes` comes from JPEG APP1 extraction (without "Exif\0\0" prefix),
 * which means it is a COMPLETE TIFF container:
 *   [ByteOrder (2)] [Magic 42 (2)] [IFD0 Offset (4)] [IFD0...] [ExifSubIFD...] [data...]
 *
 * Strategy:
 *   1. Parse the EXIF TIFF container to find the ExifSubIFD (tag 0x8769 in EXIF's IFD0)
 *   2. Parse the output TIFF header (byte order + IFD0 offset)
 *   3. If byte orders differ, convert EXIF container to output byte order
 *   4. Find/create ExifIFDPointer (tag 0x8769) in the output's IFD0
 *   5. Append the (converted) EXIF TIFF block at end of output file
 *   6. Set ExifIFDPointer to point to the correct offset (ExifSubIFD within the appended block)
 *   7. Rebase offset-type values in the appended ExifSubIFD
 *
 * @module core/files/handlers/tiff/exif-inject
 */

import { parseTiffByteOrder, readU16, readU32, writeU16, writeU32, TYPE_SIZES } from '../../tiff-ifd-reader';

/** Tag ID for EXIF SubIFD pointer in IFD0 */
const EXIF_IFD_POINTER_TAG = 0x8769;

/** Sub-IFD pointer tags whose LONG value is an offset to another IFD */
const SUB_IFD_POINTER_TAGS = new Set([
  0x8769, // ExifSubIFD
  0x8825, // GPS IFD
  0xA005, // Interop IFD
]);

/**
 * Inject raw EXIF TIFF container bytes into TIFF file bytes (post-encode processing).
 *
 * @param tiffBytes - Complete output TIFF file bytes (from vips writeToBuffer)
 * @param exifIfdBytes - Raw EXIF TIFF container bytes (from JPEG APP1, without "Exif\0\0" prefix)
 * @returns New TIFF file bytes with EXIF SubIFD injected
 */
export function injectTiffExif(tiffBytes: Uint8Array, exifIfdBytes: Uint8Array): Uint8Array {
  if (tiffBytes.length < 8 || exifIfdBytes.length < 8) {
    return tiffBytes;
  }

  // ── 1. Parse the EXIF container to find the ExifSubIFD offset ──
  const exifByteOrder = parseTiffByteOrder(exifIfdBytes);
  if (!exifByteOrder) {
    console.warn('[injectTiffExif] EXIF bytes do not have valid TIFF header, skipping injection');
    return tiffBytes;
  }

  const exifIsLE = exifByteOrder === 'little';

  // Verify TIFF magic number (42)
  const exifMagic = readU16(exifIfdBytes, 2, exifIsLE);
  if (exifMagic !== 42) {
    console.warn('[injectTiffExif] EXIF bytes have invalid TIFF magic (%d), skipping', exifMagic);
    return tiffBytes;
  }

  // Find ExifSubIFD offset within the EXIF container
  const exifIfd0Offset = readU32(exifIfdBytes, 4, exifIsLE);
  if (exifIfd0Offset === 0 || exifIfd0Offset >= exifIfdBytes.length - 2) {
    console.warn('[injectTiffExif] EXIF IFD0 offset out of bounds, skipping');
    return tiffBytes;
  }

  // Parse EXIF's IFD0 to find the 0x8769 tag (ExifSubIFD pointer)
  const exifSubIfdOffset = findExifSubIfdOffset(exifIfdBytes, exifIfd0Offset, exifIsLE);

  // The target offset within the EXIF block that our ExifIFDPointer should reference.
  // If the EXIF container has its own ExifSubIFD (tag 0x8769), use that.
  // Otherwise, use the EXIF's IFD0 directly (it contains the EXIF tags inline).
  const targetIfdOffset = exifSubIfdOffset >= 0 ? exifSubIfdOffset : exifIfd0Offset;

  // ── 2. Parse the output TIFF header ──
  const outByteOrder = parseTiffByteOrder(tiffBytes);
  if (!outByteOrder) return tiffBytes;

  const outIsLE = outByteOrder === 'little';
  const outIfd0Offset = readU32(tiffBytes, 4, outIsLE);

  if (outIfd0Offset === 0 || outIfd0Offset >= tiffBytes.length - 2) {
    return tiffBytes;
  }

  // ── 3. If byte orders differ, convert EXIF to match output byte order ──
  // A TIFF file uses a single byte order declared in its header. Appended EXIF IFD data
  // MUST be in the same byte order as the output file, otherwise readers will misinterpret it.
  let processedExif: Uint8Array;
  if (exifIsLE !== outIsLE) {
    processedExif = new Uint8Array(exifIfdBytes); // clone before modifying
    byteSwapExifContainer(processedExif, exifIsLE);
    console.debug('[injectTiffExif] Converted EXIF byte order: %s → %s',
      exifIsLE ? 'LE' : 'BE', outIsLE ? 'LE' : 'BE');
  } else {
    processedExif = exifIfdBytes;
  }

  // ── 4. Parse output's IFD0 to find existing ExifIFDPointer tag ──
  const outIfd0EntryCount = readU16(tiffBytes, outIfd0Offset, outIsLE);
  const outIfd0EntriesStart = outIfd0Offset + 2;
  const outIfd0EntriesEnd = outIfd0EntriesStart + outIfd0EntryCount * 12;

  // Check bounds
  if (outIfd0EntriesEnd + 4 > tiffBytes.length) {
    return tiffBytes;
  }

  // Search for existing 0x8769 tag in output's IFD0
  let exifTagEntryOffset = -1;
  for (let i = 0; i < outIfd0EntryCount; i++) {
    const entryOffset = outIfd0EntriesStart + i * 12;
    const tagId = readU16(tiffBytes, entryOffset, outIsLE);
    if (tagId === EXIF_IFD_POINTER_TAG) {
      exifTagEntryOffset = entryOffset;
      break;
    }
  }

  // ── 5. Append EXIF block and set ExifIFDPointer ──
  // The append offset is where the EXIF block starts in the output file
  const appendOffset = tiffBytes.length;
  // The absolute offset of the target IFD in the output file
  const absoluteExifIfdOffset = appendOffset + targetIfdOffset;

  // Create the result buffer with appended EXIF data
  const resultWithExif = new Uint8Array(tiffBytes.length + processedExif.length);
  resultWithExif.set(tiffBytes, 0);
  resultWithExif.set(processedExif, appendOffset);

  // ── 6. Rebase offset-type values in the target IFD ──
  // The EXIF data's internal offsets are relative to the start of the EXIF block (offset 0).
  // In the output file, they need to be relative to the file start (offset 0 of output).
  // So we add `appendOffset` to all offset-type values.
  // NOTE: After byte-swap (if needed), the data is now in outIsLE byte order.
  rebaseIfdOffsets(resultWithExif, absoluteExifIfdOffset, appendOffset, outIsLE);

  // Also rebase IFD entries in EXIF's IFD0 if we're using the SubIFD (IFD0 may have
  // additional tags like GPS IFD pointer that also need rebasing)
  if (exifSubIfdOffset >= 0) {
    rebaseIfdOffsets(resultWithExif, appendOffset + exifIfd0Offset, appendOffset, outIsLE);
  }

  // ── 7. Update or insert ExifIFDPointer in output's IFD0 ──
  if (exifTagEntryOffset >= 0) {
    // Case A: Tag already exists — update the pointer value
    writeU32(resultWithExif, exifTagEntryOffset + 8, absoluteExifIfdOffset, outIsLE);
  } else {
    // Case B: Tag doesn't exist — need to insert it into IFD0
    return insertExifTagIntoIfd0(
      resultWithExif, outIfd0Offset, outIfd0EntryCount, absoluteExifIfdOffset, outIsLE,
    );
  }

  return resultWithExif;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Byte-Order Conversion
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Convert an entire EXIF TIFF container from one byte order to the other.
 * Modifies the buffer IN PLACE.
 *
 * Converts: TIFF header + all IFDs (IFD0, ExifSubIFD, GPS IFD, Interop IFD)
 * and their offset-referenced data.
 *
 * @param buf - EXIF TIFF container bytes (modified in place)
 * @param srcIsLE - Source byte order (true = little-endian)
 */
function byteSwapExifContainer(buf: Uint8Array, srcIsLE: boolean): void {
  if (buf.length < 8) return;

  // 1. Convert TIFF header byte-order mark
  if (srcIsLE) {
    // Was II (little-endian) → make MM (big-endian)
    buf[0] = 0x4D; buf[1] = 0x4D;
  } else {
    // Was MM (big-endian) → make II (little-endian)
    buf[0] = 0x49; buf[1] = 0x49;
  }

  // 2. Swap magic number 42
  const magic = readU16(buf, 2, srcIsLE);
  writeU16(buf, 2, magic, !srcIsLE);

  // 3. Swap IFD0 offset
  const ifd0Offset = readU32(buf, 4, srcIsLE);
  writeU32(buf, 4, ifd0Offset, !srcIsLE);

  // 4. Recursively swap all IFDs starting from IFD0
  // Track visited offsets to prevent infinite loops
  const visited = new Set<number>();
  byteSwapIfd(buf, ifd0Offset, srcIsLE, visited);
}

/**
 * Recursively byte-swap an IFD and all sub-IFDs it references.
 * Modifies buffer in place.
 *
 * @param buf - Buffer containing the IFD
 * @param ifdOffset - Offset of the IFD within buf
 * @param srcIsLE - Current (source) byte order of the data
 * @param visited - Set of already-visited IFD offsets (cycle prevention)
 */
function byteSwapIfd(
  buf: Uint8Array,
  ifdOffset: number,
  srcIsLE: boolean,
  visited: Set<number>,
): void {
  if (ifdOffset === 0 || ifdOffset + 2 > buf.length) return;
  if (visited.has(ifdOffset)) return;
  visited.add(ifdOffset);

  // Read entry count using SOURCE byte order
  const entryCount = readU16(buf, ifdOffset, srcIsLE);
  // Write entry count in TARGET byte order
  writeU16(buf, ifdOffset, entryCount, !srcIsLE);

  const entriesStart = ifdOffset + 2;
  if (entriesStart + entryCount * 12 + 4 > buf.length) return;

  // Collect sub-IFD offsets for recursive processing
  const subIfdOffsets: number[] = [];

  for (let i = 0; i < entryCount; i++) {
    const off = entriesStart + i * 12;

    // Read all fields using source byte order
    const tag = readU16(buf, off, srcIsLE);
    const type = readU16(buf, off + 2, srcIsLE);
    const count = readU32(buf, off + 4, srcIsLE);

    // Write tag, type, count in target byte order
    writeU16(buf, off, tag, !srcIsLE);
    writeU16(buf, off + 2, type, !srcIsLE);
    writeU32(buf, off + 4, count, !srcIsLE);

    // Handle value/offset field (4 bytes at off+8) based on data size
    const typeSize = TYPE_SIZES[type] || 1;
    const totalSize = typeSize * count;

    if (totalSize > 4) {
      // Value field is an OFFSET pointer — swap as U32
      const offsetVal = readU32(buf, off + 8, srcIsLE);
      writeU32(buf, off + 8, offsetVal, !srcIsLE);

      // Check if this is a sub-IFD pointer
      if (SUB_IFD_POINTER_TAGS.has(tag) && type === 4 && count === 1) {
        subIfdOffsets.push(offsetVal);
      }

      // Swap data at the pointed offset (for multi-byte types)
      if (typeSize > 1) {
        byteSwapData(buf, offsetVal, type, count, srcIsLE);
      }
    } else if (typeSize >= 4) {
      // Single LONG/SLONG/FLOAT value — swap as U32
      const val = readU32(buf, off + 8, srcIsLE);
      writeU32(buf, off + 8, val, !srcIsLE);

      // Check if this is a sub-IFD pointer
      if (SUB_IFD_POINTER_TAGS.has(tag) && type === 4 && count === 1) {
        subIfdOffsets.push(val);
      }
    } else if (typeSize === 2) {
      // SHORT/SSHORT values packed in value field — swap each individually
      for (let j = 0; j < count; j++) {
        const pos = off + 8 + j * 2;
        const val = readU16(buf, pos, srcIsLE);
        writeU16(buf, pos, val, !srcIsLE);
      }
    }
    // typeSize === 1 (BYTE/ASCII/UNDEFINED): no swap needed for value field
  }

  // Swap next-IFD pointer (4 bytes after all entries)
  const nextIfdPtrOff = entriesStart + entryCount * 12;
  if (nextIfdPtrOff + 4 <= buf.length) {
    const nextIfd = readU32(buf, nextIfdPtrOff, srcIsLE);
    writeU32(buf, nextIfdPtrOff, nextIfd, !srcIsLE);

    // Recursively swap next IFD (if any)
    if (nextIfd > 0 && nextIfd < buf.length) {
      byteSwapIfd(buf, nextIfd, srcIsLE, visited);
    }
  }

  // Recursively swap sub-IFDs
  for (const subOffset of subIfdOffsets) {
    if (subOffset > 0 && subOffset < buf.length) {
      byteSwapIfd(buf, subOffset, srcIsLE, visited);
    }
  }
}

/**
 * Byte-swap data array at a given offset according to its TIFF type.
 *
 * @param buf - Buffer containing the data
 * @param offset - Offset of the data within buf
 * @param type - TIFF data type (1=BYTE, 2=ASCII, 3=SHORT, 4=LONG, 5=RATIONAL, etc.)
 * @param count - Number of elements
 * @param srcIsLE - Source byte order
 */
function byteSwapData(
  buf: Uint8Array,
  offset: number,
  type: number,
  count: number,
  srcIsLE: boolean,
): void {
  const typeSize = TYPE_SIZES[type] || 1;
  if (typeSize <= 1) return; // BYTE, ASCII, UNDEFINED — no swap needed

  const totalBytes = typeSize * count;
  if (offset + totalBytes > buf.length) return;

  if (typeSize === 2) {
    // SHORT (3) / SSHORT (8) — swap each 2-byte value
    for (let i = 0; i < count; i++) {
      const pos = offset + i * 2;
      const val = readU16(buf, pos, srcIsLE);
      writeU16(buf, pos, val, !srcIsLE);
    }
  } else if (typeSize === 4) {
    // LONG (4) / SLONG (9) / FLOAT (11) — swap each 4-byte value
    for (let i = 0; i < count; i++) {
      const pos = offset + i * 4;
      const val = readU32(buf, pos, srcIsLE);
      writeU32(buf, pos, val, !srcIsLE);
    }
  } else if (typeSize === 8) {
    // RATIONAL (5) / SRATIONAL (10) — swap each component (numerator + denominator, 4B each)
    // DOUBLE (12) — swap all 8 bytes (handled as 2 × 4-byte swap for simplicity,
    //   which is correct for RATIONAL but technically wrong for IEEE DOUBLE;
    //   however DOUBLE is never used in standard EXIF)
    for (let i = 0; i < count; i++) {
      const pos = offset + i * 8;
      const hi = readU32(buf, pos, srcIsLE);
      const lo = readU32(buf, pos + 4, srcIsLE);
      writeU32(buf, pos, hi, !srcIsLE);
      writeU32(buf, pos + 4, lo, !srcIsLE);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// IFD Parsing Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Find ExifSubIFD offset within an EXIF TIFF container by parsing its IFD0.
 * Returns the offset (relative to start of exifBytes) or -1 if not found.
 */
function findExifSubIfdOffset(
  exifBytes: Uint8Array,
  ifd0Offset: number,
  isLE: boolean,
): number {
  if (ifd0Offset + 2 > exifBytes.length) return -1;

  const entryCount = readU16(exifBytes, ifd0Offset, isLE);
  const entriesStart = ifd0Offset + 2;

  if (entriesStart + entryCount * 12 > exifBytes.length) return -1;

  for (let i = 0; i < entryCount; i++) {
    const entryOffset = entriesStart + i * 12;
    const tagId = readU16(exifBytes, entryOffset, isLE);
    if (tagId === EXIF_IFD_POINTER_TAG) {
      // Type should be LONG (4), Count should be 1
      return readU32(exifBytes, entryOffset + 8, isLE);
    }
  }

  return -1;
}

/**
 * Rebase offset-type values in an IFD.
 * For each entry whose value size > 4 bytes, the value field is an offset
 * that was relative to the EXIF block start — we add `rebaseAmount` to it.
 *
 * @param buf - The entire output buffer (modified in place)
 * @param ifdAbsoluteOffset - Absolute offset of the IFD in buf
 * @param rebaseAmount - Amount to add to each offset value
 * @param isLE - Byte order
 */
function rebaseIfdOffsets(
  buf: Uint8Array,
  ifdAbsoluteOffset: number,
  rebaseAmount: number,
  isLE: boolean,
): void {
  if (ifdAbsoluteOffset + 2 > buf.length) return;

  const entryCount = readU16(buf, ifdAbsoluteOffset, isLE);
  const entriesStart = ifdAbsoluteOffset + 2;

  if (entriesStart + entryCount * 12 > buf.length) return;

  for (let i = 0; i < entryCount; i++) {
    const entryOffset = entriesStart + i * 12;
    const type = readU16(buf, entryOffset + 2, isLE);
    const count = readU32(buf, entryOffset + 4, isLE);

    const typeSize = TYPE_SIZES[type] || 1;
    const totalSize = typeSize * count;

    // If the value doesn't fit in 4 bytes, the value field is an offset
    if (totalSize > 4) {
      const originalOffset = readU32(buf, entryOffset + 8, isLE);
      writeU32(buf, entryOffset + 8, originalOffset + rebaseAmount, isLE);
    }

    // Also rebase IFD pointer tags (GPS IFD, Interop IFD) which store offsets inline
    const tagId = readU16(buf, entryOffset, isLE);
    if ((tagId === 0x8825 || tagId === 0xA005) && type === 4 && count === 1) {
      // GPS IFD Pointer (0x8825) and Interop IFD Pointer (0xA005)
      // These are LONG type, count=1, value IS an offset (fits in 4 bytes but semantically an offset)
      const originalOffset = readU32(buf, entryOffset + 8, isLE);
      if (originalOffset > 0 && originalOffset < rebaseAmount) {
        // Only rebase if the offset looks like it's relative to the EXIF block
        writeU32(buf, entryOffset + 8, originalOffset + rebaseAmount, isLE);
      }
    }
  }

  // Rebase the "next IFD" pointer at the end of the IFD
  const nextIfdPtrOffset = entriesStart + entryCount * 12;
  if (nextIfdPtrOffset + 4 <= buf.length) {
    const nextIfd = readU32(buf, nextIfdPtrOffset, isLE);
    if (nextIfd > 0 && nextIfd < rebaseAmount) {
      // Only rebase if pointing within the EXIF block range
      writeU32(buf, nextIfdPtrOffset, nextIfd + rebaseAmount, isLE);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// IFD0 Insertion (Case B)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Case B: ExifIFDPointer tag doesn't exist in output's IFD0.
 * Rebuild IFD0 with the new tag inserted, then update header pointer.
 *
 * Strategy: Since we can't insert bytes in the middle of a TIFF without breaking
 * all offsets, we rebuild IFD0 at the end of the file.
 * We then update the header's IFD0 offset pointer to point to the new location.
 */
function insertExifTagIntoIfd0(
  tiffBytes: Uint8Array,
  ifd0Offset: number,
  ifd0EntryCount: number,
  exifIfdAbsoluteOffset: number,
  isLE: boolean,
): Uint8Array {
  // Read existing IFD0 entries
  const ifd0EntriesStart = ifd0Offset + 2;
  const nextIfdPointer = readU32(tiffBytes, ifd0EntriesStart + ifd0EntryCount * 12, isLE);

  // Layout at end of file:
  //   [newIFD0: count(2) + (N+1)*12 entries + nextIfdPtr(4)]
  const newIfd0Offset = tiffBytes.length;
  const newEntryCount = ifd0EntryCount + 1;
  const newIfd0Size = 2 + newEntryCount * 12 + 4;

  // Build new IFD0
  const newIfd0 = new Uint8Array(newIfd0Size);
  writeU16(newIfd0, 0, newEntryCount, isLE);

  // Copy existing entries (they still reference valid offsets in the original data)
  // Insert the new ExifIFDPointer tag in sorted order (IFD entries must be sorted by tag ID)
  let inserted = false;
  let destIdx = 0;
  for (let i = 0; i < ifd0EntryCount; i++) {
    const srcEntryOffset = ifd0EntriesStart + i * 12;
    const tagId = readU16(tiffBytes, srcEntryOffset, isLE);

    // Insert ExifIFDPointer before the first tag that has a higher ID
    if (!inserted && tagId > EXIF_IFD_POINTER_TAG) {
      writeExifIfdEntry(newIfd0, 2 + destIdx * 12, exifIfdAbsoluteOffset, isLE);
      destIdx++;
      inserted = true;
    }

    // Copy existing entry
    newIfd0.set(tiffBytes.slice(srcEntryOffset, srcEntryOffset + 12), 2 + destIdx * 12);
    destIdx++;
  }

  // If not inserted yet (all existing tags have lower IDs), append at end
  if (!inserted) {
    writeExifIfdEntry(newIfd0, 2 + destIdx * 12, exifIfdAbsoluteOffset, isLE);
    destIdx++;
  }

  // Write next-IFD pointer (preserve original)
  writeU32(newIfd0, 2 + newEntryCount * 12, nextIfdPointer, isLE);

  // Assemble final buffer
  const result = new Uint8Array(tiffBytes.length + newIfd0Size);
  result.set(tiffBytes, 0);
  result.set(newIfd0, newIfd0Offset);

  // Update TIFF header to point to new IFD0 location
  writeU32(result, 4, newIfd0Offset, isLE);

  return result;
}

/**
 * Write an ExifIFDPointer (0x8769) IFD entry at the given offset.
 * Type = LONG (4), Count = 1, Value = pointer to EXIF SubIFD
 */
function writeExifIfdEntry(buf: Uint8Array, offset: number, exifOffset: number, isLE: boolean): void {
  writeU16(buf, offset, EXIF_IFD_POINTER_TAG, isLE); // Tag
  writeU16(buf, offset + 2, 4, isLE);                 // Type = LONG
  writeU32(buf, offset + 4, 1, isLE);                 // Count = 1
  writeU32(buf, offset + 8, exifOffset, isLE);        // Value = offset
}
