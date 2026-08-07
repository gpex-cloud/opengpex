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
 * WebP RIFF container-level operations.
 *
 * Pure byte-level operations on the RIFF/WebP container — no semantic parsing.
 * Handles ICCP (ICC Profile) and EXIF chunk extraction/injection.
 *
 * WebP extended format (VP8X) structure:
 * ```
 * RIFF [4B size] WEBP
 *   VP8X [4B size] [10B flags+dimensions] (flags bit 5 = ICC, bit 3 = EXIF)
 *   ICCP [4B size] [ICC profile bytes]
 *   ...
 *   EXIF [4B size] [EXIF bytes (TIFF IFD, possibly with "Exif\0\0" prefix)]
 * ```
 *
 * @module core/files/handlers/webp/riff
 */

// ═══════════════════════════════════════════════════════════════════════════════
// ICC Profile Operations
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extract ICC Profile bytes from WebP RIFF container.
 *
 * Scans RIFF chunks for the ICCP chunk and returns its data.
 * @returns Raw ICC profile bytes, or null if not found
 */
export function extractWebpIcc(bytes: Uint8Array): Uint8Array | null {
  if (!isRiffWebP(bytes)) return null;

  // Scan RIFF chunks starting at offset 12
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const chunkId = getFourCC(bytes, pos);
    const chunkSize = readUint32LE(bytes, pos + 4);

    if (chunkId === 'ICCP') {
      const dataStart = pos + 8;
      const dataEnd = dataStart + chunkSize;
      if (dataEnd <= bytes.length && chunkSize > 0) {
        return bytes.slice(dataStart, dataEnd);
      }
      return null;
    }

    // Move to next chunk (chunks are padded to even byte boundaries)
    pos += 8 + chunkSize + (chunkSize % 2);
  }

  return null;
}

/**
 * Inject ICC Profile into a WebP file via RIFF chunk manipulation.
 *
 * Handles two cases:
 *   1. Simple WebP (VP8/VP8L at offset 12) → upgrade to extended format (VP8X) + insert ICCP chunk
 *   2. Extended WebP (VP8X at offset 12) → insert ICCP chunk + update VP8X flags
 *
 * @param webpBytes    - Original WebP file bytes (from canvas.convertToBlob)
 * @param iccProfile   - ICC Profile binary data to embed
 * @returns New WebP file bytes with ICC Profile injected
 * @throws Error if input is not a valid WebP file
 */
export function injectWebpIcc(webpBytes: Uint8Array, iccProfile: Uint8Array): Uint8Array {
  if (!isRiffWebP(webpBytes)) {
    throw new Error('Not a valid WebP file');
  }

  const firstChunkFourCC = getFourCC(webpBytes, 12);
  const isExtended = firstChunkFourCC === 'VP8X';

  if (isExtended) {
    return injectIccIntoExtended(webpBytes, iccProfile);
  } else {
    return upgradeToExtendedWithIcc(webpBytes, iccProfile);
  }
}

/**
 * Strip ICC Profile (ICCP chunk) from a WebP file.
 *
 * Used when user explicitly disables ICC embedding — Chrome's native encoder
 * may auto-inject sRGB/P3 ICC profiles, so we need to remove them.
 *
 * @param webpBytes - WebP file bytes (possibly with browser-injected ICC)
 * @returns New WebP file bytes without ICCP chunk (or original if no ICCP found)
 */
