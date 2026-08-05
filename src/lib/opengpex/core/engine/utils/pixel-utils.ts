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
 * pixel-utils.ts — Pure utility functions for pixel processing.
 *
 * Extracted from v1 `PixelUtils.ts`. These are stateless, side-effect-free
 * functions that can be safely shared across main thread and Worker.
 *
 * Design rules:
 * - No external service dependencies.
 * - No DOM manipulation (beyond OffscreenCanvas which works in Workers).
 * - All functions are async where browser APIs require it.
 */

import type { LocalRect, TileMetadata } from '@opengpex/editor/core/types';
import { buildTileMeta } from '@opengpex/editor/core/helpers/tiling';

/**
 * Compute SHA-256 hash of a Blob.
 * Used for content-addressable asset identification.
 */
export async function calculateHash(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Convert an OffscreenCanvas to a Blob.
 * Works in both main thread and Worker contexts.
 */
export async function canvasToBlob(
  canvas: OffscreenCanvas,
  type = 'image/png',
  quality = 0.92,
): Promise<Blob> {
  return canvas.convertToBlob({ type, quality });
}

// buildTileMeta re-exported from canonical source for backward compatibility
export { buildTileMeta };

/**
 * Scan visible region of a bitmap (Content Bounds Detection).
 * Returns the tight bounding box of non-transparent pixels.
 *
 * Uses four-edge shrink algorithm with early exit for optimal performance:
 * - Top: scan rows top→down, stop at first row with any opaque pixel
 * - Bottom: scan rows bottom→up, stop at first row with any opaque pixel
 * - Left/Right: scan only within [top, bottom] range, with progressive narrowing
 *
 * Typical performance: 4K canvas with 20% stroke coverage → ~3-8ms (vs ~15ms full scan)
 */
export async function calculateContentBounds(bitmap: ImageBitmap): Promise<LocalRect> {
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) {
    return { x: 0, y: 0, w: width, h: height } as LocalRect;
  }

  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, width, height);
  return calculateContentBoundsFromImageData(imageData, width, height);
}

/**
 * Calculate content bounds directly from ImageData (avoids extra bitmap/canvas allocation).
 *
 * Preferred when caller already has a canvas context available — call ctx.getImageData()
 * and pass it here to skip the intermediate ImageBitmap → OffscreenCanvas → drawImage round-trip.
 */
export function calculateContentBoundsFromImageData(
  imageData: ImageData,
  width: number,
  height: number,
): LocalRect {
  const data = imageData.data;

  // 1. Top → find first row with any opaque pixel
  let top = -1;
  topScan: for (let y = 0; y < height; y++) {
    const rowBase = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[rowBase + x * 4 + 3] > 0) { top = y; break topScan; }
    }
  }

  // Fully transparent bitmap — return full canvas bounds
  if (top === -1) {
    return { x: 0, y: 0, w: width, h: height } as LocalRect;
  }

  // 2. Bottom → find last row with any opaque pixel
  let bottom = top;
  bottomScan: for (let y = height - 1; y > top; y--) {
    const rowBase = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[rowBase + x * 4 + 3] > 0) { bottom = y; break bottomScan; }
    }
  }

  // 3. Left → scan only within [top, bottom] rows, progressively narrowing
  let left = width - 1;
  for (let y = top; y <= bottom; y++) {
    const rowBase = y * width * 4;
    for (let x = 0; x < left; x++) {
      if (data[rowBase + x * 4 + 3] > 0) { left = x; break; }
    }
  }

  // 4. Right → scan only within [top, bottom] rows, progressively narrowing
  let right = 0;
  for (let y = top; y <= bottom; y++) {
    const rowBase = y * width * 4;
    for (let x = width - 1; x > right; x--) {
      if (data[rowBase + x * 4 + 3] > 0) { right = x; break; }
    }
  }

  return {
    x: left,
    y: top,
    w: right - left + 1,
    h: bottom - top + 1,
    __brand: 'local',
  } as LocalRect;
}

/**
 * Wrap a result blob with hash + TileMetadata (convenience for handlers).
 */
export async function wrapResult(
  blob: Blob,
  dprScale?: number,
): Promise<{ blob: Blob; hash: string; tileMeta: TileMetadata }> {
  const hash = await calculateHash(blob);
  const bitmap = await createImageBitmap(blob);
  const tileMeta = buildTileMeta(bitmap.width, bitmap.height, dprScale ?? 1);
  bitmap.close();
  return { blob, hash, tileMeta };
}

/**
 * Fetch image from URL and convert to File object.
 */
export async function fetchFromUrl(url: string): Promise<File> {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Network response was not ok');
  const blob = await response.blob();
  const filename = url.split('/').pop() || 'downloaded-image';
  return new File([blob], filename, { type: blob.type });
}

/**
 * Trigger browser download of a Blob.
 */
export async function download(blob: Blob, name: string): Promise<void> {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
