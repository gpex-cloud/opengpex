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
 * The handler does not sniff metadata or derive a colour strategy of its own.
 * The FileService entry injects `metadata` + `decision` (the single
 * `resolveIngestDecision` call, with the HEVC capability flag awaited in the
 * entry) and this function simply executes the assigned
 * `decision.decodeChannel`. `colorIdentity` / `sourceBlob` are mounted by the
 * entry — hence the `Omit` return.
 *
 * Channel map (both stages landed):
 *   - `'webcodecs-heic'` (19a, capability-gated): container parse → per-tile
 *     VideoDecoder decode in the files-layer worker → fixed-point YUV→RGB →
 *     uprighted RGBA → iCCP-tagged PNG proxy. Fail-Fast: any hard-decode error
 *     propagates — the decision-time capability probe already admitted this
 *     route, so a failure means probe/decoder disagreement, never a silent
 *     proxy fallback.
 *   - `'libheif-proxy'` (19b/19c/19e/19-gm-proxy): heic-worker libheif decode → same
 *     proxy tail. 10/12-bit sources deliver 8-bit while the metadata reports
 *     the TRUE depth.
 *
 * Wide-gamut composition (adobe-rgb / prophoto-rgb; type-reachable, not seen
 * in practice) reuses the standing wide-gamut rules on both channels: the
 * verbatim source-encoded pixels are f16-lifted here and P3-folded into the
 * proxy.
 */

import type { ImageMetadata, DecodedPayload } from '../../types';
import type { IngestDecision } from '../../strategy';
import { wideGamut8ToF16 } from '@opengpex/editor/core/engine/color';
import { liftBaseToF16 } from '../../shared/gain-map';
import { parseHeicContainer } from './metadata/container';
import { convertHeicToBlob, buildGamutProxy } from './transcode';
import { decodeHeicHard } from './harddecode';
import { extractHeicGainMapInto } from './gainmap';

/**
 * Decode a HEIC file by executing the entry-resolved ingest decision.
 */
export async function decodeHeic(
  file: File,
  metadata: ImageMetadata,
  decision: IngestDecision,
): Promise<DecodedPayload[]> {
  const channel = decision.decodeChannel;
  if (channel !== 'webcodecs-heic' && channel !== 'libheif-proxy') {
    // Those two are the only HEIC routes; anything else is a decision/handler
    // mismatch that must fail loudly rather than mis-decode.
    throw new Error(`decodeHeic: unexpected decodeChannel '${channel}'`);
  }

  const gamut = decision.colorIdentity.gamut;
  let displayBlob: Blob;
  let width: number;
  let height: number;
  let rgba: Uint8ClampedArray | undefined;

  if (channel === 'webcodecs-heic') {
    // Hardware path: container parse carries the tile manifest + hvcC; the
    // worker returns uprighted RGBA-8 (values verbatim source-encoded).
    const bytes = new Uint8Array(await file.arrayBuffer());
    const view = parseHeicContainer(bytes, { extractPayload: true });
    // Colour signal: nclx matrix 9 = BT.2020; everything else (incl. ICC-only
    // Apple files) is BT.709-quantized SDR.
    const matrix = view.color.nclx?.matrixCoefficients === 9 ? '2020' : '709';
    const fullRange = view.color.nclx?.fullRangeFlag ?? false;
    const hard = await decodeHeicHard(view, matrix, fullRange);
    ({ displayBlob, width, height } = await buildGamutProxy(hard.rgba, hard.width, hard.height, gamut));
    rgba = hard.rgba;
  } else {
    // Proxy path: heic-worker libheif decode → RGBA-8 (already upright).
    ({ displayBlob, width, height, rgba } = await convertHeicToBlob(file, gamut));
  }

  // Gain-map carrier (19-gm*): the decision declares the f16 identity, and the
  // master is the LIFTED SDR BASE — the gain map is NOT applied at ingest (see
  // liftBaseToF16's header for why the bake is wrong). The lift can only fail
  // on a decoder/decision mismatch, which fails loudly like every other
  // channel.
  let highDepthSource: DecodedPayload['highDepthSource'];
  if (decision.colorIdentity.dataFormat === 'rgba16float' && metadata.raw?.hasGainmap && rgba) {
    highDepthSource = liftBaseToF16(rgba, width, height);
  } else if (gamut === 'adobe-rgb' || gamut === 'prophoto-rgb') {
    // Wide gamut: lift the unclamped f16-linear line beside the (already
    // folded) proxy — the standing wide-gamut rule composition, fed by the
    // verbatim pixels both channels return.
    const lifted = wideGamut8ToF16(rgba!, width, height, gamut);
    // Bare payload only — container/trc/gamut live on the sibling `colorIdentity`
    // the entry injects (Path B).
    highDepthSource = {
      data: lifted.data,
      width: lifted.width,
      height: lifted.height,
    };
  }

  // Gain-map carrier: extract the aux plane into `raw.gainMap` NOW — the
  // decode handler's converting phase is the one moment the worker decode is
  // free (fail-open: any failure leaves the metadata field unset and the
  // presentation degrades to SDR). The runtime later decodes the COMPACT
  // stored image per session; it never re-opens the source file.
  if (metadata.raw?.hasGainmap) {
    await extractHeicGainMapInto(file, metadata);
  }

  return [{ displayBlob, width, height, index: 0, highDepthSource }];
}
