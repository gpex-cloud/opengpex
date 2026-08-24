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
 * ISOBMFF container parser — extracts ICC profile from colr box.
 * Shared by HEIC and AVIF handlers (both are ISOBMFF-based container formats).
 *
 * Box path: ftyp → meta(full-box) → iprp → ipco → colr (type='prof'|'rICC')
 *
 * ISOBMFF box structure:
 * ```
 * [size: 4B BE] [type: 4B FourCC] [payload...]
 *   - size includes the 8-byte header
 *   - size == 1 → 64-bit extended size follows (8B BE)
 *   - size == 0 → box extends to end of file
 *   - full-box adds 4B version(1)+flags(3) after type
 * ```
 *
 * @module core/files/metadata/isobmff-reader
 */

import type { ColorSpaceId } from '../types';

// ═══════════════════════════════════════════════════════════════════════════════
// Public Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface NclxParams {
  colourPrimaries: number;         // e.g. 12 = Display P3, 1 = BT.709/sRGB
  transferCharacteristics: number;
  matrixCoefficients: number;
  fullRangeFlag: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extract ICC profile raw bytes from ISOBMFF container (HEIC/AVIF).
 *
 * Traverses box hierarchy: meta → iprp → ipco → colr (prof/rICC)
 * @returns ICC profile bytes, or null if colr box is nclx or not found
 */
