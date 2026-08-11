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
 * Shared Inference Backend — Tile Utilities
 *
 * Provides tile-based inference infrastructure for splitting large images into
 * manageable chunks, processing them individually, and blending the results
 * back together seamlessly.
 *
 * Extracted from upscaler/worker.ts. Used by OrtSession and
 * TransformersSession for built-in tile inference.
 *
 * Functions:
 *   - computeTiles(): Calculate tile positions with overlap
 *   - extractTile(): Extract pixel data for a tile from source image
 *   - padTile(): Reflect-pad partial edge tiles to full tile size
 *   - unpadTile(): Remove padding from processed tile output
 *   - pasteTileBlend(): Paste tile into output with overlap linear blending
 *
 * ⚠️ This file is imported by Web Workers — keep it free of DOM/React deps.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** Describes the position and size of a single tile in the source image. */
export interface TileSpec {
  sx: number; sy: number;  // Source position (input image coords)
  sw: number; sh: number;  // Source tile size (may be < tileSize at edges)
}

// ─── Compute Tiles ───────────────────────────────────────────────────────────

/**
 * Split an image into tiles with overlap for seamless blending.
 *
 * Tiles step by (tileSize - overlap) pixels. Edge tiles may be smaller
 * than tileSize (handled by padTile at inference time).
 *
 * @param width - Source image width
 * @param height - Source image height
 * @param tileSize - Target tile size in pixels
 * @param overlap - Overlap between adjacent tiles in pixels
 * @returns Array of TileSpec describing each tile's position/size
 */
export function computeTiles(
  width: number, height: number,
  tileSize: number, overlap: number,
): TileSpec[] {
  const tiles: TileSpec[] = [];
  const step = tileSize - overlap;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const sw = Math.min(tileSize, width - x);
      const sh = Math.min(tileSize, height - y);
      tiles.push({ sx: x, sy: y, sw, sh });
    }
  }
  return tiles;
}

// ─── Extract Tile ────────────────────────────────────────────────────────────

/**
 * Extract a tile's RGBA pixel data from the source image.
 *
 * @param srcData - Source image RGBA data
 * @param srcWidth - Source image width
 * @param sx - Tile X position in source
 * @param sy - Tile Y position in source
 * @param sw - Tile width
 * @param sh - Tile height
 * @returns RGBA Uint8Array for the tile region
 */
export function extractTile(
  srcData: Uint8Array, srcWidth: number,
  sx: number, sy: number, sw: number, sh: number,
): Uint8Array {
  const tile = new Uint8Array(sw * sh * 4);
  for (let y = 0; y < sh; y++) {
    const srcOffset = ((sy + y) * srcWidth + sx) * 4;
    const dstOffset = y * sw * 4;
    tile.set(srcData.subarray(srcOffset, srcOffset + sw * 4), dstOffset);
  }
  return tile;
}

// ─── Pad Tile ────────────────────────────────────────────────────────────────

/**
 * Reflect-pad a tile to targetSize × targetSize.
 *
 * Edge pixels are reflected (mirrored) rather than zero-padded to avoid
 * border artifacts in the model output.
 *
 * @param tile - Input tile RGBA data
 * @param tileW - Actual tile width
 * @param tileH - Actual tile height
 * @param targetSize - Target padded size (both width and height)
 * @returns Padded RGBA Uint8Array of targetSize × targetSize
 */
export function padTile(
  tile: Uint8Array, tileW: number, tileH: number, targetSize: number,
): Uint8Array {
  if (tileW === targetSize && tileH === targetSize) return tile;

  const padded = new Uint8Array(targetSize * targetSize * 4);
  for (let y = 0; y < targetSize; y++) {
    for (let x = 0; x < targetSize; x++) {
      // Reflect-pad: mirror at boundaries
      let sy = y;
      if (sy >= tileH) {
        sy = 2 * tileH - sy - 2;
        if (sy < 0) sy = 0;
      }
      let sx = x;
      if (sx >= tileW) {
        sx = 2 * tileW - sx - 2;
        if (sx < 0) sx = 0;
      }
      const srcIdx = (sy * tileW + sx) * 4;
      const dstIdx = (y * targetSize + x) * 4;
      padded[dstIdx] = tile[srcIdx];
      padded[dstIdx + 1] = tile[srcIdx + 1];
      padded[dstIdx + 2] = tile[srcIdx + 2];
      padded[dstIdx + 3] = tile[srcIdx + 3];
    }
  }
  return padded;
}

