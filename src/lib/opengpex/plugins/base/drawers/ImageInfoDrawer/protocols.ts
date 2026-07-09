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

export const PLUGIN_ID = 'drawers.image_info';
export const PLUGIN_AUTHOR = 'opengpex';

export type ExportFormat = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/avif' | 'image/tiff';

export interface ExportConfig {
    pixels: { w: number; h: number };
    lockAspect: boolean;
    format: ExportFormat;
    quality: number;
    keepExif: boolean;
    /** Pending DPI override (0 = use frame.dpi). Committed on Apply. */
    dpi: number;
    /** When true, changing DPI auto-resamples pixels to maintain physical size. */
    resample: boolean;
    /** TIFF compression method (only used when format is 'image/tiff') */
    tiffCompression?: 'none' | 'lzw' | 'zip' | 'jpeg';
    /** JPEG quality for TIFF JPEG compression (1-100, default: 85). Only used when tiffCompression='jpeg'. */
    jpegQuality?: number;
    /** PNG compression level: 0=none/fastest, 6=default, 9=max/slowest (only used when format is 'image/png') */
    pngCompression?: 0 | 6 | 9;
    /** Export bit depth for PNG: 8 or 16 (default: 16 when source is 16-bit) */
    exportBitDepth?: 8 | 16;

    // ─── Advanced TIFF Options ──────────────────────────────────────────
    /** Predictor for LZW/ZIP compression (default: 'horizontal'). Ignored for none/jpeg. */
    tiffPredictor?: 'none' | 'horizontal' | 'float';
    /** Byte order: 'lsb' = little-endian (Intel), 'msb' = big-endian (Motorola). Default: 'lsb'. */
    tiffByteOrder?: 'lsb' | 'msb';
    /** Enable BigTIFF format (supports files >4GB). Default: false. */
    tiffBigtiff?: boolean;
    /** Enable tile-based layout. Default: false (strip-based). JPEG compression forces tiles on. */
    tiffTile?: boolean;
    /** Tile width in pixels (default: 256). Only used when tiffTile=true. */
    tiffTileWidth?: number;
    /** Tile height in pixels (default: 256). Only used when tiffTile=true. */
    tiffTileHeight?: number;
}

/* Constants */
// export const RESOLUTION_PRESETS = [256, 384, 512, 768, 1024, 1536, 2048, 4096];

/* Command IDs */
export const CMD_DOWNLOAD = 'cmd.download';
export const CMD_APPLY_RESIZE = 'cmd.apply_resize';
