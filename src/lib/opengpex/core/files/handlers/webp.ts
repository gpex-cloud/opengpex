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
 * WebP Format Handler.
 *
 * Responsibilities:
 * - Decode: browser-native (no transcoding needed), extract EXIF/ICC metadata
 * - Encode: canvas.convertToBlob with quality control
 * - Metadata: ExifReader parsing for EXIF + RIFF chunk parsing for ICC profile
 *
 * Note: exifr does NOT support WebP. We use ExifReader for EXIF and manual
 * RIFF container parsing for ICC profile extraction.
 *
 * Thread model: ALL operations run on main thread (<100ms for typical files).
 */

import ExifReader from 'exifreader';
import type { PixelService, WorkingColorSpace } from '@opengpex/editor/core/types';
import type {
  ImageFormatHandler,
  ImageMetadata,
  DecodeOptions,
  DecodeResult,
  EncodeOptions,
} from '../types';
import { bitmapToCanvas } from '../index';
import { convertImageDataColorSpace } from '@opengpex/editor/core/color/matrices';
import { iccToBase64, base64ToIcc, parseIccProfileName } from '../icc';
import { resolveColorSpaceForFormat, getImportStrategy, getExportStrategy, shouldRetainSourceBlob, resolveExportPixelConversion } from '@opengpex/editor/core/color/ColorPipeline';
import { injectWebPIcc, stripWebPIcc } from './webpIcc';

export class WebpHandler implements ImageFormatHandler {
  readonly format = 'webp';
  readonly mimeTypes = ['image/webp'];
  readonly extensions = ['webp'];

  constructor(private pixels: PixelService) {}

  // ─── Decode ──────────────────────────────────────────────────────────────

  async decode(file: File, _options?: DecodeOptions): Promise<DecodeResult> {
    const metadata = await this.extractMetadata(file);

    // ── Strategy-based color pipeline routing ──
    const detectedCS = resolveColorSpaceForFormat('webp', metadata.colorSpace);
    const strategy = getImportStrategy(detectedCS);

    let displayBlob: Blob = file;
    let dimensions: { w: number; h: number };

    switch (strategy.conversion) {
      case 'none': {
        // Zero conversion: browser-native decode is sufficient (sRGB, P3)
        const img = await createImageBitmap(file);
        dimensions = { w: img.width, h: img.height };
        img.close();
        console.debug('[ColorMgmt] WebP decode: %s conversion=none, detectedCS=%s, frameCS=%s',
          file.name, detectedCS, strategy.frameColorSpace);
        break;
      }

      case 'matrix': {
        // 3×3 matrix conversion (e.g. AdobeRGB→P3)
        const img = await createImageBitmap(file, { colorSpaceConversion: 'none' });
        const w = img.width;
        const h = img.height;
        dimensions = { w, h };

        const tmpCanvas = bitmapToCanvas(img);
        img.close();
        const tmpCtx = tmpCanvas.getContext('2d')!;
        const imageData = tmpCtx.getImageData(0, 0, w, h);

        convertImageDataColorSpace(imageData.data, detectedCS as WorkingColorSpace, strategy.frameColorSpace);

        const outCS: PredefinedColorSpace = strategy.frameColorSpace === 'display-p3' ? 'display-p3' : 'srgb';
        const outCanvas = new OffscreenCanvas(w, h);
        const outCtx = outCanvas.getContext('2d', { colorSpace: outCS })!;
        const outImageData = new ImageData(imageData.data, w, h, { colorSpace: outCS });
        outCtx.putImageData(outImageData, 0, 0);
        displayBlob = await outCanvas.convertToBlob({ type: 'image/png' });

        console.debug('[ColorMgmt] WebP decode: %s matrix %s→%s',
          file.name, detectedCS, strategy.frameColorSpace);
        break;
      }

      case 'icc-engine': {
        // Full ICC engine conversion (custom ICC profiles, unknown spaces)
        const bytes = new Uint8Array(await file.arrayBuffer());
        const { width, height, data, iccProfileData } = await this.pixels.fileIO.iccToSrgb(bytes);
        dimensions = { w: width, h: height };

        if (iccProfileData && iccProfileData.length > 0) {
          metadata.hasIccProfile = true;
          metadata.raw = metadata.raw || {};
          if (!metadata.raw.iccProfileData) {
            metadata.raw.iccProfileData = iccToBase64(iccProfileData);
            if (!metadata.raw.iccProfileName) {
              metadata.raw.iccProfileName = parseIccProfileName(iccProfileData) || 'Embedded';
            }
          }
        }

        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d')!;
        const clamped = new Uint8ClampedArray(data.length);
        clamped.set(data);
        ctx.putImageData(new ImageData(clamped, width, height), 0, 0);
        displayBlob = await canvas.convertToBlob({ type: 'image/png' });

        console.debug('[ColorMgmt] WebP decode: %s icc-engine %s→%s',
          file.name, detectedCS, strategy.frameColorSpace);
        break;
      }
    }

    // sourceBlob retention via centralized strategy
    const sourceBlob = shouldRetainSourceBlob('webp', metadata, strategy.frameColorSpace) ? file : undefined;

    return { dimensions, metadata, subImages: [{ displayBlob, width: dimensions.w, height: dimensions.h, index: 0 }], sourceBlob };
  }

