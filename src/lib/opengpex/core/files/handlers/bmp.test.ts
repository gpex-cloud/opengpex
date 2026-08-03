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

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub browser globals not available in Node.js test environment
// @ts-expect-error — ImageBitmap is a browser-only global
globalThis.ImageBitmap = class ImageBitmap {};

import { BmpHandler } from './bmp';

// ═══════════════════════════════════════════════════════════════════════════════
// Mock Dependencies
// ═══════════════════════════════════════════════════════════════════════════════

// Mock convertImageDataColorSpace to track P3→sRGB calls
const mockConvertImageDataColorSpace = vi.fn();
vi.mock('@opengpex/editor/core/color/matrices', () => ({
  convertImageDataColorSpace: (...args: unknown[]) => mockConvertImageDataColorSpace(...args),
}));

// Mock ColorPipeline strategy functions
const mockGetExportStrategy = vi.fn();
const mockResolveExportPixelConversion = vi.fn();
vi.mock('@opengpex/editor/core/color/ColorPipeline', () => ({
  getExportStrategy: (...args: unknown[]) => mockGetExportStrategy(...args),
  resolveExportPixelConversion: (...args: unknown[]) => mockResolveExportPixelConversion(...args),
}));

// Mock bitmapToCanvas (not used directly in canvas-path tests but needed for import)
vi.mock('../index', () => ({
  bitmapToCanvas: (bitmap: unknown, _colorSpace?: string) => bitmap,
}));

// ═══════════════════════════════════════════════════════════════════════════════
// Test Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a fake OffscreenCanvas with controlled pixel data.
 */
function createFakeCanvas(w: number, h: number, pixelData: Uint8ClampedArray) {
  const imageData = { data: pixelData, width: w, height: h };
  const ctx = {
    getImageData: vi.fn().mockReturnValue(imageData),
  };
  return {
    width: w,
    height: h,
    getContext: vi.fn().mockReturnValue(ctx),
  } as unknown as OffscreenCanvas;
}

/**
 * Create RGBA pixel data for a solid color canvas.
 */
function createSolidPixels(w: number, h: number, r: number, g: number, b: number, a = 255): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4 + 0] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  }
  return data;
}

/**
 * Parse BMP blob and return header fields.
 */
