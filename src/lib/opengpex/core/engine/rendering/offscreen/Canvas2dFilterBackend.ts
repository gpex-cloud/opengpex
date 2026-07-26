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
 * Canvas2dFilterBackend — Worker-side 8-bit filter execution engine.
 *
 * Counterpart to `Canvas2dBackend.ts` (compositing backend). This module
 * handles the pixel-level filter chain for the 8-bit path.
 *
 * Architecture (aligned with CompositorHandler pattern):
 *   FilterHandler → Canvas2dFilterBackend → shared/filter2d (pure algorithms)
 *
 * Responsibilities:
 * - Accept an owned ImageBitmap (transferred from main thread)
 * - Decode bitmap to RGBA8 ImageData
 * - Apply filter chain (LUT fuse → color matrix → neighborhood ops)
 * - Encode result back to ImageBitmap
 * - Return result bitmap for transfer back to main thread
 *
 * Runs exclusively in the Worker thread. Uses OffscreenCanvas for decode/encode.
 *
 * Phase 6.9 refactor: source bitmap is now received directly via transfer
 * (no longer resolved from WorkerCache by hash). This eliminates the blob
 * encoding → hash → ENSURE_ASSET roundtrip on the main thread.
 */

import type { FilterDescriptor } from '../../protocol/IFilter';
import { applyFilterChainRGBA8 } from '../shared/filter2d';

// ────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────

interface RgbaFrame {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

async function bitmapToRgba(source: ImageBitmap): Promise<RgbaFrame> {
  const canvas = new OffscreenCanvas(source.width, source.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('[Canvas2dFilterBackend] failed to acquire 2d context');
  ctx.drawImage(source, 0, 0);
  const img = ctx.getImageData(0, 0, source.width, source.height);
  return { data: img.data, width: source.width, height: source.height };
}

async function rgbaToBitmap(frame: RgbaFrame): Promise<ImageBitmap> {
  const rebound = new Uint8ClampedArray(new ArrayBuffer(frame.data.byteLength));
  rebound.set(frame.data);
  const imageData = new ImageData(rebound, frame.width, frame.height);
  const canvas = new OffscreenCanvas(frame.width, frame.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('[Canvas2dFilterBackend] failed to acquire 2d context');
  ctx.putImageData(imageData, 0, 0);
  return await createImageBitmap(canvas);
}

// ────────────────────────────────────────────────────────────
// Canvas2dFilterBackend
// ────────────────────────────────────────────────────────────

export interface FilterBackendResult {
  bitmap: ImageBitmap;
  key?: string;
}

export class Canvas2dFilterBackend {
  /**
   * Apply a filter chain to an owned source bitmap.
   *
   * Steps:
   * 1. If empty descriptors → passthrough (clone source)
   * 2. Decode source to RGBA8 ImageData
   * 3. Apply full filter chain (LUT + matrix + neighborhood) in-place
   * 4. Encode back to ImageBitmap
   *
   * @param source - Owned ImageBitmap (transferred from main thread). Will be closed.
   * @param descriptors - Ordered filter descriptors to apply
   * @param key - Optional cache key echoed back for bookkeeping
   * @returns Result with bitmap for zero-copy transfer back
   */
  async apply(
    source: ImageBitmap,
    descriptors: FilterDescriptor[],
    key?: string,
  ): Promise<FilterBackendResult> {
    // Empty filter chain — passthrough (clone to maintain ownership contract)
    if (!descriptors || descriptors.length === 0) {
      const passthrough = await createImageBitmap(source);
      source.close();
      return { bitmap: passthrough, key };
    }

    // Decode to RGBA8
    const frame = await bitmapToRgba(source);
    source.close(); // Release the transferred source

    // Apply full filter chain in-place
    applyFilterChainRGBA8(frame.data, frame.width, frame.height, descriptors);

    // Encode back to ImageBitmap
    const filtered = await rgbaToBitmap(frame);

    return { bitmap: filtered, key };
  }
}