  // ─── Encode ──────────────────────────────────────────────────────────────

  async encode(
    source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
    options: EncodeOptions,
  ): Promise<Blob> {
    const quality = options.quality ?? 0.80;
    const meta = options.metadata;
    const config = options.exportConfig;

    // ── Strategy-based export color pipeline ──
    // Use correct canvas colorSpace to avoid implicit P3→sRGB conversion.
    // Chrome 111+ can produce P3 WebP when given a display-p3 canvas.
    const frameCS: WorkingColorSpace = (config?.frameColorSpace as WorkingColorSpace) || 'srgb';
    const exportStrategy = getExportStrategy(frameCS, 'webp');
    const embedIcc = config?.embedIcc ?? false;

    // Centralized pixel conversion decision via resolveExportPixelConversion()
    const pixelConv = resolveExportPixelConversion(
      frameCS,
      { colorSpace: meta?.colorSpace, hasIccProfileData: !!meta?.raw?.iccProfileData },
      embedIcc,
      'webp',
    );

    let canvas: OffscreenCanvas;

    if (pixelConv === 'p3-to-srgb') {
      // Format fallback: P3 frame → sRGB (format doesn't support P3)
      const srcCanvas = source instanceof ImageBitmap ? bitmapToCanvas(source, 'display-p3') : source as OffscreenCanvas;
      const w = srcCanvas.width;
      const h = srcCanvas.height;
      const tmpCanvas = new OffscreenCanvas(w, h);
      const tmpCtx = tmpCanvas.getContext('2d', { colorSpace: 'display-p3' })!;
      tmpCtx.drawImage(srcCanvas, 0, 0);
      const imageData = tmpCtx.getImageData(0, 0, w, h);
      convertImageDataColorSpace(imageData.data, 'display-p3', 'srgb');
      const outCanvas = new OffscreenCanvas(w, h);
      const outCtx = outCanvas.getContext('2d')!;
      outCtx.putImageData(new ImageData(imageData.data, w, h), 0, 0);
      canvas = outCanvas;
      console.debug('[ColorMgmt] WebP Export: pixelConversion=p3-to-srgb');
    } else if (pixelConv === 'srgb-to-icc') {
      // Pixels are sRGB, need to convert to target ICC space before embedding.
      // This is an atomic operation: srgbToIcc pixel conversion + RIFF ICC injection.
      const srcCanvas = source instanceof ImageBitmap ? bitmapToCanvas(source) : source as OffscreenCanvas;
      const w = srcCanvas.width;
      const h = srcCanvas.height;
      const tmpCanvas = new OffscreenCanvas(w, h);
      const tmpCtx = tmpCanvas.getContext('2d')!;
      tmpCtx.drawImage(srcCanvas, 0, 0);
      const imageData = tmpCtx.getImageData(0, 0, w, h);

      // Step 1: Convert pixels from sRGB to target ICC space
      const iccBytes = base64ToIcc(meta!.raw!.iccProfileData!);
      const { data: convertedData } = await this.pixels.fileIO.srgbToIcc(
        new Uint8Array(imageData.data.buffer),
        w, h, iccBytes,
      );

      // Step 2: Put converted pixels onto canvas and encode to WebP
      const clamped = new Uint8ClampedArray(convertedData.length);
      clamped.set(convertedData);
      const outCanvas = new OffscreenCanvas(w, h);
      const outCtx = outCanvas.getContext('2d')!;
      outCtx.putImageData(new ImageData(clamped, w, h), 0, 0);
      const webpBlob = await outCanvas.convertToBlob({ type: 'image/webp', quality });

      // Step 3: Inject ICC Profile into the WebP RIFF container
      const webpBytes = new Uint8Array(await webpBlob.arrayBuffer());
      const finalBytes = injectWebPIcc(webpBytes, iccBytes);

      console.debug('[ColorMgmt] WebP Export: pixelConversion=srgb-to-icc, targetProfile=%s',
        meta!.raw!.iccProfileName || 'custom');
      return new Blob([finalBytes.buffer as ArrayBuffer], { type: 'image/webp' });
    } else {
      canvas = source instanceof ImageBitmap
        ? bitmapToCanvas(source, exportStrategy.encodeColorSpace)
        : source as OffscreenCanvas;
      console.debug('[ColorMgmt] WebP Export: frameCS=%s, encodeColorSpace=%s',
        frameCS, exportStrategy.encodeColorSpace);
    }

    const baseBlob = await canvas.convertToBlob({
      type: 'image/webp',
      quality,
    });

    // Embed ICC Profile into WebP RIFF container (when embedIcc=true and source has ICC data).
    // This handles the case where no pixel conversion is needed (e.g. sRGB source with sRGB ICC)
    // but the user still wants the ICC Profile embedded for accurate color reproduction.
    if (embedIcc && meta?.raw?.iccProfileData) {
      const iccBytes = base64ToIcc(meta.raw.iccProfileData);
      const webpBytes = new Uint8Array(await baseBlob.arrayBuffer());
      const finalBytes = injectWebPIcc(webpBytes, iccBytes);
      console.debug('[ColorMgmt] WebP Export: injecting ICC profile (no pixel conversion), profile=%s',
        meta.raw.iccProfileName || 'embedded');
      return new Blob([finalBytes.buffer as ArrayBuffer], { type: 'image/webp' });
    }

    // Strip browser-injected ICC when user explicitly disables embedding.
    // Chrome may auto-inject sRGB/P3 ICC profiles via canvas.convertToBlob().
    if (!embedIcc) {
      const webpBytes = new Uint8Array(await baseBlob.arrayBuffer());
      const strippedBytes = stripWebPIcc(webpBytes);
      if (strippedBytes !== webpBytes) {
        console.debug('[ColorMgmt] WebP Export: stripped browser-injected ICC (embedIcc=false)');
        return new Blob([strippedBytes.buffer as ArrayBuffer], { type: 'image/webp' });
      }
    }

    return baseBlob;
  }

