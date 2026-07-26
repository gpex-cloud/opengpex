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
 * FilterResult — concrete result type for filter operations (Phase 4).
 *
 * Extends PixelResult with filter-specific capabilities:
 *   - Carries an optional `ImageBitmap` that Canvas2dEngine can use directly
 *     (avoids redundant decode from blob → bitmap).
 *   - `dispose()` releases the transferred bitmap to free GPU/memory resources.
 *
 * Standard consumption:
 *   - result.toAsset()     → register in AssetService, auto cache warming
 *   - result.toBlob()      → get the raw filtered blob
 *   - result.toImageData() → get pixel data for CPU inspection
 *   - result.bitmap        → direct ImageBitmap reference for Canvas2dEngine
 *   - result.dispose()     → release bitmap resources when no longer needed
 */

import { PixelResult } from './PixelResult';
import type { PixelResultData } from '../protocol/results';
import type { AssetService } from '@opengpex/editor/core/types';

/**
 * Extended result data returned by the Worker FilterHandler.
 * Includes an optional ImageBitmap transferred alongside the blob.
 */
export interface FilterResultData extends PixelResultData {
  bitmap?: ImageBitmap;
}

/**
 * FilterResult — Worker-produced filtered image.
 *
 * The `bitmap` field provides a zero-copy ImageBitmap reference that was
 * transferred from the Worker. Canvas2dEngine uses it directly for rendering
 * without needing to decode the blob again.
 */
export class FilterResult extends PixelResult {
  private _bitmap: ImageBitmap | null;

  constructor(data: FilterResultData, assets: AssetService) {
    super(data, assets);
    this._bitmap = data.bitmap ?? null;
  }

  /**
   * Get the ImageBitmap for direct use in Canvas2dEngine.
   * Avoids redundant blob → bitmap decode on the main thread.
   */
  get bitmap(): ImageBitmap | null {
    return this._bitmap;
  }

  /**
   * Release the bitmap resource.
   * Call this when the result is evicted from FilterCache or replaced by a newer result.
   */
  dispose(): void {
    if (this._bitmap) {
      this._bitmap.close();
      this._bitmap = null;
    }
  }
}
