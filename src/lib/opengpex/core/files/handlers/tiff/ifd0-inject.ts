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
 * TIFF IFD0 metadata tag injection — post-encode binary manipulation.
 *
 * Injects standard TIFF IFD0 tags (Software, Artist, Copyright, Make, Model)
 * into a TIFF file after encoding. These are ASCII-type tags that most TIFF
 * viewers and metadata tools expect to find in IFD0.
 *
 * Strategy:
 *   1. Parse existing IFD0 (entry count, entries, next-IFD pointer)
 *   2. Build a new IFD0 at end-of-file with additional tags inserted (sorted)
 *   3. Append string data after the new IFD0
 *   4. Update TIFF header to point to the new IFD0
 *
 * @module core/files/handlers/tiff/ifd0-inject
 */

import { readU16, readU32, writeU16, writeU32 } from '../../metadata/tiff-ifd-reader';

// ═══════════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════════

/** A TIFF IFD0 string tag to inject */
export interface Ifd0StringTag {
  /** Tag ID (e.g. 0x0131 for Software) */
  tag: number;
  /** ASCII string value (null terminator added automatically) */
  value: string;
}

/** Well-known TIFF IFD0 tag IDs */
export const TIFF_TAGS = {
  MAKE: 0x010F,         // 271 - Camera manufacturer
  MODEL: 0x0110,        // 272 - Camera model
  SOFTWARE: 0x0131,     // 305 - Software used
  ARTIST: 0x013B,       // 315 - Image creator
  COPYRIGHT: 0x8298,    // 33432 - Copyright notice
} as const;

/**
 * Inject ASCII string tags into TIFF IFD0 (post-encode processing).
 *
 * @param tiffBytes - Complete TIFF file bytes
 * @param tags - Array of string tags to inject (duplicates with existing tags are skipped)
 * @returns New TIFF file bytes with tags injected into IFD0
 */
export function injectTiffIfd0Tags(tiffBytes: Uint8Array, tags: Ifd0StringTag[]): Uint8Array {
  if (tiffBytes.length < 8 || tags.length === 0) return tiffBytes;

  // Filter out empty-value tags
  const validTags = tags.filter(t => t.value && t.value.length > 0);
  if (validTags.length === 0) return tiffBytes;

  // 1. Parse TIFF header
  const isLE = tiffBytes[0] === 0x49 && tiffBytes[1] === 0x49;
  const isBE = tiffBytes[0] === 0x4D && tiffBytes[1] === 0x4D;
  if (!isLE && !isBE) return tiffBytes;

  const magic = readU16(tiffBytes, 2, isLE);
  if (magic !== 42) return tiffBytes;

  const ifd0Offset = readU32(tiffBytes, 4, isLE);
  if (ifd0Offset === 0 || ifd0Offset >= tiffBytes.length - 2) return tiffBytes;

  // 2. Parse existing IFD0
  const entryCount = readU16(tiffBytes, ifd0Offset, isLE);
  const entriesStart = ifd0Offset + 2;
  const entriesEnd = entriesStart + entryCount * 12;

  if (entriesEnd + 4 > tiffBytes.length) return tiffBytes;

  // Read existing tag IDs (to skip duplicates)
  const existingTags = new Set<number>();
  for (let i = 0; i < entryCount; i++) {
    const off = entriesStart + i * 12;
    existingTags.add(readU16(tiffBytes, off, isLE));
  }

  // Filter out tags that already exist
  const newTags = validTags.filter(t => !existingTags.has(t.tag));
  if (newTags.length === 0) return tiffBytes;

  // Read next-IFD pointer
  const nextIfdPtr = readU32(tiffBytes, entriesEnd, isLE);

  // 3. Build new IFD0 at end of file
  const newEntryCount = entryCount + newTags.length;
  const newIfd0Size = 2 + newEntryCount * 12 + 4;

  // Encode string values (ASCII + null terminator)
  const encoder = new TextEncoder();
  const stringDatas: Uint8Array[] = newTags.map(t => {
    const encoded = encoder.encode(t.value);
    // Add null terminator
    const withNull = new Uint8Array(encoded.length + 1);
    withNull.set(encoded);
    withNull[encoded.length] = 0;
    return withNull;
  });

  const totalStringSize = stringDatas.reduce((sum, d) => sum + d.length, 0);

  // Layout at end of file:
  //   [original file data] [new IFD0] [string data block]
  const newIfd0Offset = tiffBytes.length;
  const stringBlockOffset = newIfd0Offset + newIfd0Size;

  // 4. Build IFD0 buffer
  const newIfd0 = new Uint8Array(newIfd0Size);
  writeU16(newIfd0, 0, newEntryCount, isLE);

  // Merge existing entries + new entries in sorted tag order
  let destIdx = 0;
  // Sort new tags by tag ID
  const sortedNewTags = newTags
    .map((t, i) => ({ ...t, dataIdx: i }))
    .sort((a, b) => a.tag - b.tag);

  // Compute string offsets for each new tag (in sortedNewTags order)
  let currentStringOffset = stringBlockOffset;
  const stringOffsets: number[] = [];
  for (const st of sortedNewTags) {
    stringOffsets.push(currentStringOffset);
    currentStringOffset += stringDatas[st.dataIdx].length;
  }

  // Interleave existing entries and new entries by tag ID order
  let existingIdx = 0;
  let sortedIdx = 0;

  while (existingIdx < entryCount || sortedIdx < sortedNewTags.length) {
    const existingTag = existingIdx < entryCount
      ? readU16(tiffBytes, entriesStart + existingIdx * 12, isLE)
      : 0xFFFF;
    const newTag = sortedIdx < sortedNewTags.length
      ? sortedNewTags[sortedIdx].tag
      : 0xFFFF;

    if (existingTag <= newTag) {
      // Copy existing entry
      const srcOff = entriesStart + existingIdx * 12;
      newIfd0.set(tiffBytes.slice(srcOff, srcOff + 12), 2 + destIdx * 12);
      existingIdx++;
    } else {
      // Write new string tag entry
      const st = sortedNewTags[sortedIdx];
      const strData = stringDatas[st.dataIdx];
      const strLen = strData.length; // includes null terminator
      const entryOff = 2 + destIdx * 12;

      writeU16(newIfd0, entryOff, st.tag, isLE);     // Tag ID
      writeU16(newIfd0, entryOff + 2, 2, isLE);      // Type = ASCII (2)
      writeU32(newIfd0, entryOff + 4, strLen, isLE);  // Count (string length incl. null)

      if (strLen <= 4) {
        // Inline: value fits in 4 bytes
        for (let b = 0; b < strLen; b++) {
          newIfd0[entryOff + 8 + b] = strData[b];
        }
      } else {
        // Offset to string data
        writeU32(newIfd0, entryOff + 8, stringOffsets[sortedIdx], isLE);
      }
      sortedIdx++;
    }
    destIdx++;
  }

  // Write next-IFD pointer (preserve original)
  writeU32(newIfd0, 2 + newEntryCount * 12, nextIfdPtr, isLE);

  // 5. Assemble final buffer
  const result = new Uint8Array(tiffBytes.length + newIfd0Size + totalStringSize);
  result.set(tiffBytes, 0);
  result.set(newIfd0, newIfd0Offset);

  // Write string data in sortedNewTags order
  let strWriteOffset = stringBlockOffset;
  for (const st of sortedNewTags) {
    const strData = stringDatas[st.dataIdx];
    result.set(strData, strWriteOffset);
    strWriteOffset += strData.length;
  }

  // 6. Update TIFF header to point to new IFD0
  writeU32(result, 4, newIfd0Offset, isLE);

  return result;
}

