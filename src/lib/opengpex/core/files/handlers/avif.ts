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
 * AVIF Format Handler.
 *
 * Responsibilities:
 * - Decode: browser-native AVIF decoding + EXIF/ICC metadata extraction
 * - Encode: AVIF compression via unified engine Worker + vips-heif (libheif + libaom)
 * - Metadata: ExifReader parsing for EXIF + ICC profile extraction from HEIF container
 *
 * AVIF uses the HEIF/ISOBMFF container format. ExifReader v4+ supports parsing
 * AVIF files for EXIF, ICC profiles, and XMP metadata.
 *
 * Thread model:
 * - Decode: main thread (browser-native createImageBitmap, <10ms typical)
 * - Encode: engine Worker via vips heifsave (vips-heif.wasm, ~300ms-2s depending on resolution)
 * - Metadata: main thread via ExifReader (<50ms)
 *
 * ICC color management:
 * - Import: non-sRGB files are converted to sRGB via vips (Little CMS) for accurate editing
 * - Export: sRGB → original ICC conversion + ICC profile embedding via vips-heif
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
import { iccToBase64, parseIccProfileName } from '../icc';
import { convertImageDataColorSpace } from '@opengpex/editor/core/color/matrices';
import { resolveColorSpaceForFormat, getImportStrategy, getExportStrategy, shouldRetainSourceBlob, resolveExportPixelConversion } from '@opengpex/editor/core/color/ColorPipeline';

export class AvifHandler implements ImageFormatHandler {
  readonly format = 'avif';
  readonly mimeTypes = ['image/avif'];
  readonly extensions = ['avif'];

  constructor(private pixels: PixelService) {}

  // ─── Decode ──────────────────────────────────────────────────────────────

