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
 * Shared metadata processors — unified re-exports.
 *
 * This directory contains format-agnostic binary metadata parsers/writers
 * shared across multiple format handlers:
 *
 * - `isobmff-reader` — ISOBMFF (HEIC/AVIF) ICC/EXIF/NCLX extraction
 * - `isobmff-writer` — AVIF EXIF injection
 * - `tiff-ifd-reader` — TIFF IFD binary read/write utilities
 *
 * @module core/files/metadata
 */

export {
  extractIsobmffIcc,
  extractIsobmffNclx,
  extractIsobmffExif,
  nclxToColorSpace,
} from './isobmff-reader';
export type { NclxParams } from './isobmff-reader';

export { injectAvifExif } from './isobmff-writer';

export {
  parseTiffByteOrder,
  validateTiffHeader,
  extractTiffIcc,
  extractTiffExif,
  resetExifOrientation,
  readU16,
  readU32,
  writeU16,
  writeU32,
  ICC_PROFILE_TAG,
  TYPE_SIZES,
} from './tiff-ifd-reader';
