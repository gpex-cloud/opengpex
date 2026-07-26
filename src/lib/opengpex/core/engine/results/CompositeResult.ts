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
 * CompositeResult — concrete result type for composite operations.
 *
 * Extends PixelResult with composite-specific convenience methods:
 *   - `trimmed()` → crop transparent margins and return a new CompositeResult
 *
 * Standard consumption:
 *   - result.toAsset()     → register in AssetService, auto cache warming
 *   - result.toBlob()      → get the raw composited blob
 *   - result.toImageData() → get pixel data for CPU inspection
 *   - result.trimmed()     → trim transparent edges, get offset
 */

import { PixelResult } from './PixelResult';
import type { PixelResultData } from '../protocol/results';
import type { AssetService } from '@opengpex/editor/core/types';
import { canvasToBlob, calculateHash, buildTileMeta } from '../utils/pixel-utils';

export class CompositeResult extends PixelResult {
  constructor(data: PixelResultData, assets: AssetService) {
    super(data, assets);
  }

  /**
   * Trim transparent margins: crop all-transparent pixels around edges.
   * Returns a new CompositeResult with adjusted bounds + the pixel offset.
   *
   * Returns `null` if the entire image is fully transparent (nothing to crop).
   */
  async trimmed(): Promise<{ result: CompositeResult; offset: { x: number; y: number } } | null> {
    const imageData = await this.toImageData();
    const { data, width, height } = imageData;

    // Scan for non-transparent pixel bounds
    let top = height;
    let bottom = 0;
    let left = width;
    let right = 0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const alpha = data[(y * width + x) * 4 + 3];
        if (alpha > 0) {
          if (y < top) top = y;
          if (y > bottom) bottom = y;
          if (x < left) left = x;
          if (x > right) right = x;
        }
      }
    }

    // Fully transparent — nothing to trim
    if (top > bottom || left > right) return null;

    const trimW = right - left + 1;
    const trimH = bottom - top + 1;

    // Extract trimmed region
    const canvas = new OffscreenCanvas(trimW, trimH);
    const ctx = canvas.getContext('2d')!;
    const trimmedBitmap = await createImageBitmap(imageData, left, top, trimW, trimH);
    ctx.drawImage(trimmedBitmap, 0, 0);
    trimmedBitmap.close();

    const blob = await canvasToBlob(canvas);
    const hash = await calculateHash(blob);
    const tileMeta = buildTileMeta(trimW, trimH, 1);

    const newData: PixelResultData = {
      blob,
      hash,
      tileMeta,
      depth: this.depth,
      bounds: {
        x: this.bounds.x + left,
        y: this.bounds.y + top,
        w: trimW,
        h: trimH,
      },
    };

    return {
      result: new CompositeResult(newData, this.assets),
      offset: { x: left, y: top },
    };
  }
}
