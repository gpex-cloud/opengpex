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
 * The handler no longer sniffs metadata or derives a colour strategy of its
 * own. The FileService entry injects `metadata` + `decision` (the single
 * `resolveIngestDecision` call), and this function simply executes the
 * assigned `decision.decodeChannel`. `colorIdentity` / `sourceBlob` are
 * mounted by the entry — hence the `Omit` return.
 *
 * Channels (2026-10-13 avif pipeline, probe-backed — gpex-cloud/probes/avif):
 *   - `'image-bitmap'` (15a): 8-bit SDR verbatim passthrough, browser-native.
 *   - `'wide-gamut-8'` (17): 8-bit wide-gamut CPU lift + P3 fold (unchanged).
 *   - `'avif-proxy'` (15b / 16-r2020, NEW): the old >8→8-bit clamp is gone — the
 *     isolated jsquash/libavif wasm decoder delivers bit-exact NATIVE-depth
 *     pixels (ramp probes round-trip with zero error; 12MP ≈ 0.57s). ONE
 *     decode feeds both outputs:
 *       • highDepthSource = f16, left-shifted to the 65535 scale (lossless:
 *         10-bit << 6, 12-bit << 4 ⇒ value = native / (2^bit − 1)) — srgb-trc
 *         rows keep the source encoding; the wide-gamut rows were deleted (2026-10-18),
 *         the standing wideGamut16ToF16;
 *       • display proxy = 8-bit truncation of the same native pixels, iCCP-
 *         tagged by the shared gamut proxy (folded P3 for wide gamut).
 *     The metadata reports the TRUE depth; no precision is lost on the f16
 *     line and the Fail-Fast rule holds: any decode error propagates, never a
 *     silent 8-bit fallback.
 */

