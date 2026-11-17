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
 * thumbnail.ts — the single authority for frame thumbnail generation.
 *
 * Every frame thumbnail in the editor (single-file import, animated GIF
 * import, paste-to-new-frame slices, branch-from-selection) is produced
 * through one contract:
 *
 *   optional opaque-alpha crop → short-edge square padding →
 *   Worker resample to a 512px WebP → content-addressed asset registration →
 *   `{ src, assetId }`.
 *
 * The crop step exists because canvases routinely carry large transparent
 * margins (sprite sheets, GIF frames whose content sits in one corner). A
 * thumbnail taken from the full canvas would render as an almost fully
 * transparent checkerboard that pictures nothing the user can recognize.
 *
 * Crop rect sources, cheapest first:
 *   1. `crop.rect` — the caller already holds the bbox (the decode path
 *      precomputes `page.contentBounds`, fragment paths hold the crop
 *      window); no scanning happens.
 *   2. `crop.autoScan` — no bounds in hand (baked composite products): the
 *      source is scanned once on the main thread for its alpha bbox.
 *   3. neither — plain uncropped resample (the pre-crop behavior).
 *
 * A rect spanning the whole source degenerates to case 3: identical output,
 * and the dominant path for opaque imports (JPEG) never enters the Worker's
 * crop branch at all.
 *
 * The resolved crop window is then squared: its short edges are expanded
 * symmetrically around the content center until both edges match the longer
 * one (clamped into the source bounds). Thumbnails render in square slots
 * with cover-fit, so an uncorrected elongated bbox (a one-frame-wide GIF
 * strip, a hairline brush stroke) would be scaled until its short edge
 * fills the slot and the actual content cropped away; the padded square
 * keeps the whole content visible with transparent margins.
 */

import type { EditorContextValue, GamutId, LocalRect, Rect } from '../types';
import { calculateContentBounds } from '../engine/utils/pixel-utils';

/** Thumbnail resample contract: 512px long edge, Worker-encoded WebP. */
const THUMBNAIL_MAX_SIZE = 512;
const THUMBNAIL_FORMAT = 'image/webp' as const;
const THUMBNAIL_QUALITY = 0.9;

/** A generated thumbnail, ready to be written into `frame.thumbnail`. */
export interface FrameThumbnail {
  /** Object URL of the registered thumbnail asset. */
  src: string;
  /** Content-addressed id of the registered thumbnail asset. */
  assetId: string;
}

export interface FrameThumbnailDeps extends Pick<EditorContextValue, 'pixels' | 'assets'> {
  /**
   * Override of the default alpha-bounds scanner. Production callers omit
   * this (the default scans via fetch + createImageBitmap +
   * `calculateContentBounds`); tests inject fakes. Returning `null` (scan
   * failure) degrades to a full-image thumbnail rather than failing the
   * import — a thumbnail without the crop is still a valid thumbnail.
   */
  scanBounds?: (url: string) => Promise<LocalRect | null>;
}

export interface FrameThumbnailSource {
  /** 8-bit display URL of the source image (asset ObjectURL / blob URL). */
  url: string;
  /**
   * Source pixel dimensions. When given, a crop rect spanning the whole
   * source degenerates to a plain uncropped resample (see module doc).
   */
  width?: number;
  height?: number;
  /**
   * Source gamut, forwarded to the Worker resample so its OffscreenCanvas
   * colorSpace matches the source (wide-gamut slices must not clamp to sRGB).
   */
  gamut?: GamutId;
}

export interface FrameThumbnailCrop {
  /**
   * Precomputed opaque-alpha bbox in source pixel coords. Wins over
   * `autoScan` when both are given.
   */
  rect?: Rect;
  /**
   * Scan the source once for its alpha bbox before cropping. Use when no
   * bounds are already in hand (e.g. baked composite products).
   */
  autoScan?: boolean;
}

/**
 * Generate and register a frame thumbnail. Crop resolution never throws —
 * an unusable crop degrades to the full image; only a failed resample or
 * asset registration propagates to the caller.
 */
