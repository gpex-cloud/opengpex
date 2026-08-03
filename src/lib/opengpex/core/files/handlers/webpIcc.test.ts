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

import { describe, it, expect } from 'vitest';
import { injectWebPIcc, stripWebPIcc, _testHelpers } from './webpIcc';

const { buildChunk, getFourCC } = _testHelpers;

// ═══════════════════════════════════════════════════════════════════════════════
// Test Fixtures — Minimal WebP file generators
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a minimal VP8 (lossy) simple-format WebP.
 * Structure: RIFF + size + WEBP + VP8 chunk with keyframe header containing dimensions.
 */
function createMinimalVP8WebP(width: number, height: number): Uint8Array {
  // VP8 keyframe header: 3 bytes frame tag + 3 bytes start code (9D 01 2A) + 2B width + 2B height + fake data
  const frameTag = new Uint8Array([0x9D, 0x01, 0x2A]); // simplified: first 3 bytes not critical for our parser
  const startCode = new Uint8Array([0x9D, 0x01, 0x2A]);
  const wBytes = new Uint8Array([width & 0xFF, (width >> 8) & 0x3F]);
  const hBytes = new Uint8Array([height & 0xFF, (height >> 8) & 0x3F]);
  const fakePixels = new Uint8Array(20); // some fake pixel data

  // VP8 data: frameTag(3) + startCode(3) + width(2) + height(2) + pixels
  const vp8Data = new Uint8Array(3 + 3 + 2 + 2 + fakePixels.length);
  vp8Data.set(frameTag, 0);
  vp8Data.set(startCode, 3);
  vp8Data.set(wBytes, 6);
  vp8Data.set(hBytes, 8);
  vp8Data.set(fakePixels, 10);

  const vp8Chunk = buildChunk('VP8 ', vp8Data);

  // RIFF header: "RIFF" + fileSize(4 LE) + "WEBP"
  const fileSize = 4 + vp8Chunk.length; // "WEBP"(4) + chunks
  const result = new Uint8Array(12 + vp8Chunk.length);
  // "RIFF"
  result[0] = 0x52; result[1] = 0x49; result[2] = 0x46; result[3] = 0x46;
  // File size (LE)
  new DataView(result.buffer).setUint32(4, fileSize, true);
  // "WEBP"
  result[8] = 0x57; result[9] = 0x45; result[10] = 0x42; result[11] = 0x50;
  // VP8 chunk
  result.set(vp8Chunk, 12);

  return result;
}

/**
 * Create a minimal VP8L (lossless) simple-format WebP.
 */
function createMinimalVP8LWebP(width: number, height: number): Uint8Array {
  // VP8L data: signature(1) + packed dimensions(4) + fake data
  const w1 = width - 1;
  const h1 = height - 1;
  const bits = (w1 & 0x3FFF) | ((h1 & 0x3FFF) << 14);
  const vp8lData = new Uint8Array(5 + 10); // signature + packed + fake
  vp8lData[0] = 0x2F; // signature
  vp8lData[1] = bits & 0xFF;
  vp8lData[2] = (bits >> 8) & 0xFF;
  vp8lData[3] = (bits >> 16) & 0xFF;
  vp8lData[4] = (bits >> 24) & 0xFF;

  const vp8lChunk = buildChunk('VP8L', vp8lData);

  const fileSize = 4 + vp8lChunk.length;
  const result = new Uint8Array(12 + vp8lChunk.length);
  result[0] = 0x52; result[1] = 0x49; result[2] = 0x46; result[3] = 0x46;
  new DataView(result.buffer).setUint32(4, fileSize, true);
  result[8] = 0x57; result[9] = 0x45; result[10] = 0x42; result[11] = 0x50;
  result.set(vp8lChunk, 12);

  return result;
}

/**
 * Create a minimal extended (VP8X) WebP without ICC.
 */
function createExtendedWebP(width: number, height: number): Uint8Array {
  // VP8X data: flags(1) + reserved(3) + width-1(3 LE) + height-1(3 LE) = 10 bytes
  const vp8xData = new Uint8Array(10);
  vp8xData[0] = 0x00; // no flags set
  const w1 = width - 1;
  const h1 = height - 1;
  vp8xData[4] = w1 & 0xFF;
  vp8xData[5] = (w1 >> 8) & 0xFF;
  vp8xData[6] = (w1 >> 16) & 0xFF;
  vp8xData[7] = h1 & 0xFF;
  vp8xData[8] = (h1 >> 8) & 0xFF;
  vp8xData[9] = (h1 >> 16) & 0xFF;

  const vp8xChunk = buildChunk('VP8X', vp8xData);

  // Add a fake VP8 chunk after VP8X
  const fakeVp8Data = new Uint8Array(30);
  const vp8Chunk = buildChunk('VP8 ', fakeVp8Data);

  const fileSize = 4 + vp8xChunk.length + vp8Chunk.length;
  const result = new Uint8Array(12 + vp8xChunk.length + vp8Chunk.length);
  result[0] = 0x52; result[1] = 0x49; result[2] = 0x46; result[3] = 0x46;
  new DataView(result.buffer).setUint32(4, fileSize, true);
  result[8] = 0x57; result[9] = 0x45; result[10] = 0x42; result[11] = 0x50;
  result.set(vp8xChunk, 12);
  result.set(vp8Chunk, 12 + vp8xChunk.length);

  return result;
}