// ─── Unpad Tile ──────────────────────────────────────────────────────────────

/**
 * Remove padding from a processed tile output.
 *
 * Extracts only the valid region (validW × validH) from a full padded
 * output (paddedW × paddedH).
 *
 * @param paddedOutput - Full padded output RGBA data
 * @param paddedW - Padded output width
 * @param validW - Valid (unpadded) output width
 * @param validH - Valid (unpadded) output height
 * @returns RGBA Uint8Array containing only the valid region
 */
export function unpadTile(
  paddedOutput: Uint8Array, paddedW: number,
  validW: number, validH: number,
): Uint8Array {
  if (validW === paddedW) {
    // Width matches — just trim rows
    return new Uint8Array(paddedOutput.buffer, paddedOutput.byteOffset, validW * validH * 4);
  }
  const out = new Uint8Array(validW * validH * 4);
  for (let y = 0; y < validH; y++) {
    const srcOffset = y * paddedW * 4;
    const dstOffset = y * validW * 4;
    out.set(paddedOutput.subarray(srcOffset, srcOffset + validW * 4), dstOffset);
  }
  return out;
}

// ─── Paste Tile with Blending ────────────────────────────────────────────────

/**
 * Paste a processed tile into the output buffer with overlap linear blending.
 *
 * In overlap regions (left and top edges of non-first tiles), pixel values
 * are linearly interpolated between the existing output and the new tile
 * to create seamless transitions.
 *
 * @param output - Output image buffer (modified in place)
 * @param outWidth - Output image width
 * @param outHeight - Output image height
 * @param tileData - Processed tile RGBA data
 * @param tileWidth - Tile width
 * @param tileHeight - Tile height
 * @param dx - Destination X position in output
 * @param dy - Destination Y position in output
 * @param overlapPx - Overlap in output-space pixels
 * @param isFirstCol - True if tile is in first column (no left blend)
 * @param isFirstRow - True if tile is in first row (no top blend)
 */
export function pasteTileBlend(
  output: Uint8Array, outWidth: number, outHeight: number,
  tileData: Uint8Array, tileWidth: number, tileHeight: number,
  dx: number, dy: number,
  overlapPx: number,
  isFirstCol: boolean,
  isFirstRow: boolean,
): void {
  for (let y = 0; y < tileHeight; y++) {
    const outY = dy + y;
    if (outY < 0 || outY >= outHeight) continue;

    for (let x = 0; x < tileWidth; x++) {
      const outX = dx + x;
      if (outX < 0 || outX >= outWidth) continue;

      const srcIdx = (y * tileWidth + x) * 4;
      const dstIdx = (outY * outWidth + outX) * 4;

      // Compute blend weight for overlap regions
      let weight = 1.0;

      // Left overlap blend (only if not first column)
      if (!isFirstCol && x < overlapPx) {
        weight *= x / overlapPx;
      }
      // Top overlap blend (only if not first row)
      if (!isFirstRow && y < overlapPx) {
        weight *= y / overlapPx;
      }

      if (weight >= 1.0) {
        // No blending needed — direct write
        output[dstIdx] = tileData[srcIdx];
        output[dstIdx + 1] = tileData[srcIdx + 1];
        output[dstIdx + 2] = tileData[srcIdx + 2];
        output[dstIdx + 3] = tileData[srcIdx + 3];
      } else {
        // Linear blend with existing pixel
        const invWeight = 1.0 - weight;
        output[dstIdx] = Math.round(output[dstIdx] * invWeight + tileData[srcIdx] * weight);
        output[dstIdx + 1] = Math.round(output[dstIdx + 1] * invWeight + tileData[srcIdx + 1] * weight);
        output[dstIdx + 2] = Math.round(output[dstIdx + 2] * invWeight + tileData[srcIdx + 2] * weight);
        output[dstIdx + 3] = Math.round(output[dstIdx + 3] * invWeight + tileData[srcIdx + 3] * weight);
      }
    }
  }
}
