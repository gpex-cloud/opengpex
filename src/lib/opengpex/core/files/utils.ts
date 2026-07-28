/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * Shared utilities for file format handlers.
 *
 * Consolidates common operations (rgbaToBlob, etc.) that were previously
 * duplicated across multiple handler files (jpeg.ts, gif.ts).
 */

/**
 * Convert raw RGBA pixel data to a PNG Blob via OffscreenCanvas.
 *
 * Used by handlers that decode to raw pixels (JPEG ICC conversion, GIF frames, etc.)
 * and need to produce a displayable Blob for the editor.
 */
export async function rgbaToBlob(rgba: Uint8Array, width: number, height: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  const clamped = new Uint8ClampedArray(rgba.length);
  clamped.set(rgba);
  const imageData = new ImageData(clamped, width, height);
  ctx.putImageData(imageData, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}
