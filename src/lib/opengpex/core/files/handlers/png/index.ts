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
 * PNG Format Handler (V2).
 *
 * High-level entry point implementing ImageFormatHandler.
 * Delegates to decode/encode/metadata sub-modules.
 *
 * Thread model: ALL operations run on main thread (<100ms for typical files).
 * PNG chunk parsing is O(n) over chunk headers only, skipping IDAT data.
 */

import type {
  ImageFormatHandler,
  DecodeOptions,
  DecodedPayload,
  EncodeOptions,
  EncodeSource,
} from '../../types';
import type { ImageMetadata } from '../../types';
import type { IngestDecision } from '../../strategy';
import { decodePng } from './decode';
import { encodePng } from './encode';
import { extractPngMetadata } from './metadata';

export class PngHandler implements ImageFormatHandler {
  readonly format = 'png';
  readonly mimeTypes = ['image/png'];
  readonly extensions = ['png'];

  decode(
    file: File,
    metadata: ImageMetadata,
    decision: IngestDecision,
    _options?: DecodeOptions,
  ): Promise<DecodedPayload[]> {
    return decodePng(file, metadata, decision);
  }

  encode(
    source: EncodeSource,
    options: EncodeOptions,
  ): Promise<Blob> {
    return encodePng(source, options);
  }

  async extractMetadata(file: File): Promise<ImageMetadata> {
    return extractPngMetadata(file);
  }
}
