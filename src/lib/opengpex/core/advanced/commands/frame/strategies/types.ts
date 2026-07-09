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
 * Shared types for frame import strategies.
 */

import type { EditorContextValue } from '@opengpex/editor/core/types';
import type { DecodeResult } from '@opengpex/editor/core/files/types';

/**
 * Context passed to import strategy functions.
 *
 * Encapsulates all the parameters needed by each strategy
 * to create a frame from decoded image data.
 */
export interface ImportContext {
  /** Editor context (services, state, actions) */
  ctx: EditorContextValue;
  /** Original source file */
  file: File;
  /** Decoded result from FileService */
  decoded: DecodeResult;
  /** How the file was obtained */
  sourceType: 'local' | 'url';
  /** Whether to switch viewport to the newly created frame */
  switchFrame: boolean;
  /** User-chosen DPI for vector imports (undefined for raster) */
  chosenFrameDpi?: number;
  /** Extra metadata to attach to the frame */
  extra?: Record<string, unknown>;
}