export function extractIsobmffIcc(bytes: Uint8Array): Uint8Array | null {
  try {
    const colrBox = findColrBox(bytes);
    if (!colrBox) return null;

    // colr box payload starts with 4-byte colour_type
    if (colrBox.length < 4) return null;
    const colourType = getFourCC(colrBox, 0);

    if (colourType === 'prof' || colourType === 'rICC') {
      const iccData = colrBox.slice(4);
      return iccData.length > 0 ? iccData : null;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Extract nclx CICP parameters from ISOBMFF colr box.
 * Used as fallback when extractIsobmffIcc() returns null.
 *
 * @returns CICP parameters, or null if no nclx colr box found
 */
export function extractIsobmffNclx(bytes: Uint8Array): NclxParams | null {
  try {
    const colrBox = findColrBox(bytes);
    if (!colrBox) return null;

    if (colrBox.length < 4) return null;
    const colourType = getFourCC(colrBox, 0);

    if (colourType !== 'nclx') return null;

    // nclx payload: colour_type(4) + primaries(2) + transfer(2) + matrix(2) + full_range(1)
    if (colrBox.length < 11) return null;

    return {
      colourPrimaries: readUint16BE(colrBox, 4),
      transferCharacteristics: readUint16BE(colrBox, 6),
      matrixCoefficients: readUint16BE(colrBox, 8),
      fullRangeFlag: (colrBox[10] & 0x80) !== 0,
    };
  } catch {
    return null;
  }
}

/**
 * Extract raw EXIF bytes (TIFF IFD) from ISOBMFF container (HEIC/AVIF).
 *
 * EXIF data in ISOBMFF is stored as a metadata item:
 *   meta → iinf (find item_type='Exif') → iloc (locate item extents) → raw data
 *
 * The item data starts with a 4-byte big-endian offset prefix indicating
 * where the TIFF header begins relative to the prefix. Usually 0.
 *
 * @returns Raw TIFF IFD bytes (without the 4-byte ISOBMFF prefix), or null if not found
 */
export function extractIsobmffExif(bytes: Uint8Array): Uint8Array | null {
  try {
    // Find the meta box at top level
    const metaPayload = findTopLevelBox(bytes, 'meta');
    if (!metaPayload || metaPayload.length < 4) return null;

    // meta is a full-box: skip 4 bytes (version + flags)
    const metaContent = metaPayload.subarray(4);

    // Step 1: Find Exif item ID from iinf box
    const exifItemId = findExifItemId(metaContent);
    if (exifItemId < 0) return null;

    // Step 2: Locate item data via iloc box
    const itemData = locateItemData(metaContent, exifItemId, bytes);
    if (!itemData || itemData.length < 4) return null;

    // Step 3: Skip 4-byte Exif TIFF header offset prefix
    // The prefix is a BE uint32 indicating offset from prefix end to TIFF header.
    // Usually 0 (TIFF starts immediately after).
    const tiffOffset = readUint32BE(itemData, 0);
    const dataStart = 4 + tiffOffset;
    if (dataStart >= itemData.length) return null;

    return itemData.subarray(dataStart);
  } catch {
    return null;
  }
}

/**
 * Map nclx colour_primaries to ColorSpaceId.
 *
 * CICP colour_primaries values (ISO/IEC 23091-2):
 *   1  = BT.709 (≈ sRGB primaries)
 *   12 = Display P3 (DCI-P3 with D65 white point)
 *   2  = Unspecified
 *   9  = BT.2020
 */
export function nclxToColorSpace(nclx: NclxParams): ColorSpaceId {
  switch (nclx.colourPrimaries) {
    case 1:  return 'srgb';
    case 12: return 'display-p3';
    case 9:  return 'unknown'; // BT.2020 — no direct mapping in our ColorSpaceId
    default: return 'unknown';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Internal Implementation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Find the colr box payload within the ISOBMFF container.
 * Traverses: top-level → meta (full-box) → iprp → ipco → colr
 *
 * Some files may have colr directly inside ipco, others may nest deeper.
 * We also handle the case where colr appears at a shallow level for robustness.
 */
function findColrBox(bytes: Uint8Array): Uint8Array | null {
  // Strategy: find `meta` box at top level, then drill into iprp → ipco → colr
  const metaPayload = findTopLevelBox(bytes, 'meta');
  if (!metaPayload) return null;

  // `meta` is a full-box: skip 4 bytes (version + flags)
  if (metaPayload.length < 4) return null;
  const metaContent = metaPayload.subarray(4);

  // Find iprp inside meta
  const iprpPayload = findChildBox(metaContent, 'iprp');
  if (!iprpPayload) return null;

  // Find ipco inside iprp
  const ipcoPayload = findChildBox(iprpPayload, 'ipco');
  if (!ipcoPayload) return null;

  // Find colr inside ipco (there may be multiple — prefer prof/rICC over nclx)
  let nclxPayload: Uint8Array | null = null;

  let pos = 0;
  while (pos + 8 <= ipcoPayload.length) {
    const header = readBoxHeader(ipcoPayload, pos);
    if (!header) break;

    const { type, dataOffset, boxEnd } = header;

    if (type === 'colr') {
      const payload = ipcoPayload.subarray(dataOffset, boxEnd);
      if (payload.length >= 4) {
        const ct = getFourCC(payload, 0);
        if (ct === 'prof' || ct === 'rICC') {
          return payload; // Prefer ICC profile over nclx
        }
        if (ct === 'nclx') {
          nclxPayload = payload; // Remember nclx, continue looking for prof/rICC
        }
      }
    }

    pos = boxEnd;
  }

  // No prof/rICC found — return nclx payload (or null)
  return nclxPayload;
}

/**
 * Find a box by type at the top level of the ISOBMFF file.
 * Returns the box's data payload (after header).
 */
function findTopLevelBox(bytes: Uint8Array, targetType: string): Uint8Array | null {
  let pos = 0;
  while (pos + 8 <= bytes.length) {
    const header = readBoxHeader(bytes, pos);
    if (!header) break;

    if (header.type === targetType) {
      return bytes.subarray(header.dataOffset, header.boxEnd);
    }

    pos = header.boxEnd;
  }
  return null;
}

/**
 * Find a child box within a container box's payload.
 * Returns the child box's data payload (after header).
 */
function findChildBox(parentPayload: Uint8Array, targetType: string): Uint8Array | null {
  let pos = 0;
  while (pos + 8 <= parentPayload.length) {
    const header = readBoxHeader(parentPayload, pos);
    if (!header) break;

    if (header.type === targetType) {
      return parentPayload.subarray(header.dataOffset, header.boxEnd);
    }

    pos = header.boxEnd;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXIF Item Extraction Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Find the item ID of the 'Exif' item from the iinf (Item Information) box.
 *
 * iinf is a full-box inside meta. Structure:
 *   version(1) + flags(3) + entry_count(2 or 4) + infe entries...
 *
 * Each infe (Item Info Entry) is also a full-box:
 *   version(1) + flags(3) + item_ID(2 for v<3, 4 for v>=3) +
 *   item_protection_index(2) + item_type(4 for v>=2) + item_name(null-term)
 *
 * @returns Item ID of the Exif item, or -1 if not found
 */
function findExifItemId(metaContent: Uint8Array): number {
  const iinfPayload = findChildBox(metaContent, 'iinf');
  if (!iinfPayload || iinfPayload.length < 4) return -1;

  // iinf is a full-box: version(1) + flags(3)
  const iinfVersion = iinfPayload[0];
  let pos = 4; // skip version + flags

  // entry_count: 4 bytes if version >= 2 of the iinf box itself, else 2 bytes
  // Note: iinfVersion here is the version of the iinf full-box
  let entryCount: number;
  if (iinfVersion === 0) {
    if (pos + 2 > iinfPayload.length) return -1;
    entryCount = readUint16BE(iinfPayload, pos);
    pos += 2;
  } else {
    if (pos + 4 > iinfPayload.length) return -1;
    entryCount = readUint32BE(iinfPayload, pos);
    pos += 4;
  }

  // Iterate infe entries (each is a child box)
  for (let i = 0; i < entryCount && pos + 8 <= iinfPayload.length; i++) {
    const header = readBoxHeader(iinfPayload, pos);
    if (!header) break;

    if (header.type === 'infe') {
      const infeData = iinfPayload.subarray(header.dataOffset, header.boxEnd);
      if (infeData.length >= 4) {
        const infeVersion = infeData[0];
        // skip version(1) + flags(3)
        let infePos = 4;

        let itemId: number;
        if (infeVersion >= 3) {
          // item_ID is 4 bytes
          if (infePos + 4 > infeData.length) { pos = header.boxEnd; continue; }
          itemId = readUint32BE(infeData, infePos);
          infePos += 4;
        } else {
          // item_ID is 2 bytes
          if (infePos + 2 > infeData.length) { pos = header.boxEnd; continue; }
          itemId = readUint16BE(infeData, infePos);
          infePos += 2;
        }

        // item_protection_index: 2 bytes
        infePos += 2;

        // item_type: 4 bytes (only for version >= 2)
        if (infeVersion >= 2) {
          if (infePos + 4 > infeData.length) { pos = header.boxEnd; continue; }
          const itemType = getFourCC(infeData, infePos);
          if (itemType === 'Exif') {
            return itemId;
          }
        }
      }
    }

    pos = header.boxEnd;
  }

  return -1;
}

/**
 * Locate item data bytes by item ID using the iloc (Item Location) box.
 *
 * iloc is a full-box inside meta. Structure:
 *   version(1) + flags(3) +
 *   offset_size(4 bits) + length_size(4 bits) +
 *   base_offset_size(4 bits) + index_size(4 bits, v1+) or reserved(4 bits, v0) +
 *   item_count(2 for v<2, 4 for v2) +
 *   items[]: item_ID + construction_method(v1+) + data_reference_index +
 *            base_offset + extent_count + extents[]
 *
 * @param metaContent - meta box content (after version+flags)
 * @param targetItemId - the item ID to locate
 * @param fileBytes - the full file bytes (for absolute offset reading)
 * @returns Raw item bytes, or null
 */
function locateItemData(
  metaContent: Uint8Array,
  targetItemId: number,
  fileBytes: Uint8Array,
): Uint8Array | null {
  const ilocPayload = findChildBox(metaContent, 'iloc');
  if (!ilocPayload || ilocPayload.length < 8) return null;

  const ilocVersion = ilocPayload[0];
  let pos = 4; // skip version(1) + flags(3)

  // Size fields (4 bits each)
  const sizeByte1 = ilocPayload[pos];
  const sizeByte2 = ilocPayload[pos + 1];
  const offsetSize = (sizeByte1 >> 4) & 0x0F;   // 0, 4, or 8 bytes
  const lengthSize = sizeByte1 & 0x0F;           // 0, 4, or 8 bytes
  const baseOffsetSize = (sizeByte2 >> 4) & 0x0F;
  const indexSize = (ilocVersion >= 1) ? (sizeByte2 & 0x0F) : 0;
  pos += 2;

  // item_count
  let itemCount: number;
  if (ilocVersion < 2) {
    if (pos + 2 > ilocPayload.length) return null;
    itemCount = readUint16BE(ilocPayload, pos);
    pos += 2;
  } else {
    if (pos + 4 > ilocPayload.length) return null;
    itemCount = readUint32BE(ilocPayload, pos);
    pos += 4;
  }

  for (let i = 0; i < itemCount; i++) {
    if (pos >= ilocPayload.length) return null;

    // item_ID
    let itemId: number;
    if (ilocVersion < 2) {
      if (pos + 2 > ilocPayload.length) return null;
      itemId = readUint16BE(ilocPayload, pos);
      pos += 2;
    } else {
      if (pos + 4 > ilocPayload.length) return null;
      itemId = readUint32BE(ilocPayload, pos);
      pos += 4;
    }

    // construction_method (version >= 1): 2 bytes
    let constructionMethod = 0;
    if (ilocVersion >= 1) {
      if (pos + 2 > ilocPayload.length) return null;
      constructionMethod = readUint16BE(ilocPayload, pos) & 0x0F;
      pos += 2;
    }

    // data_reference_index: 2 bytes
    pos += 2;

    // base_offset
    const baseOffset = readVarIntBE(ilocPayload, pos, baseOffsetSize);
    pos += baseOffsetSize;

    // extent_count: 2 bytes
    if (pos + 2 > ilocPayload.length) return null;
    const extentCount = readUint16BE(ilocPayload, pos);
    pos += 2;

    // Read extents
    if (itemId === targetItemId && constructionMethod === 0) {
      // Concatenate all extents for this item
      const chunks: Uint8Array[] = [];
      for (let e = 0; e < extentCount; e++) {
        // extent_index (only if version >= 1 and indexSize > 0)
        if (ilocVersion >= 1 && indexSize > 0) {
          pos += indexSize;
        }
        const extentOffset = readVarIntBE(ilocPayload, pos, offsetSize);
        pos += offsetSize;
        const extentLength = readVarIntBE(ilocPayload, pos, lengthSize);
        pos += lengthSize;

        const absOffset = baseOffset + extentOffset;
        if (absOffset + extentLength <= fileBytes.length) {
          chunks.push(fileBytes.subarray(absOffset, absOffset + extentLength));
        }
      }
      if (chunks.length === 0) return null;
      if (chunks.length === 1) return chunks[0];
      // Concatenate multiple extents
      const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
      const result = new Uint8Array(totalLen);
      let off = 0;
      for (const chunk of chunks) {
        result.set(chunk, off);
        off += chunk.length;
      }
      return result;
    } else {
      // Skip extents for non-matching items
      for (let e = 0; e < extentCount; e++) {
        if (ilocVersion >= 1 && indexSize > 0) pos += indexSize;
        pos += offsetSize;
        pos += lengthSize;
      }
    }
  }

  return null;
}

/**
 * Read a variable-length big-endian unsigned integer (0, 4, or 8 bytes).
 * Used for iloc offset/length/base_offset fields.
 */
function readVarIntBE(bytes: Uint8Array, offset: number, size: number): number {
  if (size === 0) return 0;
  if (size === 4) return readUint32BE(bytes, offset);
  if (size === 8) {
    const hi = readUint32BE(bytes, offset);
    const lo = readUint32BE(bytes, offset + 4);
    return hi * 0x100000000 + lo;
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════════════════════════════════

interface BoxHeader {
  type: string;       // FourCC box type
  dataOffset: number; // Offset where box data (payload) starts (relative to buffer start)
  boxEnd: number;     // Offset where this box ends (relative to buffer start)
}

/**
 * Read ISOBMFF box header at given offset.
 * Handles standard 32-bit size and 64-bit extended size.
 *
 * @returns Box header info, or null if bytes are insufficient/invalid
 */
function readBoxHeader(bytes: Uint8Array, offset: number): BoxHeader | null {
  if (offset + 8 > bytes.length) return null;

  const size32 = readUint32BE(bytes, offset);
  const type = getFourCC(bytes, offset + 4);
  let dataOffset = offset + 8;
  let boxEnd: number;

  if (size32 === 1) {
    // 64-bit extended size
    if (offset + 16 > bytes.length) return null;
    // Read 64-bit size (we only support up to Number.MAX_SAFE_INTEGER)
    const hi = readUint32BE(bytes, offset + 8);
    const lo = readUint32BE(bytes, offset + 12);
    const size64 = hi * 0x100000000 + lo;
    dataOffset = offset + 16;
    boxEnd = offset + Math.min(size64, bytes.length - offset);
  } else if (size32 === 0) {
    // Box extends to end of containing data
    dataOffset = offset + 8;
    boxEnd = bytes.length;
  } else {
    // Normal 32-bit size
    if (size32 < 8) return null; // Invalid box size
    boxEnd = offset + size32;
  }

  // Clamp boxEnd to buffer boundary
  if (boxEnd > bytes.length) {
    boxEnd = bytes.length;
  }

  return { type, dataOffset, boxEnd };
}

/** Read a 4-byte ASCII string (FourCC) at the given offset. */
function getFourCC(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3],
  );
}

/** Read a 4-byte big-endian unsigned integer. */
function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]
  ) >>> 0;
}

/** Read a 2-byte big-endian unsigned integer. */
function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test Helpers (exported for unit tests)
// ═══════════════════════════════════════════════════════════════════════════════

/** @internal — exported for testing only */
export const _testHelpers = {
  readBoxHeader,
  findTopLevelBox,
  findChildBox,
  findColrBox,
  getFourCC,
  readUint32BE,
  readUint16BE,
};
