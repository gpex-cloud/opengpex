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
 * TIFF encode — color pipeline + engine Worker encoding.
 *
 * Uses the centralized ColorPipeline strategy for export pixel conversion.
 * Encodes via engine Worker (vips) with full TIFF options support.
 */

import type { GamutId } from '@opengpex/editor/core/types';
import { toGamutId } from '@opengpex/editor/core/types';
import type { EncodeOptions, EncodeSource } from '../../types';
import { isRawPixelSource } from '../../types';
import { bitmapToCanvas } from '../../index';
import { base64ToIcc, getStockIccProfile } from '../../shared/icc';
import { resetExifOrientation } from '../../metadata/tiff-ifd-reader';
import { toCanvasColorSpace } from '@opengpex/editor/core/engine/color';
import { injectTiffIfd0Tags, TIFF_TAGS } from './ifd0-inject';
import type { Ifd0StringTag } from './ifd0-inject';
import { injectTiffExif } from './exif-inject';
import { getLibVips } from '../../shared/lib-vips';

/** TIFF compression method for encoding */
export type TiffCompression = 'none' | 'lzw' | 'zip' | 'jpeg';

/** Extended encode options for TIFF */
export interface TiffEncodeOptions extends EncodeOptions {
  /** TIFF compression method (default: 'lzw') */
  tiffCompression?: TiffCompression;
  /**
   * JPEG quality (1-100) for the JPEG codec inside the TIFF. Only used when
   * `tiffCompression === 'jpeg'`. Default: 85. Distinct from `EncodeOptions.quality`
   * (0-1), which is the JPEG/WebP/AVIF container quality.
   */
  tiffJpegQuality?: number;
  /** Predictor for LZW/ZIP (default: 'none'). */
  tiffPredictor?: 'none' | 'horizontal' | 'float';
  /** Enable BigTIFF format (>4GB support). Default: false. */
  tiffBigtiff?: boolean;
  /** Enable tile layout (default: false = strip). JPEG forces tile on. */
  tiffTile?: boolean;
  /** Tile width pixels (default: 256). */
  tiffTileWidth?: number;
  /** Tile height pixels (default: 256). */
  tiffTileHeight?: number;
}

/**
 * Encode a canvas/bitmap to TIFF with color management.
 *
 * ── COLOR CONTRACT ──────────────────────────────────────────────────────────
 * Pixels arrive ALREADY in the target gamut with the target TRC applied (the
 * terminal `unpremultiplyEncodeGamut` in the export command did the single
 * source→target matrix + TRC + quantization step). This encoder performs ZERO
 * internal color conversion — it writes the TIFF container and the ICC profile
 * matching what the pixels now carry. Wide-gamut Adobe RGB / ProPhoto output
 * arrives via the RawPixelSource path (8-bit `raw-8` or 16-bit `raw-16`) with a
 * stock `targetGamut` ICC profile.
 */
