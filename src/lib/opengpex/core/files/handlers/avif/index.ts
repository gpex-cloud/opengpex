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
 * AVIF Format Handler (V2).
 *
 * High-level entry point implementing ImageFormatHandler.
 * Delegates to decode/encode/metadata sub-modules.
 *
 * Thread model:
 * - Decode: main thread (browser-native createImageBitmap) + ICC read via vips
 * - Encode: @jsquash/avif in an isolated Worker (/ext/wasm/avif/avif-worker.js).
 *   Does NOT use vips-heif — see encode.ts header for rationale + the tracked
 *   "no ICC embed" defect.
 * - Metadata: main thread via ExifReader
 */

import type {
  ImageFormatHandler,
  DecodeOptions,
  DecodedPayload,
  EncodeOptions,
} from '../../types';
import type { ImageMetadata } from '../../types';
import type { IngestDecision } from '../../strategy';
import { decodeAvif } from './decode';
import { encodeAvif } from './encode';
import { extractAvifMetadata } from './metadata';

export class AvifHandler implements ImageFormatHandler {
  readonly format = 'avif';
  readonly mimeTypes = ['image/avif'];
  readonly extensions = ['avif'];

  decode(
    file: File,
    metadata: ImageMetadata,
    decision: IngestDecision,
    _options?: DecodeOptions,
  ): Promise<DecodedPayload[]> {
    return decodeAvif(file, metadata, decision);
  }

  encode(
    source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
    options: EncodeOptions,
  ): Promise<Blob> {
    return encodeAvif(source, options);
  }

  async extractMetadata(file: File): Promise<ImageMetadata> {
    return extractAvifMetadata(file);
  }
}
