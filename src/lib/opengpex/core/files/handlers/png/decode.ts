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
 * PNG decode — color pipeline routing.
 *
 * Uses the centralized ColorPipeline strategy to determine the correct
 * import conversion path (none / matrix / icc-engine).
 */

import type { PixelService, WorkingColorSpace } from '@opengpex/editor/core/types';
import type { DecodeOptions, DecodeResult } from '../../types';
import type { ImageMetadata } from '../../metadata';
import { bitmapToCanvas } from '../../index';
import { iccToBase64, parseIccProfileName } from '../../icc';
import { convertImageDataColorSpace } from '@opengpex/editor/core/color/matrices';
import { resolveColorSpaceForFormat, getImportStrategy, shouldRetainSourceBlob } from '@opengpex/editor/core/color/ColorPipeline';
import { extractPngMetadata } from './metadata';

/**
 * Decode a PNG file: extract metadata (V2) + color pipeline routing.
 */
export async function decodePng(
  file: File,
  pixels: PixelService,
  _options?: DecodeOptions,
): Promise<DecodeResult> {
  const metadata: ImageMetadata = await extractPngMetadata(file);

  // ── Strategy-based color pipeline routing ──
  const detectedCS = resolveColorSpaceForFormat('png', metadata.colorSpace);
  const strategy = getImportStrategy(detectedCS);

  let displayBlob: Blob = file;
  let dimensions: { w: number; h: number };

  switch (strategy.conversion) {
    case 'none': {
      // Zero conversion: browser-native decode is sufficient (sRGB, P3, grayscale)
      const img = await createImageBitmap(file);
      dimensions = { w: img.width, h: img.height };
      img.close();
      console.debug('[ColorMgmt] PNG decode: %s conversion=none, detectedCS=%s, frameCS=%s',
        file.name, detectedCS, strategy.frameColorSpace);
      break;
    }

    case 'matrix': {
      // 3×3 matrix conversion (e.g. AdobeRGB→P3)
      // Must disable browser auto color management to preserve source pixel values
      const img = await createImageBitmap(file, { colorSpaceConversion: 'none' });
      const w = img.width;
      const h = img.height;
      dimensions = { w, h };

      // Use sRGB canvas to extract raw pixel values (avoids browser implicit conversion)
      const tmpCanvas = bitmapToCanvas(img);
      img.close();
      const tmpCtx = tmpCanvas.getContext('2d')!;
      const imageData = tmpCtx.getImageData(0, 0, w, h);

      // Matrix conversion: detectedCS → frameColorSpace
      // Safe assertion: 'matrix' entries only have keys that are valid WorkingColorSpace
      convertImageDataColorSpace(imageData.data, detectedCS as WorkingColorSpace, strategy.frameColorSpace);

      // Write to target-space canvas with correct color space tagging
      const outCS: PredefinedColorSpace = strategy.frameColorSpace === 'display-p3' ? 'display-p3' : 'srgb';
      const outCanvas = new OffscreenCanvas(w, h);
      const outCtx = outCanvas.getContext('2d', { colorSpace: outCS })!;
      // Tag converted pixels with target colorSpace to prevent putImageData from re-converting
      const outImageData = new ImageData(imageData.data, w, h, { colorSpace: outCS });
      outCtx.putImageData(outImageData, 0, 0);
      displayBlob = await outCanvas.convertToBlob({ type: 'image/png' });

      console.debug('[ColorMgmt] PNG decode: %s matrix %s→%s',
        file.name, detectedCS, strategy.frameColorSpace);
      break;
    }

    case 'icc-engine': {
      // Full ICC engine conversion (CMYK, custom ICC profiles, unknown spaces)
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { width, height, data, iccProfileData } = await pixels.fileIO.iccToSrgb(bytes);
      dimensions = { w: width, h: height };

      // Vips reliably extracts ICC — populate metadata if handler missed it
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

      console.debug('[ColorMgmt] PNG decode: %s icc-engine %s→%s',
        file.name, detectedCS, strategy.frameColorSpace);
      break;
    }
  }

  // sourceBlob retention via centralized strategy (replaces manual bitDepth check)
  const sourceBlob = shouldRetainSourceBlob('png', metadata, strategy.frameColorSpace) ? file : undefined;

  return {
    dimensions,
    metadata,
    subImages: [{ displayBlob, width: dimensions.w, height: dimensions.h, index: 0 }],
    sourceBlob,
  };
}
