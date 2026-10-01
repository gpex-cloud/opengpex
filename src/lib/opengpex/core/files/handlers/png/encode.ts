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
 * PNG encode — color pipeline + chunk reassembly.
 *
 * Uses the centralized ColorPipeline strategy for export pixel conversion,
 * then reassembles chunks with metadata injection (pHYs, iCCP/sRGB, tEXt, tIME).
 */

import type { GamutId } from '@opengpex/editor/core/types';
import { toGamutId } from '@opengpex/editor/core/types';
import type { EncodeOptions, EncodeSource } from '../../types';
import { isRawPixelSource } from '../../types';
import { bitmapToCanvas } from '../../index';
import { base64ToIcc, getStockIccProfile } from '../../shared/icc';
import { resetExifOrientation } from '../../metadata/tiff-ifd-reader';
import { toCanvasColorSpace } from '@opengpex/editor/core/engine/color';
import { getLibVips } from '../../shared/lib-vips';
import { verifySignature, iterateChunks, concat } from './chunks';
import { buildPhysChunk, buildSrgbChunk, buildIccpChunk, buildTextChunk, buildTimeChunk, buildExifChunk } from './writers';

/**
 * Encode a canvas/bitmap to PNG with metadata injection.
 *
 * ── COLOR CONTRACT ──────────────────────────────────────────────────────────
 * Pixels arrive ALREADY in the target gamut with the target TRC applied — the
 * terminal `unpremultiplyEncodeGamut` in the export command did the single
 * source→target matrix + TRC + quantization step, and there is NO reverse
 * pre-encode conversion anymore (the `srgb-to-icc` step was removed mechanism-
 * level: choosing sRGB now yields true sRGB, so `FileService.encode()` hands the
 * pixels straight to this handler untouched).
 * This encoder performs ZERO internal color conversion — it writes the PNG
 * container and the color chunks (iCCP / sRGB / pHYs / tEXt) matching what the
 * pixels now carry. The RawPixelSource path (8-bit `raw-8` or 16-bit `raw-16`)
 * is exactly how wide-gamut Adobe RGB / ProPhoto output ships: naked pixels
 * straight to vips + a stock `targetGamut` iCCP chunk, at the source's own bit
 * depth, with no browser canvas reinterpretation.
 */
