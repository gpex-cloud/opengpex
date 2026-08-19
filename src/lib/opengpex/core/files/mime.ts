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
 * MIME type utilities — Single Source of Truth for MIME ↔ format/extension mappings.
 *
 * Architecture: A unified MIME_REGISTRY defines each format's complete descriptor
 * (canonical MIME, MIME aliases, preferred extension, extension aliases).
 * All derived lookup tables (mimeToFormat, extToFormat, formatToMime, mimeToExt)
 * are generated from this single registry — zero duplication, zero drift.
 *
 * All export-related code should import from here instead of maintaining
 * local MIME lookup tables.
 */

import type { SourceFormat } from './types';

// ═══════════════════════════════════════════════════════════════════════════════
// Unified MIME Registry — Single Source of Truth
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Descriptor for a single image format.
 *
 * Each entry fully describes the MIME/extension universe of one SourceFormat:
 * - `format`: canonical SourceFormat identifier
 * - `mime`: primary MIME type (used for export Content-Type)
 * - `mimeAliases`: additional MIME types that resolve to this format (import)
 * - `ext`: preferred file extension for export filenames
 * - `extAliases`: additional extensions that resolve to this format (import)
 */
interface FormatDescriptor {
  readonly format: SourceFormat;
  readonly mime: string;
  readonly mimeAliases?: readonly string[];
  readonly ext: string;
  readonly extAliases?: readonly string[];
}

/**
 * The unified format registry.
 *
 * Order matters for readability only — all derived maps are built programmatically.
 * To add a new format: add ONE entry here. All lookups update automatically.
 */
const MIME_REGISTRY: readonly FormatDescriptor[] = [
  {
    format: 'jpeg',
    mime: 'image/jpeg',
    ext: 'jpg',
    extAliases: ['jpeg'],
  },
  {
    format: 'png',
    mime: 'image/png',
    ext: 'png',
  },
  {
    format: 'webp',
    mime: 'image/webp',
    ext: 'webp',
  },
  {
    format: 'avif',
    mime: 'image/avif',
    ext: 'avif',
  },
  {
    format: 'tiff',
    mime: 'image/tiff',
    ext: 'tiff',
    extAliases: ['tif'],
  },
  {
    format: 'bmp',
    mime: 'image/bmp',
    mimeAliases: ['image/x-ms-bmp'],
    ext: 'bmp',
  },
  {
    format: 'gif',
    mime: 'image/gif',
    ext: 'gif',
  },
  {
    format: 'heic',
    mime: 'image/heic',
    mimeAliases: ['image/heif'],
    ext: 'heic',
    extAliases: ['heif'],
  },
  {
    format: 'svg',
    mime: 'image/svg+xml',
    ext: 'svg',
  },
  {
    format: 'eps',
    mime: 'application/postscript',
    mimeAliases: ['application/eps', 'image/x-eps'],
    ext: 'eps',
    extAliases: ['epsf'],
  },
] as const;

// ═══════════════════════════════════════════════════════════════════════════════
// Derived Lookup Tables (generated from MIME_REGISTRY, zero manual duplication)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * MIME type → SourceFormat lookup.
 * Covers canonical MIME + all aliases for every registered format.
 */
export const mimeToFormat: Record<string, SourceFormat> = (() => {
  const map: Record<string, SourceFormat> = {};
  for (const desc of MIME_REGISTRY) {
    map[desc.mime] = desc.format;
    if (desc.mimeAliases) {
      for (const alias of desc.mimeAliases) {
        map[alias] = desc.format;
      }
    }
  }
  return map;
})();

/**
 * File extension → SourceFormat lookup.
 * Covers preferred extension + all aliases for every registered format.
 */
export const extToFormat: Record<string, SourceFormat> = (() => {
  const map: Record<string, SourceFormat> = {};
  for (const desc of MIME_REGISTRY) {
    map[desc.ext] = desc.format;
    if (desc.extAliases) {
      for (const alias of desc.extAliases) {
        map[alias] = desc.format;
      }
    }
  }
  return map;
})();

/**
 * SourceFormat → canonical MIME type lookup.
 * Maps each format to its primary MIME type (used for export Content-Type headers).
 */
export const formatToMime: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const desc of MIME_REGISTRY) {
    map[desc.format] = desc.mime;
  }
  return map;
})();

/**
 * MIME type → preferred file extension lookup.
 * Covers canonical MIME + all aliases → the preferred extension for that format.
 * Used for generating export filenames.
 */
export const mimeToExt: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const desc of MIME_REGISTRY) {
    map[desc.mime] = desc.ext;
    if (desc.mimeAliases) {
      for (const alias of desc.mimeAliases) {
        map[alias] = desc.ext;
      }
    }
  }
  return map;
})();


// ═══════════════════════════════════════════════════════════════════════════════
// Camera RAW Detection
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

// ═══════════════════════════════════════════════════════════════════════════════
// Unified Format Detection
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Detects the source format of a file from MIME type and extension.
 * Uses mimeToFormat and extToFormat lookup tables,
 * with Camera RAW as a special fallback (many vendor MIME types + extensions).
 */
export function detectFormat(file: File): SourceFormat {
  const type = file.type.toLowerCase();

  // 1. Try MIME type lookup (covers standard + non-standard MIME types)
  const fromMime = mimeToFormat[type];
  if (fromMime) return fromMime;

  // 2. Try extension lookup
  const ext = file.name.toLowerCase().split('.').pop() || '';
  const fromExt = extToFormat[ext];
  if (fromExt) return fromExt;

  // 3. Camera RAW (many vendor-specific extensions/MIME types — kept as separate sets)
  if (RAW_EXTENSIONS.has(ext) || RAW_MIME_TYPES.has(type)) return 'raw';

  return 'unknown';
}