export async function createFrameThumbnail(
  deps: FrameThumbnailDeps,
  source: FrameThumbnailSource,
  crop?: FrameThumbnailCrop,
): Promise<FrameThumbnail> {
  const targetRect = await resolveCropRect(deps, source, crop);

  const thumbResult = await deps.pixels.image.resample(source.url, {
    maxSize: THUMBNAIL_MAX_SIZE,
    ...(targetRect ? { targetRect } : {}),
    ...(source.gamut ? { sourceGamut: source.gamut } : {}),
    format: THUMBNAIL_FORMAT,
    quality: THUMBNAIL_QUALITY,
  });

  const { assetId, url } = await deps.assets.register({
    displayBlob: thumbResult.displayBlob,
    width: thumbResult.width,
    height: thumbResult.height,
    precomputedHash: thumbResult.precomputedHash,
  });
  return { src: url, assetId };
}

/**
 * Resolve the crop rect for a thumbnail request: explicit rect → scanned
 * bounds → none. A rect covering the whole source, or a failed scan, yields
 * `undefined` — the plain uncropped resample. A resolved rect is squared
 * (short-edge compensation, see `expandShortEdgesToSquare`).
 */
async function resolveCropRect(
  deps: FrameThumbnailDeps,
  source: FrameThumbnailSource,
  crop: FrameThumbnailCrop | undefined,
): Promise<Rect | undefined> {
  let rect: Rect | null | undefined = crop?.rect;
  if (rect === undefined && crop?.autoScan) {
    rect = deps.scanBounds
      ? await deps.scanBounds(source.url)
      : await scanAlphaBounds(source.url);
  }
  if (!rect) return undefined;

  const fullCanvas =
    source.width != null && source.height != null &&
    rect.x <= 0 && rect.y <= 0 &&
    rect.w >= source.width && rect.h >= source.height;
  if (fullCanvas) return undefined;

  // Without source dimensions the squared window cannot be clamped into the
  // source (out-of-bounds windows get proportionally clipped by the Worker
  // rather than padded, which would shift the content), so keep the
  // uncorrected crop. All production callers pass width/height.
  if (source.width == null || source.height == null) return rect;
  return expandShortEdgesToSquare(rect, source.width, source.height);
}

/**
 * Short-edge compensation: expand a crop rect symmetrically around the
 * content center until both edges equal the longer one, so the resampled
 * thumbnail is square and survives cover-fit display in square slots with
 * its content intact. The expansion is clamped into the source bounds —
 * the Worker's drawImage clips out-of-bounds source rects proportionally
 * instead of padding them transparently, so an unclamped window would
 * shift and rescale the content. When the source's own short edge is
 * smaller than the content's long edge, the window stops at the source
 * bound on that axis: the window never shrinks below the content bbox
 * (w ≥ rect.w and h ≥ rect.h hold throughout), so content is never cut and
 * the aspect ratio improves as far as the source allows. The returned
 * window always contains `rect` entirely.
 */
function expandShortEdgesToSquare(rect: Rect, sourceW: number, sourceH: number): Rect {
  const long = Math.max(rect.w, rect.h);
  const w = Math.min(long, sourceW);
  const h = Math.min(long, sourceH);
  let x = Math.round(rect.x + rect.w / 2 - w / 2);
  let y = Math.round(rect.y + rect.h / 2 - h / 2);
  x = Math.max(0, Math.min(x, sourceW - w));
  y = Math.max(0, Math.min(y, sourceH - h));
  // Rounding can push the window up to half a pixel past a fractional
  // content edge; pull it back so containment of `rect` is unconditional.
  if (x > rect.x) x = Math.floor(rect.x);
  if (x + w < rect.x + rect.w) x = Math.ceil(rect.x + rect.w) - w;
  if (y > rect.y) y = Math.floor(rect.y);
  if (y + h < rect.y + rect.h) y = Math.ceil(rect.y + rect.h) - h;
  return { x, y, w, h };
}

/**
 * Default alpha-bounds scanner: decode the URL's blob and run the shared
 * four-edge shrink scan (`calculateContentBounds` — the same authority the
 * decode path uses for `page.contentBounds`). Any failure degrades to `null`
 * (full-image thumbnail) instead of rejecting the import.
 */
async function scanAlphaBounds(url: string): Promise<LocalRect | null> {
  try {
    const blob = await (await fetch(url)).blob();
    const bitmap = await createImageBitmap(blob, {
      imageOrientation: 'from-image',
      colorSpaceConversion: 'none',
    });
    try {
      return await calculateContentBounds(bitmap);
    } finally {
      bitmap.close();
    }
  } catch (err) {
    console.warn('[thumbnail] alpha bounds scan failed; using full-image thumbnail', err);
    return null;
  }
}
