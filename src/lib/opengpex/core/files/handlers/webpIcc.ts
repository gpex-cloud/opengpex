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
 * WebP RIFF ICC Profile Injection Utility.
 *
 * Injects ICC Profile data into a WebP file by manipulating its RIFF container.
 * This enables custom ICC Profile embedding for WebP export, which is not
 * possible through the standard canvas.convertToBlob() API.
 *
 * Handles two cases:
 *   1. Simple WebP (VP8/VP8L at offset 12) → upgrade to extended format (VP8X) + insert ICCP chunk
 *   2. Extended WebP (VP8X at offset 12) → insert ICCP chunk + update VP8X flags
 *
 * Pure byte-level operations, no external dependencies.
 *
 * @module core/files/utils/webpIcc
 * @see docs/opengpex/plans/20260803_webp_riff_icc_injection.md
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Inject ICC Profile into a WebP file via RIFF chunk manipulation.
 *
 * @param webpBytes    - Original WebP file bytes (from canvas.convertToBlob)
 * @param iccProfile   - ICC Profile binary data to embed
 * @returns New WebP file bytes with ICC Profile injected
 * @throws Error if input is not a valid WebP file
 */
export function injectWebPIcc(webpBytes: Uint8Array, iccProfile: Uint8Array): Uint8Array {
  if (!isRiffWebP(webpBytes)) {
    throw new Error('Not a valid WebP file');
  }

  // Detect format: simple (VP8/VP8L at offset 12) or extended (VP8X at offset 12)
  const firstChunkFourCC = getFourCC(webpBytes, 12);
  const isExtended = firstChunkFourCC === 'VP8X';

  if (isExtended) {
    return injectIntoExtended(webpBytes, iccProfile);
  } else {
    return upgradeToExtended(webpBytes, iccProfile);
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
export function stripWebPIcc(webpBytes: Uint8Array): Uint8Array {
  if (!isRiffWebP(webpBytes)) {
    throw new Error('Not a valid WebP file');
  }

  // Only extended format (VP8X) can have ICCP chunks
  const firstChunkFourCC = getFourCC(webpBytes, 12);
  if (firstChunkFourCC !== 'VP8X') {
    // Simple format — no ICCP possible, return as-is
    return webpBytes;
  }

  // Scan chunks to find and remove ICCP
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
// Internal Implementation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Inject ICCP chunk into an existing extended (VP8X) WebP.
 * Sets the ICC flag in VP8X and inserts the ICCP chunk right after VP8X.
 */
function injectIntoExtended(webpBytes: Uint8Array, iccProfile: Uint8Array): Uint8Array {
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
function upgradeToExtended(webpBytes: Uint8Array, iccProfile: Uint8Array): Uint8Array {
  // Parse image dimensions from VP8/VP8L header
  const { width, height } = parseWebPDimensions(webpBytes, 12);

  // Build VP8X chunk (10 bytes of data)
  const vp8xData = new Uint8Array(10);
  // Byte 0: flags — bit 5 = ICC present (0x20)
  vp8xData[0] = 0x20;
  // Bytes 1-3: reserved (0)
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

// ═══════════════════════════════════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate that bytes start with RIFF...WEBP signature.
 */
function isRiffWebP(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  return (
    getFourCC(bytes, 0) === 'RIFF' &&
    getFourCC(bytes, 8) === 'WEBP'
  );
}

/**
 * Read a 4-byte ASCII string (FourCC) at the given offset.
 */
function getFourCC(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3],
  );
}

/**
 * Build a RIFF chunk: FourCC(4) + Size(4 LE) + Data + [Padding].
 * Chunks are padded to 2-byte alignment per RIFF spec.
 */
function buildChunk(fourcc: string, data: Uint8Array): Uint8Array {
  const padded = data.length % 2 === 1;
  const chunk = new Uint8Array(8 + data.length + (padded ? 1 : 0));
  // FourCC
  for (let i = 0; i < 4; i++) chunk[i] = fourcc.charCodeAt(i);
  // Size (LE uint32) — size of data only, not including padding
  new DataView(chunk.buffer).setUint32(4, data.length, true);
  // Data
  chunk.set(data, 8);
  // Padding byte (already 0 from Uint8Array initialization)
  return chunk;
}

/**
 * Parse image dimensions from VP8 or VP8L bitstream header.
 *
 * VP8 (lossy) keyframe:
 *   3 bytes frame tag + 3 bytes start code (9D 01 2A) + 2 bytes width + 2 bytes height
 *
 * VP8L (lossless):
 *   1 byte signature (0x2F) + 4 bytes with width-1 (14 bits) and height-1 (14 bits)
 *
 * @param bytes - Full WebP file bytes
 * @param chunkOffset - Offset where the VP8/VP8L chunk starts (its FourCC position)
 */
function parseWebPDimensions(bytes: Uint8Array, chunkOffset: number): { width: number; height: number } {
  const fourcc = getFourCC(bytes, chunkOffset);
  const dataOffset = chunkOffset + 8; // skip FourCC(4) + Size(4)

  if (fourcc === 'VP8 ') {
    // VP8 lossy keyframe
    // Frame tag: 3 bytes, then start code: 0x9D 0x01 0x2A
    // Width at offset 6 (from data start), Height at offset 8
    const w = (bytes[dataOffset + 6] | (bytes[dataOffset + 7] << 8)) & 0x3FFF;
    const h = (bytes[dataOffset + 8] | (bytes[dataOffset + 9] << 8)) & 0x3FFF;
    return { width: w, height: h };
  } else if (fourcc === 'VP8L') {
    // VP8L lossless
    // Byte 0: signature 0x2F
    // Bytes 1-4: packed bits — width-1 (14 bits) then height-1 (14 bits)
    const b1 = bytes[dataOffset + 1];
    const b2 = bytes[dataOffset + 2];
    const b3 = bytes[dataOffset + 3];
    const b4 = bytes[dataOffset + 4];
    const bits = b1 | (b2 << 8) | (b3 << 16) | (b4 << 24);
    const width = (bits & 0x3FFF) + 1;
    const height = ((bits >> 14) & 0x3FFF) + 1;
    return { width, height };
  }

  // Fallback: should not happen for valid WebP
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
