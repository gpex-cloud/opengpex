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
 * This module defines ALL core type definitions for the file I/O layer:
 * - ImageMetadata: Two-layer metadata model (semantic + raw)
 * - Format capability queries
 * - ImageFormatHandler: Per-format handler contract
 * - FileService: Public facade interface
 *
 * Previously split across types.ts + metadata.ts; unified 2026-08-07.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Metadata Types (canonical definitions — re-exported by metadata.ts for compat)
// ═══════════════════════════════════════════════════════════════════════════════

/** Supported source format identifiers */
export type SourceFormat =
  | 'jpeg' | 'png' | 'bmp' | 'webp' | 'avif'
  | 'heic' | 'tiff' | 'raw' | 'svg' | 'eps' | 'gif' | 'unknown';

/** How the DPI value was determined */
export type DpiSource = 'exif' | 'png-phys' | 'bmp-header' | 'tiff-tag' | 'user' | 'default';

/** Semantic color space identifier */
export type ColorSpaceId =
  | 'srgb' | 'adobe-rgb' | 'display-p3' | 'prophoto-rgb'
  | 'cmyk' | 'grayscale' | 'unknown';

/**
 * ImageMetadata — unified image metadata.
 *
 * Two-layer model:
 * - Semantic layer: format-agnostic, UI can directly consume
 * - Raw layer: standard binary passthrough for lossless export round-trip
 *
 * Design principles:
 * - Raw layer stores only standard binary (base64 of raw bytes)
 * - One data, one representation (no duplication)
 * - All inline (no external AssetId references)
 * - Semantic layer is format-agnostic
 * - Raw layer supports round-trip (import → store → export injection)
 */
export interface ImageMetadata {

  // ═══ Basic Info ═══════════════════════════════════════════════════════════
  sourceFormat: SourceFormat;
  sourceFileName?: string;
  sourceFileSize?: number;
  width: number;
  height: number;

  // ═══ Physical Dimensions ═══════════════════════════════════════════════════
  dpi: number;
  dpiSource: DpiSource;

  // ═══ Color Info ═══════════════════════════════════════════════════════════
  colorSpace: ColorSpaceId;
  bitDepth: number;
  /** Per-channel data type. Default 'uint'. TIFF 32-bit float = 'float'. */
  sampleFormat?: 'uint' | 'float';
  hasAlpha: boolean;

  // ═══ Camera ═══════════════════════════════════════════════════════════════
  camera?: {
    make?: string;
    model?: string;
    lensMake?: string;
    lensModel?: string;
    software?: string;
  };

  // ═══ Capture Parameters ═══════════════════════════════════════════════════
  capture?: {
    fNumber?: number;
    exposureTime?: number;
    iso?: number;
    focalLength?: number;
    whiteBalance?: string;
    flash?: boolean;
    orientation?: number;  // EXIF orientation 1-8
  };

  // ═══ Dates ═══════════════════════════════════════════════════════════════
  dates?: {
    created?: string;    // ISO 8601 (EXIF DateTimeOriginal)
    digitized?: string;  // ISO 8601 (EXIF DateTimeDigitized)
    modified?: string;   // ISO 8601 (EXIF DateTime / PNG tIME)
  };

  // ═══ GPS ═══════════════════════════════════════════════════════════════════
  gps?: {
    latitude?: number;
    longitude?: number;
    altitude?: number;
  };

  // ═══ Author / Copyright ════════════════════════════════════════════════════
  author?: {
    name?: string;
    copyright?: string;
    description?: string;
  };

  // ═══ Raw Layer: standard binary passthrough ════════════════════════════════
  raw: RawBinaryData;
}

/**
 * Raw binary data layer.
 *
 * All fields are base64-encoded standard format binary data.
 * No third-party library internal representations stored here.
 *
 * Data flow: import extract → base64 into state → export retrieve → inject target format
 */
export interface RawBinaryData {
  /**
   * ICC Profile (complete binary, base64).
   * Source: PNG iCCP / JPEG APP2 / WebP ICCP / HEIC colr box / TIFF tag 34675
   * Usage: inject into target format on export (per format rules)
   * Size: typically 0.5-50KB, max ~100KB
   */
  icc?: {
    data: string;       // base64 of raw ICC profile bytes
    name: string;       // Profile description (parsed from ICC desc tag)
  };

