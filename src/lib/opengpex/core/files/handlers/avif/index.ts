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
 * AVIF Format Handler (V2) — Dual-Engine Architecture.
 *
 * High-level entry point implementing ImageFormatHandler.
 * Delegates to decode/encode/metadata sub-modules.
 *
 * Thread model:
 * - Decode: main thread (browser-native createImageBitmap)
 * - Encode (@jsquash): static Worker at /ext/wasm/avif/avif-worker.js
 * - Encode (vips): engine Worker via FileIO.encodeAvif dispatch
 * - Metadata: main thread via ExifReader
 */

import type { PixelService } from '@opengpex/editor/core/types';
import type {
  ImageFormatHandler,
  DecodeOptions,
  DecodeResult,
  EncodeOptions,
} from '../../types';
import type { ImageMetadata } from '../../metadata';
import { decodeAvif } from './decode';
import { encodeAvif } from './encode';
import { extractAvifMetadata } from './metadata';

export class AvifHandler implements ImageFormatHandler {
  readonly format = 'avif';
  readonly mimeTypes = ['image/avif'];
  readonly extensions = ['avif'];

  constructor(private pixels: PixelService) {}

  decode(file: File, options?: DecodeOptions): Promise<DecodeResult> {
    return decodeAvif(file, this.pixels, options);
  }

  encode(
    source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
    options: EncodeOptions,
  ): Promise<Blob> {
    return encodeAvif(source, this.pixels, options);
  }

  async extractMetadata(file: File): Promise<ImageMetadata> {
    return extractAvifMetadata(file);
  }
}
