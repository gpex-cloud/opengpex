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
 * Dependencies: AssetService + WorkerProxy (infrastructure peers).
 * Does NOT depend on PixelService (see architecture doc §2.3).
 */

import type { AssetService, WorkerProxy } from '@opengpex/editor/core/types';
import type {
  FileService,
  ImageFormatHandler,
  DecodeOptions,
  DecodeResult,
  EncodeOptions,
  SourceFormat,
} from './types';
import { JpegHandler } from './handlers/jpeg';
import { PngHandler } from './handlers/png';
import { BmpHandler } from './handlers/bmp';
import { HeicHandler } from './handlers/heic';
import { TiffHandler } from './handlers/tiff';
import { RawHandler } from './handlers/raw';
import { WebpHandler } from './handlers/webp';
import { VectorHandler, getVectorIntrinsicSize, detectVectorFormat } from './handlers/vector';
import { GifHandler } from './handlers/gif';

// Re-export vector utilities (used by frame/create command)
export { getVectorIntrinsicSize, detectVectorFormat };

// Re-export all public types
export type {
  FileService,
  ImageFormatHandler,
  ImageMetadata,
  RawMetadataRefs,
  DecodeOptions,
  DecodeResult,
  EncodeOptions,
  ExportMetadataConfig,
  SourceFormat,
  DpiSource,
  ColorSpaceId,
} from './types';

// ═══════════════════════════════════════════════════════════════════════════════
// Format Detection (migrated from PixelUtils.detectFormat)
// ═══════════════════════════════════════════════════════════════════════════════

/** Camera RAW file extensions supported by libraw-wasm */
const RAW_EXTENSIONS = new Set([
  'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2',
  'dng', 'orf', 'rw2', 'raf', 'pef', 'srw',
  'raw', 'rwl', '3fr', 'fff', 'iiq',
]);

/** Camera RAW MIME types */
const RAW_MIME_TYPES = new Set([
  'image/x-dcraw', 'image/x-adobe-dng',
  'image/x-canon-cr2', 'image/x-nikon-nef', 'image/x-sony-arw',
]);

/**
 * Detects the source format of a file from MIME type and extension.
 */
function detectFormat(file: File): SourceFormat {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  const ext = name.split('.').pop() || '';

  if (type === 'image/jpeg' || ext === 'jpg' || ext === 'jpeg') return 'jpeg';
  if (type === 'image/png' || ext === 'png') return 'png';
  if (type === 'image/webp' || ext === 'webp') return 'webp';
  if (type === 'image/avif' || ext === 'avif') return 'avif';
  if (type === 'image/heic' || type === 'image/heif' || ext === 'heic' || ext === 'heif') return 'heic';
  if (type === 'image/svg+xml' || ext === 'svg') return 'svg';
  if (type === 'application/postscript' || type === 'application/eps' || type === 'image/x-eps' || ext === 'eps' || ext === 'epsf') return 'eps';
  if (type === 'image/gif' || ext === 'gif') return 'gif';
  if (type === 'image/bmp' || type === 'image/x-ms-bmp' || ext === 'bmp') return 'bmp';
  if (type === 'image/tiff' || ext === 'tiff' || ext === 'tif') return 'tiff';
  if (RAW_EXTENSIONS.has(ext) || RAW_MIME_TYPES.has(type)) return 'raw';

  return 'unknown';
}

// ═══════════════════════════════════════════════════════════════════════════════
// MIME → Extension mapping
// ═══════════════════════════════════════════════════════════════════════════════

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/tiff': 'tiff',
  'image/svg+xml': 'svg',
};

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
    return {
      dimensions,
      metadata: {
        version: 1,
        sourceFormat: 'unknown',
        sourceFileName: file.name,
        sourceFileSize: file.size,
        dpi: 72,
        dpiSource: 'default',
        colorSpace: 'srgb',
        bitDepth: 8,
        hasAlpha: false,
        hasIccProfile: false,
      },
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

  async extractMetadata(file: File) {
    return {
      version: 1 as const,
      sourceFormat: 'unknown' as const,
      sourceFileName: file.name,
      sourceFileSize: file.size,
      dpi: 72,
      dpiSource: 'default' as const,
      colorSpace: 'srgb' as const,
      bitDepth: 8,
      hasAlpha: false,
      hasIccProfile: false,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Utility: ImageBitmap → OffscreenCanvas
// ═══════════════════════════════════════════════════════════════════════════════

/** Convert ImageBitmap to OffscreenCanvas for encoding APIs */
export function bitmapToCanvas(bitmap: ImageBitmap): OffscreenCanvas {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
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
 * @param workerProxy - WorkerProxy for heavy transcoding (SVG/EPS/RAW)
 */
export function createFileService(
  assets: AssetService,
  workerProxy: WorkerProxy,
): FileService {
  // Instantiate all format handlers
  const handlers: ImageFormatHandler[] = [
    new JpegHandler(assets),
    new PngHandler(assets),
    new WebpHandler(),
    new BmpHandler(),
    new GifHandler(),
    new HeicHandler(assets),
    new TiffHandler(assets, workerProxy),
    new RawHandler(assets, workerProxy),
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
      const ext = MIME_TO_EXT[mimeType] || mimeType.split('/')[1] || 'png';
      return `${baseName}-${w}x${h}.${ext}`;
    },

    detectFormat,

    needsTranscoding(file: File): boolean {
      const handler = getHandler(file);
      return handler.needsTranscoding === true;
    },
  };

  return service;
}

// Re-export DPI utilities consumed by external modules (plugins / UI components)
export { DPI_PRESETS, formatPrintSize } from './dpi';
