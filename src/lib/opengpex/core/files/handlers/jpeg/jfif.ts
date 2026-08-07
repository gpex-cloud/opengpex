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
 * JPEG JFIF marker-level operations.
 *
 * Pure binary operations on JPEG marker structure — no semantic parsing.
 * Handles APP1 (EXIF) and APP2 (ICC_PROFILE) marker extraction/injection.
 *
 * JPEG marker structure refresher:
 *   0xFF 0xXX             ← 2-byte marker
 *   [2 bytes length]      ← length of payload + 2 (self-inclusive)
 *   [payload...]          ← marker data
 */

// ═══════════════════════════════════════════════════════════════════════════════
// EXIF APP1 Operations
// ═══════════════════════════════════════════════════════════════════════════════

/** The 6-byte EXIF header prefix in APP1: "Exif\0\0" */
const EXIF_HEADER = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);

/**
 * Extract raw EXIF bytes from JPEG APP1 marker.
 * Returns the TIFF IFD structure (without "Exif\0\0" prefix).
 * Returns null if no EXIF APP1 found.
 */
export function extractJpegExif(jpegBytes: Uint8Array): Uint8Array | null {
  let pos = 2; // skip SOI (0xFF 0xD8)

  while (pos < jpegBytes.length - 1) {
    if (jpegBytes[pos] !== 0xFF) break;
    const marker = jpegBytes[pos + 1];

    // SOS (0xDA) — end of markers
    if (marker === 0xDA) break;

    // Markers without length (RST, SOI, EOI)
    if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) {
      pos += 2;
      continue;
    }

    // Marker with length
    const len = (jpegBytes[pos + 2] << 8) | jpegBytes[pos + 3];
    const segmentEnd = pos + 2 + len;

    // Check for APP1 (0xE1) with "Exif\0\0" header
    if (marker === 0xE1 && len > 8) {
      const headerMatch =
        jpegBytes[pos + 4] === 0x45 && // 'E'
        jpegBytes[pos + 5] === 0x78 && // 'x'
        jpegBytes[pos + 6] === 0x69 && // 'i'
        jpegBytes[pos + 7] === 0x66 && // 'f'
        jpegBytes[pos + 8] === 0x00 &&
        jpegBytes[pos + 9] === 0x00;

      if (headerMatch) {
        // Return TIFF IFD bytes (after "Exif\0\0" 6-byte prefix)
        return jpegBytes.slice(pos + 10, segmentEnd);
      }
    }

    pos = segmentEnd;
  }

  return null;
}

/**
 * Inject raw EXIF bytes into JPEG as APP1 marker.
 * Adds "Exif\0\0" prefix and wraps in APP1 marker structure.
 * Removes any existing EXIF APP1 first to avoid duplicates.
 */
export function injectJpegExif(jpegBytes: Uint8Array, exifBytes: Uint8Array): Uint8Array {
  // Remove existing EXIF APP1 first
  const cleaned = stripJpegExif(jpegBytes);

  // Build APP1 marker: 0xFF 0xE1 + length(2) + "Exif\0\0"(6) + TIFF IFD data
  const payloadLen = EXIF_HEADER.length + exifBytes.length;
  const markerLen = payloadLen + 2; // +2 for length field itself
  const app1 = new Uint8Array(4 + payloadLen);
  app1[0] = 0xFF;
  app1[1] = 0xE1;
  app1[2] = (markerLen >> 8) & 0xFF;
  app1[3] = markerLen & 0xFF;
  app1.set(EXIF_HEADER, 4);
  app1.set(exifBytes, 4 + EXIF_HEADER.length);

  // Insert after SOI (position 2), before any other markers
  const insertPos = findExifInsertPosition(cleaned);
  const result = new Uint8Array(cleaned.length + app1.length);
  result.set(cleaned.slice(0, insertPos), 0);
  result.set(app1, insertPos);
  result.set(cleaned.slice(insertPos), insertPos + app1.length);
  return result;
}

/**
 * Remove EXIF APP1 marker from JPEG bytes.
 */
