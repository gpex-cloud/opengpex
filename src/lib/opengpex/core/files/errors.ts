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
 * Declared ingest termini as typed errors.
 *
 * `unsupported` is a DECISION, not a malfunction (matrix row 26 semantics:
 * the execution layer throws this typed error to show a precise
 * "unsupported" notice instead of forcing a decode attempt).
 * The FileService entry short-circuits the dispatch with this error BEFORE
 * any handler runs, so the UI can show the precise reason and the console
 * stays free of failure stack traces for expected rejections.
 */

import type { ImageMetadata } from './types';

export type UnsupportedIngestReason = 'hdr' | 'multiframe' | 'sub8bit' | 'generic';

export class UnsupportedIngestError extends Error {
  constructor(
    message: string,
    readonly reason: UnsupportedIngestReason,
  ) {
    super(message);
    this.name = 'UnsupportedIngestError';
  }
}

/** Build the declared-terminus error for a resolved `unsupported` decision. */
export function unsupportedIngestError(metadata: ImageMetadata): UnsupportedIngestError {
  const format = metadata.sourceFormat.toUpperCase();
  if (metadata.isMultiFrame) {
    return new UnsupportedIngestError(
      `${format}: animated / multi-frame sequences are not supported yet.`,
      'multiframe',
    );
  }
  if (metadata.colorSpace === 'unknown') {
    return new UnsupportedIngestError(
      `${format}: HDR content (PQ / HLG / BT.2020) is not supported yet.`,
      'hdr',
    );
  }
  if (metadata.bitDepth < 8) {
    return new UnsupportedIngestError(
      `${format}: sub-8-bit images are not supported yet.`,
      'sub8bit',
    );
  }
  return new UnsupportedIngestError(
    `${format}: this file variant is not supported yet.`,
    'generic',
  );
}
