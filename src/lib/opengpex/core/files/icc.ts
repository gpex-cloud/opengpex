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
 * ICC Color Profile utility functions.
 *
 * Provides base64 encoding/decoding and profile name parsing for ICC Profile
 * data stored inline in the document state JSON.
 *
 * ICC Profiles are typically 2-50KB (sRGB=3.1KB, AdobeRGB=560B, custom<100KB).
 * They are set once at import time and do not participate in undo/redo.
 */

// ─── Base64 Conversion ──────────────────────────────────────────────────────

/**
 * Convert ICC Profile bytes (Uint8Array) → base64 string for JSON storage.
 */
export function iccToBase64(iccBytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < iccBytes.length; i++) {
    binary += String.fromCharCode(iccBytes[i]);
  }
  return btoa(binary);
}

/**
 * Convert base64 string → ICC Profile bytes (Uint8Array) for export injection.
 */
export function base64ToIcc(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ─── ICC Profile Name Parsing ───────────────────────────────────────────────

/**
 * Parse ICC Profile description name from raw profile bytes.
 *
 * ICC v2/v4 profiles store a 'desc' tag containing the profile description.
 * This function performs a lightweight parse of the tag table to find it.
 *
 * @returns The profile description string, or undefined if not found.
 */
export function parseIccProfileName(iccBytes: Uint8Array): string | undefined {
  if (iccBytes.length < 132) return undefined;

  // ICC Profile header: 128 bytes
  // Tag count at offset 128 (4 bytes, big-endian)
  const tagCount = readUint32BE(iccBytes, 128);
  if (tagCount === 0 || tagCount > 100) return undefined;

  // Tag table starts at offset 132, each entry is 12 bytes:
  //   [signature(4)] [offset(4)] [size(4)]
  for (let i = 0; i < tagCount; i++) {
    const tagOffset = 132 + i * 12;
    if (tagOffset + 12 > iccBytes.length) break;

    const sig = String.fromCharCode(
      iccBytes[tagOffset],
      iccBytes[tagOffset + 1],
      iccBytes[tagOffset + 2],
      iccBytes[tagOffset + 3],
    );

    if (sig === 'desc') {
      const dataOffset = readUint32BE(iccBytes, tagOffset + 4);
      const dataSize = readUint32BE(iccBytes, tagOffset + 8);
      if (dataOffset + dataSize > iccBytes.length) return undefined;
      return parseDescTag(iccBytes, dataOffset, dataSize);
    }
  }

  return undefined;
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/** Read a 4-byte big-endian unsigned integer from a Uint8Array. */
function readUint32BE(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] << 24) |
      (data[offset + 1] << 16) |
      (data[offset + 2] << 8) |
      data[offset + 3]) >>>
    0
  );
}

/**
 * Parse ICC 'desc' tag to extract the ASCII description string.
 *
 * ICC v2 'desc' tag (type signature 'desc'):
 *   [type signature: 'desc' (4)] [reserved (4)] [ASCII count (4)] [ASCII string...]
 *
 * ICC v4 'desc' tag may use 'mluc' (multiLocalizedUnicodeType):
 *   [type signature: 'mluc' (4)] [reserved (4)] [record count (4)] [record size (4)]
 *   Then records with offset/length pairs pointing to UTF-16BE strings.
 */
function parseDescTag(
  iccBytes: Uint8Array,
  offset: number,
  size: number,
): string | undefined {
  if (size < 12) return undefined;

  const typeSig = String.fromCharCode(
    iccBytes[offset],
    iccBytes[offset + 1],
    iccBytes[offset + 2],
    iccBytes[offset + 3],
  );

  if (typeSig === 'desc') {
    // ICC v2 textDescriptionType
    const asciiLen = readUint32BE(iccBytes, offset + 8);
    if (asciiLen === 0 || asciiLen > size - 12) return undefined;
    const strBytes = iccBytes.slice(offset + 12, offset + 12 + asciiLen - 1); // -1 for null terminator
    return new TextDecoder('ascii', { fatal: false }).decode(strBytes).trim();
  }

  if (typeSig === 'mluc') {
    // ICC v4 multiLocalizedUnicodeType
    const recordCount = readUint32BE(iccBytes, offset + 8);
    const recordSize = readUint32BE(iccBytes, offset + 12);
    if (recordCount === 0 || recordSize < 12) return undefined;

    // Read first record (usually 'enUS')
    const firstRecordOffset = offset + 16;
    if (firstRecordOffset + 12 > iccBytes.length) return undefined;

    const strLen = readUint32BE(iccBytes, firstRecordOffset + 4);  // string length in bytes
    const strOffset = readUint32BE(iccBytes, firstRecordOffset + 8); // offset from tag start
    const absOffset = offset + strOffset;

    if (absOffset + strLen > iccBytes.length) return undefined;

    // Decode UTF-16BE
    const utf16Bytes = iccBytes.slice(absOffset, absOffset + strLen);
    const chars: string[] = [];
    for (let i = 0; i < utf16Bytes.length - 1; i += 2) {
      const code = (utf16Bytes[i] << 8) | utf16Bytes[i + 1];
      if (code === 0) break; // null terminator
      chars.push(String.fromCharCode(code));
    }
    return chars.join('').trim();
  }

  return undefined;
}
