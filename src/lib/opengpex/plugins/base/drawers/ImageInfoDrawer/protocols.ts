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

export type ExportFormat = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/avif';

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
}

/* Constants */
// export const RESOLUTION_PRESETS = [256, 384, 512, 768, 1024, 1536, 2048, 4096];

/* Command IDs */
export const CMD_DOWNLOAD = 'cmd.download';
export const CMD_APPLY_RESIZE = 'cmd.apply_resize';