async function parseBmpHeader(blob: Blob) {
  const buffer = await blob.arrayBuffer();
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  return {
    signature: String.fromCharCode(bytes[0], bytes[1]),
    fileSize: view.getUint32(2, true),
    pixelDataOffset: view.getUint32(10, true),
    dibHeaderSize: view.getUint32(14, true),
    width: view.getInt32(18, true),
    height: view.getInt32(22, true),
    colorPlanes: view.getUint16(26, true),
    bitsPerPixel: view.getUint16(28, true),
    compression: view.getUint32(30, true),
    imageSize: view.getUint32(34, true),
    xPpm: view.getInt32(38, true),
    yPpm: view.getInt32(42, true),
    bytes,
    buffer,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('BmpHandler.encode', () => {
  let handler: BmpHandler;

  beforeEach(() => {
    handler = new BmpHandler();
    vi.clearAllMocks();

    // Default mock: sRGB frame, no conversion needed
    mockGetExportStrategy.mockReturnValue({ encodeColorSpace: 'srgb', embedIccByDefault: false });
    mockResolveExportPixelConversion.mockReturnValue('none');
  });

  it('produces valid BMP (signature, header size, pixel data)', async () => {
    const w = 4, h = 3;
    const pixels = createSolidPixels(w, h, 255, 0, 0); // Red
    const canvas = createFakeCanvas(w, h, pixels);

    const blob = await handler.encode(canvas, { metadata: undefined, exportConfig: {} });
    const bmp = await parseBmpHeader(blob);

    expect(bmp.signature).toBe('BM');
    expect(bmp.pixelDataOffset).toBe(54);
    expect(bmp.dibHeaderSize).toBe(40);
    expect(bmp.width).toBe(4);
    expect(bmp.height).toBe(-3); // Negative = top-down
    expect(bmp.colorPlanes).toBe(1);
    expect(bmp.bitsPerPixel).toBe(24);
    expect(bmp.compression).toBe(0); // BI_RGB
    expect(blob.type).toBe('image/bmp');
  });

  it('injects DPI correctly into DIB header', async () => {
    const w = 2, h = 2;
    const pixels = createSolidPixels(w, h, 0, 0, 0);
    const canvas = createFakeCanvas(w, h, pixels);

    const dpi = 300;
    const expectedPpm = Math.round(dpi / 0.0254);

    const blob = await handler.encode(canvas, {
      metadata: undefined,
      exportConfig: { dpi },
    });
    const bmp = await parseBmpHeader(blob);

    expect(bmp.xPpm).toBe(expectedPpm);
    expect(bmp.yPpm).toBe(expectedPpm);
  });

  it('encodes sRGB frame without conversion (pixelConv=none)', async () => {
    mockGetExportStrategy.mockReturnValue({ encodeColorSpace: 'srgb', embedIccByDefault: false });
    mockResolveExportPixelConversion.mockReturnValue('none');

    const w = 2, h = 2;
    const pixels = createSolidPixels(w, h, 100, 150, 200);
    const canvas = createFakeCanvas(w, h, pixels);

    await handler.encode(canvas, {
      metadata: undefined,
      exportConfig: { frameColorSpace: 'srgb' },
    });

    // Should NOT call convertImageDataColorSpace
    expect(mockConvertImageDataColorSpace).not.toHaveBeenCalled();

    // Verify strategy was queried with correct args
    expect(mockGetExportStrategy).toHaveBeenCalledWith('srgb', 'bmp');
    expect(mockResolveExportPixelConversion).toHaveBeenCalledWith(
      'srgb',
      { colorSpace: undefined, hasIccProfileData: false },
      false,
      'bmp',
    );
  });

  it('converts P3 frame to sRGB before writing (pixelConv=p3-to-srgb)', async () => {
    mockGetExportStrategy.mockReturnValue({ encodeColorSpace: 'srgb', embedIccByDefault: false });
    mockResolveExportPixelConversion.mockReturnValue('p3-to-srgb');

    const w = 2, h = 2;
    const pixels = createSolidPixels(w, h, 200, 100, 50);
    const canvas = createFakeCanvas(w, h, pixels);

    await handler.encode(canvas, {
      metadata: { colorSpace: 'display-p3' } as any,
      exportConfig: { frameColorSpace: 'display-p3' },
    });

    // Should call convertImageDataColorSpace with p3→srgb
    expect(mockConvertImageDataColorSpace).toHaveBeenCalledTimes(1);
    expect(mockConvertImageDataColorSpace).toHaveBeenCalledWith(
      pixels, // The imageData.data reference
      'display-p3',
      'srgb',
    );

    // Verify strategy was queried with P3
    expect(mockGetExportStrategy).toHaveBeenCalledWith('display-p3', 'bmp');
  });

  it('handles 1×1 pixel (minimal case)', async () => {
    const w = 1, h = 1;
    const pixels = createSolidPixels(w, h, 128, 64, 32);
    const canvas = createFakeCanvas(w, h, pixels);

    const blob = await handler.encode(canvas, { metadata: undefined, exportConfig: {} });
    const bmp = await parseBmpHeader(blob);

    // 1 pixel = 3 bytes, row padded to 4 bytes
    const rowSize = 4; // ceil(1*3/4)*4 = 4
    const expectedFileSize = 54 + rowSize * 1;
    expect(bmp.fileSize).toBe(expectedFileSize);
    expect(blob.size).toBe(expectedFileSize);

    // Verify pixel data: BGR order
    expect(bmp.bytes[54]).toBe(32);  // B
    expect(bmp.bytes[55]).toBe(64);  // G
    expect(bmp.bytes[56]).toBe(128); // R
    expect(bmp.bytes[57]).toBe(0);   // Padding
  });

  it('pads rows to 4-byte boundary for odd widths', async () => {
    const w = 3, h = 1; // 3 pixels × 3 bytes = 9 bytes → padded to 12
    const pixels = createSolidPixels(w, h, 10, 20, 30);
    const canvas = createFakeCanvas(w, h, pixels);

    const blob = await handler.encode(canvas, { metadata: undefined, exportConfig: {} });
    const bmp = await parseBmpHeader(blob);

    const expectedRowSize = 12; // ceil(3*3/4)*4 = 12
    const expectedFileSize = 54 + expectedRowSize * 1;
    expect(bmp.fileSize).toBe(expectedFileSize);
    expect(bmp.imageSize).toBe(expectedRowSize * 1);

    // Verify padding bytes are zero
    // Row: B G R | B G R | B G R | pad pad pad
    const rowStart = 54;
    expect(bmp.bytes[rowStart + 9]).toBe(0);  // padding byte 1
    expect(bmp.bytes[rowStart + 10]).toBe(0); // padding byte 2
    expect(bmp.bytes[rowStart + 11]).toBe(0); // padding byte 3
  });

  it('discards alpha channel (32-bit source → 24-bit output)', async () => {
    const w = 2, h = 1;
    // Semi-transparent pixels
    const pixels = createSolidPixels(w, h, 255, 128, 0, 127);
    const canvas = createFakeCanvas(w, h, pixels);

    const blob = await handler.encode(canvas, { metadata: undefined, exportConfig: {} });
    const bmp = await parseBmpHeader(blob);

    // Output is always 24-bit regardless of source alpha
    expect(bmp.bitsPerPixel).toBe(24);

    // Verify pixel values (alpha discarded, RGB preserved in BGR order)
    expect(bmp.bytes[54]).toBe(0);   // B (first pixel)
    expect(bmp.bytes[55]).toBe(128); // G (first pixel)
    expect(bmp.bytes[56]).toBe(255); // R (first pixel)
  });

  it('uses metadata DPI fallback when exportConfig.dpi is not set', async () => {
    const w = 2, h = 2;
    const pixels = createSolidPixels(w, h, 0, 0, 0);
    const canvas = createFakeCanvas(w, h, pixels);

    const metaDpi = 150;
    const expectedPpm = Math.round(metaDpi / 0.0254);

    const blob = await handler.encode(canvas, {
      metadata: { dpi: metaDpi } as any,
      exportConfig: {},
    });
    const bmp = await parseBmpHeader(blob);

    expect(bmp.xPpm).toBe(expectedPpm);
    expect(bmp.yPpm).toBe(expectedPpm);
  });

  it('defaults to 72 DPI when no DPI info available', async () => {
    const w = 2, h = 2;
    const pixels = createSolidPixels(w, h, 0, 0, 0);
    const canvas = createFakeCanvas(w, h, pixels);

    const expectedPpm = Math.round(72 / 0.0254);

    const blob = await handler.encode(canvas, {
      metadata: undefined,
      exportConfig: {},
    });
    const bmp = await parseBmpHeader(blob);

    expect(bmp.xPpm).toBe(expectedPpm);
    expect(bmp.yPpm).toBe(expectedPpm);
  });

  it('file size matches header declaration for various dimensions', async () => {
    const testCases = [
      { w: 1, h: 1 },
      { w: 3, h: 2 },
      { w: 5, h: 4 },
      { w: 100, h: 100 },
      { w: 7, h: 1 }, // Odd width — tests padding
    ];

    for (const { w, h } of testCases) {
      const pixels = createSolidPixels(w, h, 0, 0, 0);
      const canvas = createFakeCanvas(w, h, pixels);

      const blob = await handler.encode(canvas, { metadata: undefined, exportConfig: {} });
      const bmp = await parseBmpHeader(blob);

      const rowSize = Math.ceil((w * 3) / 4) * 4;
      const expectedFileSize = 54 + rowSize * h;

      expect(bmp.fileSize).toBe(expectedFileSize);
      expect(blob.size).toBe(expectedFileSize);
      expect(bmp.imageSize).toBe(rowSize * h);
    }
  });
});
