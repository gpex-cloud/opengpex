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
 * TIFF Format Handler (V2) — wasm-vips powered.
 *
 * High-level entry point implementing ImageFormatHandler.
 * Delegates to decode/encode/metadata sub-modules.
 *
 * Also re-exports public APIs for 16-bit high-res export.
 *
 * Thread model (vips unification):
 * - All vips operations flow through the files-layer shared lib-vips worker
 * - IFD metadata extraction runs on main thread (lightweight header-only parse, <10ms)
 */

import type { AssetService } from '@opengpex/editor/core/types';
import type {
  ImageFormatHandler,
  DecodeOptions,
  DecodedPayload,
  EncodeOptions,
  EncodeSource,
} from '../../types';
import type { ImageMetadata } from '../../types';
import type { IngestDecision } from '../../strategy';
import { decodeTiff } from './decode';
import { encodeTiff } from './encode';
import { extractTiffMetadata } from './metadata';

export class TiffHandler implements ImageFormatHandler {
  readonly format = 'tiff';
  readonly needsTranscoding = true;
  readonly mimeTypes = ['image/tiff'];
  readonly extensions = ['tiff', 'tif'];

  constructor(
    private assets: AssetService,
  ) {}

  decode(
    file: File,
    metadata: ImageMetadata,
    decision: IngestDecision,
    _options?: DecodeOptions,
  ): Promise<DecodedPayload[]> {
    return decodeTiff(file, metadata, decision);
  }

  encode(
    source: EncodeSource,
    options: EncodeOptions,
  ): Promise<Blob> {
    return encodeTiff(source, options);
  }

  async extractMetadata(file: File): Promise<ImageMetadata> {
    return extractTiffMetadata(file);
  }
}

// Re-export public types and functions
export type { TiffCompression, TiffEncodeOptions } from './encode';
