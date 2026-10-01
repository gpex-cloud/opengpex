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

import { toCanvasColorSpace } from '@opengpex/editor/core/engine/color/gamut';
import type { LocalRect, GamutId } from '@opengpex/editor/core/types';
import type { CompositedImage } from '../types';

/**
 * Display-track-specific canvas color space mapping — distinct from
 * `core/files/color.ts::toCanvasColorSpace`. That function serves export (egest)
 * scenarios where wide-gamut documents are routed to the 16-bit vips raw-pixel
 * channel by `resolveEgestDecision`, never reaching canvas tagging, so it clamps
 * adobe-rgb/prophoto-rgb/rec2020 down to 'srgb'.
 *
 * Any 8-bit OffscreenCanvas display track (composite readback, Worker resample)
 * has no such detour — it unconditionally emits a canvas bitmap for every source
 * gamut. Reusing the egest fallback there would silently clamp wide-gamut sources
 * to sRGB, forfeiting the 'display-p3' option 8-bit canvas already supports.
 * Hence this separate mapping: only exact 'srgb' stays 'srgb'; every other gamut
 * (including adobe-rgb / prophoto-rgb / rec2020, which have no native
 * PredefinedColorSpace) maps to 'display-p3' as the closest canvas-representable
 * superset.
 */
export function toDisplayTrackCanvasColorSpace(gamut: GamutId): PredefinedColorSpace {
  return gamut === 'srgb' ? 'srgb' : 'display-p3';
}

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

/**
 * Convert a display Blob or ImageBitmap to ImageData for CPU pixel inspection.
 * Ported from the retired `PixelResult.toImageData()`.
 */
export async function blobToImageData(
  source: Blob | ImageBitmap,
  colorSpace?: PredefinedColorSpace,
): Promise<ImageData> {
  const bitmap = source instanceof ImageBitmap ? source : await createImageBitmap(source);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', colorSpace ? { colorSpace } : undefined)!;
  ctx.drawImage(bitmap, 0, 0);
  if (!(source instanceof ImageBitmap)) {
    bitmap.close();
  }
  return ctx.getImageData(0, 0, canvas.width, canvas.height, colorSpace ? { colorSpace } : undefined);
}

export const toImageData = blobToImageData;

/**
 * Transcode a Blob to another MIME format (e.g. PNG → WebP for thumbnails).
 */
export async function transcodeBlob(
  blob: Blob,
  type = 'image/webp',
  quality = 0.85,
): Promise<Blob> {
  if (blob.type === type) return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvasToBlob(canvas, type, quality);
}

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
 * Trim transparent margins from a `CompositedImage`'s display bitmap.
 *
 * Ported from the retired `CompositeResult.trimmed()` OOP wrapper.
 * Only the 8-bit `displayBlob` is scanned/cropped —
 * `highDepthSource`, if present, is dropped from the result, matching the
 * original's behavior (it never carried high-depth pixels through trimming either).
 *
 * Returns `null` when the image is fully transparent (no content to trim to).
 */
export async function trimTransparentMargins(
  image: CompositedImage,
): Promise<{ image: CompositedImage; offset: { x: number; y: number } } | null> {
  const canvasColorSpace = toCanvasColorSpace(image.colorIdentity.gamut);
  const bitmap = await createImageBitmap(image.displayBlob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { colorSpace: canvasColorSpace })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data, width, height } = imageData;

  let top = height, bottom = 0, left = width, right = 0;
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
  if (top > bottom || left > right) return null;

  const trimW = right - left + 1;
  const trimH = bottom - top + 1;
  const trimmedCanvas = new OffscreenCanvas(trimW, trimH);
  const trimmedCtx = trimmedCanvas.getContext('2d', { colorSpace: canvasColorSpace })!;
  const trimmedBitmap = await createImageBitmap(imageData, left, top, trimW, trimH);
  trimmedCtx.drawImage(trimmedBitmap, 0, 0);
  trimmedBitmap.close();

  const displayBlob = await canvasToBlob(trimmedCanvas);

  return {
    image: {
      displayBlob,
      width: trimW,
      height: trimH,
      colorIdentity: image.colorIdentity,
      bounds: { x: image.bounds.x + left, y: image.bounds.y + top, w: trimW, h: trimH },
    },
    offset: { x: left, y: top },
  };
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
