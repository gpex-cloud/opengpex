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
 * BMP Format Handler.
 *
 * Responsibilities:
 * - Decode: browser-native, read DPI from DIB header
 * - Encode: pure JS BMP encoder with DPI injection
 * - Metadata: DIB header parsing (lightweight)
 *
 * Thread model: ALL operations run on main thread.
 */

import type {
  ImageFormatHandler,
  ImageMetadata,
  DecodeOptions,
  DecodeResult,
  EncodeOptions,
} from '../types';
import { bitmapToCanvas } from '../index';

export class BmpHandler implements ImageFormatHandler {
  readonly format = 'bmp';
  readonly mimeTypes = ['image/bmp', 'image/x-ms-bmp'];
  readonly extensions = ['bmp'];

  // ─── Decode ──────────────────────────────────────────────────────────────

  async decode(file: File, _options?: DecodeOptions): Promise<DecodeResult> {
    // BMP is browser-native — no transcoding needed
    const img = await createImageBitmap(file);
    const dimensions = { w: img.width, h: img.height };
    img.close();

    const metadata = await this.extractMetadata(file);

    return { dimensions, metadata, subImages: [{ displayBlob: file, width: dimensions.w, height: dimensions.h, index: 0 }] };
  }

  // ─── Encode ──────────────────────────────────────────────────────────────

  async encode(
    source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
    options: EncodeOptions,
  ): Promise<Blob> {
    const canvas = source instanceof ImageBitmap ? bitmapToCanvas(source) : source;
    const ctx = (canvas as OffscreenCanvas).getContext('2d')!;
    const w = (canvas as OffscreenCanvas).width;
    const h = (canvas as OffscreenCanvas).height;
    const imageData = ctx.getImageData(0, 0, w, h);
    const pixels = imageData.data;

    const dpi = options.exportConfig?.dpi || options.metadata?.dpi || 72;
    const ppm = Math.round(dpi / 0.0254); // DPI → pixels per meter

    // Build 24-bit BMP (no alpha — BMP viewers handle 24-bit better)
    const rowSize = Math.ceil((w * 3) / 4) * 4; // Rows padded to 4-byte boundary
    const pixelDataSize = rowSize * h;
    const fileSize = 54 + pixelDataSize; // 14 (file header) + 40 (DIB header) + pixels

    const buffer = new ArrayBuffer(fileSize);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    // ─── BMP File Header (14 bytes) ───
    bytes[0] = 0x42; bytes[1] = 0x4D; // "BM" signature
    view.setUint32(2, fileSize, true);  // File size
    view.setUint32(6, 0, true);         // Reserved
    view.setUint32(10, 54, true);       // Pixel data offset

    // ─── DIB Header (BITMAPINFOHEADER, 40 bytes) ───
    view.setUint32(14, 40, true);       // DIB header size
    view.setInt32(18, w, true);         // Width
    view.setInt32(22, -h, true);        // Height (negative = top-down)
    view.setUint16(26, 1, true);        // Color planes
    view.setUint16(28, 24, true);       // Bits per pixel
    view.setUint32(30, 0, true);        // Compression (0 = BI_RGB)
    view.setUint32(34, pixelDataSize, true); // Image size
    view.setInt32(38, ppm, true);       // X pixels per meter (DPI injection)
    view.setInt32(42, ppm, true);       // Y pixels per meter (DPI injection)
    view.setUint32(46, 0, true);        // Colors in palette
    view.setUint32(50, 0, true);        // Important colors

    // ─── Pixel Data (BGR, top-down due to negative height) ───
    let offset = 54;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const srcIdx = (y * w + x) * 4;
        bytes[offset++] = pixels[srcIdx + 2]; // B
        bytes[offset++] = pixels[srcIdx + 1]; // G
        bytes[offset++] = pixels[srcIdx + 0]; // R
      }
      // Pad row to 4-byte boundary
      const padding = rowSize - (w * 3);
      for (let p = 0; p < padding; p++) {
        bytes[offset++] = 0;
      }
    }

    return new Blob([buffer], { type: 'image/bmp' });
  }

  // ─── Metadata Extraction ─────────────────────────────────────────────────

  async extractMetadata(file: File): Promise<ImageMetadata> {
    const base: ImageMetadata = {
      version: 1,
      sourceFormat: 'bmp',
      sourceFileName: file.name,
      sourceFileSize: file.size,
      dpi: 72,
      dpiSource: 'default',
      colorSpace: 'srgb',
      bitDepth: 24,
      hasAlpha: false,
      hasIccProfile: false,
    };

    try {
      // Read first 54 bytes (BMP file header + DIB header)
      const headerSlice = file.slice(0, 54);
      const buffer = await headerSlice.arrayBuffer();
      const view = new DataView(buffer);

      // Verify BMP signature
      if (view.getUint8(0) !== 0x42 || view.getUint8(1) !== 0x4D) return base;

      // DIB header size (at offset 14)
      const dibSize = view.getUint32(14, true);
      if (dibSize < 40) return base; // Only BITMAPINFOHEADER (40+) has DPI

      // Bits per pixel (at offset 28)
      base.bitDepth = view.getUint16(28, true);
      base.hasAlpha = base.bitDepth === 32;

      // X resolution in pixels per meter (at offset 38)
      const ppmX = view.getInt32(38, true);
      if (ppmX > 0) {
        const dpi = Math.round(ppmX * 0.0254);
        if (dpi > 1 && dpi < 10000) {
          base.dpi = dpi;
          base.dpiSource = 'bmp-header';
        }
      }
    } catch (err) {
      console.debug('[BmpHandler] Header parsing failed:', (err as Error).message);
    }

    return base;
  }
}
