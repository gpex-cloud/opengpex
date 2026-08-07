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
 * ImageMetadata — unified image metadata type definitions.
 *
 * Two-layer model:
 * - Semantic layer: format-agnostic, UI-consumable
 * - Raw layer: standard binary passthrough for lossless export round-trip
 *
 * Design principles:
 * - Raw layer stores only standard binary (base64 of raw bytes)
 * - One data, one representation (no piexifObj / exifBlobAssetId duplication)
 * - All inline (no external AssetId references)
 * - Semantic layer is format-agnostic
 * - Raw layer supports round-trip (import → store → export injection)
 */

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
