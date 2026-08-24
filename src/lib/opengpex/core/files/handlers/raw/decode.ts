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
 * RAW decode — metadata extraction + libraw Worker transcoding + color pipeline.
 *
 * RAW files are always transcoded to PNG via libraw-wasm Worker.
 * Color pipeline strategy is applied during the transcoding step.
 */

import type { WorkingColorSpace } from '@opengpex/editor/core/types';
import type { DecodeOptions, DecodeResult } from '../../types';
import type { ImageMetadata } from '../../types';
import { resolveColorSpaceForFormat, getImportStrategy, shouldRetainSourceBlob } from '@opengpex/editor/core/color/ColorPipeline';
import { extractRawMetadata } from './metadata';
import { convertRawToBlob } from './libraw';

/**
 * Decode a Camera RAW file: extract metadata (V2), transcode via libraw, apply color pipeline.
 */
export async function decodeRaw(
  file: File,
  _options?: DecodeOptions,
): Promise<DecodeResult> {
  // 1. Extract metadata first (lightweight, main thread)
  const metadata: ImageMetadata = await extractRawMetadata(file);

  // 2. Strategy-based color pipeline routing
  const detectedCS = resolveColorSpaceForFormat('raw', metadata.colorSpace);
  const strategy = getImportStrategy(detectedCS);

  // 3. Decode RAW → PNG via libraw-wasm (spawns its own internal Worker)
  // Strategy-driven: passes conversion info so convertRawToBlob adapts.
  const pngBlob = await convertRawToBlob(file, {
    sourceColorSpace: detectedCS as WorkingColorSpace,
    targetColorSpace: strategy.frameColorSpace,
    conversion: strategy.conversion,
  });
  const safeFile = new File(
    [pngBlob],
    file.name.replace(/\.[^.]+$/, '.png'),
    { type: 'image/png' },
  );

  // 4. Get dimensions from transcoded result
  const img = await createImageBitmap(safeFile);
  const dimensions = { w: img.width, h: img.height };
  img.close();

  // 5. Strategy-based sourceBlob retention (RAW: sourceBlobRetention='always')
  const sourceBlob = shouldRetainSourceBlob('raw', metadata, strategy.frameColorSpace) ? file : undefined;

  return {
    dimensions,
    metadata,
    subImages: [{ displayBlob: safeFile, width: dimensions.w, height: dimensions.h, index: 0 }],
    sourceBlob,
  };
}