export async function encodeTiff(
  source: EncodeSource,
  options: EncodeOptions,
): Promise<Blob> {
  const config = options.exportConfig;
  const compression: TiffCompression = (config?.tiffCompression as TiffCompression) || 'lzw';
  const dpi = config?.dpi || options.metadata?.dpi || 72;

  // ── Strategy-based export color pipeline ──
  const meta = options.metadata;
  const embedIcc = config?.embedIcc ?? false;

  // The gamut the incoming pixels ARE in = the egest decision's `targetGamut`.
  // The terminal encode already converted into it upstream, so it drives ONLY the
  // canvas tag + ICC selection here.
  const targetGamut: GamutId = (config?.targetGamut as GamutId | undefined) ?? 'srgb';
  // Embed the SOURCE profile verbatim ONLY when the output gamut still equals the
  // source file's gamut (exact round-trip) — the pixels are then in the source's
  // numeric space, so a stock `targetGamut` profile would mislabel them.
  const sourceIccMatchesTarget = !!meta?.raw?.icc?.data && toGamutId(meta?.colorSpace) === targetGamut;
  const embedSourceIccVerbatim = sourceIccMatchesTarget;

  let rgbaData: Uint8Array;
  let outWidth: number;
  let outHeight: number;
  let bitDepth: 8 | 16 = 8;

  if (isRawPixelSource(source)) {
    outWidth = source.width;
    outHeight = source.height;
    bitDepth = source.bitDepth === 16 ? 16 : 8;
    rgbaData = source.data instanceof Uint8Array
      ? source.data
      : new Uint8Array(source.data.buffer, source.data.byteOffset, source.data.byteLength);
  } else {
    // Pixels already carry targetGamut + its TRC — tag the canvas to match so the
    // browser round-trip does not reinterpret them. NO color conversion here.
    const canvas: OffscreenCanvas | HTMLCanvasElement = source instanceof ImageBitmap
      ? bitmapToCanvas(source, toCanvasColorSpace(targetGamut))
      : source;

    const ctx = (canvas as OffscreenCanvas).getContext('2d')!;
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    rgbaData = new Uint8Array(imageData.data.buffer);
    outWidth = canvas.width;
    outHeight = canvas.height;
  }

  // ICC Profile for embedding
  let iccProfileBytes: Uint8Array | undefined;
  if (embedIcc && embedSourceIccVerbatim) {
    // Round-trip (output gamut == source gamut) → embed the source's own profile.
    const { base64ToIcc: b64ToIcc } = await import('../../shared/icc');
    iccProfileBytes = b64ToIcc(meta!.raw!.icc!.data);
  } else if (embedIcc) {
    // No matching source ICC (none present, or gamut changed) → use the stock
    // profile for the OUTPUT gamut, which is what the pixels now carry.
    const stockProfile = getStockIccProfile(targetGamut);
    if (stockProfile) {
      iccProfileBytes = stockProfile.bytes;
    }
  }

  // Encode via engine Worker (FILE_IO job)
  try {
    // Prepare EXIF bytes for injection (decoded from base64)
    // Reset Orientation to 1 (Normal) since exported pixels are already correctly oriented.
    const exifBytes = config?.preserveExif && meta?.raw?.exif
      ? resetExifOrientation(base64ToIcc(meta.raw.exif)) : undefined;

    let tiffBytes = await getLibVips().encodeTiff(
      rgbaData,
      outWidth,
      outHeight,
      {
        compression,
        dpi,
        iccProfileBytes,
        // vips' own option name stays `jpegQuality`; ours is prefixed so the UI
        // cannot confuse it with the container-level `quality`.
        jpegQuality: config?.tiffJpegQuality,
        predictor: config?.tiffPredictor,
        bigtiff: config?.tiffBigtiff,
        tile: config?.tiffTile,
        tileWidth: config?.tiffTileWidth,
        tileHeight: config?.tiffTileHeight,
        bitDepth,
      },
    );

    // Post-encode EXIF injection — a pure byte-level op (no vips). Done HERE in
    // the files layer, next to where `exifBytes` is prepared, instead of the
    // former round-trip through engine (`file-io.ts` used to import this same
    // `injectTiffExif` from files — a layering inversion now removed).
    if (exifBytes && exifBytes.length > 0) {
      tiffBytes = injectTiffExif(tiffBytes, exifBytes);
    }

    // ── Inject IFD0 metadata tags (Software, Author, Copyright, Camera) ──
    const ifd0Tags: Ifd0StringTag[] = [];

    // Always write Software tag
    if (config?.writeSoftwareTag !== false) {
      ifd0Tags.push({ tag: TIFF_TAGS.SOFTWARE, value: 'OpenGPEX' });
    }

    // Author / Copyright from config or source metadata
    const authorName = config?.author?.name || meta?.author?.name;
    const copyright = config?.author?.copyright || meta?.author?.copyright;
    if (authorName) ifd0Tags.push({ tag: TIFF_TAGS.ARTIST, value: authorName });
    if (copyright) ifd0Tags.push({ tag: TIFF_TAGS.COPYRIGHT, value: copyright });

    // Camera Make/Model from source metadata (when preserving EXIF)
    if (config?.preserveExif && meta?.camera) {
      if (meta.camera.make) ifd0Tags.push({ tag: TIFF_TAGS.MAKE, value: meta.camera.make });
      if (meta.camera.model) ifd0Tags.push({ tag: TIFF_TAGS.MODEL, value: meta.camera.model });
    }

    if (ifd0Tags.length > 0) {
      tiffBytes = injectTiffIfd0Tags(tiffBytes, ifd0Tags);
    }

    const blob = new Blob([tiffBytes.buffer as ArrayBuffer], { type: 'image/tiff' });
    console.log(`[TiffHandler] Encode complete: ${outWidth}×${outHeight}, compression=${compression}, dpi=${dpi}`);
    return blob;
  } catch (error) {
    console.error('[TiffHandler] Encode failed:', error);
    throw error;
  }
}
