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
 * ISOBMFF write operations — EXIF injection for AVIF/HEIF containers.
 *
 * Injects raw EXIF data into an existing AVIF file by manipulating
 * the ISOBMFF box structure (meta → iinf/iloc).
 *
 * HEIF Exif item structure:
 *   - Item in `iinf` with item_type='Exif'
 *   - Item data in `iloc` pointing to: [4-byte offset to TIFF header] + EXIF TIFF IFD bytes
 *   - The 4-byte prefix is typically 0x00000000 (offset = 0, meaning TIFF header immediately follows)
 *
 * @module core/files/metadata/isobmff-writer
 */

/**
 * Inject raw EXIF bytes into an AVIF/HEIF ISOBMFF container.
 *
 * Strategy: Append EXIF data to the end of the file in a new `mdat` box,
 * then update the `meta` box (iinf + iloc) to reference the new Exif item.
 *
 * Note: This is a best-effort implementation for vips-produced AVIF files.
 * If the ISOBMFF structure cannot be parsed, returns the original bytes unchanged.
 *
 * @param avifBytes - Complete AVIF file bytes
 * @param exifTiffIfd - Raw EXIF TIFF IFD bytes (no "Exif\0\0" prefix)
 * @returns New AVIF file bytes with EXIF injected, or original if injection fails
 */