  // ─── Metadata Extraction ─────────────────────────────────────────────────

  async extractMetadata(file: File): Promise<ImageMetadata> {
    const base: ImageMetadata = {
      version: 1,
      sourceFormat: 'webp',
      sourceFileName: file.name,
      sourceFileSize: file.size,
      dpi: 72,
      dpiSource: 'default',
      colorSpace: 'srgb',
      bitDepth: 8,
      hasAlpha: false,
      hasIccProfile: false,
    };

    try {
      const fileBuffer = await file.arrayBuffer();

      // 1. Parse EXIF with ExifReader (supports WebP RIFF container)
      const tags = ExifReader.load(fileBuffer, { expanded: true });

      // DPI
      const xRes = tags.exif?.XResolution?.value;
      if (xRes) {
        const resUnit = tags.exif?.ResolutionUnit?.value;
        let dpi = Array.isArray(xRes) ? xRes[0] / (xRes[1] || 1) : Number(xRes);
        if (resUnit === 3) dpi = dpi * 2.54; // cm → inches
        if (dpi > 1 && dpi < 10000) {
          base.dpi = Math.round(dpi);
          base.dpiSource = 'exif';
        }
      }

      // Camera info
      const make = tags.exif?.Make?.description;
      const model = tags.exif?.Model?.description;
      if (make || model) {
        base.camera = {
          make,
          model,
          lensMake: tags.exif?.LensMake?.description,
          lensModel: tags.exif?.LensModel?.description,
          software: tags.exif?.Software?.description,
        };
      }

      // Capture parameters
      const fNumber = tags.exif?.FNumber?.value;
      const exposureTime = tags.exif?.ExposureTime?.value;
      const iso = tags.exif?.ISOSpeedRatings?.value;
      if (fNumber || exposureTime || iso) {
        base.capture = {
          fNumber: fNumber ? (Array.isArray(fNumber) ? fNumber[0] / (fNumber[1] || 1) : Number(fNumber)) : undefined,
          exposureTime: exposureTime ? (Array.isArray(exposureTime) ? exposureTime[0] / (exposureTime[1] || 1) : Number(exposureTime)) : undefined,
          iso: iso ? (Array.isArray(iso) ? iso[0] : Number(iso)) : undefined,
          focalLength: tags.exif?.FocalLength?.value
            ? (Array.isArray(tags.exif.FocalLength.value)
                ? tags.exif.FocalLength.value[0] / (tags.exif.FocalLength.value[1] || 1)
                : Number(tags.exif.FocalLength.value))
            : undefined,
        };
      }

      // Dates
      const dateOriginal = tags.exif?.DateTimeOriginal?.description;
      if (dateOriginal) {
        try {
          const normalized = dateOriginal.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
          base.dates = { created: new Date(normalized).toISOString() };
        } catch { /* non-critical */ }
      }

      // GPS
      const lat = tags.gps?.Latitude;
      const lon = tags.gps?.Longitude;
      if (lat != null && lon != null) {
        base.gps = { latitude: Number(lat), longitude: Number(lon) };
      }

      // 2. ICC Profile extraction from WebP RIFF ICCP chunk
      const iccBytes = extractWebpIccChunk(new Uint8Array(fileBuffer));
      if (iccBytes) {
        base.hasIccProfile = true;
        base.raw = base.raw || {};
        base.raw.iccProfileData = iccToBase64(iccBytes);
        const profileName = parseIccProfileName(iccBytes);
        base.raw.iccProfileName = profileName || 'Embedded';

        // Detect known color spaces from ICC profile name
        const pName = (base.raw.iccProfileName || '').toLowerCase();
        if (pName.includes('adobe') && pName.includes('rgb')) {
          base.colorSpace = 'adobe-rgb';
        } else if (pName.includes('display p3') || pName.includes('p3')) {
          base.colorSpace = 'display-p3';
        } else if (pName.includes('prophoto')) {
          base.colorSpace = 'prophoto-rgb';
        }
      }
    } catch (err) {
      console.debug('[WebpHandler] EXIF extraction failed:', (err as Error).message);
    }

    return base;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WebP RIFF Container — ICCP Chunk Extraction
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extract ICC Profile bytes from WebP RIFF container.
 *
 * WebP extended format (VP8X) structure:
 * ```
 * RIFF [4B size] WEBP
 *   VP8X [4B size] [10B flags+dimensions] (flags bit 5 = ICC present)
 *   ICCP [4B size] [ICC profile bytes]
 *   ...
 * ```
 *
 * @returns Raw ICC profile bytes, or null if not found
 */
function extractWebpIccChunk(bytes: Uint8Array): Uint8Array | null {
  // Minimum valid RIFF WebP: "RIFF" + size(4) + "WEBP" = 12 bytes
  if (bytes.length < 12) return null;

  // Verify RIFF WebP signature
  const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const webp = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if (riff !== 'RIFF' || webp !== 'WEBP') return null;

  // Scan RIFF chunks starting at offset 12
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const chunkId = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
    // Chunk size (little-endian 32-bit)
    const chunkSize = bytes[pos + 4] | (bytes[pos + 5] << 8) | (bytes[pos + 6] << 16) | (bytes[pos + 7] << 24);

    if (chunkId === 'ICCP') {
      // Found ICC Profile chunk
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
