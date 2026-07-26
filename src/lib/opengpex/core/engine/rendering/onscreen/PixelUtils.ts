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
 * PixelUtils — Rendering-specific pure utility functions for Engine V2.
 *
 * Contains tile job computation logic needed by Canvas2dEngine.
 * Adapted from v1 `engine/PixelUtils.ts` (computeTileJobs only).
 * Other v1 utilities (hash, content bounds, etc.) live in `../../utils/pixel-utils.ts`.
 */

import type { TileMetadata, TileData, Layer, ClipDescriptor } from '@opengpex/editor/core/types';

/** Tile source interface — duck type matching TileCache.get() */
interface TileSource {
  get(assetId: string, level: number, x: number, y: number): ImageBitmap | HTMLImageElement | null | undefined;
}

export const PixelUtils = {
  /**
   * getRenderPipeline: Converts layer viewport and masks into abstract clipping instructions.
   */
  getRenderPipeline(layer: Layer): ClipDescriptor[] {
    const pipeline: ClipDescriptor[] = [];
    if (layer.visibleShape) {
      pipeline.push({ shape: layer.visibleShape, inverted: false });
    }
    const activeMasks = layer.vectorMasks?.filter(m => m.enabled);
    if (activeMasks) {
      for (const mask of activeMasks) {
        pipeline.push({ shape: mask.shape, inverted: mask.inverted, feather: mask.feather || 0 });
      }
    }
    return pipeline;
  },

  /**
   * Computes and assembles the tile task queue required for rendering (Data-Driven Tiling).
   * Supports object pool reuse to achieve Zero-Allocation hot path.
   *
   * @param layerAssetId - The asset identifier for tile lookup.
   * @param tileMeta - Tile metadata (dimensions, tileSize, levels, dprScale).
   * @param matrix - Current viewport transform matrix.
   * @param drawRect - Optional sub-region to render (for partial updates).
   * @param isExporting - If true, disables overlap (pixel-exact export).
   * @param tilePool - Reusable tile data array (object pool).
   * @param tileSource - Tile cache implementing `get(assetId, level, x, y)`.
   * @returns Number of valid tile entries written to tilePool.
   */
  computeTileJobs(
    layerAssetId: string,
    tileMeta: TileMetadata,
    matrix: { a: number; b: number; c: number; d: number; tx: number; ty: number } | undefined,
    drawRect: { x: number; y: number; w: number; h: number } | undefined,
    isExporting: boolean,
    tilePool: TileData[],
    tileSource: TileSource,
  ): number {
    const { tileSize, width, height, levels } = tileMeta;
    const s = tileMeta.dprScale || 1;
    const scaleX = matrix ? Math.sqrt(matrix.a * matrix.a + matrix.b * matrix.b) : 1;
    const visualScaleX = scaleX / s;
    const level = Math.max(0, Math.min(Math.floor(Math.log2(1 / visualScaleX)), levels - 1));
    const ratio = Math.pow(2, level);
    const scaledTileSize = tileSize * ratio;

    const logicalWidth = width / s;
    const logicalHeight = height / s;
    const dRect = drawRect || { x: 0, y: 0, w: logicalWidth, h: logicalHeight };

    const overlap = isExporting ? 0 : (1.0 / (ratio * visualScaleX));

    const physicalDRect = {
      x: dRect.x * s,
      y: dRect.y * s,
      w: dRect.w * s,
      h: dRect.h * s,
    };

    const startCol = Math.max(0, Math.floor(physicalDRect.x / scaledTileSize));
    const endCol = Math.min(Math.ceil(width / scaledTileSize) - 1, Math.ceil((physicalDRect.x + physicalDRect.w) / scaledTileSize));
    const startRow = Math.max(0, Math.floor(physicalDRect.y / scaledTileSize));
    const endRow = Math.min(Math.ceil(height / scaledTileSize) - 1, Math.ceil((physicalDRect.y + physicalDRect.h) / scaledTileSize));

    let tileCount = 0;

    for (let y = startRow; y <= endRow; y++) {
      for (let x = startCol; x <= endCol; x++) {
        const bitmap = tileSource.get(layerAssetId, level, x, y);
        if (bitmap) {
          if (tileCount >= tilePool.length) {
            tilePool.push({
              bitmap,
              x: (x * scaledTileSize) / s,
              y: (y * scaledTileSize) / s,
              scale: ratio / s,
              overlap,
            });
          } else {
            const tile = tilePool[tileCount];
            tile.bitmap = bitmap;
            tile.x = (x * scaledTileSize) / s;
            tile.y = (y * scaledTileSize) / s;
            tile.scale = ratio / s;
            tile.overlap = overlap;
          }
          tileCount++;
        }
      }
    }

    return tileCount;
  },
};
