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
 * Unified File Service types.
 *
 * This module defines the core interfaces for the unified file I/O layer:
 * - ImageMetadata: Two-layer metadata model (semantic + raw)
 * - ImageFormatHandler: Per-format handler contract
 * - FileService: Public facade interface
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Metadata Model (Semantic Layer + Raw Layer)
// ═══════════════════════════════════════════════════════════════════════════════

/** Supported source format identifiers */
export type SourceFormat =
  | 'jpeg'
  | 'png'
  | 'bmp'
  | 'webp'
  | 'avif'
  | 'heic'
  | 'tiff'
  | 'raw'
  | 'svg'
  | 'eps'
  | 'gif'
  | 'unknown';

/** How the DPI value was determined */
export type DpiSource = 'exif' | 'png-phys' | 'bmp-header' | 'user' | 'default';

/** Semantic color space identifier */
export type ColorSpaceId =
  | 'srgb'
  | 'adobe-rgb'
  | 'display-p3'
  | 'prophoto-rgb'
  | 'cmyk'
  | 'grayscale'
  | 'unknown';

/**
 * Unified image metadata — semantic layer + raw layer.
 *
 * The semantic layer is format-agnostic and UI-consumable.
 * The raw layer preserves format-specific binary data for lossless round-trip.
 */
export interface ImageMetadata {
  /** Schema version for state migration */
  version: 1;

  // ─── Basic Info ──────────────────────────────────────────────────────────
  sourceFormat: SourceFormat;
  /** Internal codec after transcoding (e.g. 'image/png'). Undefined if no transcoding needed. */
  internalCodec?: string;
  sourceFileName?: string;
  sourceFileSize?: number;

  // ─── Physical Dimensions & DPI ───────────────────────────────────────────
  dpi: number;
  dpiSource: DpiSource;

  // ─── Color Info ──────────────────────────────────────────────────────────
  colorSpace: ColorSpaceId;
  bitDepth: number;
  hasAlpha: boolean;
  hasIccProfile: boolean;

  // ─── Camera Info ─────────────────────────────────────────────────────────
  camera?: {
    make?: string;
    model?: string;
    lensMake?: string;
    lensModel?: string;
    software?: string;
  };

  // ─── Capture Parameters ──────────────────────────────────────────────────
  capture?: {
    fNumber?: number;
    exposureTime?: number;
    iso?: number;
    focalLength?: number;
    whiteBalance?: string;
    flash?: boolean;
  };

  // ─── Dates ───────────────────────────────────────────────────────────────
  dates?: {
    created?: string;   // ISO 8601
    modified?: string;  // ISO 8601
  };

  // ─── GPS ─────────────────────────────────────────────────────────────────
  gps?: {
    latitude?: number;
    longitude?: number;
    altitude?: number;
  };

  // ─── Author / Copyright ──────────────────────────────────────────────────
  author?: {
    name?: string;
    copyright?: string;
    description?: string;
  };

  // ─── AI Generation Info ──────────────────────────────────────────────────
  ai?: {
    model?: string;
    prompt?: string;
  };

  // ─── Raw Layer (format-specific, for lossless round-trip) ────────────────
  raw?: RawMetadataRefs;
}

/**
 * Raw metadata blob references.
 * ICC Profile is stored inline as base64 (typically 2-50KB, max ~100KB).
 * Large binary data (EXIF) is stored via AssetId to avoid inflating state JSON.
 */
export interface RawMetadataRefs {
  /** PNG eXIf chunk raw bytes, base64 encoded (for export round-trip) */
  exifBytes?: string;
  /** File gamma value (from PNG gAMA chunk, only meaningful without ICC/sRGB) */
  gamma?: number;
  /** ICC Profile binary, base64 encoded. Typically 2-50KB. */
  iccProfileData?: string;
  /** ICC Profile description name (e.g. "sRGB IEC61966-2.1") */
  iccProfileName?: string;
  /** Original EXIF binary for passthrough (stored as asset) */
  exifBlobAssetId?: string;
  /** XMP sidecar string (inline, typically <10KB) */
  xmpString?: string;
  /** Raw piexif object for JPEG EXIF round-trip (inline JSON, <5KB) */
  piexifObj?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Service Options
// ═══════════════════════════════════════════════════════════════════════════════

export interface DecodeOptions {
  /** Override DPI for vector import */
  dpi?: number;
  /** Target rasterization width (for vector formats) */
  targetWidth?: number;
  /** Target rasterization height (for vector formats) */
  targetHeight?: number;
}

export interface EncodeOptions {
  /** Compression quality (0-1) */
  quality?: number;
  /** Source metadata to inject into output */
  metadata?: ImageMetadata;
  /** Export-specific metadata configuration */
  exportConfig?: ExportMetadataConfig;
}

export interface ExportMetadataConfig {
  /** Output DPI (overrides metadata.dpi) */
  dpi?: number;
  /** Preserve original EXIF data in output */
  preserveExif?: boolean;
  /** Embed ICC Profile in output */
  embedIcc?: boolean;
  /** Write software identification tag */
  writeSoftwareTag?: boolean;
  /** Override author/copyright for this export */
  author?: { name?: string; copyright?: string };
}

/** Decode result returned by handlers */
export interface DecodeResult {
  /** Transcoded file safe for browser display (e.g., HEIC→JPEG, RAW→PNG) */
  safeFile: File;
  /** Decoded pixel dimensions */
  dimensions: { w: number; h: number };
  /** Extracted metadata */
  metadata: ImageMetadata;

