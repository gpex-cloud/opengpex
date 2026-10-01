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
 * AVIF decode — pure pixel producer driven by the pre-resolved IngestDecision.
 *
 * The handler no longer sniffs metadata or derives a colour
 * strategy of its own. The FileService entry injects `metadata` + `decision`
 * (the single `resolveIngestDecision` call), and this function simply executes
 * the assigned `decision.decodeChannel`, delegating the 8-bit wide-gamut fold to
 * the shared `decodeWideGamut8`. `colorIdentity` / `sourceBlob` are
 * mounted by the entry — hence the `Omit` return.
 *
 * ⚠️ KNOWN DEFECT (deliberate, tracked — see also ./encode.ts): AVIF is uniformly
 * 8-bit in this editor. High-depth (10/12-bit) AVIF decode would need vips-heif,
 * which shares the wasm-vips singleton + its fixed heap; an OOM there corrupts
 * every other vips consumer (TIFF/PNG/ICC) with no restart path. So the ingest
 * decision clamps a >8-bit AVIF to 8-bit at its source, and
 * this decoder only ever sees the two 8-bit channels below (`image-bitmap` /
 * `wide-gamut-8`); a >8-bit AVIF is decoded to an 8-bit display bitmap and does
 * NOT gain >8-bit screen precision. FUTURE FIX (no shared-vips risk): decode
 * 10/12-bit AVIF via an isolated @jsquash/avif-style decoder, then AVIF can
 * rejoin the >8-bit high-depth set.
 */

import type { ImageMetadata, DecodedPayload } from '../../types';
import type { IngestDecision } from '../../strategy';
import { decodeWideGamut8 } from '../../shared/lib-custom';
import { readImageDimensions } from '../../utils';

/**
 * Decode an AVIF file by executing the entry-resolved ingest decision.
 */
export async function decodeAvif(
  file: File,
  metadata: ImageMetadata,
  decision: IngestDecision,
): Promise<DecodedPayload[]> {

  let displayBlob: Blob = file;
  let dimensions: { w: number; h: number };
  let highDepthSource: DecodedPayload['highDepthSource'];

  switch (decision.decodeChannel) {
    case 'image-bitmap': {
      // Standard sRGB / Display-P3 8-bit: browser-native decode is sufficient,
      // the original file bytes remain the verbatim displayBlob.
      dimensions = await readImageDimensions(file);
      break;
    }

    case 'wide-gamut-8': {
      // 8-bit wide-gamut (Adobe RGB / ProPhoto): decode with browser colour management
      // OFF, lift f16 naked line AND fold P3 preview in one call.
      // NB: this is the CPU helper path (createImageBitmap + gammaToLinear), NOT
      // the vips-heif >8-bit path — no shared-singleton OOM hazard. Wide-gamut
      // AVIF is near-nonexistent in practice (its wide gamut is rec2020 = gap #8),
      // wired only for consistency since the shared decode is format-agnostic.
      const decoded = await decodeWideGamut8(
        file,
        decision.colorIdentity.gamut as 'adobe-rgb' | 'prophoto-rgb',
      );
      dimensions = { w: decoded.width, h: decoded.height };
      displayBlob = decoded.displayBlob;
      // Bare payload only — container/trc/gamut live on the sibling `colorIdentity`
      // the entry injects (Path B).
      highDepthSource = {
        data: decoded.highDepthSource.data,
        width: decoded.highDepthSource.width,
        height: decoded.highDepthSource.height,
      };
      break;
    }

    default:
      // AVIF only ever routes to the two 8-bit channels above (unknown / multi-
      // frame / high-depth are steered to 'unsupported' at the entry). Any other
      // channel is a decision/handler mismatch that must fail loudly.
      throw new Error(`decodeAvif: unexpected decodeChannel '${decision.decodeChannel}'`);
  }

  return [{ displayBlob, width: dimensions.w, height: dimensions.h, index: 0, highDepthSource }];
}
