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
import { TILE_SIZE } from '@opengpex/editor/core/helpers/tiling';

/**
 * Per-asset mipmap cache. Maps asset hash → array of ImageBitmap levels.
 * Level 0 = full resolution, Level N = 2^N downscale.
 */
const mipmapCache = new Map<string, ImageBitmap[]>();

export class TileHandler {
  /**
   * Handle a GET_TILE job dispatched by the router.
   * Returns ImageBitmap for tiles with content, or null for fully-transparent tiles
   * (Sparse Tile optimization — Phase 3 of tile flicker fix).
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

    // [Sparse Tile] Detect fully-transparent tile — skip storage & rendering.
    // Paint layers are mostly transparent; detecting empty tiles reduces cache
    // usage from ~176 tiles to ~10-30 tiles for a typical paint layer.
    if (this.isTileEmpty(ctx, TILE_SIZE, TILE_SIZE)) {
      return { result: null, transfer: [] };
    }

    const tileBitmap = canvas.transferToImageBitmap();

    return {
      result: tileBitmap,
      transfer: [tileBitmap],
    };
  }

  /**
   * Fast check: are all pixels in the tile fully transparent (alpha === 0)?
   * Uses getImageData to read the alpha channel. For a 256×256 tile this reads
   * 256 KB — negligible compared to the createImageBitmap cost already paid.
   */
  private isTileEmpty(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number): boolean {
    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;
    // Check alpha channel (every 4th byte starting at offset 3)
    for (let i = 3, len = data.length; i < len; i += 4) {
      if (data[i] !== 0) return false;
    }
    return true;
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

    // Build downsampled mipmap levels (aligned with computeMipmapLevelCount stop condition)
    let currW = width;
    let currH = height;
    while (currW > TILE_SIZE || currH > TILE_SIZE) {
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