  /**
   * Multi-frame extension (GIF / APNG).
   * Present only when the source contains multiple animation frames.
   * Each entry is a single decoded frame as PNG blob with timing info.
   */
  frames?: Array<{
    /** Single frame as PNG Blob (browser-displayable) */
    blob: Blob;
    /** Frame delay in milliseconds */
    delay: number;
    /** Zero-based frame index */
    index: number;
  }>;

  /**
   * Phase 5: High-resolution raw source blob.
   * Present only when the source file has bitDepth > 8 (16-bit TIFF/PNG/RAW).
   * Used by AssetService to store the original high-precision data for lossless 16-bit export.
   * The raw blob is the original file bytes — NOT decoded pixel data.
   */
  rawBlob?: Blob;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Handler & Service Interfaces
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Per-format image handler.
 *
 * Each handler encapsulates all format-specific logic:
 * - Decoding (transcoding non-standard formats to browser-safe versions)
 * - Encoding (compressing pixels to target format with metadata injection)
 * - Metadata extraction (reading headers without full decode)
 *
 * Dependencies (AssetService, WorkerProxy) are injected at construction time,
 * keeping method signatures clean and preventing circular references.
 */
export interface ImageFormatHandler {
  /** Format identifier (e.g., 'jpeg', 'png', 'heic') */
  readonly format: string;
  /** MIME types handled by this handler */
  readonly mimeTypes: string[];
  /** File extensions handled (without dot, lowercase) */
  readonly extensions: string[];
  /**
   * Whether this format requires heavy transcoding (WASM/Worker) during decode.
   * When true, the UI should show a "Converting…" indicator during file load.
   * Defaults to false if not specified.
   */
  readonly needsTranscoding?: boolean;

  /**
   * Decode: transcode to browser-safe format + extract metadata.
   * For natively supported formats (JPEG/PNG), returns the original file.
   * For non-native formats (HEIC/RAW/SVG/EPS), transcodes to PNG/JPEG.
   */
  decode(file: File, options?: DecodeOptions): Promise<DecodeResult>;

  /**
   * Encode: compress Canvas/Bitmap to this format with metadata/DPI injection.
   */
  encode(
    source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
    options: EncodeOptions,
  ): Promise<Blob>;

  /**
   * Fast metadata-only extraction (reads file header, no pixel decode).
   */
  extractMetadata(file: File): Promise<ImageMetadata>;
}

/**
 * Unified FileService facade.
 *
 * Entry point for all file format I/O operations.
 * Routes to the appropriate ImageFormatHandler based on file type/extension.
 *
 * Dependency: AssetService + WorkerProxy (injected via createFileService factory).
 * Does NOT depend on PixelService (peer relationship, no circular refs).
 */
export interface FileService {
  /** Get handler for a given file (by MIME type + extension detection) */
  getHandler(file: File): ImageFormatHandler;
  /** Get handler by MIME type string */
  getHandlerByMimeType(mimeType: string): ImageFormatHandler;

  /**
   * Unified decode: format detection + transcoding + metadata extraction.
   * Single call handles format detection, transcoding, and metadata extraction.
   */
  decode(file: File, options?: DecodeOptions): Promise<DecodeResult>;

  /**
   * Unified encode: pixel compression + metadata/DPI injection.
   * Single call replaces the old convertToBlob + injectToBlob + injectPngDpi pattern.
   */
  encode(
    source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
    mimeType: string,
    options: EncodeOptions,
  ): Promise<Blob>;

  /**
   * Fast metadata extraction (no transcoding).
   */
  extractMetadata(file: File): Promise<ImageMetadata>;

  /**
   * Get export filename with correct extension for the given format.
   */
  getExportFilename(baseName: string, w: number, h: number, mimeType: string): string;

  /**
   * Detect format from a File object (by MIME type + extension).
   */
  detectFormat(file: File): SourceFormat;

  /**
   * Whether a file requires heavy transcoding (WASM/Worker decode).
   * Used by the command layer to decide whether to show a "Converting…" indicator.
   * Delegates to the matched handler's `needsTranscoding` flag.
   */
  needsTranscoding(file: File): boolean;
}
