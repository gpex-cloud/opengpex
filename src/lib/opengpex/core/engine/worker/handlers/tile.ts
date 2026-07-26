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
 * TileHandler — Worker-side handler for GET_TILE jobs.
 *
 * Adapted from v1 `worker/handlers/explorer.ts` (getTile function):
 * - Builds mipmap pyramid on demand from the full-res bitmap in WorkerCache.
 * - Extracts a 256×256 tile at the specified (level, x, y) position.
 * - Transfers the tile ImageBitmap back to the main thread (zero-copy).
 *
 * Mipmap levels are cached per-asset to avoid re-computation on repeated tile requests.
 */

import type { GetTileJob } from '../../protocol/jobs';
import { workerCache } from '../cache/WorkerCache';
import type { RouterResult } from '../router';

const TILE_SIZE = 256;

/**
 * Per-asset mipmap cache. Maps asset hash → array of ImageBitmap levels.
 * Level 0 = full resolution, Level N = 2^N downscale.
 */
const mipmapCache = new Map<string, ImageBitmap[]>();

export class TileHandler {
  /**
   * Handle a GET_TILE job dispatched by the router.
   */
  async handle(job: GetTileJob): Promise<RouterResult> {
    const { hash, level, x, y } = job;

    // Ensure mipmap pyramid exists for this asset
    const levels = await this.ensureMipmap(hash);

    // Clamp level to available range
    const effectiveLevel = Math.min(level, levels.length - 1);
    const bitmap = levels[effectiveLevel];

    // Extract tile at (x, y) from the mipmap level
    const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
    const ctx = canvas.getContext('2d')!;

    ctx.drawImage(
      bitmap,
      x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE,
      0, 0, TILE_SIZE, TILE_SIZE,
    );

    const tileBitmap = canvas.transferToImageBitmap();

    return {
      result: tileBitmap,
      transfer: [tileBitmap],
    };
  }

  /**
   * Build or retrieve the mipmap pyramid for a given asset hash.
   * Uses the full-resolution bitmap from WorkerCache as the base level.
   */
  private async ensureMipmap(hash: string): Promise<ImageBitmap[]> {
    const existing = mipmapCache.get(hash);
    if (existing) return existing;

    const sourceBitmap = workerCache.getBitmap(hash);
    if (!sourceBitmap) {
      throw new Error(`[TileHandler] Asset "${hash}" not found in WorkerCache`);
    }

    const { width, height } = sourceBitmap;
    const levels: ImageBitmap[] = [sourceBitmap];

    // Build downsampled mipmap levels until both dimensions fit in 2×TILE_SIZE
    let currW = width;
    let currH = height;
    while (currW > TILE_SIZE * 2 || currH > TILE_SIZE * 2) {
      currW = Math.floor(currW / 2);
      currH = Math.floor(currH / 2);
      const lastLevel = levels[levels.length - 1];
      const mip = await createImageBitmap(lastLevel, {
        resizeWidth: currW,
        resizeHeight: currH,
        resizeQuality: 'medium',
      });
      levels.push(mip);
    }

    mipmapCache.set(hash, levels);
    return levels;
  }

  /**
   * Evict cached mipmap for a given asset (called when asset is removed).
   */
  evict(hash: string): void {
    const levels = mipmapCache.get(hash);
    if (levels) {
      // Don't close level 0 — it's the shared bitmap from WorkerCache
      for (let i = 1; i < levels.length; i++) {
        levels[i].close();
      }
      mipmapCache.delete(hash);
    }
  }
}