/** Create a fake ICC profile (just random bytes with proper header-ish structure). */
function createFakeIcc(size: number = 3144): Uint8Array {
  const icc = new Uint8Array(size);
  // Minimal ICC: put size at offset 0 (big-endian)
  new DataView(icc.buffer).setUint32(0, size, false);
  // Tag 'acsp' at offset 36 (ICC signature)
  icc[36] = 0x61; icc[37] = 0x63; icc[38] = 0x73; icc[39] = 0x70;
  return icc;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Chunk scanning helpers for assertions
// ═══════════════════════════════════════════════════════════════════════════════

function findChunkOffset(bytes: Uint8Array, targetFourCC: string): number {
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const fourcc = getFourCC(bytes, pos);
    if (fourcc === targetFourCC) return pos;
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(pos + 4, true);
    pos += 8 + size + (size % 2 ? 1 : 0);
  }
  return -1;
}

function hasChunk(bytes: Uint8Array, fourcc: string): boolean {
  return findChunkOffset(bytes, fourcc) >= 0;
}

function getChunkData(bytes: Uint8Array, fourcc: string): Uint8Array | null {
  const offset = findChunkOffset(bytes, fourcc);
  if (offset < 0) return null;
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset + 4, true);
  return bytes.slice(offset + 8, offset + 8 + size);
}

function getVP8XFlags(bytes: Uint8Array): number {
  const offset = findChunkOffset(bytes, 'VP8X');
  if (offset < 0) return 0;
  return bytes[offset + 8]; // flags byte is first byte of VP8X data
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('injectWebPIcc', () => {
  it('injects ICCP chunk into simple VP8 WebP (upgrades to extended)', () => {
    const simpleWebP = createMinimalVP8WebP(100, 100);
    const icc = createFakeIcc();
    const result = injectWebPIcc(simpleWebP, icc);

    expect(hasChunk(result, 'VP8X')).toBe(true);
    expect(hasChunk(result, 'ICCP')).toBe(true);
    expect(getVP8XFlags(result) & 0x20).toBe(0x20); // ICC flag set
    expect(getChunkData(result, 'ICCP')).toEqual(icc);
  });

  it('injects ICCP chunk into simple VP8L WebP', () => {
    const simpleWebP = createMinimalVP8LWebP(200, 150);
    const icc = createFakeIcc(2000);
    const result = injectWebPIcc(simpleWebP, icc);

    expect(hasChunk(result, 'VP8X')).toBe(true);
    expect(hasChunk(result, 'ICCP')).toBe(true);
    expect(hasChunk(result, 'VP8L')).toBe(true);
    expect(getChunkData(result, 'ICCP')).toEqual(icc);

    // VP8X dimensions should be correct
    const vp8xOffset = findChunkOffset(result, 'VP8X');
    const vp8xData = result.slice(vp8xOffset + 8, vp8xOffset + 8 + 10);
    const w1 = vp8xData[4] | (vp8xData[5] << 8) | (vp8xData[6] << 16);
    const h1 = vp8xData[7] | (vp8xData[8] << 8) | (vp8xData[9] << 16);
    expect(w1 + 1).toBe(200);
    expect(h1 + 1).toBe(150);
  });

  it('injects ICCP chunk into extended VP8X WebP', () => {
    const extWebP = createExtendedWebP(200, 150);
    const icc = createFakeIcc(4096);
    const result = injectWebPIcc(extWebP, icc);

    expect(getChunkData(result, 'ICCP')).toEqual(icc);
    expect(hasChunk(result, 'VP8X')).toBe(true);
    expect(getVP8XFlags(result) & 0x20).toBe(0x20); // ICC flag set
  });

  it('updates RIFF file size correctly for simple WebP', () => {
    const webp = createMinimalVP8WebP(50, 50);
    const icc = createFakeIcc(3144);
    const result = injectWebPIcc(webp, icc);

    const riffSize = new DataView(result.buffer).getUint32(4, true);
    expect(riffSize).toBe(result.length - 8);
  });

  it('updates RIFF file size correctly for extended WebP', () => {
    const webp = createExtendedWebP(300, 200);
    const icc = createFakeIcc(2048);
    const result = injectWebPIcc(webp, icc);

    const riffSize = new DataView(result.buffer).getUint32(4, true);
    expect(riffSize).toBe(result.length - 8);
  });

  it('handles odd-sized ICC profiles with padding', () => {
    const webp = createMinimalVP8WebP(10, 10);
    const icc = createFakeIcc(3145); // odd size
    const result = injectWebPIcc(webp, icc);

    // ICCP chunk should have the correct size field
    const iccpOffset = findChunkOffset(result, 'ICCP');
    expect(iccpOffset).toBeGreaterThan(0);
    const iccpSize = new DataView(result.buffer).getUint32(iccpOffset + 4, true);
    expect(iccpSize).toBe(3145); // size field = actual data size (unpadded)

    // The ICCP chunk data should match original ICC
    const iccpData = getChunkData(result, 'ICCP')!;
    expect(iccpData).toEqual(icc);

    // RIFF file size should still be consistent
    const riffSize = new DataView(result.buffer).getUint32(4, true);
    expect(riffSize).toBe(result.length - 8);
  });

  it('throws for non-WebP input', () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(() => injectWebPIcc(png, createFakeIcc())).toThrow('Not a valid WebP file');
  });

  it('throws for empty input', () => {
    expect(() => injectWebPIcc(new Uint8Array(0), createFakeIcc())).toThrow('Not a valid WebP file');
  });

  it('throws for too-short input', () => {
    const short = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00]);
    expect(() => injectWebPIcc(short, createFakeIcc())).toThrow('Not a valid WebP file');
  });

  it('preserves existing VP8X flags when injecting into extended', () => {
    const extWebP = createExtendedWebP(100, 100);
    // Set EXIF flag (bit 3 = 0x08) manually
    extWebP[20] = 0x08; // VP8X flags byte
    const icc = createFakeIcc();
    const result = injectWebPIcc(extWebP, icc);

    const flags = getVP8XFlags(result);
    expect(flags & 0x08).toBe(0x08); // EXIF flag preserved
    expect(flags & 0x20).toBe(0x20); // ICC flag added
  });

  it('preserves original VP8 pixel data after injection', () => {
    const webp = createMinimalVP8WebP(64, 64);
    const icc = createFakeIcc(100);
    const result = injectWebPIcc(webp, icc);

    // VP8 chunk should still exist with same data
    expect(hasChunk(result, 'VP8 ')).toBe(true);
    const originalVp8Data = getChunkData(webp, 'VP8 ');
    const resultVp8Data = getChunkData(result, 'VP8 ');
    expect(resultVp8Data).toEqual(originalVp8Data);
  });
});

