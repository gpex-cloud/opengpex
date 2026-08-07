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
 * Re-export stub for backward compatibility.
 *
 * Canonical definitions now live in `./types.ts`.
 * Existing imports from `../../metadata` continue to work via this file.
 *
 * New code should import directly from `./types` instead.
 *
 * @deprecated Import from './types' instead.
 */
export type {
  ImageMetadata,
  RawBinaryData,
  SourceFormat,
  DpiSource,
  ColorSpaceId,
} from './types';