export function injectAvifExif(avifBytes: Uint8Array, exifTiffIfd: Uint8Array): Uint8Array {
  try {
    // Construct the HEIF Exif payload: 4-byte offset (0) + raw TIFF IFD
    // The 4-byte prefix indicates the offset from the start of the Exif payload
    // to the TIFF header. Since we place TIFF IFD immediately after, offset = 0.
    const exifPayload = new Uint8Array(4 + exifTiffIfd.length);
    // First 4 bytes = 0x00000000 (big-endian offset to TIFF header)
    exifPayload.set(exifTiffIfd, 4);

    // Find meta box in the ISOBMFF structure
    const metaBox = findBox(avifBytes, 'meta', 0, avifBytes.length);
    if (!metaBox) return avifBytes;

    // meta is a full-box: skip version(1) + flags(3) = 4 bytes after box header
    const metaContentStart = metaBox.dataOffset + 4;
    const metaContentEnd = metaBox.end;

    // Find iinf and iloc within meta
    const iinfBox = findBox(avifBytes, 'iinf', metaContentStart, metaContentEnd);
    const ilocBox = findBox(avifBytes, 'iloc', metaContentStart, metaContentEnd);

    if (!iinfBox || !ilocBox) return avifBytes;

    // Determine next available item_id by parsing iinf
    const nextItemId = getNextItemId(avifBytes, iinfBox);
    if (nextItemId === 0) return avifBytes;

    // Build new iinf entry for Exif item (infe box v2)
    const infeBox = buildInfeBox(nextItemId, 'Exif');

    // Append EXIF data in a new mdat box at end of file
    const mdatBox = buildBox('mdat', exifPayload);
    const _exifDataOffset = avifBytes.length + 8; // offset within the new mdat (after mdat header)

    // Build iloc entry for the new item
    // We need to patch the iloc box to add an entry for our Exif item
    const ilocEntry = buildIlocEntry(nextItemId, avifBytes.length + 8, exifPayload.length, ilocBox, avifBytes);

    if (!ilocEntry) return avifBytes;

    // Strategy: rebuild the file with patched meta box
    // This is complex — for simplicity, we append mdat and patch iinf/iloc in-place
    // by rebuilding the meta box.

    // Simpler approach: build the complete output
    const result = buildAvifWithExif(avifBytes, metaBox, iinfBox, ilocBox, infeBox, ilocEntry, mdatBox);
    return result || avifBytes;
  } catch {
    // If anything goes wrong, return original bytes unchanged
    return avifBytes;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Internal Types & Helpers
// ═══════════════════════════════════════════════════════════════════════════════

interface BoxInfo {
  offset: number;      // start of box (including header)
  dataOffset: number;  // start of box data (after header)
  size: number;        // total box size
  end: number;         // offset + size
}

/** Find a box by type within a range of bytes. */
function findBox(bytes: Uint8Array, type: string, start: number, end: number): BoxInfo | null {
  let pos = start;
  while (pos + 8 <= end) {
    const size = readUint32BE(bytes, pos);
    const boxType = getFourCC(bytes, pos + 4);

    if (size < 8) return null; // Invalid box
    if (pos + size > end) return null; // Box extends beyond range

    if (boxType === type) {
      return { offset: pos, dataOffset: pos + 8, size, end: pos + size };
    }

    pos += size;
  }
  return null;
}

/** Get next available item_id from iinf box. */
function getNextItemId(bytes: Uint8Array, iinfBox: BoxInfo): number {
  // iinf is a full-box: version(1) + flags(3) + entry_count(2 or 4)
  const version = bytes[iinfBox.dataOffset];
  const countOffset = iinfBox.dataOffset + 4; // after version + flags
  let entryCount: number;
  if (version === 0) {
    entryCount = readUint16BE(bytes, countOffset);
  } else {
    entryCount = readUint32BE(bytes, countOffset);
  }

  // Scan all infe boxes to find max item_id
  let maxId = 0;
  const contentStart = countOffset + (version === 0 ? 2 : 4);
  let pos = contentStart;
  for (let i = 0; i < entryCount && pos + 8 < iinfBox.end; i++) {
    const infeSize = readUint32BE(bytes, pos);
    if (infeSize < 8) break;
    // infe v2/v3: version(1) + flags(3) + item_id(2)
    const infeVersion = bytes[pos + 8];
    let itemId: number;
    if (infeVersion >= 2) {
      if (infeVersion === 2) {
        itemId = readUint16BE(bytes, pos + 12); // after version + flags
      } else {
        itemId = readUint32BE(bytes, pos + 12);
      }
    } else {
      itemId = readUint16BE(bytes, pos + 12);
    }
    if (itemId > maxId) maxId = itemId;
    pos += infeSize;
  }

  return maxId + 1;
}

/** Build an infe (item info entry) box v2 for an Exif item. */
function buildInfeBox(itemId: number, itemType: string): Uint8Array {
  // infe v2: size(4) + 'infe'(4) + version(1)=2 + flags(3)=0 + item_id(2) + item_protection_index(2) + item_type(4) + item_name(\0)
  const boxData = new Uint8Array(21); // 8 header + 4 version/flags + 2 id + 2 protection + 4 type + 1 name
  const size = boxData.length;
  writeUint32BE(boxData, 0, size);
  setFourCC(boxData, 4, 'infe');
  boxData[8] = 2; // version = 2
  // flags = 0 (bytes 9-11)
  writeUint16BE(boxData, 12, itemId);
  writeUint16BE(boxData, 14, 0); // item_protection_index
  setFourCC(boxData, 16, itemType);
  boxData[20] = 0; // item_name: empty string (null terminator)
  return boxData;
}

/** Build iloc entry bytes for a new item (simplified for construction_method=0, offset_size=4, length_size=4). */
function buildIlocEntry(
  _itemId: number,
  _dataOffset: number,
  _dataLength: number,
  _ilocBox: BoxInfo,
  _bytes: Uint8Array,
): Uint8Array | null {
  // iloc is complex — different versions have different field sizes.
  // For simplicity, we return a marker and handle in buildAvifWithExif
  return new Uint8Array(0); // Placeholder — actual logic in buildAvifWithExif
}

/**
 * Build complete AVIF output with EXIF item injected.
 * 
 * Strategy: Rebuild meta box with updated iinf (+ new infe) and iloc (+ new entry),
 * then append new mdat with EXIF data.
 */
function buildAvifWithExif(
  original: Uint8Array,
  metaBox: BoxInfo,
  iinfBox: BoxInfo,
  ilocBox: BoxInfo,
  infeBox: Uint8Array,
  _ilocEntry: Uint8Array,
  mdatBox: Uint8Array,
): Uint8Array | null {
  // Parse iloc to understand field sizes
  const ilocVersion = original[ilocBox.dataOffset];
  const offsetSizeLengthSize = original[ilocBox.dataOffset + 4];
  const offsetSize = (offsetSizeLengthSize >> 4) & 0x0F;
  const lengthSize = offsetSizeLengthSize & 0x0F;
  const baseOffsetSizeIndexSize = original[ilocBox.dataOffset + 5];
  const baseOffsetSize = (baseOffsetSizeIndexSize >> 4) & 0x0F;

  // For simplicity, only handle common case: offset_size=4, length_size=4
  if (offsetSize !== 4 || lengthSize !== 4) return null;

  // Calculate where EXIF data will end up
  // The new mdat is appended after the original file (with meta box size adjustment)
  // EXIF data starts 8 bytes into the mdat (after mdat box header)

  // Read iloc item count
  const ilocCountOffset = ilocBox.dataOffset + 4 + 2; // after version+flags + offset/length/base sizes
  let itemCount: number;
  let _itemCountFieldSize: number;
  if (ilocVersion < 2) {
    itemCount = readUint16BE(original, ilocCountOffset);
    _itemCountFieldSize = 2;
  } else {
    itemCount = readUint32BE(original, ilocCountOffset);
    _itemCountFieldSize = 4;
  }

  // Get the item ID for the new Exif item (from infe box)
  const newItemId = readUint16BE(infeBox, 12);

  // Build new iloc entry: item_id(2) + construction_method(0 for v1+, 2B) + data_reference_index(2) + base_offset(baseOffsetSize) + extent_count(2) + [offset(4) + length(4)]
  let ilocEntrySize: number;
  if (ilocVersion === 1 || ilocVersion === 2) {
    // v1/v2: item_id(2 or 4) + construction_method(2) + data_reference_index(2) + base_offset + extent_count(2) + extents
    const itemIdSize = ilocVersion === 2 ? 4 : 2;
    ilocEntrySize = itemIdSize + 2 + 2 + baseOffsetSize + 2 + (offsetSize + lengthSize);
  } else {
    // v0: item_id(2) + data_reference_index(2) + base_offset + extent_count(2) + extents
    ilocEntrySize = 2 + 2 + baseOffsetSize + 2 + (offsetSize + lengthSize);
  }

  const newIlocEntry = new Uint8Array(ilocEntrySize);
  let entryPos = 0;

  // Write item_id
  if (ilocVersion === 2) {
    writeUint32BE(newIlocEntry, entryPos, newItemId);
    entryPos += 4;
  } else {
    writeUint16BE(newIlocEntry, entryPos, newItemId);
    entryPos += 2;
  }

  // construction_method (v1+)
  if (ilocVersion >= 1) {
    writeUint16BE(newIlocEntry, entryPos, 0); // construction_method = 0 (file offset)
    entryPos += 2;
  }

  // data_reference_index
  writeUint16BE(newIlocEntry, entryPos, 0); // 0 = this file
  entryPos += 2;

  // base_offset (typically 0)
  for (let i = 0; i < baseOffsetSize; i++) {
    newIlocEntry[entryPos++] = 0;
  }

  // extent_count = 1
  writeUint16BE(newIlocEntry, entryPos, 1);
  entryPos += 2;

  // We'll fill in the actual offset later after we know the final layout
  const extentOffsetPos = entryPos; // remember where to write offset
  entryPos += offsetSize; // offset placeholder
  writeUint32BE(newIlocEntry, entryPos, mdatBox.length - 8); // length = mdat payload size
  entryPos += lengthSize;

  // Now rebuild the file:
  // [before meta] [new meta with updated iinf + iloc] [after meta] [new mdat]
  
  // Build new iinf: original iinf content + new infe, with updated entry count
  const iinfVersion = original[iinfBox.dataOffset];
  const _iinfCountOffset = iinfBox.dataOffset + 4;
  const iinfCountFieldSize = iinfVersion === 0 ? 2 : 4;
  const iinfContentAfterCount = iinfBox.dataOffset + 4 + iinfCountFieldSize;
  const iinfOriginalEntries = original.slice(iinfContentAfterCount, iinfBox.end);

  const newIinfDataSize = 4 + iinfCountFieldSize + iinfOriginalEntries.length + infeBox.length;
  const newIinfBox = new Uint8Array(8 + newIinfDataSize);
  writeUint32BE(newIinfBox, 0, newIinfBox.length);
  setFourCC(newIinfBox, 4, 'iinf');
  newIinfBox[8] = iinfVersion; // version
  // flags = 0
  let iinfWritePos = 12;
  if (iinfVersion === 0) {
    writeUint16BE(newIinfBox, iinfWritePos, itemCount + 1);
    iinfWritePos += 2;
  } else {
    writeUint32BE(newIinfBox, iinfWritePos, itemCount + 1);
    iinfWritePos += 4;
  }
  newIinfBox.set(iinfOriginalEntries, iinfWritePos);
  iinfWritePos += iinfOriginalEntries.length;
  newIinfBox.set(infeBox, iinfWritePos);

  // Build new iloc: original iloc content + new entry, with updated item count
  const ilocOrigContent = original.slice(ilocBox.dataOffset, ilocBox.end);
  const newIlocDataSize = (ilocBox.end - ilocBox.dataOffset) + newIlocEntry.length;
  const newIlocBox = new Uint8Array(8 + newIlocDataSize);
  writeUint32BE(newIlocBox, 0, newIlocBox.length);
  setFourCC(newIlocBox, 4, 'iloc');
  // Copy original iloc content
  newIlocBox.set(ilocOrigContent, 8);
  // Append new entry
  newIlocBox.set(newIlocEntry, 8 + ilocOrigContent.length);
  // Update item count in iloc
  const newIlocCountOffset = 8 + 4 + 2; // box header + version/flags + sizes
  if (ilocVersion < 2) {
    writeUint16BE(newIlocBox, newIlocCountOffset, itemCount + 1);
  } else {
    writeUint32BE(newIlocBox, newIlocCountOffset, itemCount + 1);
  }

  // Rebuild meta box: replace iinf and iloc, keep everything else
  const metaPrefix = original.slice(metaBox.offset + 8, metaBox.offset + 8 + 4); // version+flags of full-box
  const metaChildren: Uint8Array[] = [];
  
  // Iterate meta children (skip iinf and iloc, insert our replacements)
  const metaChildStart = metaBox.dataOffset + 4; // after full-box version+flags
  const metaChildEnd = metaBox.end;
  let childPos = metaChildStart;
  let iinfReplaced = false;
  let ilocReplaced = false;
  while (childPos + 8 <= metaChildEnd) {
    const childSize = readUint32BE(original, childPos);
    const childType = getFourCC(original, childPos + 4);
    if (childSize < 8 || childPos + childSize > metaChildEnd) break;

    if (childType === 'iinf') {
      metaChildren.push(newIinfBox);
      iinfReplaced = true;
    } else if (childType === 'iloc') {
      metaChildren.push(newIlocBox);
      ilocReplaced = true;
    } else {
      metaChildren.push(original.slice(childPos, childPos + childSize));
    }
    childPos += childSize;
  }
  if (!iinfReplaced) metaChildren.push(newIinfBox);
  if (!ilocReplaced) metaChildren.push(newIlocBox);

  // Calculate new meta box size
  let newMetaContentSize = 4; // version + flags
  for (const child of metaChildren) newMetaContentSize += child.length;
  const newMetaBox = new Uint8Array(8 + newMetaContentSize);
  writeUint32BE(newMetaBox, 0, newMetaBox.length);
  setFourCC(newMetaBox, 4, 'meta');
  newMetaBox.set(metaPrefix, 8);
  let metaWritePos = 12;
  for (const child of metaChildren) {
    newMetaBox.set(child, metaWritePos);
    metaWritePos += child.length;
  }

  // Assemble final file: [before meta] + [new meta] + [after meta] + [new mdat]
  const beforeMeta = original.slice(0, metaBox.offset);
  const afterMeta = original.slice(metaBox.end);
  const totalSize = beforeMeta.length + newMetaBox.length + afterMeta.length + mdatBox.length;
  const result = new Uint8Array(totalSize);
  let writePos = 0;
  result.set(beforeMeta, writePos); writePos += beforeMeta.length;
  result.set(newMetaBox, writePos); writePos += newMetaBox.length;
  result.set(afterMeta, writePos); writePos += afterMeta.length;
  result.set(mdatBox, writePos);

  // Fix the extent offset in the iloc entry to point to actual EXIF data location
  // The EXIF mdat starts at: beforeMeta.length + newMetaBox.length + afterMeta.length
  // The data inside mdat starts 8 bytes later (after mdat box header)
  const exifDataFileOffset = beforeMeta.length + newMetaBox.length + afterMeta.length + 8;

  // Find and patch the iloc entry we added (last entry in iloc)
  // The new iloc box is at offset: beforeMeta.length + (offset within newMetaBox where iloc lives)
  // We need to find iloc in the result and patch the last entry's offset
  const ilocInResult = findBox(result, 'iloc', beforeMeta.length + 8 + 4, beforeMeta.length + newMetaBox.length);
  if (ilocInResult) {
    // The new entry is at the end of iloc content
    const entryEnd = ilocInResult.end;
    const entryStart = entryEnd - newIlocEntry.length;
    // Patch extent offset (at extentOffsetPos within the entry)
    writeUint32BE(result, entryStart + extentOffsetPos, exifDataFileOffset);
  }

  return result;
}

/** Build an ISOBMFF box: size(4) + type(4) + data. */
function buildBox(type: string, data: Uint8Array): Uint8Array {
  const box = new Uint8Array(8 + data.length);
  writeUint32BE(box, 0, box.length);
  setFourCC(box, 4, type);
  box.set(data, 8);
  return box;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Byte-level utilities
// ═══════════════════════════════════════════════════════════════════════════════

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function writeUint16BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >> 8) & 0xFF;
  bytes[offset + 1] = value & 0xFF;
}

function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >> 24) & 0xFF;
  bytes[offset + 1] = (value >> 16) & 0xFF;
  bytes[offset + 2] = (value >> 8) & 0xFF;
  bytes[offset + 3] = value & 0xFF;
}

function getFourCC(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function setFourCC(bytes: Uint8Array, offset: number, str: string): void {
  for (let i = 0; i < 4; i++) bytes[offset + i] = str.charCodeAt(i);
}
