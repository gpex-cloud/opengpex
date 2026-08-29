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
 * tiling.ts — Pure utility functions for tile metadata computation.
 *
 * Single Source of Truth for tile grid layout and mipmap level count.
 * Guarantees exact match between metadata declaration (AssetService)
 * and Worker mipmap construction (TileHandler).
 *
 * Design rules:
 * - No external service dependencies.
 * - No I/O, no DOM manipulation, no side effects.
 * - All functions are synchronous and deterministic.
 */

import type { TileMetadata, TileData } from '@opengpex/editor/core/types';

// ─── Diagnostic Logging (toggle via: window.__TILE_FLICKER_DEBUG = true) ───
declare global {
  interface Window { __TILE_FLICKER_DEBUG?: boolean; }
}
function _tileDbg(): boolean {
  return typeof window !== 'undefined' && !!(window as Window).__TILE_FLICKER_DEBUG;
}

/** Tile size for the rendering pipeline (256×256 per tile) */
export const TILE_SIZE = 256;

/**
 * Sentinel value for tiles known to be fully transparent (alpha === 0 everywhere).
 * Sparse Tile optimization (Phase 3): Paint layers are mostly transparent — empty tiles
 * are detected by the Worker and tracked via this sentinel. They cost zero LRU budget
 * and zero draw calls.
 *
 * Usage: `tileCache.get() === TILE_EMPTY` → skip drawing, not a miss.
 */
export const TILE_EMPTY: unique symbol = Symbol('TILE_EMPTY');
export type TileEmpty = typeof TILE_EMPTY;

/** Threshold above which tiled rendering is activated */
const TILED_THRESHOLD = 512;

/**
 * Compute mipmap level count via iterative halving.
 * Single Source of Truth — guarantees exact match between
 * metadata declaration and Worker mipmap construction.
 */
function computeMipmapLevelCount(w: number, h: number): number {
  let levels = 1;
  let currW = w;
  let currH = h;
  while (currW > TILE_SIZE || currH > TILE_SIZE) {
    currW = Math.floor(currW / 2);
    currH = Math.floor(currH / 2);
    levels++;
  }
  return levels;
}

/**
 * Build complete TileMetadata from image dimensions.
 * Pure computation — no I/O, no blob decoding, no side effects.
 */
export function buildTileMeta(w: number, h: number, dprScale = 1): TileMetadata {
  return {
    width: w,
    height: h,
    tileSize: TILE_SIZE,
    cols: Math.ceil(w / TILE_SIZE),
    rows: Math.ceil(h / TILE_SIZE),
    levels: computeMipmapLevelCount(w, h),
    isTiled: w > TILED_THRESHOLD || h > TILED_THRESHOLD,
    dprScale,
  };
}

// ─── Tile Job Computation ────────────────────────────────────────────────────

/**
 * Tile source interface — duck type matching TileCache.get().
 * Return values:
 * - ImageBitmap/HTMLImageElement — tile has content, draw it.
 * - TILE_EMPTY — tile is known to be fully transparent (skip, not a miss).
 * - null/undefined — tile not yet loaded (cache miss).
 */
export interface TileSource {
  get(assetId: string, level: number, x: number, y: number): ImageBitmap | HTMLImageElement | TileEmpty | null | undefined;
}

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
 * @returns Object with tileCount (cache hits written to pool) and missCount (cache misses).
 */
export interface TileJobResult {
  tileCount: number;
  missCount: number;
}

