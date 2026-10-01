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
 * metadata/icc.ts — the RAW three-tier ICC deep probe.
 *
 * SOLE RESPONSIBILITY: get the ICC PROFILE BYTES out of a TIFF-based RAW
 * container. It classifies nothing and decides nothing — naming, gamut
 * arbitration and the fallback chain all live in `./index.ts`.
 *
 * WHY THREE TIERS: a traditional DSLR RAW hangs its ICC off the top-level IFD,
 * where `extractTiffIcc` finds it. iPhone ProRAW has NO top-level ICC and no
 * `ColorSpace` tag — its only parseable Display-P3 signal is the APP2 ICC inside
 * an embedded preview JPEG, which itself lives in a **SubIFD**. So:
 *
 *   ① top-level IFD chain          `extractTiffIcc`                  (DSLR path)
 *   ② BFS over SubIFDs, direct ICC `collectTiffIccCandidates().directIcc`
 *   ③ embedded preview JPEG APP2   `extractJpegIcc` per preview      (ProRAW path)
 *
 * First hit wins, in that order — a container's own profile always outranks a
 * profile carried by a derived preview.
 *
 * @module core/files/handlers/raw/metadata/icc
 */

import { extractTiffIcc, collectTiffIccCandidates } from '../../../metadata/tiff-ifd-reader';
import { extractJpegIcc } from '../../jpeg/jfif';

/**
 * Resolve the RAW's embedded ICC profile bytes via the three-tier probe above,
 * or `null` when the container carries no parseable profile anywhere.
 *
 * Pure over the already-read file bytes (no `File`, no I/O), so it is directly
 * unit-testable against synthesised TIFF containers.
 */
export function resolveRawIccBytes(fileBytes: Uint8Array): Uint8Array | null {
  // ① Top-level TIFF IFD tag 34675.
  const topLevel = extractTiffIcc(fileBytes);
  if (topLevel && topLevel.length > 0) return topLevel;

  // ②/③ Walk the FULL IFD tree once, then prefer a direct SubIFD ICC over a
  // preview-carried one.
  const candidates = collectTiffIccCandidates(fileBytes);
  if (candidates.directIcc && candidates.directIcc.length > 0) return candidates.directIcc;

  for (const preview of candidates.jpegPreviews) {
    const jpegIcc = extractJpegIcc(preview);
    if (jpegIcc && jpegIcc.length > 0) return jpegIcc;
  }

  return null;
}
