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
 * RAW decode — pure pixel producer driven by the pre-resolved IngestDecision.
 *
 * The handler no longer sniffs metadata or derives a colour
 * strategy of its own. The FileService entry injects `metadata` + `decision`
 * (the single `resolveIngestDecision` call), and this function simply executes
 * the assigned `decision.decodeChannel` (always `libraw` for RAW). `colorIdentity`
 * / `sourceBlob` are mounted by the entry — hence the `Omit` return.
 *
 * The libraw transcode step still takes a source/target/conversion triple, but it
 * is now derived from `decision.colorIdentity.gamut` instead of `getImportStrategy`:
 *   - `conversion: 'matrix'` iff the source is a WIDE gamut (adobe/prophoto) — the
 *     ONLY case where `convertRawToBlob` folds the 8-bit display copy (the old
 *     'none' / 'icc-engine' both meant "no fold", so they collapse to 'none' here).
 *   - `targetColorSpace` is the display proxy's canvas tag: 'srgb' for an sRGB
 *     source, 'display-p3' otherwise — bit-identical to the former IMPORT_PIPELINE
 *     mapping, and consistent with the sibling decoders (wide → P3, else verbatim).
 * The 16-bit high-depth naked pixels are always the UNCONVERTED source-gamut line
 * (the GPU does the source→working fold), tagged with the authoritative gamut.
 */

import type { WorkingColorSpace, GamutId } from '@opengpex/editor/core/types';
import type { DecodedPayload, ImageMetadata } from '../../types';
import type { IngestDecision } from '../../strategy';
import { convertRawToBlob } from './libraw';

/**
 * Map the authoritative source gamut → LibRaw `-o` output-colour enum (defect B).
 *
 * LibRaw / libraw-wasm `-o` values: `0=raw, 1=sRGB, 2=Adobe, 3=Wide, 4=ProPhoto,
 * 5=XYZ, 6=ACES, 7=DCI-P3(D65), 8=Rec2020`. Picking the enum that MATCHES the
 * probed gamut makes the demosaiced pixels physically live in that gamut, so the
 * `colorIdentity.gamut` tag is honest (replaces the former hard-coded `5`, which
 * was XYZ, not ProPhoto). Exhaustive over `GamutId` — no `default`, so a new gamut
 * member is a compile error until it gets an explicit mapping.
 */
export function librawOutputColorFor(gamut: GamutId): number {
  switch (gamut) {
    case 'srgb':
      return 1;
    case 'adobe-rgb':
      return 2;
    case 'prophoto-rgb':
      return 4;
    case 'display-p3':
      return 7; // DCI-P3 D65 = Display P3 primaries
    case 'rec2020':
      return 8;
  }
}

/**
 * Decode a Camera RAW file by executing the entry-resolved ingest decision.
 */
export async function decodeRaw(
  file: File,
  _metadata: ImageMetadata,
  decision: IngestDecision,
): Promise<DecodedPayload[]> {
  if (decision.decodeChannel !== 'libraw') {
    // RAW only ever routes to 'libraw'; any other channel is a decision/handler
    // mismatch that must fail loudly rather than mis-decode.
    throw new Error(`decodeRaw: unexpected decodeChannel '${decision.decodeChannel}'`);
  }

  const gamut = decision.colorIdentity.gamut;
  const isWideGamut8 = gamut === 'adobe-rgb' || gamut === 'prophoto-rgb';

  // Decode RAW → 8-bit display blob (+ optional 16-bit naked pixels) via
  // libraw-wasm (spawns its own internal Worker). Only a wide-gamut source needs
  // the CPU matrix fold on the 8-bit display copy; the naked f16 line is always
  // the unconverted source-gamut pixels (GPU folds source→working).
  const decoded = await convertRawToBlob(file, {
    sourceColorSpace: gamut as WorkingColorSpace,
    targetColorSpace: gamut === 'srgb' ? 'srgb' : 'display-p3',
    conversion: isWideGamut8 ? 'matrix' : 'none',
    // Derive LibRaw output-colour from the probed gamut so pixels == tag (defect B).
    outputColor: librawOutputColorFor(gamut),
  });
  const safeFile = new File(
    [decoded.displayBlob],
    file.name.replace(/\.[^.]+$/, '.png'),
    { type: 'image/png' },
  );

  const dimensions = { w: decoded.width, h: decoded.height };

  return [{
    displayBlob: safeFile,
    width: dimensions.w,
    height: dimensions.h,
    index: 0,
    // RAW's 16-bit pixels are transcoder-produced HERE (libraw), not via
    // vips `decodeHighDepth` on the source blob — the retained sourceBlob is the
    // ORIGINAL camera file (CR2/NEF/…), which vips cannot decode. So we hand the
    // pre-decoded naked pixels straight to the importer to warm the cache.
    // ⚠️ COLD RELOAD: on reload/revert `highDepthTextureCache` is
    // empty and CanvasStage's `getOrFetch → getRaw → decodeHighDepth` fetches the
    // RAW source blob → vips cannot decode it → falls back to the 8-bit display
    // blob if rawbuf is unavailable (no crash, just loses >8-bit precision until re-import).
    // BARE payload — container/trc/gamut live on the sibling `colorIdentity` the
    // entry injects (Path B); the source-gamut tag is carried there, not per-page.
    highDepthSource: decoded.highDepth
      ? {
          data: decoded.highDepth.data,
          width: decoded.highDepth.width,
          height: decoded.highDepth.height,
        }
      : undefined,
  }];
}