function stripJpegExif(jpegBytes: Uint8Array): Uint8Array {
  const segments: Uint8Array[] = [];
  let pos = 0;

  // Copy SOI
  segments.push(jpegBytes.slice(0, 2));
  pos = 2;

  while (pos < jpegBytes.length - 1) {
    if (jpegBytes[pos] !== 0xFF) {
      segments.push(jpegBytes.slice(pos));
      break;
    }

    const marker = jpegBytes[pos + 1];

    // SOS — copy rest
    if (marker === 0xDA) {
      segments.push(jpegBytes.slice(pos));
      break;
    }

    // Markers without length
    if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) {
      segments.push(jpegBytes.slice(pos, pos + 2));
      pos += 2;
      continue;
    }

    // Marker with length
    const len = (jpegBytes[pos + 2] << 8) | jpegBytes[pos + 3];
    const segmentEnd = pos + 2 + len;

    // Skip EXIF APP1 markers
    if (marker === 0xE1 && len > 8) {
      const headerMatch =
        jpegBytes[pos + 4] === 0x45 &&
        jpegBytes[pos + 5] === 0x78 &&
        jpegBytes[pos + 6] === 0x69 &&
        jpegBytes[pos + 7] === 0x66 &&
        jpegBytes[pos + 8] === 0x00 &&
        jpegBytes[pos + 9] === 0x00;

      if (headerMatch) {
        pos = segmentEnd;
        continue;
      }
    }

    segments.push(jpegBytes.slice(pos, segmentEnd));
    pos = segmentEnd;
  }

  return concatSegments(segments);
}

/**
 * Find insertion position for EXIF APP1 (right after SOI, before APP0 if present).
 * Per JFIF spec, APP0 should come first, then APP1 (EXIF).
 */
function findExifInsertPosition(jpegBytes: Uint8Array): number {
  let pos = 2; // after SOI

  while (pos < jpegBytes.length - 1) {
    if (jpegBytes[pos] !== 0xFF) break;
    const marker = jpegBytes[pos + 1];

    // APP0 (0xE0) — skip past it, insert after
    if (marker === 0xE0) {
      const len = (jpegBytes[pos + 2] << 8) | jpegBytes[pos + 3];
      pos += 2 + len;
      continue;
    }

    // Any other marker — insert before it
    break;
  }

  return pos;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ICC APP2 Operations
// ═══════════════════════════════════════════════════════════════════════════════

const ICC_HEADER_STR = 'ICC_PROFILE\0';
const ICC_HEADER_BYTES = new TextEncoder().encode(ICC_HEADER_STR);
const MAX_ICC_CHUNK_DATA = 65519; // 65535(max marker) - 2(length) - 14(header+seq+count)

/**
 * Extract ICC Profile from JPEG APP2 markers.
 * Reassembles multi-chunk ICC (>64KB split across markers).
 */
export function extractJpegIcc(jpegBytes: Uint8Array): Uint8Array | null {
  const chunks: { seq: number; data: Uint8Array }[] = [];
  let pos = 2; // skip SOI

  while (pos < jpegBytes.length - 1) {
    if (jpegBytes[pos] !== 0xFF) break;
    const marker = jpegBytes[pos + 1];

    // SOS (0xDA) — end of markers
    if (marker === 0xDA) break;

    // Markers without length
    if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) {
      pos += 2;
      continue;
    }

    // Marker with length
    const len = (jpegBytes[pos + 2] << 8) | jpegBytes[pos + 3];
    const segmentEnd = pos + 2 + len;

    // Check for APP2 ICC_PROFILE marker
    if (marker === 0xE2 && len > 14) {
      const headerSlice = jpegBytes.slice(pos + 4, pos + 4 + 12);
      const headerStr = String.fromCharCode(...headerSlice);
      if (headerStr === ICC_HEADER_STR) {
        const seqNo = jpegBytes[pos + 16];    // sequence number (1-based)
        const iccData = jpegBytes.slice(pos + 18, segmentEnd);
        chunks.push({ seq: seqNo, data: iccData });
      }
    }

    pos = segmentEnd;
  }

  if (chunks.length === 0) return null;

  // Sort by sequence number and concatenate
  chunks.sort((a, b) => a.seq - b.seq);
  const totalLen = chunks.reduce((s, c) => s + c.data.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk.data, offset);
    offset += chunk.data.length;
  }
  return result;
}

/**
 * Inject ICC Profile into JPEG via APP2 markers.
 * Handles chunking for profiles > 64KB.
 * Removes existing ICC markers first.
 */