export function computeTileJobs(
  layerAssetId: string,
  tileMeta: TileMetadata,
  matrix: { a: number; b: number; c: number; d: number; tx: number; ty: number } | undefined,
  drawRect: { x: number; y: number; w: number; h: number } | undefined,
  isExporting: boolean,
  tilePool: TileData[],
  tileSource: TileSource,
): TileJobResult {
  const { tileSize, width, height, levels } = tileMeta;
  const s = tileMeta.dprScale || 1;
  const scaleX = matrix ? Math.sqrt(matrix.a * matrix.a + matrix.b * matrix.b) : 1;
  const visualScaleX = scaleX / s;

  // LOD selection with safety constraint:
  // TileCache has a global LRU limit of 500. With 2-3 tiled layers, per-layer budget ≈ 200.
  // If the natural LOD level would require more visible tiles than the budget allows,
  // we force a coarser mipmap level (fewer, larger tiles). This prevents cache thrashing
  // that would otherwise cause permanent fallback to the expensive single-image path.
  const MAX_TILES_PER_LAYER = 200;
  let level = Math.max(0, Math.min(Math.floor(Math.log2(1 / visualScaleX)), levels - 1));

  const logicalWidth = width / s;
  const logicalHeight = height / s;
  const dRect = drawRect || { x: 0, y: 0, w: logicalWidth, h: logicalHeight };
  const physicalDRect = {
    x: dRect.x * s,
    y: dRect.y * s,
    w: dRect.w * s,
    h: dRect.h * s,
  };

  // LOD safety constraint: ensure visible tile count ≤ budget
  while (level < levels - 1) {
    const r = Math.pow(2, level);
    const st = tileSize * r;
    const sc = Math.max(0, Math.floor(physicalDRect.x / st));
    const ec = Math.min(Math.ceil(width / st) - 1, Math.ceil((physicalDRect.x + physicalDRect.w) / st));
    const sr = Math.max(0, Math.floor(physicalDRect.y / st));
    const er = Math.min(Math.ceil(height / st) - 1, Math.ceil((physicalDRect.y + physicalDRect.h) / st));
    const visibleCount = (ec - sc + 1) * (er - sr + 1);
    if (visibleCount <= MAX_TILES_PER_LAYER) break;
    level++;
  }

  const ratio = Math.pow(2, level);
  const scaledTileSize = tileSize * ratio;

  const overlap = isExporting ? 0 : (1.0 / (ratio * visualScaleX));

  const startCol = Math.max(0, Math.floor(physicalDRect.x / scaledTileSize));
  const endCol = Math.min(Math.ceil(width / scaledTileSize) - 1, Math.ceil((physicalDRect.x + physicalDRect.w) / scaledTileSize));
  const startRow = Math.max(0, Math.floor(physicalDRect.y / scaledTileSize));
  const endRow = Math.min(Math.ceil(height / scaledTileSize) - 1, Math.ceil((physicalDRect.y + physicalDRect.h) / scaledTileSize));

  let tileCount = 0;
  let _missCount = 0;
  let _emptyCount = 0;
  const _missList: string[] = [];

  // [Perf] Early-exit budget: once missCount exceeds this threshold, the caller
  // will use the single-image fallback anyway (missCount > 0). Continuing to
  // iterate only triggers more tileCache.get() calls that each schedule an async
  // Worker fetch. By breaking early, we avoid flooding the Worker with ~100+
  // fetch messages in a single frame (~7ms overhead). Remaining tiles are fetched
  // incrementally: each tile completion triggers notifyCoalesced → needsRender →
  // next computeTileJobs call kicks the next batch.
  const EARLY_EXIT_MISS_BUDGET = 8;

  for (let y = startRow; y <= endRow; y++) {
    for (let x = startCol; x <= endCol; x++) {
      const result = tileSource.get(layerAssetId, level, x, y);

      // [Sparse Tile] Skip known-empty tiles — don't draw, don't count as miss.
      if (result === TILE_EMPTY) {
        _emptyCount++;
        continue;
      }

      if (result) {
        if (tileCount >= tilePool.length) {
          tilePool.push({
            bitmap: result,
            x: (x * scaledTileSize) / s,
            y: (y * scaledTileSize) / s,
            scale: ratio / s,
            overlap,
          });
        } else {
          const tile = tilePool[tileCount];
          tile.bitmap = result;
          tile.x = (x * scaledTileSize) / s;
          tile.y = (y * scaledTileSize) / s;
          tile.scale = ratio / s;
          tile.overlap = overlap;
        }
        tileCount++;
      } else {
        _missCount++;
        if (_missList.length < 8) _missList.push(`(${x},${y})`);
        // [Perf] Stop kicking new fetches once we've exceeded the budget.
        // The fallback path is guaranteed (missCount > 0); remaining tiles
        // will be requested on subsequent frames as loaded tiles trigger re-renders.
        if (_missCount >= EARLY_EXIT_MISS_BUDGET) break;
      }
    }
    if (_missCount >= EARLY_EXIT_MISS_BUDGET) break;
  }

  // ─── Diagnostic: tile job summary per layer ───
  if (_tileDbg()) {
    const totalExpected = (endRow - startRow + 1) * (endCol - startCol + 1);
    console.log(
      `[TileJobs] asset=${layerAssetId.slice(0, 8)}… | LOD=${level}/${levels - 1} | ` +
      `zoom=${visualScaleX.toFixed(4)} | grid=[${startCol}..${endCol}]×[${startRow}..${endRow}] | ` +
      `expected=${totalExpected} hit=${tileCount} miss=${_missCount} empty=${_emptyCount}` +
      (_missCount > 0 ? ` | missed=${_missList.join(',')}${_missCount > 8 ? '…' : ''}` : ''),
    );
  }

  return { tileCount, missCount: _missCount };
}