describe('stripWebPIcc', () => {
  it('removes ICCP chunk from extended WebP with ICC', () => {
    // First inject ICC, then strip it
    const webp = createExtendedWebP(100, 100);
    const icc = createFakeIcc(2048);
    const withIcc = injectWebPIcc(webp, icc);
    expect(hasChunk(withIcc, 'ICCP')).toBe(true);

    const stripped = stripWebPIcc(withIcc);
    expect(hasChunk(stripped, 'ICCP')).toBe(false);
    expect(getVP8XFlags(stripped) & 0x20).toBe(0); // ICC flag cleared
  });

  it('updates RIFF file size after stripping', () => {
    const webp = createMinimalVP8WebP(50, 50);
    const icc = createFakeIcc(3144);
    const withIcc = injectWebPIcc(webp, icc);
    const stripped = stripWebPIcc(withIcc);

    const riffSize = new DataView(stripped.buffer).getUint32(4, true);
    expect(riffSize).toBe(stripped.length - 8);
  });

  it('returns as-is for simple format WebP (no VP8X)', () => {
    const webp = createMinimalVP8WebP(100, 100);
    const result = stripWebPIcc(webp);
    expect(result).toBe(webp); // same reference — no change needed
  });

  it('returns as-is for extended WebP without ICCP', () => {
    const webp = createExtendedWebP(100, 100);
    const result = stripWebPIcc(webp);
    expect(result).toBe(webp); // same reference — no ICCP to strip
  });

  it('preserves other chunks when stripping ICCP', () => {
    const webp = createExtendedWebP(100, 100);
    const icc = createFakeIcc(1000);
    const withIcc = injectWebPIcc(webp, icc);

    // Should still have VP8X and VP8 chunks
    const stripped = stripWebPIcc(withIcc);
    expect(hasChunk(stripped, 'VP8X')).toBe(true);
    expect(hasChunk(stripped, 'VP8 ')).toBe(true);
  });

  it('preserves other VP8X flags when clearing ICC flag', () => {
    const webp = createExtendedWebP(100, 100);
    webp[20] = 0x08; // Set EXIF flag
    const icc = createFakeIcc();
    const withIcc = injectWebPIcc(webp, icc);
    expect(getVP8XFlags(withIcc) & 0x28).toBe(0x28); // Both EXIF + ICC

    const stripped = stripWebPIcc(withIcc);
    expect(getVP8XFlags(stripped) & 0x20).toBe(0); // ICC cleared
    expect(getVP8XFlags(stripped) & 0x08).toBe(0x08); // EXIF preserved
  });

  it('round-trips: inject then strip restores original pixel data', () => {
    const webp = createMinimalVP8WebP(64, 64);
    const originalVp8Data = getChunkData(webp, 'VP8 ');

    const withIcc = injectWebPIcc(webp, createFakeIcc());
    const stripped = stripWebPIcc(withIcc);

    const strippedVp8Data = getChunkData(stripped, 'VP8 ');
    expect(strippedVp8Data).toEqual(originalVp8Data);
  });
});
