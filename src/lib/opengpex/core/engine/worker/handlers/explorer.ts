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
 * handlers/explorer.ts: Asset exploration handler
 */

import { TileMetadata } from '@opengpex/editor/core/types';
import { workerCache } from '../core/WorkerCache';
import { PixelUtils } from '../../PixelUtils';

export async function decodeAndGetMetadata(id: string, blob: Blob): Promise<TileMetadata> {
  // 1. Backup Blob
  if (!workerCache.blobCache.has(id)) {
    workerCache.blobCache.set(id, blob);
  }

  // 2. If already in processing
  const existing = workerCache.pendingDecodes.get(id);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const sourceBitmap = await createImageBitmap(blob);
      const { width, height } = sourceBitmap;
      
      const contentBounds = await PixelUtils.calculateContentBounds(sourceBitmap);
      const tileSize = 256;
      const levels: ImageBitmap[] = [sourceBitmap];
      
      let currW = width;
      let currH = height;
      while (currW > tileSize * 2 || currH > tileSize * 2) {
        currW = Math.floor(currW / 2);
        currH = Math.floor(currH / 2);
        const lastLevel = levels[levels.length - 1];
        const mip = await createImageBitmap(lastLevel, {
          resizeWidth: currW,
          resizeHeight: currH,
          resizeQuality: 'medium'
        });
        levels.push(mip);
      }

      workerCache.touch(id, levels);

      const cols = Math.ceil(width / tileSize);
      const rows = Math.ceil(height / tileSize);
      const isTiled = width > 512 || height > 512;

      return { width, height, tileSize, cols, rows, levels: levels.length, contentBounds, isTiled };
    } finally {
      workerCache.pendingDecodes.delete(id);
    }
  })();

  workerCache.pendingDecodes.set(id, promise);
  return promise;
}

export async function getTile(id: string, level: number, x: number, y: number): Promise<ImageBitmap> {
  let levels = workerCache.getBitmaps(id);
  
  if (!levels) {
    const blob = workerCache.blobCache.get(id);
    if (!blob) throw new Error(`Asset ${id} not found in worker`);
    await decodeAndGetMetadata(id, blob);
    levels = workerCache.getBitmaps(id)!;
  }

  const bitmap = levels[level];
  const tileSize = 256;
  
  const canvas = new OffscreenCanvas(tileSize, tileSize);
  const offCtx2d = canvas.getContext('2d')!;
  
  offCtx2d.drawImage(
    bitmap,
    x * tileSize, y * tileSize, tileSize, tileSize,
    0, 0, tileSize, tileSize
  );

  return canvas.transferToImageBitmap();
}
