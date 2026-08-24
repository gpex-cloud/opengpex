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
 * JPEG Format Handler (V2).
 *
 * High-level entry point implementing ImageFormatHandler.
 * Delegates to decode/encode/metadata sub-modules.
 *
 * Thread model: ALL operations run on main thread (<100ms for typical files).
 */

import type { PixelService } from '@opengpex/editor/core/types';
import type {
  ImageFormatHandler,
  DecodeOptions,
  DecodeResult,
  EncodeOptions,
} from '../../types';
import type { ImageMetadata } from '../../types';
import { decodeJpeg } from './decode';
import { encodeJpeg } from './encode';
import { extractJpegMetadata } from './metadata';

export class JpegHandler implements ImageFormatHandler {
  readonly format = 'jpeg';
  readonly mimeTypes = ['image/jpeg'];
  readonly extensions = ['jpg', 'jpeg'];

  constructor(private pixels: PixelService) {}

  decode(file: File, options?: DecodeOptions): Promise<DecodeResult> {
    return decodeJpeg(file, this.pixels, options);
  }

  encode(
    source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
    options: EncodeOptions,
  ): Promise<Blob> {
    return encodeJpeg(source, this.pixels, options);
  }

  async extractMetadata(file: File): Promise<ImageMetadata> {
    return extractJpegMetadata(file);
  }
}
