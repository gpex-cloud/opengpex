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
 * Camera RAW Format Handler (V2).
 *
 * Supports: CR2, CR3, NEF, NRW, ARW, DNG, ORF, RW2, RAF, PEF, SRW, RAW, RWL, 3FR, FFF, IIQ
 *
 * High-level entry point implementing ImageFormatHandler.
 * Delegates to decode/metadata sub-modules.
 *
 * Note: RAW encoding is NOT supported (RAW is a capture-only format).
 *
 * Thread model: Decode runs heavy computation on Worker via libraw-wasm.
 * EXIF extraction runs on main thread (lightweight header-only parse).
 */

import type { AssetService } from '@opengpex/editor/core/types';
import type {
  ImageFormatHandler,
  DecodeOptions,
  DecodeResult,
  EncodeOptions,
} from '../../types';
import type { ImageMetadata } from '../../types';
import { decodeRaw } from './decode';
import { extractRawMetadata } from './metadata';

export class RawHandler implements ImageFormatHandler {
  readonly format = 'raw';
  readonly needsTranscoding = true;
  readonly mimeTypes = [
    'image/x-dcraw', 'image/x-adobe-dng',
    'image/x-canon-cr2', 'image/x-nikon-nef', 'image/x-sony-arw',
  ];
  readonly extensions = [
    'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2',
    'dng', 'orf', 'rw2', 'raf', 'pef', 'srw',
    'raw', 'rwl', '3fr', 'fff', 'iiq',
  ];

  constructor(private assets: AssetService) {}

  decode(file: File, options?: DecodeOptions): Promise<DecodeResult> {
    return decodeRaw(file, options);
  }

  async encode(
    _source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
    _options: EncodeOptions,
  ): Promise<Blob> {
    throw new Error('[RawHandler] RAW encoding is not supported. RAW is a capture-only format.');
  }

  async extractMetadata(file: File): Promise<ImageMetadata> {
    return extractRawMetadata(file);
  }
}
