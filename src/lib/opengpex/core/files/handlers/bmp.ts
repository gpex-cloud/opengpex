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

import type { GamutId } from '@opengpex/editor/core/types';
import type {
  ImageFormatHandler,
  DecodeOptions,
  DecodedPayload,
  EncodeOptions,
} from '../types';
import type { ImageMetadata } from '../types';
import type { IngestDecision } from '../strategy';
import { bitmapToCanvas } from '../index';
import { toCanvasColorSpace } from '@opengpex/editor/core/engine/color';

export class BmpHandler implements ImageFormatHandler {
  readonly format = 'bmp';
  readonly mimeTypes = ['image/bmp', 'image/x-ms-bmp'];
  readonly extensions = ['bmp'];

  // ─── Decode ──────────────────────────────────────────────────────────────

  // Direct-passthrough format (pure-producer contract): BMP is always browser-native
  // 8-bit sRGB, so there is no colour-strategy branching to do — `decision` carries no
  // fold for this format. Consumes the entry-supplied `metadata` (no internal re-extract)
  // and returns naked pixels; the entry mounts `colorIdentity` / `sourceBlob`.
  async decode(
    file: File,
    _metadata: ImageMetadata,
    _decision: IngestDecision,
    _options?: DecodeOptions,
  ): Promise<DecodedPayload[]> {
    // BMP is browser-native — no transcoding needed
    const img = await createImageBitmap(file);
    const dimensions = { w: img.width, h: img.height };
    img.close();

    return [{ displayBlob: file, width: dimensions.w, height: dimensions.h, index: 0 }];
  }

  // ─── Encode ──────────────────────────────────────────────────────────────

  async encode(
    source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
    options: EncodeOptions,
  ): Promise<Blob> {
    const meta = options.metadata;
    const config = options.exportConfig;

    // BMP is a fixed-sRGB container — `resolveEgestDecision`'s container clamp
    // (clamp gate 2) already forces the egest `targetGamut` to 'srgb' for this
    // format, and the terminal `unpremultiplyEncodeGamut` upstream has already
    // converted the pixels accordingly. This handler only tags the canvas to match
    // so the browser performs no implicit conversion — no in-handler P3→sRGB step.
    const pixelGamut: GamutId = (config?.targetGamut as GamutId | undefined) ?? 'srgb';
    const canvas = source instanceof ImageBitmap
      ? bitmapToCanvas(source, toCanvasColorSpace(pixelGamut))
      : source as OffscreenCanvas;
    const ctx = canvas.getContext('2d')!;
    const w = canvas.width;
    const h = canvas.height;
    const imageData = ctx.getImageData(0, 0, w, h);

    const pixels = imageData.data;
    const dpi = config?.dpi || meta?.dpi || 72;
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
    const meta: ImageMetadata = {
      sourceFormat: 'bmp',
      sourceFileName: file.name,
      sourceFileSize: file.size,
      width: 0,
      height: 0,
      dpi: 72,
      dpiSource: 'default',
      colorSpace: 'srgb',
      bitDepth: 24,
      hasAlpha: false,
      raw: {},
    };

    try {
      // Read up to BITMAPV5HEADER's span (14 + 124 bytes) so the V3+ alpha mask
      // field (absolute offset 66) is reachable when present; most BMPs only need
      // the first 54 bytes, this is just a safe upper bound.
      const headerSlice = file.slice(0, Math.min(file.size, 14 + 124));
      const buffer = await headerSlice.arrayBuffer();
      const view = new DataView(buffer);

      // Verify BMP signature
      if (view.getUint8(0) !== 0x42 || view.getUint8(1) !== 0x4D) return meta;

      // DIB header size (at offset 14)
      const dibSize = view.getUint32(14, true);
      if (dibSize < 40) return meta; // Only BITMAPINFOHEADER (40+) has DPI

      // Dimensions
      meta.width = Math.abs(view.getInt32(18, true));
      meta.height = Math.abs(view.getInt32(22, true));

      // Bits per pixel (at offset 28). Decode always goes through createImageBitmap,
      // which yields 8-bit RGBA regardless of source bpp — BMP has no real 16-bit-
      // per-channel format, so bitDepth is always 8.
      const bpp = view.getUint16(28, true);
      meta.bitDepth = 8;

      // Real alpha requires an explicit declaration: BI_RGB (compression=0) 32bpp is
      // the common "XRGB" case where the 4th byte is padding, not alpha. Only
      // BI_BITFIELDS(3)/BI_ALPHABITFIELDS(6) with a non-zero alpha mask (absolute
      // offset 66, present from BITMAPV3INFOHEADER/dibSize>=56 onward) means the
      // file actually carries alpha.
      meta.hasAlpha = false;
      if (bpp === 32) {
        const compression = view.getUint32(30, true);
        if ((compression === 3 || compression === 6) && dibSize >= 56 && buffer.byteLength >= 70) {
          const alphaMask = view.getUint32(66, true);
          meta.hasAlpha = alphaMask !== 0;
        }
      }

      // X resolution in pixels per meter (at offset 38)
      const ppmX = view.getInt32(38, true);
      if (ppmX > 0) {
        const dpi = Math.round(ppmX * 0.0254);
        if (dpi > 1 && dpi < 10000) {
          meta.dpi = dpi;
          meta.dpiSource = 'bmp-header';
        }
      }
    } catch {
      // Header parsing failed — non-critical
    }

    return meta;
  }
}
