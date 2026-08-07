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
 * Provides base64 encoding/decoding, profile name parsing, and stock profile
 * access for ICC Profile data stored inline in the document state JSON.
 *
 * ICC Profiles are typically 2-50KB (sRGB=3.1KB, AdobeRGB=560B, custom<100KB).
 * They are set once at import time and do not participate in undo/redo.
 */

import type { WorkingColorSpace } from '@opengpex/editor/core/types';

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

// ─── Stock ICC Profiles ─────────────────────────────────────────────────────

/** sRGB IEC61966-2.1 — the standard sRGB ICC v2 profile (3144 bytes). */
const SRGB_ICC_BASE64 = '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';

/** Display P3 — Apple's standard Display P3 profile (DCI-P3 primaries + D65 white). */
const DISPLAY_P3_ICC_BASE64 = 'AAACGGFwcGwEAAAAbW50clJHQiBYWVogB+YAAQABAAAAAAAAYWNzcEFQUEwAAAAAQVBQTAAAAAAAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1hcHBsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKZGVzYwAAAPwAAAAwY3BydAAAASwAAABQd3RwdAAAAXwAAAAUclhZWgAAAZAAAAAUZ1hZWgAAAaQAAAAUYlhZWgAAAbgAAAAUclRSQwAAAcwAAAAgY2hhZAAAAewAAAAsYlRSQwAAAcwAAAAgZ1RSQwAAAcwAAAAgbWx1YwAAAAAAAAABAAAADGVuVVMAAAAUAAAAHABEAGkAcwBwAGwAYQB5ACAAUAAzbWx1YwAAAAAAAAABAAAADGVuVVMAAAA0AAAAHABDAG8AcAB5AHIAaQBnAGgAdAAgAEEAcABwAGwAZQAgAEkAbgBjAC4ALAAgADIAMAAyADJYWVogAAAAAAAA9tUAAQAAAADTLFhZWiAAAAAAAACD3wAAPb////+7WFlaIAAAAAAAAEq/AACxNwAACrlYWVogAAAAAAAAKDgAABELAADIuXBhcmEAAAAAAAMAAAACZmYAAPKnAAANWQAAE9AAAApbc2YzMgAAAAAAAQxCAAAF3v//8yYAAAeTAAD9kP//+6L///2jAAAD3AAAwG4=';

/**
 * Get the stock ICC profile for a given working color space.
 *
 * Returns the industry-standard ICC profile for the frame's color space.
 * Used when "Embed ICC Profile" is enabled but the source image has no
 * ICC profile data to preserve.
 *
 * @returns Stock profile data, or null for unsupported color spaces
 */
export function getStockIccProfile(colorSpace: WorkingColorSpace): { bytes: Uint8Array; name: string } | null {
  switch (colorSpace) {
    case 'srgb':
      return { bytes: base64ToIcc(SRGB_ICC_BASE64), name: 'sRGB IEC61966-2.1' };
    case 'display-p3':
      return { bytes: base64ToIcc(DISPLAY_P3_ICC_BASE64), name: 'Display P3' };
    default:
      return null;
  }
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
