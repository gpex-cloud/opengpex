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
 * EXIF orientation post-processing — files-layer shared decode helper.
 *
 * TWO orientation paths, ONE shared EXIF mapping table (`EXIF_ORIENTATION_MAP`):
 *   1. `applyExifOrientation` — 8-bit displayBlob via OffscreenCanvas transforms.
 *   2. `rotateNakedRgba`       — f16/f32 interleaved naked RGBA via index remap.
 * Keeping both in this module against the same table is deliberate: split across
 * files they WILL drift, silently mis-orienting the high-depth buffer relative to
 * its 8-bit proxy. The golden test cross-checks the two paths agree.
 *
 * Aligned with `shared/lib-custom.ts` and `shared/lib-vips.ts` as decode
 * infrastructure. Actually consumed only by the PNG and WebP handlers
 * (`png/decode.ts`, `webp/decode.ts`) — the sole call sites of
 * `applyExifOrientation`. AVIF and TIFF also resolve `applyOrientation:
 * 'explicit'` but NO handler calls into here for them, so their displayBlob is
 * still left un-uprighted; that is a separate, unfulfilled gap, not a user of
 * this module.
 *
 * @module core/files/shared/orientation
 */

/**
 * The single EXIF Orientation mapping table both paths derive from.
 *
 * `dest(x, y, w, h)` gives the destination pixel `(dx, dy)` for a source pixel
 * `(x, y)` in a `w×h` buffer; `swapDims` marks the orientations (5-8) whose
 * output geometry is `h×w`. `applyExifOrientation` expresses the SAME per-entry
 * transform as an equivalent canvas affine op (a per-pixel remap on the canvas
 * path would be pathologically slow), and reads `swapDims` from here.
 */
export const EXIF_ORIENTATION_MAP: Record<
  number,
  { swapDims: boolean; dest: (x: number, y: number, w: number, h: number) => readonly [number, number] }
> = {
  1: { swapDims: false, dest: (x, y) => [x, y] }, // Normal
  2: { swapDims: false, dest: (x, y, w) => [w - 1 - x, y] }, // Flip H
  3: { swapDims: false, dest: (x, y, w, h) => [w - 1 - x, h - 1 - y] }, // Rotate 180°
  4: { swapDims: false, dest: (x, y, _w, h) => [x, h - 1 - y] }, // Flip V
  5: { swapDims: true, dest: (x, y) => [y, x] }, // Transpose
  6: { swapDims: true, dest: (x, y, _w, h) => [h - 1 - y, x] }, // Rotate 90° CW
  7: { swapDims: true, dest: (x, y, w, h) => [h - 1 - y, w - 1 - x] }, // Transverse
  8: { swapDims: true, dest: (x, y, w) => [y, w - 1 - x] }, // Rotate 270° CW
};

/**
 * EXIF Orientation for the RAW high-depth buffer: a pure index remap on the
 * interleaved f16/f32 RGBA pixels, moving each pixel's 4 elements as a unit.
 *
 * The 8-bit `applyExifOrientation` goes through `OffscreenCanvas` +
 * `createImageBitmap` and CANNOT touch >8-bit data, so this is the naked-buffer
 * counterpart — same EXIF semantics (`EXIF_ORIENTATION_MAP`), different mechanism.
 * `orientation === 1` (or unknown) is a zero-copy identity: the input buffer is
 * returned as-is. Output geometry is swapped (`h×w`) for orientations 5-8.
 */
export function rotateNakedRgba<T extends Uint16Array | Float32Array>(
  src: T,
  w: number,
  h: number,
  orientation: number,
): { data: T; width: number; height: number } {
  const entry = EXIF_ORIENTATION_MAP[orientation];
  // orientation 1 (or any unmapped value) → identity, no allocation.
  if (!entry || orientation === 1) {
    return { data: src, width: w, height: h };
  }

  const { swapDims, dest } = entry;
  const outW = swapDims ? h : w;
  const outH = swapDims ? w : h;

  // Preserve the concrete element type (Uint16Array | Float32Array), not a
  // widened union — `src.constructor` is the right TypedArray constructor.
  const Ctor = src.constructor as new (length: number) => T;
  const out = new Ctor(outW * outH * 4);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [dx, dy] = dest(x, y, w, h);
      const s = (y * w + x) * 4;
      const d = (dy * outW + dx) * 4;
      out[d] = src[s];
      out[d + 1] = src[s + 1];
      out[d + 2] = src[s + 2];
      out[d + 3] = src[s + 3];
    }
  }

  return { data: out, width: outW, height: outH };
}

/**
 * Apply an EXIF Orientation transform to a display Blob, returning a new Blob
 * with upright pixels and (for orientations 5-8) swapped dimensions.
 *
 * EXIF Orientation values:
 * 1: Normal (no-op — should not reach here)
 * 2: Flip horizontal
 * 3: Rotate 180°
 * 4: Flip vertical
 * 5: Transpose (flip H + rotate 270° CW)
 * 6: Rotate 90° CW
 * 7: Transverse (flip H + rotate 90° CW)
 * 8: Rotate 270° CW (= 90° CCW)
 */
export async function applyExifOrientation(
  blob: Blob,
  dims: { w: number; h: number },
  orientation: number,
): Promise<{ blob: Blob; dimensions: { w: number; h: number } }> {
  const img = await createImageBitmap(blob instanceof File ? blob : new Blob([blob], { type: 'image/png' }));
  const { w, h } = dims;

  // Orientations 5-8 swap width/height — read from the shared table so this
  // path and `rotateNakedRgba` can never disagree on which orientations swap.
  const swapDims = EXIF_ORIENTATION_MAP[orientation]?.swapDims ?? false;
  const outW = swapDims ? h : w;
  const outH = swapDims ? w : h;

  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext('2d')!;

  // Apply the appropriate transform
  switch (orientation) {
    case 2: // Flip H
      ctx.scale(-1, 1);
      ctx.drawImage(img, -w, 0);
      break;
    case 3: // Rotate 180°
      ctx.translate(w, h);
      ctx.rotate(Math.PI);
      ctx.drawImage(img, 0, 0);
      break;
    case 4: // Flip V
      ctx.scale(1, -1);
      ctx.drawImage(img, 0, -h);
      break;
    case 5: // Transpose (flip H + rotate 270° CW)
      ctx.translate(outW, 0);
      ctx.rotate(Math.PI / 2);
      ctx.scale(1, -1);
      ctx.drawImage(img, 0, -h);
      break;
    case 6: // Rotate 90° CW
      ctx.translate(outW, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(img, 0, 0);
      break;
    case 7: // Transverse (flip H + rotate 90° CW)
      ctx.translate(0, outH);
      ctx.rotate(-Math.PI / 2);
      ctx.scale(1, -1);
      ctx.drawImage(img, 0, -h);
      break;
    case 8: // Rotate 270° CW
      ctx.translate(0, outH);
      ctx.rotate(-Math.PI / 2);
      ctx.drawImage(img, 0, 0);
      break;
    default:
      ctx.drawImage(img, 0, 0);
  }

  img.close();
  const rotatedBlob = await canvas.convertToBlob({ type: 'image/png' });
  return { blob: rotatedBlob, dimensions: { w: outW, h: outH } };
}
