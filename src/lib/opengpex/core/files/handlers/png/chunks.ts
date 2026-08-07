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
 * PNG chunk-level primitives.
 *
 * Provides:
 * - PNG signature verification
 * - Generator-based chunk iteration (lazy, no IDAT decompression)
 * - Chunk building (length + type + data + CRC)
 * - CRC32 computation (PNG standard polynomial)
 * - Uint8Array concatenation utility
 */

// PNG magic bytes
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/** A single PNG chunk (parsed from file bytes) */
export interface PngChunk {
  /** 4-character chunk type (e.g. 'IHDR', 'pHYs', 'iCCP') */
  type: string;
  /** Chunk payload (excludes length/type/CRC) */
  data: Uint8Array;
  /** Byte offset of this chunk in the file */
  offset: number;
  /** Total chunk size in bytes (12 + data.length) */
  totalSize: number;
}

/** Verify PNG 8-byte signature */
export function verifySignature(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

/**
 * Iterate all PNG chunks using a generator (lazy evaluation).
 * Yields each chunk without decompressing IDAT data.
 * Assumes signature has already been verified.
 */
export function* iterateChunks(bytes: Uint8Array): Generator<PngChunk> {
  let offset = 8; // Skip 8-byte signature
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  while (offset + 8 <= bytes.length) {
    const chunkLength = view.getUint32(offset, false);
    const type = String.fromCharCode(
      bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7],
    );
    const dataStart = offset + 8;
    const totalSize = 12 + chunkLength; // 4(length) + 4(type) + data + 4(CRC)

    if (dataStart + chunkLength > bytes.length) break; // Truncated

    const data = bytes.subarray(dataStart, dataStart + chunkLength);

    yield { type, data, offset, totalSize };

    offset += totalSize;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CRC32
// ═══════════════════════════════════════════════════════════════════════════════

/** CRC32 lookup table (PNG standard polynomial 0xEDB88320) */
const CRC_TABLE = /* @__PURE__ */ (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
})();

/** Compute CRC32 over a Uint8Array */
export function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Chunk Builder
// ═══════════════════════════════════════════════════════════════════════════════

/** Build a complete PNG chunk: 4(length) + 4(type) + data + 4(CRC) */
export function buildChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);

  // Length
  view.setUint32(0, data.length, false);
  // Type
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  // Data
  chunk.set(data, 8);
  // CRC (over type + data)
  const crcData = chunk.subarray(4, 8 + data.length);
  view.setUint32(8 + data.length, crc32(crcData), false);

  return chunk;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Utility
// ═══════════════════════════════════════════════════════════════════════════════

/** Concatenate multiple Uint8Arrays into one */
export function concat(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