export function stripWebpIcc(webpBytes: Uint8Array): Uint8Array {
  if (!isRiffWebP(webpBytes)) {
    throw new Error('Not a valid WebP file');
  }

  const firstChunkFourCC = getFourCC(webpBytes, 12);
  if (firstChunkFourCC !== 'VP8X') {
    // Simple format — no ICCP possible, return as-is
    return webpBytes;
  }

  const view = new DataView(webpBytes.buffer, webpBytes.byteOffset, webpBytes.byteLength);
  const vp8xDataSize = view.getUint32(16, true);
  const vp8xChunkTotalSize = 8 + vp8xDataSize + (vp8xDataSize % 2 ? 1 : 0);
  const afterVp8x = 12 + vp8xChunkTotalSize;

  // Find ICCP chunk position
  let pos = afterVp8x;
  while (pos + 8 <= webpBytes.length) {
    const chunkFourCC = getFourCC(webpBytes, pos);
    const chunkDataSize = view.getUint32(pos + 4, true);
    const chunkTotalSize = 8 + chunkDataSize + (chunkDataSize % 2 ? 1 : 0);

    if (chunkFourCC === 'ICCP') {
      // Found it — remove this chunk
      const result = new Uint8Array(webpBytes.length - chunkTotalSize);
      result.set(webpBytes.subarray(0, pos), 0);
      result.set(webpBytes.subarray(pos + chunkTotalSize), pos);

      // Clear ICC flag (bit 5) in VP8X flags
      result[20] = result[20] & ~0x20;

      // Update RIFF file size
      new DataView(result.buffer).setUint32(4, result.length - 8, true);

      return result;
    }

    pos += chunkTotalSize;
  }

  // No ICCP chunk found — return as-is
  return webpBytes;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXIF Operations
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Inject raw EXIF bytes into WebP RIFF container.
 *
 * Adds/replaces EXIF chunk and sets VP8X EXIF flag (bit 3).
 * EXIF chunk is placed after all image data chunks.
 *
 * @param webpBytes - Original WebP file bytes
 * @param exifBytes - Raw EXIF TIFF IFD bytes to embed
 * @returns New WebP file bytes with EXIF injected
 * @throws Error if input is not a valid WebP file
 */
export function injectWebpExif(webpBytes: Uint8Array, exifBytes: Uint8Array): Uint8Array {
  if (!isRiffWebP(webpBytes)) {
    throw new Error('Not a valid WebP file');
  }

  const firstChunkFourCC = getFourCC(webpBytes, 12);
  const isExtended = firstChunkFourCC === 'VP8X';

  if (isExtended) {
    return injectExifIntoExtended(webpBytes, exifBytes);
  } else {
    return upgradeToExtendedWithExif(webpBytes, exifBytes);
  }
}

/**
 * Extract raw EXIF bytes from WebP RIFF EXIF chunk.
 *
 * WebP EXIF chunk contains TIFF IFD structure.
 * Some encoders prepend "Exif\0\0" (6 bytes) before the TIFF header — we strip that.
 * Returns the TIFF IFD bytes (starting with "II" or "MM" byte order marker).
 *
 * @returns Raw EXIF TIFF IFD bytes, or null if not found
 */
export function extractWebpExif(bytes: Uint8Array): Uint8Array | null {
  if (!isRiffWebP(bytes)) return null;

  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const chunkId = getFourCC(bytes, pos);
    const chunkSize = readUint32LE(bytes, pos + 4);

    if (chunkId === 'EXIF') {
      const dataStart = pos + 8;
      const dataEnd = dataStart + chunkSize;
      if (dataEnd <= bytes.length && chunkSize > 6) {
        let exifData = bytes.slice(dataStart, dataEnd);
        // Strip "Exif\0\0" prefix if present (some encoders include it)
        if (
          exifData[0] === 0x45 && // 'E'
          exifData[1] === 0x78 && // 'x'
          exifData[2] === 0x69 && // 'i'
          exifData[3] === 0x66 && // 'f'
          exifData[4] === 0x00 &&
          exifData[5] === 0x00
        ) {
          exifData = exifData.slice(6);
        }
        return exifData.length > 0 ? exifData : null;
      }
      return null;
    }

    pos += 8 + chunkSize + (chunkSize % 2);
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Internal Implementation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Inject ICCP chunk into an existing extended (VP8X) WebP.
 * Sets the ICC flag in VP8X and inserts the ICCP chunk right after VP8X.
 */
function injectIccIntoExtended(webpBytes: Uint8Array, iccProfile: Uint8Array): Uint8Array {
  const view = new DataView(webpBytes.buffer, webpBytes.byteOffset, webpBytes.byteLength);

  // VP8X chunk header is at offset 12, data starts at offset 20
  const vp8xDataSize = view.getUint32(16, true); // typically 10
  const flagsOffset = 20; // VP8X data starts here (first byte = flags)

  // Insertion point: right after VP8X chunk (header(8) + data + padding)
  const vp8xChunkTotalSize = 8 + vp8xDataSize + (vp8xDataSize % 2 ? 1 : 0);
  const insertOffset = 12 + vp8xChunkTotalSize;

  // Build ICCP chunk
  const iccpChunk = buildChunk('ICCP', iccProfile);

  // Assemble: [header + VP8X] + [ICCP] + [rest of file]
  const result = new Uint8Array(webpBytes.length + iccpChunk.length);
  result.set(webpBytes.subarray(0, insertOffset), 0);
  result.set(iccpChunk, insertOffset);
  result.set(webpBytes.subarray(insertOffset), insertOffset + iccpChunk.length);

  // Set ICC flag (bit 5, 0x20) in VP8X flags
  result[flagsOffset] = result[flagsOffset] | 0x20;

  // Update RIFF file size (offset 4, LE uint32)
  const resultView = new DataView(result.buffer);
  resultView.setUint32(4, result.length - 8, true);

  return result;
}

/**
 * Upgrade a simple WebP (VP8/VP8L) to extended format (VP8X) with ICCP.
 * Creates a VP8X chunk with ICC flag + dimensions, then inserts it and ICCP
 * before the original pixel data.
 */
function upgradeToExtendedWithIcc(webpBytes: Uint8Array, iccProfile: Uint8Array): Uint8Array {
  // Parse image dimensions from VP8/VP8L header
  const { width, height } = parseWebPDimensions(webpBytes, 12);

  // Build VP8X chunk (10 bytes of data)
  const vp8xData = new Uint8Array(10);
  // Byte 0: flags — bit 5 = ICC present (0x20)
  vp8xData[0] = 0x20;
  // Bytes 4-6: canvas width - 1 (24-bit LE)
  const w1 = width - 1;
  vp8xData[4] = w1 & 0xFF;
  vp8xData[5] = (w1 >> 8) & 0xFF;
  vp8xData[6] = (w1 >> 16) & 0xFF;
  // Bytes 7-9: canvas height - 1 (24-bit LE)
  const h1 = height - 1;
  vp8xData[7] = h1 & 0xFF;
  vp8xData[8] = (h1 >> 8) & 0xFF;
  vp8xData[9] = (h1 >> 16) & 0xFF;

  const vp8xChunk = buildChunk('VP8X', vp8xData);
  const iccpChunk = buildChunk('ICCP', iccProfile);

  // Original pixel data starts at offset 12 (after RIFF header)
  const pixelData = webpBytes.subarray(12);

  // Assemble: RIFF header(12) + VP8X + ICCP + original chunks (VP8/VP8L + etc.)
  const totalLength = 12 + vp8xChunk.length + iccpChunk.length + pixelData.length;
  const result = new Uint8Array(totalLength);
  result.set(webpBytes.subarray(0, 12), 0); // RIFF + size + WEBP
  result.set(vp8xChunk, 12);
  result.set(iccpChunk, 12 + vp8xChunk.length);
  result.set(pixelData, 12 + vp8xChunk.length + iccpChunk.length);

  // Update RIFF file size (offset 4)
  new DataView(result.buffer).setUint32(4, result.length - 8, true);

  return result;
}

/**
 * Inject EXIF chunk into an existing extended (VP8X) WebP.
 * Strips any existing EXIF chunk, appends the new one at end of file,
 * and sets VP8X EXIF flag (bit 3).
 */
function injectExifIntoExtended(webpBytes: Uint8Array, exifBytes: Uint8Array): Uint8Array {
  // 1. Strip existing EXIF chunk if any
  const bytes = stripExifChunk(webpBytes);

  const flagsOffset = 20; // VP8X flags byte

  // 2. Build EXIF chunk and append at end of file
  const exifChunk = buildChunk('EXIF', exifBytes);

  const result = new Uint8Array(bytes.length + exifChunk.length);
  result.set(bytes, 0);
  result.set(exifChunk, bytes.length);

  // 3. Set EXIF flag (bit 3, 0x08) in VP8X flags
  result[flagsOffset] = result[flagsOffset] | 0x08;

  // 4. Update RIFF file size (offset 4, LE uint32)
  new DataView(result.buffer).setUint32(4, result.length - 8, true);

  return result;
}

/**
 * Upgrade a simple WebP (VP8/VP8L) to extended format (VP8X) with EXIF.
 * Creates a VP8X chunk with EXIF flag + dimensions, then inserts VP8X before
 * pixel data and appends EXIF chunk at end.
 */
function upgradeToExtendedWithExif(webpBytes: Uint8Array, exifBytes: Uint8Array): Uint8Array {
  // Parse image dimensions from VP8/VP8L header
  const { width, height } = parseWebPDimensions(webpBytes, 12);

  // Build VP8X chunk (10 bytes of data)
  const vp8xData = new Uint8Array(10);
  // Byte 0: flags — bit 3 = EXIF present (0x08)
  vp8xData[0] = 0x08;
  // Bytes 4-6: canvas width - 1 (24-bit LE)
  const w1 = width - 1;
  vp8xData[4] = w1 & 0xFF;
  vp8xData[5] = (w1 >> 8) & 0xFF;
  vp8xData[6] = (w1 >> 16) & 0xFF;
  // Bytes 7-9: canvas height - 1 (24-bit LE)
  const h1 = height - 1;
  vp8xData[7] = h1 & 0xFF;
  vp8xData[8] = (h1 >> 8) & 0xFF;
  vp8xData[9] = (h1 >> 16) & 0xFF;

  const vp8xChunk = buildChunk('VP8X', vp8xData);
  const exifChunk = buildChunk('EXIF', exifBytes);

  // Original pixel data starts at offset 12 (after RIFF header)
  const pixelData = webpBytes.subarray(12);

  // Assemble: RIFF header(12) + VP8X + original chunks + EXIF at end
  const totalLength = 12 + vp8xChunk.length + pixelData.length + exifChunk.length;
  const result = new Uint8Array(totalLength);
  result.set(webpBytes.subarray(0, 12), 0); // RIFF + size + WEBP
  result.set(vp8xChunk, 12);
  result.set(pixelData, 12 + vp8xChunk.length);
  result.set(exifChunk, 12 + vp8xChunk.length + pixelData.length);

  // Update RIFF file size (offset 4)
  new DataView(result.buffer).setUint32(4, result.length - 8, true);

  return result;
}

/**
 * Strip existing EXIF chunk from an extended WebP (if present).
 */
function stripExifChunk(webpBytes: Uint8Array): Uint8Array {
  const view = new DataView(webpBytes.buffer, webpBytes.byteOffset, webpBytes.byteLength);
  const vp8xDataSize = view.getUint32(16, true);
  const vp8xChunkTotalSize = 8 + vp8xDataSize + (vp8xDataSize % 2 ? 1 : 0);
  const afterVp8x = 12 + vp8xChunkTotalSize;

  let pos = afterVp8x;
  while (pos + 8 <= webpBytes.length) {
    const chunkFourCC = getFourCC(webpBytes, pos);
    const chunkDataSize = view.getUint32(pos + 4, true);
    const chunkTotalSize = 8 + chunkDataSize + (chunkDataSize % 2 ? 1 : 0);

    if (chunkFourCC === 'EXIF') {
      // Remove this chunk
      const result = new Uint8Array(webpBytes.length - chunkTotalSize);
      result.set(webpBytes.subarray(0, pos), 0);
      result.set(webpBytes.subarray(pos + chunkTotalSize), pos);
      // Update RIFF size
      new DataView(result.buffer).setUint32(4, result.length - 8, true);
      return result;
    }

    pos += chunkTotalSize;
  }

  return webpBytes;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════════════════════════════════

/** Validate that bytes start with RIFF...WEBP signature. */
function isRiffWebP(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  return (
    getFourCC(bytes, 0) === 'RIFF' &&
    getFourCC(bytes, 8) === 'WEBP'
  );
}

/** Read a 4-byte ASCII string (FourCC) at the given offset. */
function getFourCC(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3],
  );
}

/** Read a 4-byte little-endian unsigned integer. */
function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

/**
 * Build a RIFF chunk: FourCC(4) + Size(4 LE) + Data + [Padding].
 * Chunks are padded to 2-byte alignment per RIFF spec.
 */
function buildChunk(fourcc: string, data: Uint8Array): Uint8Array {
  const padded = data.length % 2 === 1;
  const chunk = new Uint8Array(8 + data.length + (padded ? 1 : 0));
  for (let i = 0; i < 4; i++) chunk[i] = fourcc.charCodeAt(i);
  new DataView(chunk.buffer).setUint32(4, data.length, true);
  chunk.set(data, 8);
  return chunk;
}

/**
 * Parse image dimensions from VP8 or VP8L bitstream header.
 */
function parseWebPDimensions(bytes: Uint8Array, chunkOffset: number): { width: number; height: number } {
  const fourcc = getFourCC(bytes, chunkOffset);
  const dataOffset = chunkOffset + 8;

  if (fourcc === 'VP8 ') {
    const w = (bytes[dataOffset + 6] | (bytes[dataOffset + 7] << 8)) & 0x3FFF;
    const h = (bytes[dataOffset + 8] | (bytes[dataOffset + 9] << 8)) & 0x3FFF;
    return { width: w, height: h };
  } else if (fourcc === 'VP8L') {
    const b1 = bytes[dataOffset + 1];
    const b2 = bytes[dataOffset + 2];
    const b3 = bytes[dataOffset + 3];
    const b4 = bytes[dataOffset + 4];
    const bits = b1 | (b2 << 8) | (b3 << 16) | (b4 << 24);
    const width = (bits & 0x3FFF) + 1;
    const height = ((bits >> 14) & 0x3FFF) + 1;
    return { width, height };
  }

  throw new Error(`Cannot parse dimensions from chunk type: ${fourcc}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test Helpers (exported for unit tests)
// ═══════════════════════════════════════════════════════════════════════════════

/** @internal — exported for testing only */
export const _testHelpers = {
  isRiffWebP,
  getFourCC,
  buildChunk,
  parseWebPDimensions,
};
