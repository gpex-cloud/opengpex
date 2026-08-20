/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * Unified File Service — factory and public exports.
 *
 * Creates a FileService instance with all format handlers registered.
 * Dependencies: AssetService + PixelService (for fileIO namespace — TIFF/RAW Worker ops).
 * Phase 7.2: FileService depends on PixelService.fileIO (vips unified Worker).
 */

import type { AssetService, PixelService } from '@opengpex/editor/core/types';
import type {
  FileService,
  ImageFormatHandler,
  DecodeOptions,
  DecodeResult,
  EncodeOptions,
} from './types';
import type { ImageMetadata } from './metadata';
import { JpegHandler } from './handlers/jpeg';
import { PngHandler } from './handlers/png';
import { BmpHandler } from './handlers/bmp';
import { HeicHandler } from './handlers/heic';
import { TiffHandler } from './handlers/tiff';
import { RawHandler } from './handlers/raw';
import { WebpHandler } from './handlers/webp';
import { AvifHandler } from './handlers/avif';
import { VectorHandler, getVectorIntrinsicSize, detectVectorFormat } from './handlers/vector';
import { GifHandler } from './handlers/gif';
import { mimeToExt } from './mime';

// Re-export vector utilities (used by frame/create command)
export { getVectorIntrinsicSize, detectVectorFormat };

// Re-export metadata display helpers
export { hasDisplayableMetadata, isComfyUiWorkflow } from './utils';

// Re-export all public types
export type {
  FileService,
  ImageFormatHandler,
  DecodeOptions,
  DecodeResult,
  EncodeOptions,
  ExportMetadataConfig,
  SourceFormat,
  DpiSource,
  ColorSpaceId,
} from './types';

// Re-export V2 metadata types
export type { ImageMetadata, RawBinaryData } from './metadata';


// ═══════════════════════════════════════════════════════════════════════════════
// Fallback Handler (for unknown/unsupported formats)
// ═══════════════════════════════════════════════════════════════════════════════

class FallbackHandler implements ImageFormatHandler {
  readonly format = 'unknown';
  readonly mimeTypes: string[] = [];
  readonly extensions: string[] = [];

  async decode(file: File): Promise<DecodeResult> {
    // Return file as-is — let the browser try to handle it
    const img = await createImageBitmap(file);
    const dimensions = { w: img.width, h: img.height };
    img.close();
    const metadata: ImageMetadata = {
      sourceFormat: 'unknown',
      sourceFileName: file.name,
      sourceFileSize: file.size,
      width: dimensions.w,
      height: dimensions.h,
      dpi: 72,
      dpiSource: 'default',
      colorSpace: 'srgb',
      bitDepth: 8,
      hasAlpha: false,
      raw: {},
    };
    return {
      dimensions,
      metadata,
      subImages: [{ displayBlob: file, width: dimensions.w, height: dimensions.h, index: 0 }],
    };
  }

  async encode(
    source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
    _options: EncodeOptions,
  ): Promise<Blob> {
    // Fallback: encode as PNG
    const canvas = source instanceof ImageBitmap
      ? bitmapToCanvas(source)
      : source;
    return (canvas as OffscreenCanvas).convertToBlob({ type: 'image/png' });
  }

  async extractMetadata(file: File): Promise<ImageMetadata> {
    return {
      sourceFormat: 'unknown',
      sourceFileName: file.name,
      sourceFileSize: file.size,
      width: 0,
      height: 0,
      dpi: 72,
      dpiSource: 'default',
      colorSpace: 'srgb',
      bitDepth: 8,
      hasAlpha: false,
      raw: {},
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Utility: ImageBitmap → OffscreenCanvas
// ═══════════════════════════════════════════════════════════════════════════════

/** Convert ImageBitmap to OffscreenCanvas for encoding APIs */
export function bitmapToCanvas(bitmap: ImageBitmap, colorSpace?: PredefinedColorSpace): OffscreenCanvas {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', colorSpace ? { colorSpace } : undefined)!;
  ctx.drawImage(bitmap, 0, 0);
  return canvas;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Factory: createFileService
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Creates a unified FileService instance.
 *
 * @param assets - AssetService for registering ICC/EXIF blobs
 * @param pixels - PixelService (provides fileIO namespace for TIFF/RAW Worker operations)
 */
export function createFileService(
  assets: AssetService,
  pixels: PixelService,
): FileService {
  // Instantiate all format handlers
  const handlers: ImageFormatHandler[] = [
    new JpegHandler(pixels),
    new PngHandler(pixels),
    new WebpHandler(pixels),
    new AvifHandler(pixels),
    new BmpHandler(),
    new GifHandler(),
    new HeicHandler(assets, pixels),
    new TiffHandler(assets, pixels),
    new RawHandler(assets),
    new VectorHandler(),
  ];

  const fallback = new FallbackHandler();

  // Build lookup maps for fast routing
  const mimeMap = new Map<string, ImageFormatHandler>();
  const extMap = new Map<string, ImageFormatHandler>();

  for (const handler of handlers) {
    for (const mime of handler.mimeTypes) {
      mimeMap.set(mime, handler);
    }
    for (const ext of handler.extensions) {
      extMap.set(ext, handler);
    }
  }

  /** Route file → handler */
  function getHandler(file: File): ImageFormatHandler {
    // Try MIME type first
    const type = file.type.toLowerCase();
    if (type && mimeMap.has(type)) return mimeMap.get(type)!;

    // Fallback to extension
    const ext = file.name.toLowerCase().split('.').pop() || '';
    if (ext && extMap.has(ext)) return extMap.get(ext)!;

    return fallback;
  }

  /** Route MIME type string → handler */
  function getHandlerByMimeType(mimeType: string): ImageFormatHandler {
    return mimeMap.get(mimeType.toLowerCase()) || fallback;
  }

  // ─── Build the FileService facade ──────────────────────────────────────────

  const service: FileService = {
    getHandler,
    getHandlerByMimeType,

    async decode(file: File, options?: DecodeOptions): Promise<DecodeResult> {
      const handler = getHandler(file);
      return handler.decode(file, options);
    },

    async encode(
      source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
      mimeType: string,
      options: EncodeOptions,
    ): Promise<Blob> {
      const handler = getHandlerByMimeType(mimeType);
      return handler.encode(source, options);
    },

    async extractMetadata(file: File) {
      const handler = getHandler(file);
      return handler.extractMetadata(file);
    },

    getExportFilename(baseName: string, w: number, h: number, mimeType: string): string {
      const ext = mimeToExt[mimeType] || mimeType.split('/')[1] || 'png';
      return `${baseName}-${w}x${h}.${ext}`;
    },

    needsTranscoding(file: File): boolean {
      const handler = getHandler(file);
      return handler.needsTranscoding === true;
    },
  };

  return service;
}

// Re-export MIME utilities (stateless helpers used without FileService access)
export { mimeToFormat, formatToMime, detectFormat } from './mime';

// Re-export DPI utilities consumed by external modules (plugins / UI components)
export { DPI_PRESETS, formatPrintSize } from './dpi';
export { supportsExifEmbed } from './types';