export async function encodePng(
  source: EncodeSource,
  options: EncodeOptions,
): Promise<Blob> {
  const meta = options.metadata;
  const config = options.exportConfig;

  // The gamut the incoming pixels ARE in = the egest decision's `targetGamut`.
  // The terminal encode already converted into it upstream, so it drives ONLY the
  // canvas tag + colour-chunk selection here.
  const targetGamut: GamutId = (config?.targetGamut as GamutId | undefined) ?? 'srgb';
  // Embed the SOURCE profile verbatim ONLY when the output gamut still equals the
  // source file's gamut (exact round-trip): the pixels are then in the source's
  // numeric space, so a stock `targetGamut` profile would mislabel them.
  const sourceIccMatchesTarget = !!meta?.raw?.icc?.data && toGamutId(meta?.colorSpace) === targetGamut;
  const embedSourceIccVerbatim = sourceIccMatchesTarget;

  let baseBlob: Blob;

  if (isRawPixelSource(source)) {
    // Both 8-bit (`raw-8`) and 16-bit (`raw-16`) go straight to vips, which
    // encodes each at the source's native bit depth with no canvas hop.
    const rgbaData = source.data instanceof Uint8Array
      ? source.data
      : new Uint8Array(source.data.buffer, source.data.byteOffset, source.data.byteLength);

    const pngBytes = await getLibVips().encodePng(
      rgbaData,
      source.width,
      source.height,
      {
        compression: config?.pngCompression ?? 6,
        dpi: config?.dpi || meta?.dpi || 72,
        bitDepth: source.bitDepth,
      },
    );
    baseBlob = new Blob([pngBytes.buffer as ArrayBuffer], { type: 'image/png' });
  } else {
    // Pixels already carry targetGamut + its TRC — tag the canvas to match so the
    // browser encoder does not reinterpret them. NO color conversion here.
    const canvas: OffscreenCanvas = source instanceof ImageBitmap
      ? bitmapToCanvas(source, toCanvasColorSpace(targetGamut))
      : source as OffscreenCanvas;

    if (config?.pngCompression !== undefined) {
      // The browser's `convertToBlob` has no compression-level knob, so an explicit
      // user choice (NONE / DEFAULT / MAX) would be silently dropped on the 8-bit
      // path. Route those through vips instead, which honours `compression` at
      // `bitDepth: 8` exactly as it does at 16. Colour is unaffected: the pixels are
      // read back from the already-tagged canvas, and no conversion happens either
      // side of the hop.
      const ctx = canvas.getContext('2d')!;
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const pngBytes = await getLibVips().encodePng(
        new Uint8Array(imageData.data.buffer),
        canvas.width,
        canvas.height,
        {
          compression: config.pngCompression,
          dpi: config?.dpi || meta?.dpi || 72,
          bitDepth: 8,
        },
      );
      baseBlob = new Blob([pngBytes.buffer as ArrayBuffer], { type: 'image/png' });
    } else {
      // Default: the browser encoder (fastest, zero wasm hop).
      baseBlob = await canvas.convertToBlob({ type: 'image/png' });
    }
  }

  // If no metadata to inject, return as-is
  const dpi = config?.dpi || meta?.dpi;
  const hasAuthor = !!(config?.author?.name || meta?.author?.name);
  const hasCopyright = !!(config?.author?.copyright || meta?.author?.copyright);
  const writeSoftware = config?.writeSoftwareTag !== false;

  if (!dpi && !hasAuthor && !hasCopyright && !writeSoftware && !config?.embedIcc) {
    return baseBlob;
  }

  // 2. Reassemble PNG chunks with metadata injection
  try {
    const buffer = await baseBlob.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    if (!verifySignature(bytes)) return baseBlob;

    const chunks: Uint8Array[] = [];

    // PNG Signature (8 bytes)
    chunks.push(bytes.slice(0, 8));

    // IHDR chunk (first chunk after signature: 4 length + 4 type + 13 data + 4 CRC = 25 bytes)
    chunks.push(bytes.slice(8, 33));

    // Insert pHYs chunk (DPI)
    if (dpi && dpi > 0) {
      chunks.push(buildPhysChunk(dpi));
    }

    // Insert color profile declaration (iCCP or sRGB chunk, mutually exclusive per PNG spec)
    if (config?.embedIcc && embedSourceIccVerbatim) {
      // Round-trip (output gamut == source gamut) → embed the source's own profile.
      const iccBytes = base64ToIcc(meta!.raw!.icc!.data);
      chunks.push(await buildIccpChunk(iccBytes, meta!.raw!.icc!.name));
    } else if (config?.embedIcc) {
      // No matching source ICC (none present, or gamut changed) → use the stock
      // profile for the OUTPUT gamut, which is what the pixels now carry.
      const stockProfile = getStockIccProfile(targetGamut);
      if (stockProfile) {
        chunks.push(await buildIccpChunk(stockProfile.bytes, stockProfile.name));
      } else {
        chunks.push(buildSrgbChunk());
      }
    } else if (targetGamut === 'srgb') {
      // No embedding requested → insert sRGB chunk as lightweight color declaration
      chunks.push(buildSrgbChunk());
    }

    // Insert tEXt chunks (Author, Copyright, Software)
    if (hasAuthor) {
      const name = config?.author?.name || meta?.author?.name || '';
      chunks.push(buildTextChunk('Author', name));
    }
    if (hasCopyright) {
      const cr = config?.author?.copyright || meta?.author?.copyright || '';
      chunks.push(buildTextChunk('Copyright', cr));
    }
    if (writeSoftware) {
      chunks.push(buildTextChunk('Software', 'OpenGPEX'));
    }

    // Insert eXIf chunk (raw EXIF passthrough with Orientation reset)
    if (config?.preserveExif && meta?.raw?.exif) {
      const exifBytes = base64ToIcc(meta.raw.exif);
      // Reset Orientation to 1 (Normal) since exported pixels are already correctly
      // oriented. Source formats like HEIC may store non-trivial orientation in EXIF,
      // but the composite/transcode pipeline normalizes pixel orientation.
      resetExifOrientation(exifBytes);
      chunks.push(buildExifChunk(exifBytes));
    }

    // Insert tIME chunk (current export timestamp)
    chunks.push(buildTimeChunk());

    // Remaining original chunks (skip any we're replacing to avoid duplicates)
    // Use iterateChunks but skip signature + IHDR (already added)
    let firstChunkSeen = false;
    for (const chunk of iterateChunks(bytes)) {
      // Skip IHDR (already added above)
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        continue;
      }
      // Skip chunks we're replacing
      if (chunk.type === 'pHYs' || chunk.type === 'sRGB' || chunk.type === 'tEXt'
          || chunk.type === 'iCCP' || chunk.type === 'tIME' || chunk.type === 'iTXt'
          || chunk.type === 'eXIf') {
        continue;
      }
      // Keep everything else (IDAT, IEND, etc.)
      chunks.push(bytes.slice(chunk.offset, chunk.offset + chunk.totalSize));
    }

    const result = concat(chunks);
    return new Blob([result.buffer as ArrayBuffer], { type: 'image/png' });
  } catch (e) {
    console.warn('[PngHandler.encode] Chunk injection failed, returning raw blob:', e);
    return baseBlob;
  }
}