  async decode(file: File, _options?: DecodeOptions): Promise<DecodeResult> {
    const metadata = await this.extractMetadata(file);

    // ── Strategy-based color pipeline routing ──
    const detectedCS = resolveColorSpaceForFormat('avif', metadata.colorSpace);
    const strategy = getImportStrategy(detectedCS);

    let displayBlob: Blob = file;
    let dimensions: { w: number; h: number };

    switch (strategy.conversion) {
      case 'none': {
        // Zero conversion: browser-native decode is sufficient (sRGB, P3)
        const img = await createImageBitmap(file);
        dimensions = { w: img.width, h: img.height };
        img.close();
        console.debug('[ColorMgmt] AVIF decode: %s conversion=none, detectedCS=%s, frameCS=%s',
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

        console.debug('[ColorMgmt] AVIF decode: %s matrix %s→%s',
          file.name, detectedCS, strategy.frameColorSpace);
        break;
      }

      case 'icc-engine': {
        // Full ICC engine conversion (custom ICC profiles, unknown spaces)
        const bytes = new Uint8Array(await file.arrayBuffer());
        const { width, height, data, iccProfileData } = await this.pixels.fileIO.iccToSrgb(bytes);
        dimensions = { w: width, h: height };

        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d')!;
        const clamped = new Uint8ClampedArray(data.length);
        clamped.set(data);
        ctx.putImageData(new ImageData(clamped, width, height), 0, 0);
        displayBlob = await canvas.convertToBlob({ type: 'image/png' });

        // Vips reliably extracts ICC from AVIF colr box — populate metadata if ExifReader missed it
        if (iccProfileData && iccProfileData.length > 0) {
          metadata.hasIccProfile = true;
          metadata.raw = metadata.raw || {};
          if (!metadata.raw.iccProfileData) {
            metadata.raw.iccProfileData = iccToBase64(iccProfileData);
          }
          if (!metadata.raw.iccProfileName) {
            metadata.raw.iccProfileName = parseIccProfileName(iccProfileData) || 'Embedded';
          }
        }

        console.debug('[ColorMgmt] AVIF decode: %s icc-engine %s→%s',
          file.name, detectedCS, strategy.frameColorSpace);
        break;
      }
    }

    // sourceBlob retention via centralized strategy
    const sourceBlob = shouldRetainSourceBlob('avif', metadata, strategy.frameColorSpace) ? file : undefined;

    return { dimensions, metadata, subImages: [{ displayBlob, width: dimensions.w, height: dimensions.h, index: 0 }], sourceBlob };
  }

  // ─── Encode ──────────────────────────────────────────────────────────────

  async encode(
    source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
    options: EncodeOptions,
  ): Promise<Blob> {
    const quality = Math.round((options.quality ?? 0.80) * 100); // vips Q: 0-100
    const meta = options.metadata;
    const config = options.exportConfig;

    // ── Strategy-based export color pipeline ──
    const frameCS: WorkingColorSpace = (config?.frameColorSpace as WorkingColorSpace) || 'srgb';
    const exportStrategy = getExportStrategy(frameCS, 'avif');
    const embedIcc = config?.embedIcc ?? false;

    // Centralized pixel conversion decision via resolveExportPixelConversion()
    const pixelConv = resolveExportPixelConversion(
      frameCS,
      { colorSpace: meta?.colorSpace, hasIccProfileData: !!meta?.raw?.iccProfileData },
      embedIcc,
      'avif',
    );

    // Get RGBA pixel data from source using the strategy's encodeColorSpace
    // to prevent implicit P3→sRGB conversion when drawing the bitmap.
    let canvas: OffscreenCanvas | HTMLCanvasElement;

    if (pixelConv === 'p3-to-srgb') {
      // Format fallback: P3 frame → sRGB (format doesn't support P3)
      const srcCanvas = source instanceof ImageBitmap ? bitmapToCanvas(source, 'display-p3') : source as OffscreenCanvas;
      const w = srcCanvas.width;
      const h = srcCanvas.height;
      const tmpCanvas = new OffscreenCanvas(w, h);
      const tmpCtx = tmpCanvas.getContext('2d', { colorSpace: 'display-p3' })!;
      tmpCtx.drawImage(srcCanvas, 0, 0);
      const imgData = tmpCtx.getImageData(0, 0, w, h);
      convertImageDataColorSpace(imgData.data, 'display-p3', 'srgb');
      const outCanvas = new OffscreenCanvas(w, h);
      const outCtx = outCanvas.getContext('2d')!;
      outCtx.putImageData(new ImageData(imgData.data, w, h), 0, 0);
      canvas = outCanvas;
      console.debug('[ColorMgmt] AVIF Export: pixelConversion=p3-to-srgb');
    } else {
      canvas = source instanceof ImageBitmap
        ? bitmapToCanvas(source, exportStrategy.encodeColorSpace)
        : source as OffscreenCanvas;
    }

    const ctx = (canvas as OffscreenCanvas).getContext('2d')!;
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const rgbaData = new Uint8Array(imageData.data.buffer);

    // ICC Profile for embedding (if user requested preserve-ICC)
    let iccProfileBytes: Uint8Array | undefined;
    if (embedIcc && meta?.raw?.iccProfileData) {
      const { base64ToIcc } = await import('../icc');
      iccProfileBytes = base64ToIcc(meta.raw.iccProfileData);

      if (pixelConv === 'srgb-to-icc') {
        const { data: convertedData } = await this.pixels.fileIO.srgbToIcc(
          rgbaData, canvas.width, canvas.height, iccProfileBytes,
        );
        rgbaData.set(convertedData);
        console.debug('[ColorMgmt] AVIF Export: pixelConversion=srgb-to-icc, targetProfile=%s',
          meta.raw.iccProfileName || 'custom');
      }
    } else if (embedIcc && !meta?.raw?.iccProfileData) {
      // embedIcc requested but no source ICC data (e.g. BMP→AVIF export)
      // sRGB without ICC is universally correct; future: embed standard sRGB ICC constant
      console.debug('[ColorMgmt] AVIF Export: embedIcc=true but no source ICC data; frameCS=%s (sRGB assumed)', frameCS);
    }

    console.debug('[ColorMgmt] AVIF Export: frameCS=%s, encodeColorSpace=%s, embedIcc=%s',
      frameCS, exportStrategy.encodeColorSpace, !!iccProfileBytes);

    // Encode via engine Worker (FILE_IO encodeAvif → vips heifsave + AV1)
    const dpi = config?.dpi || meta?.dpi || 72;
    const avifBytes = await this.pixels.fileIO.encodeAvif(
      rgbaData,
      canvas.width,
      canvas.height,
      { quality, lossless: false, effort: 4, iccProfileBytes, dpi },
    );

    return new Blob([avifBytes.buffer as ArrayBuffer], { type: 'image/avif' });
  }

  // ─── Metadata Extraction ─────────────────────────────────────────────────

  async extractMetadata(file: File): Promise<ImageMetadata> {
    const base: ImageMetadata = {
      version: 1,
      sourceFormat: 'avif',
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

      // ExifReader v4+ supports AVIF/HEIF container parsing
      const tags = ExifReader.load(fileBuffer, { expanded: true });

      // DPI from EXIF
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

      // ICC Profile — ExifReader extracts ICC from AVIF's colr box
      const iccDesc = tags.icc?.['ICC Description']?.description
        || tags.icc?.ProfileDescription?.description;
      if (iccDesc) {
        base.hasIccProfile = true;
        base.raw = base.raw || {};
        base.raw.iccProfileName = String(iccDesc);

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

      // Try to get raw ICC profile bytes from ExifReader
      // ExifReader may expose raw ICC data via icc chunk
      const iccChunks = tags.icc;
      if (iccChunks && typeof iccChunks === 'object') {
        // ExifReader exposes raw ICC bytes in certain parse modes
        const rawIcc = (iccChunks as Record<string, unknown>).__raw;
        if (rawIcc instanceof Uint8Array && rawIcc.length > 0) {
          base.raw = base.raw || {};
          base.raw.iccProfileData = iccToBase64(rawIcc);
          if (!base.raw.iccProfileName) {
            base.raw.iccProfileName = parseIccProfileName(rawIcc) || 'Embedded';
          }
        }
      }

      // Bit depth detection from AVIF pixi box (if ExifReader exposes it)
      const fileTags = tags.file as Record<string, { value?: unknown }> | undefined;
      const bitDepth = fileTags?.BitDepth?.value;
      if (bitDepth && Number(bitDepth) > 8) {
        base.bitDepth = Number(bitDepth);
      }

      // Alpha detection
      // AVIF supports alpha; detect from file properties if available
      const hasAlpha = fileTags?.NumberOfComponents?.value;
      if (hasAlpha && Number(hasAlpha) === 4) {
        base.hasAlpha = true;
      }
    } catch (err) {
      console.debug('[AvifHandler] Metadata extraction failed:', (err as Error).message);
    }

    return base;
  }

}