import type { ImageMetadata, DecodedPayload } from '../../types';
import type { IngestDecision } from '../../strategy';
import {
  wideGamut16ToF16,
  normalizedUint16ToFloat16,
  hdrTransfer16ToF16,
  pqToSceneLinear,
  hlgToSceneLinear,
  deriveMatrix64,
} from '@opengpex/editor/core/engine/color';
import { renderSdrDown } from '@opengpex/editor/core/engine/color/shoulder';
import { linearToSrgb } from '@opengpex/editor/core/engine/color/trc';
import { readImageDimensions } from '../../utils';
import { buildGamutProxy } from '../heic/transcode';
import { decodeAvifJsquash } from './worker';

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

    case 'avif-proxy': {
      // ≥10-bit (15b / 16-r2020): wasm decode at the source's
      // TRUE depth — the metadata already declares it honestly (no clamp).
      const gamut = decision.colorIdentity.gamut;
      const requestedDepth = metadata.bitDepth >= 12 ? 12 : 10;
      const native = await decodeAvifJsquash(await file.arrayBuffer(), requestedDepth);
      dimensions = { w: native.width, h: native.height };
      if (!(native.pixels instanceof Uint16Array)) {
        // jsquash contract: bitDepth 10/12 ⇒ Uint16Array; anything else is a
        // decoder/decision mismatch and must fail loudly.
        throw new Error(`decodeAvif: avif-proxy expected Uint16Array at depth ${requestedDepth}`);
      }

      // Exact pre-scale onto the 65535 scale: v × 65535/(2^bit − 1), so the
      // downstream /65535 normalizations yield exactly v/(2^bit − 1). (A bare
      // left-shift would darken uniformly by ~0.1% — 65535 ≠ 65472 — breaking
      // the bit-exact-into-f16 promise the probe pinned.)
      const upscale = 65535 / ((1 << requestedDepth) - 1);
      const naked = new Uint16Array(native.pixels.length);
      for (let i = 0; i < native.pixels.length; i++) naked[i] = (native.pixels[i] * upscale + 0.5) | 0;

      // ── HDR lane (PQ/HLG, rules 18-hdr-*) ──
      // The decoder delivered RAW TRANSFER CODE VALUES (probe: maxDev 0)
      // — the EOTF is ours: 203-nit-anchored scene-linear in the SOURCE
      // gamut, trc 'linear' + the source gamut tag (the shader's
      // gamut_to_working does the W matrix; NO default look — the HDR
      // presentation switch owns rendering semantics).
      const transfer = metadata.raw?.transfer;
      if (transfer === 'pq' || transfer === 'hlg') {
        highDepthSource = {
          data: hdrTransfer16ToF16(naked, transfer),
          width: native.width,
          height: native.height,
        };

        // SDR display proxy: source-gamut scene-linear → display-p3 linear
        // (projection) → direct-pass shoulder down-render (display domain,
        // chromaticity-preserving scalar gain) → sRGB-encode → 8-bit PNG
        // tagged display-p3. This is the toggle-OFF look the panel shows
        // before the compositor takes over (WYSIWYG sibling of the SDR
        // present variant's white clamp).
        const m = deriveMatrix64(gamut, 'display-p3');
        const toScene = transfer === 'pq' ? pqToSceneLinear : hlgToSceneLinear;
        const rgba8 = new Uint8ClampedArray(native.width * native.height * 4);
        for (let px = 0; px < rgba8.length; px += 4) {
          // Raw transfer code → scene-linear (203 anchor) per channel, then
          // the display-gamut projection and the shoulder down-render.
          const sr = toScene(naked[px] / 65535);
          const sg = toScene(naked[px + 1] / 65535);
          const sb = toScene(naked[px + 2] / 65535);
          const dr = m[0] * sr + m[1] * sg + m[2] * sb;
          const dg = m[3] * sr + m[4] * sg + m[5] * sb;
          const db = m[6] * sr + m[7] * sg + m[8] * sb;
          const [or_, og, ob] = renderSdrDown(dr, dg, db);
          rgba8[px] = linearToSrgb(Math.min(1, Math.max(0, or_))) * 255;
          rgba8[px + 1] = linearToSrgb(Math.min(1, Math.max(0, og))) * 255;
          rgba8[px + 2] = linearToSrgb(Math.min(1, Math.max(0, ob))) * 255;
          // Alpha from the NATIVE-scale codes (naked is 16-bit scale —
          // shifting it by depth−8 would clamp every α>1.5% to 255).
          rgba8[px + 3] = native.pixels[px + 3] >> (requestedDepth - 8);
        }
        const proxy = await buildGamutProxy(rgba8, native.width, native.height, 'display-p3');
        displayBlob = proxy.displayBlob;
      } else if (gamut === 'adobe-rgb' || gamut === 'prophoto-rgb' || gamut === 'rec2020') {
        // D4's SDR BT.2020 (and the deleted 16-wg used the same shape): de-gamma the source-encoded pixels onto
        // the true-linear f16 line (PNG/TIFF row-8 semantics — the wide-gamut
        // standing rule). rec2020 de-gammas through the BT.709/BT.2020 OETF.
        const lifted = wideGamut16ToF16(naked, native.width, native.height, gamut);
        highDepthSource = { data: lifted.data, width: lifted.width, height: lifted.height };
      } else {
        // 15b: srgb-trc — f16 keeps the source encoding, plain normalization.
        highDepthSource = {
          data: normalizedUint16ToFloat16(naked),
          width: native.width,
          height: native.height,
        };
      }

      // Display proxy: 8-bit truncation of the SAME native pixels (verbatim
      // consistency with the f16 line), then the shared gamut-tagged PNG tail.
      const dropBits = requestedDepth - 8;
      const rgba8 = new Uint8ClampedArray(native.width * native.height * 4);
      for (let i = 0; i < rgba8.length; i++) rgba8[i] = native.pixels[i] >> dropBits;
      const proxy = await buildGamutProxy(rgba8, native.width, native.height, gamut);
      displayBlob = proxy.displayBlob;
      break;
    }

    default:
      // AVIF routes only to the channels above (unknown / multi-frame / HDR are
      // steered to 'unsupported' at the entry). Any other channel is a
      // decision/handler mismatch that must fail loudly.
      throw new Error(`decodeAvif: unexpected decodeChannel '${decision.decodeChannel}'`);
  }

  return [{ displayBlob, width: dimensions.w, height: dimensions.h, index: 0, highDepthSource }];
}
