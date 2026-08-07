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
 * HEIC decode — HEIC→JPEG transcoding + color pipeline routing.
 *
 * HEIC is not browser-natively decodable in all environments,
 * so we transcode to JPEG first, then apply the color pipeline.
 */

import type { PixelService, WorkingColorSpace } from '@opengpex/editor/core/types';
import type { DecodeOptions, DecodeResult } from '../../types';
import type { ImageMetadata } from '../../metadata';
import { bitmapToCanvas } from '../../index';
import { iccToBase64, parseIccProfileName } from '../../icc';
import { convertImageDataColorSpace } from '@opengpex/editor/core/color/matrices';
import { resolveColorSpaceForFormat, getImportStrategy } from '@opengpex/editor/core/color/ColorPipeline';
import { extractHeicMetadata } from './metadata';
import { convertHeicToBlob } from './transcode';

/**
 * Decode a HEIC file: extract metadata (V2), transcode to JPEG, then color pipeline routing.
 */
export async function decodeHeic(
  file: File,
  pixels: PixelService,
  _options?: DecodeOptions,
): Promise<DecodeResult> {
  // 1. Extract metadata before transcoding (HEIC container has EXIF)
  const metadata: ImageMetadata = await extractHeicMetadata(file);

  // 2. Transcode HEIC → JPEG via heic-to (quality 0.9)
  const jpegBlob = await convertHeicToBlob(file);
  const safeFile = new File(
    [jpegBlob],
    file.name.replace(/\.(heic|heif)$/i, '.jpg'),
    { type: 'image/jpeg' },
  );

  // 3. Strategy-based color pipeline routing (applied to transcoded JPEG)
  const detectedCS = resolveColorSpaceForFormat('heic', metadata.colorSpace);
  const strategy = getImportStrategy(detectedCS);

  let displayBlob: Blob = safeFile;
  let dimensions: { w: number; h: number };

  switch (strategy.conversion) {
    case 'none': {
      // Zero conversion: browser-native decode is sufficient (sRGB, P3 from iPhone)
      const img = await createImageBitmap(safeFile);
      dimensions = { w: img.width, h: img.height };
      img.close();
      console.debug('[ColorMgmt] HEIC decode: %s conversion=none, detectedCS=%s, frameCS=%s',
        file.name, detectedCS, strategy.frameColorSpace);
      break;
    }

    case 'matrix': {
      // 3×3 matrix conversion (e.g. AdobeRGB→P3)
      const img = await createImageBitmap(safeFile, { colorSpaceConversion: 'none' });
      const w = img.width;
      const h = img.height;
      dimensions = { w, h };

      const tmpCanvas = bitmapToCanvas(img);
      img.close();
      const tmpCtx = tmpCanvas.getContext('2d')!;
      const imageData = tmpCtx.getImageData(0, 0, w, h);

      convertImageDataColorSpace(imageData.data, detectedCS as WorkingColorSpace, strategy.frameColorSpace);

      const outCS: PredefinedColorSpace = strategy.frameColorSpace === 'display-p3' ? 'display-p3' : 'srgb';
      const outCanvas = new OffscreenCanvas(w, h);
      const outCtx = outCanvas.getContext('2d', { colorSpace: outCS })!;
      const outImageData = new ImageData(imageData.data, w, h, { colorSpace: outCS });
      outCtx.putImageData(outImageData, 0, 0);
      displayBlob = await outCanvas.convertToBlob({ type: 'image/png' });

      console.debug('[ColorMgmt] HEIC decode: %s matrix %s→%s',
        file.name, detectedCS, strategy.frameColorSpace);
      break;
    }

    case 'icc-engine': {
      // Full ICC engine conversion (custom ICC profiles, unknown spaces)
      const bytes = new Uint8Array(await safeFile.arrayBuffer());
      const { width, height, data, iccProfileData } = await pixels.fileIO.iccToSrgb(bytes);
      dimensions = { w: width, h: height };

      if (iccProfileData && iccProfileData.length > 0) {
        if (!metadata.raw.icc) {
          metadata.raw.icc = {
            data: iccToBase64(iccProfileData),
            name: parseIccProfileName(iccProfileData) || 'Embedded',
          };
        }
      }

      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d')!;
      const clamped = new Uint8ClampedArray(data.length);
      clamped.set(data);
      ctx.putImageData(new ImageData(clamped, width, height), 0, 0);
      displayBlob = await canvas.convertToBlob({ type: 'image/png' });

      console.debug('[ColorMgmt] HEIC decode: %s icc-engine %s→%s',
        file.name, detectedCS, strategy.frameColorSpace);
      break;
    }
  }

  // HEIC: sourceBlobRetention='never' per strategy table — no sourceBlob returned
  return {
    dimensions,
    metadata,
    subImages: [{ displayBlob, width: dimensions.w, height: dimensions.h, index: 0 }],
  };
}