export function injectJpegIcc(jpegBytes: Uint8Array, iccBytes: Uint8Array): Uint8Array {
  const numChunks = Math.ceil(iccBytes.length / MAX_ICC_CHUNK_DATA);
  const app2Markers: Uint8Array[] = [];

  for (let i = 0; i < numChunks; i++) {
    const chunkData = iccBytes.slice(i * MAX_ICC_CHUNK_DATA, (i + 1) * MAX_ICC_CHUNK_DATA);

    // APP2 payload: "ICC_PROFILE\0" + seq_no(1) + num_chunks(1) + ICC_data
    const payload = new Uint8Array(ICC_HEADER_BYTES.length + 2 + chunkData.length);
    payload.set(ICC_HEADER_BYTES, 0);
    payload[ICC_HEADER_BYTES.length] = i + 1;      // sequence number (1-based)
    payload[ICC_HEADER_BYTES.length + 1] = numChunks;
    payload.set(chunkData, ICC_HEADER_BYTES.length + 2);

    // Wrap in APP2 marker: 0xFF 0xE2 + length(2 bytes big-endian)
    const markerLen = payload.length + 2; // +2 for length field itself
    const marker = new Uint8Array(4 + payload.length);
    marker[0] = 0xFF;
    marker[1] = 0xE2;
    marker[2] = (markerLen >> 8) & 0xFF;
    marker[3] = markerLen & 0xFF;
    marker.set(payload, 4);
    app2Markers.push(marker);
  }

  // Remove any existing APP2 ICC_PROFILE markers first
  const cleanedJpeg = stripJpegIcc(jpegBytes);
  const insertPos = findIccInsertPosition(cleanedJpeg);

  // Build result
  const totalIccSize = app2Markers.reduce((s, m) => s + m.length, 0);
  const result = new Uint8Array(cleanedJpeg.length + totalIccSize);
  result.set(cleanedJpeg.slice(0, insertPos), 0);
  let offset = insertPos;
  for (const marker of app2Markers) {
    result.set(marker, offset);
    offset += marker.length;
  }
  result.set(cleanedJpeg.slice(insertPos), offset);
  return result;
}

/**
 * Remove all ICC APP2 markers from JPEG.
 */
export function stripJpegIcc(jpegBytes: Uint8Array): Uint8Array {
  const segments: Uint8Array[] = [];
  let pos = 0;

  // Copy SOI
  segments.push(jpegBytes.slice(0, 2));
  pos = 2;

  while (pos < jpegBytes.length - 1) {
    if (jpegBytes[pos] !== 0xFF) {
      segments.push(jpegBytes.slice(pos));
      break;
    }

    const marker = jpegBytes[pos + 1];

    // SOS — copy rest
    if (marker === 0xDA) {
      segments.push(jpegBytes.slice(pos));
      break;
    }

    // Markers without length (RST, SOI, EOI)
    if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) {
      segments.push(jpegBytes.slice(pos, pos + 2));
      pos += 2;
      continue;
    }

    // Marker with length
    const len = (jpegBytes[pos + 2] << 8) | jpegBytes[pos + 3];
    const segmentEnd = pos + 2 + len;

    // Check if this is an APP2 ICC_PROFILE marker to skip
    if (marker === 0xE2 && len > 14) {
      const headerSlice = jpegBytes.slice(pos + 4, pos + 4 + 12);
      const headerStr = String.fromCharCode(...headerSlice);
      if (headerStr === ICC_HEADER_STR) {
        pos = segmentEnd;
        continue;
      }
    }

    // Keep this segment
    segments.push(jpegBytes.slice(pos, segmentEnd));
    pos = segmentEnd;
  }

  return concatSegments(segments);
}

/**
 * Find the position to insert APP2 ICC markers.
 * Should be after SOI (2 bytes) and after APP0/APP1 markers if present.
 */
function findIccInsertPosition(jpegBytes: Uint8Array): number {
  let pos = 2; // Start after SOI

  while (pos < jpegBytes.length - 1) {
    if (jpegBytes[pos] !== 0xFF) break;
    const marker = jpegBytes[pos + 1];

    // APP0 (0xE0) or APP1 (0xE1) — skip these, insert after them
    if (marker === 0xE0 || marker === 0xE1) {
      const len = (jpegBytes[pos + 2] << 8) | jpegBytes[pos + 3];
      pos += 2 + len;
      continue;
    }

    // Stop at any other marker — this is our insert position
    break;
  }

  return pos;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Internal Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/** Concatenate Uint8Array segments into one. */
function concatSegments(segments: Uint8Array[]): Uint8Array {
  const totalLen = segments.reduce((s, seg) => s + seg.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const seg of segments) {
    result.set(seg, offset);
    offset += seg.length;
  }
  return result;
}
