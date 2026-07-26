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
 * PixelResult — unified base class for all Worker operation results.
 *
 * All pixel operations (composite/resample/filter/rasterize) produce
 * a PixelResult. The consuming code uses:
 *   - `toAsset()` → register in AssetService, get id + url + dimensions
 *   - `toBlob()`  → get the raw output blob
 *   - `toImageData()` → get pixel data for CPU inspection
 *
 * Design points:
 * - `toAsset()` returns AssetRef { id, url, dimensions },
 *   eliminating the v1 multi-step pattern.
 * - Cache warming is triggered automatically through AssetService hooks.
 * - Subclasses (CompositeResult, FilterResult, etc.) can add domain-specific
 *   convenience methods in later Phases.
 */

import type { PixelResultData } from '../protocol/results';
import type { AssetService, AssetRef, Rect, TileMetadata } from '@opengpex/editor/core/types';

/**
 * PixelResult — abstract base for all operation results.
 */
export abstract class PixelResult {
  constructor(
    protected readonly data: PixelResultData,
    protected readonly assets: AssetService,
  ) {}

  get hash(): string {
    return this.data.hash;
  }

  get depth(): 8 | 16 | 32 {
    return this.data.depth;
  }

  get bounds(): Rect {
    return this.data.bounds;
  }

  get tileMeta(): TileMetadata {
    return this.data.tileMeta;
  }

  get dimensions(): { w: number; h: number } {
    return { w: this.data.tileMeta.width, h: this.data.tileMeta.height };
  }

  /**
   * Register as asset (one-step):
   * 1. Inject into AssetService
   * 2. Trigger SourceBitmapCache warmFromBlob (via cache warming hook)
   * 3. Return AssetRef { id, url, dimensions }
   *
   * Callers no longer need manual register + getURL + decode.loadBitmap + decode.dimensions.
   */
  async toAsset(): Promise<AssetRef> {
    const id = await this.assets.inject(this.data.hash, this.data.blob, this.data.tileMeta);
    const url = this.assets.getURL(id) ?? '';
    return {
      id,
      url,
      dimensions: { w: this.data.tileMeta.width, h: this.data.tileMeta.height },
    };
  }

  /**
   * Get the result as a Blob. Optionally convert to a different format.
   * @param format - MIME type (e.g. 'image/png', 'image/webp', 'image/jpeg')
   * @param _opts - Encode options (reserved for future format-specific quality/config)
   */
  async toBlob(format?: string, _opts?: unknown): Promise<Blob> {
    if (!format || format === 'image/png') return this.data.blob;
    // Future: format conversion via OffscreenCanvas or encoder using _opts
    return this.data.blob;
  }

  /**
   * Get pixel data as ImageData (for CPU-side inspection/processing).
   */
  async toImageData(): Promise<ImageData> {
    const bitmap = await createImageBitmap(this.data.blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }
}
