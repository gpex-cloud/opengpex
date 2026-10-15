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
 *   - `'libheif-proxy'` (19b/19c/19e/19-wg): heic-worker libheif decode → same
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
import {
  wideGamut8ToF16,
  srgbToLinear,
  linearFloatToFloat16,
} from '@opengpex/editor/core/engine/color';
import { parseHeicContainer } from './metadata/container';
import { convertHeicToBlob, buildGamutProxy } from './transcode';
import { decodeHeicHard } from './harddecode';

/**
 * Lift the decoded SDR base onto the linear f16 master line — and NOTHING
 * else. The gain map is deliberately NOT applied here.
 *
 * WHY NOT BAKE hdr = sdr·2^gain INTO THE MASTER: the engine renders BOTH
 * HDR-OFF and HDR-ON from the ONE resident f16 line (the `hdr` switch only
 * selects the view pipeline's white clamp vs extended range — never the data
 * source). A baked-HDR master therefore makes the OFF presentation the
 * CLAMPED HDR rendition, not the file's authoritative SDR base: a 2× sky
 * (0.2, 0.4, 1.8) clamps to (0.2, 0.4, 1.0) — the blue channel pins at white
 * and the image hue-skews (deep saturated sky, vivid foliage). PQ AVIF does
 * not have this problem because its scene-linear buffer IS its only
 * rendition; a gain-map file carries TWO (SDR base + HDR derived), and OFF
 * must show the former. The gain map stays a presentation adjunct — decoded
 * from the retained source file (`handlers/heic/gainmap.ts`) and applied at
 * the view pass (`engine/color/gainMap.ts` holds the math), so OFF is always
 * exactly the authored SDR look.
 */
function liftBaseToF16(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): DecodedPayload['highDepthSource'] {
  const linear = new Float32Array(width * height * 4);
  for (let i = 0; i < linear.length; i += 4) {
    linear[i] = srgbToLinear(rgba[i] / 255);
    linear[i + 1] = srgbToLinear(rgba[i + 1] / 255);
    linear[i + 2] = srgbToLinear(rgba[i + 2] / 255);
    linear[i + 3] = rgba[i + 3] / 255;
  }
  return { data: linearFloatToFloat16(linear), width, height };
}

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

  return [{ displayBlob, width, height, index: 0, highDepthSource }];
}
