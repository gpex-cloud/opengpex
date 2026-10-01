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
 * HEIC/HEIF Format Handler (V2).
 *
 * High-level entry point implementing ImageFormatHandler.
 * Delegates to decode/metadata sub-modules.
 *
 * Note: HEIC encoding is NOT supported (no browser HEIC encoder exists).
 *
 * Thread model: Decode runs on main thread via heic-to.
 * Future: migrate to Worker-based libheif-wasm for better perf.
 */

import type { AssetService } from '@opengpex/editor/core/types';
import type {
  ImageFormatHandler,
  DecodeOptions,
  DecodedPayload,
  EncodeOptions,
} from '../../types';
import type { ImageMetadata } from '../../types';
import type { IngestDecision } from '../../strategy';
import { decodeHeic } from './decode';
import { extractHeicMetadata } from './metadata';

export class HeicHandler implements ImageFormatHandler {
  readonly format = 'heic';
  readonly needsTranscoding = true;
  readonly mimeTypes = ['image/heic', 'image/heif'];
  readonly extensions = ['heic', 'heif'];

  constructor(private assets: AssetService) {}

  decode(
    file: File,
    metadata: ImageMetadata,
    decision: IngestDecision,
    _options?: DecodeOptions,
  ): Promise<DecodedPayload[]> {
    return decodeHeic(file, metadata, decision);
  }

  async encode(
    _source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
    _options: EncodeOptions,
  ): Promise<Blob> {
    throw new Error('[HeicHandler] HEIC encoding is not supported in browsers. Use JPEG or PNG.');
  }

  async extractMetadata(file: File): Promise<ImageMetadata> {
    return extractHeicMetadata(file);
  }
}
