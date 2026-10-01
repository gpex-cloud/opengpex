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
 * HEIC decode — pure pixel producer driven by the pre-resolved IngestDecision.
 *
 * The handler does not sniff metadata or derive a colour
 * strategy of its own. The FileService entry injects `metadata` + `decision`
 * (the single `resolveIngestDecision` call), and this function simply executes
 * the assigned `decision.decodeChannel`. `colorIdentity` / `sourceBlob` are
 * mounted by the entry — hence the `Omit` return.
 *
 * HEIC specifics vs. the jpeg/png pilots:
 *   - HEIC is not browser-natively decodable in all environments, so it ALWAYS
 *     routes to the `heic-to` channel (`format === 'heic'` short-circuits in
 *     `resolveIngestDecision` before any colour-space branch). Step one is thus
 *     always a HEIC → JPEG transcode (q0.95 proxy container).
 *   - Colour handling then splits on the pre-resolved `colorIdentity.gamut`,
 *     exactly like TIFF splits inside its `vips` channel: standard sRGB / P3
 *     keeps the transcoded JPEG verbatim as the displayBlob, while 8-bit wide
 *     gamut (Adobe RGB / ProPhoto) reads the transcoded pixels back and hands
 *     them to the shared `decodeWideGamut8` (f16 lift + P3 proxy fold).
 */

import type { ImageMetadata, DecodedPayload } from '../../types';
import type { IngestDecision } from '../../strategy';
import { decodeWideGamut8 } from '../../shared/lib-custom';
import { readImageDimensions } from '../../utils';
import { convertHeicToBlob } from './transcode';

/**
 * Decode a HEIC file by executing the entry-resolved ingest decision.
 */
export async function decodeHeic(
  file: File,
  _metadata: ImageMetadata,
  decision: IngestDecision,
): Promise<DecodedPayload[]> {
  if (decision.decodeChannel !== 'heic-to') {
    // HEIC only ever routes to 'heic-to'; any other channel is a decision/handler
    // mismatch that must fail loudly rather than mis-decode.
    throw new Error(`decodeHeic: unexpected decodeChannel '${decision.decodeChannel}'`);
  }

  // 1. Transcode HEIC → JPEG (q0.95 proxy container) via heic-to. The browser's
  //    native HEIC decoder (where available) already colour-manages this step.
  const jpegBlob = await convertHeicToBlob(file);
  const safeFile = new File(
    [jpegBlob],
    file.name.replace(/\.(heic|heif)$/i, '.jpg'),
    { type: 'image/jpeg' },
  );

  const gamut = decision.colorIdentity.gamut;
  let displayBlob: Blob = safeFile;
  let dimensions: { w: number; h: number };
  let highDepthSource: DecodedPayload['highDepthSource'];

  if (gamut === 'adobe-rgb' || gamut === 'prophoto-rgb') {
    // 8-bit wide-gamut: decode with browser colour management OFF, lift f16
    // naked line AND fold P3 display proxy in one call.
    // `gamut` is already narrowed to 'adobe-rgb' | 'prophoto-rgb' here.
    const decoded = await decodeWideGamut8(safeFile, gamut);
    dimensions = { w: decoded.width, h: decoded.height };
    displayBlob = decoded.displayBlob;
    // Bare payload only — container/trc/gamut live on the sibling `colorIdentity`
    // the entry injects (Path B).
    highDepthSource = {
      data: decoded.highDepthSource.data,
      width: decoded.highDepthSource.width,
      height: decoded.highDepthSource.height,
    };
  } else {
    // Standard sRGB / Display-P3 (incl. unknown → srgb): browser-native decode of
    // the transcoded JPEG is sufficient; its bytes stay the verbatim displayBlob.
    dimensions = await readImageDimensions(safeFile);
  }

  return [{ displayBlob, width: dimensions.w, height: dimensions.h, index: 0, highDepthSource }];
}