  /**
   * EXIF (TIFF IFD structure, base64).
   * Source: PNG eXIf chunk / JPEG APP1 (minus "Exif\0\0" prefix) / WebP EXIF chunk
   * Usage: inject into target format on export
   * Size: typically 5-50KB
   *
   * Note: This is standard TIFF IFD binary, not any library's JSON mapping.
   * Semantic field parsing (camera/capture/dates) is done once at import time,
   * results go into semantic layer. raw.exif is only used for export injection.
   */
  exif?: string;        // base64 of raw EXIF bytes (TIFF IFD structure)

  /**
   * XMP sidecar (UTF-8 XML string).
   * Source: JPEG APP1 XMP / PNG iTXt "XML:com.adobe.xmp" / TIFF tag 700
   * Size: typically <10KB
   */
  xmp?: string;         // UTF-8 XML string (not base64, already text)

  /** PNG gAMA gamma value (only meaningful for PNG, effective without ICC/sRGB) */
  gamma?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Format Capability Queries
// ═══════════════════════════════════════════════════════════════════════════════

/** Formats that support EXIF metadata embedding on export. */
const EXIF_CAPABLE_FORMATS = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/tiff', 'image/avif']);

/**
 * Whether a given format supports EXIF metadata embedding.
 * Used by UI to conditionally show "Keep EXIF" toggle.
 */
export function supportsExifEmbed(format: string): boolean {
  return EXIF_CAPABLE_FORMATS.has(format);
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

  /**
   * Frame's working color space at export time.
   *
   * Passed from the compositor/command layer (= activeFrame.colorSpace).
   * Used by handlers to query `getExportStrategy(frameColorSpace)` for
   * correct canvas colorSpace and pixel conversion decisions.
   *
   * When undefined, handlers derive from metadata via IMPORT_PIPELINE lookup.
   */
  frameColorSpace?: 'srgb' | 'display-p3' | 'adobe-rgb' | 'prophoto-rgb';

  /** Target resize dimensions (if post-composite resize is needed) */
  resize?: { w: number; h: number };

  // ─── Format-specific options (passed through to handlers) ───
  /** TIFF compression method */
  tiffCompression?: string;
  /** PNG compression level (0-9) */
  pngCompression?: number;
  /** JPEG quality for TIFF JPEG compression (1-100) */
  jpegQuality?: number;
  /** TIFF predictor */
  tiffPredictor?: string;
  /** BigTIFF format */
  tiffBigtiff?: boolean;
  /** Tile layout */
  tiffTile?: boolean;
  /** Tile width */
  tiffTileWidth?: number;
  /** Tile height */
  tiffTileHeight?: number;
}

/**
 * A single sub-image within a decoded file.
 *
 * Unified representation for:
 * - Single-page images (JPEG/PNG/WebP/BMP/HEIC/RAW/TIFF single)
 * - Multi-page TIFF pages
 * - Animated GIF/APNG frames
 */
export interface SubImage {
  /** 8-bit display-ready blob (PNG/JPEG for Canvas2D/WebGPU texture upload) */
  displayBlob: Blob;

  /** Pixel dimensions of this sub-image */
  width: number;
  height: number;

  /** Zero-based index within the source file */
  index: number;

  /**
   * Frame delay in milliseconds.
   * Present ONLY for animated formats (GIF, APNG, WebP animation).
   * Undefined for static multi-page formats (TIFF pages, PDF pages).
   */
  delay?: number;

  /**
   * Per-sub-image bit depth (if different from metadata.bitDepth).
   * Typically undefined — inherited from top-level metadata.
   */
  bitDepth?: number;
}

/** Decode result returned by handlers */
export interface DecodeResult {
  /** Decoded pixel dimensions (canvas size: first/largest page) */
  dimensions: { w: number; h: number };
  /** Extracted metadata (format-agnostic semantic layer) */
  metadata: ImageMetadata;

  /**
   * Sub-images: always present, length ≥ 1.
   *
   * - Single-page file → length = 1
   * - Multi-page TIFF → length = N pages
   * - Animated GIF/APNG → length = N frames
   *
   * Consumers iterate this array uniformly.
   */
  subImages: SubImage[];

  /**
   * Original source blob for high-fidelity operations.
   *
   * Present when:
   * - Source bit depth > 8 (16-bit TIFF/PNG/RAW) → enables lossless 16-bit export
   * - Source is multi-page → worker extracts pages by index on demand
   *
   * NOT present for standard 8-bit single-page files (JPEG/PNG/WebP) since
   * the displayBlob IS the final representation.
   *
   * Design: ONE shared source blob (not N per-page copies) — memory efficient.
   */
  sourceBlob?: Blob;
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
