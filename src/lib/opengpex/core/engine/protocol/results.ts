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
 * results.ts — Unified result data format returned by Worker to main thread.
 *
 * All operations (composite/resample/filter/rasterize) share this shape.
 * The main-thread PixelResult class wraps this data and provides
 * convenience methods (toAsset, toBlob, toImageData).
 */

import type { Rect, TileMetadata } from '@opengpex/editor/core/types';

/**
 * Worker-produced result payload.
 * Transferred back to main thread via postMessage.
 */
export interface PixelResultData {
  blob: Blob;
  hash: string;
  tileMeta: TileMetadata;
  depth: 8 | 16 | 32;
  bounds: Rect;
}
