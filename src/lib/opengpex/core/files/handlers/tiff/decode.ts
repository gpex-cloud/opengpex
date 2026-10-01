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
 * TIFF decode — pure pixel producer driven by the pre-resolved IngestDecision.
 *
 * The handler no longer sniffs metadata or derives a colour
 * strategy of its own. The FileService entry injects `metadata` + `decision`
 * (the single `resolveIngestDecision` call), and this function simply executes
 * the assigned `decision.decodeChannel`. `colorIdentity` / `sourceBlob` are
 * mounted by the entry — hence the `Omit` return.
 *
 * TIFF specifics vs. the png/jpeg pilots:
 *   - `resolveIngestDecision` routes ALL non-CMYK TIFF to the `vips` channel
 *     (`format === 'tiff'` short-circuits before the `isWideGamut8` branch),
 *     because the `wide-gamut-8` channel reads pixels via the browser
 *     (`createImageBitmap`, which cannot decode TIFF). So the `vips` case here
 *     covers 8-bit wide-gamut TIFF too — vips reads it back as 8-bit source
 *     pixels (no `highDepth`), then reuses the SAME shared wide-gamut-8 decode the
 *     `wide-gamut-8` channel uses (f16 lift + P3 proxy).
 *   - CMYK TIFF routes to `vips-icc` (LibVips ICC engine, Little CMS).
 *   - Multi-page TIFF (below): probed FIRST, so a multi-page file never runs the
 *     single-page decode. Each page then resolves its OWN colour identity and its
 *     OWN high-depth pixels from its OWN IFD tags, through the same
 *     `getLibVips().decode` one-pass entry the single-page `vips` channel uses
 *     (now page-addressable). This is the one place a handler may return a
 *     per-page `colorIdentity` (see `DecodedPayload`): a multi-page TIFF's pages
 *     can genuinely differ in photometric interpretation, depth and ICC, which a
 *     single file-level identity cannot express.
 */

import type { GamutId } from '@opengpex/editor/core/types';
import type { ColorIdentity } from '@opengpex/editor/core/storage/asset/AssetStore';
import type { DecodedPayload, ImageMetadata } from '../../types';
import type { IngestDecision } from '../../strategy';
import { colorSpaceToGamut } from '../../strategy';
import { iccToBase64, parseIccProfileName } from '../../shared/icc';
import { getLibVips } from '../../shared/lib-vips';
import { probeTiffPages, readTiffPageColorInfo } from '../../metadata/tiff-ifd-reader';
import { photometricToColorSpace, inferColorSpaceFromIcc } from './metadata';
import { rgbaToBlob } from '../../utils';

/**
 * Decode a TIFF file by executing the entry-resolved ingest decision.
 *
 * The 8-bit display path is bit-exact with the former strategy-driven decoder
 * (the same preserve-mode vips readback → gamut-aware proxy). When the source is
 * >8-bit, the SAME vips pass also yields the high-bit-depth naked pixels (packed
 * to f16), surfaced on the page's `highDepthSource` — so the importer warms the
 * high-depth cache directly (RAW-aligned), no second decode. Multi-page files get
 * this per page, gated on that page's own `BitsPerSample`.
 */
export async function decodeTiff(
  file: File,
  metadata: ImageMetadata,
  decision: IngestDecision,
): Promise<DecodedPayload[]> {
  const { decodeChannel } = decision;
  if (decodeChannel !== 'vips' && decodeChannel !== 'vips-icc') {
    // TIFF only ever routes to 'vips' / 'vips-icc'; any other channel is a
    // decision/handler mismatch that must fail loudly rather than mis-decode.
    throw new Error(`decodeTiff: unexpected decodeChannel '${decodeChannel}'`);
  }

  const gamut = decision.colorIdentity.gamut;
  const wantHighDepth = decision.colorIdentity.bitDepth > 8;

  // ── Multi-page fast path (Stage 1 authoritative; no vips getPageCount RPC) ──
  // `metadata.isMultiFrame` was probed on the main thread at Stage 1
  // (`probeTiffPages`, BigTIFF included), so a multi-page TIFF is known up front
  // and never runs the single-page decode below (which would decode page 0 twice).
  // The exact page count comes from the SAME cheap main-thread IFD-walk — the old
  // cross-thread `getLibVips().getPageCount` round-trip is gone. Each page then
  // resolves its OWN colour identity and its OWN high-depth pixels from its OWN
  // IFD, so `gamut` is passed only as the per-page fallback (see decodeAllPages).
  if (metadata.isMultiFrame) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { pageCount } = probeTiffPages(bytes);
    if (pageCount > 1) {
      return decodeAllPages(bytes, pageCount, gamut);
    }
  }

  // ── Single-page path: execute the assigned decode channel ──
  let displayBlob: Blob;
  let dimensions: { w: number; h: number };
  let highDepthSource: DecodedPayload['highDepthSource'];

  if (decodeChannel === 'vips') {
    // All non-CMYK TIFF: a preserve-mode vips pass (colour management OFF) yields
    // the SOURCE-encoded 8-bit pixels AND, when the source is genuinely >8-bit,
    // the full-precision f16 naked pixels in ONE decode.
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { width, height, displayBlob: blob, highDepth } = await getLibVips().decode(bytes, {
      preserveColorSpace: true,
      wantHighDepth,
      gamut,
    });
    dimensions = { w: width, h: height };
    displayBlob = blob!;

    if (highDepth) {
      // BARE payload — container/trc/gamut live on the sibling `colorIdentity`
      // the entry injects (Path B), so they are no longer carried per-page here.
      highDepthSource = {
        data: highDepth.data,
        width: highDepth.width,
        height: highDepth.height,
      };
    }
  } else {
    // vips-icc — CMYK / custom ICC: full LibVips ICC engine conversion (Little CMS).
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { width, height, data, iccProfileData } = await getLibVips().iccToSrgb(bytes);
    dimensions = { w: width, h: height };

    // Vips reliably extracts ICC — backfill metadata if the header sniff missed it.
    if (iccProfileData && iccProfileData.length > 0 && !metadata.raw.icc) {
      metadata.raw.icc = {
        data: iccToBase64(iccProfileData),
        name: parseIccProfileName(iccProfileData) || 'Embedded',
      };
    }
    displayBlob = await rgbaToBlob(data, width, height);

    // High-depth naked pixels come from a color-management-agnostic vips pass (the
    // display path above already handled the ICC transform for the 8-bit output).
    // Preserves the former icc-engine behaviour exactly.
    if (wantHighDepth) {
      const { highDepth } = await getLibVips().decode(bytes, { wantHighDepth: true });
      if (highDepth) {
        // BARE payload (same as the `vips` branch) — container/trc/gamut come from
        // the entry-injected sibling `colorIdentity` (Path B).
        highDepthSource = {
          data: highDepth.data,
          width: highDepth.width,
          height: highDepth.height,
        };
      }
    }
  }

  return [{ displayBlob, width: dimensions.w, height: dimensions.h, index: 0, highDepthSource }];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Multi-page Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Decode every page of a multi-page TIFF, each page reaching parity with "that
 * page saved as a standalone single-page TIFF and imported on its own".
 *
 * Each page goes through the SAME `getLibVips().decode` entry as the single-page
 * `vips` channel (ONE pass → 8-bit display pixels + optional high-depth naked
 * pixels), now aimed at page `i` via its `page` option. Per page we derive:
 *   • its OWN gamut, from its OWN IFD tags (ICC first, then
 *     PhotometricInterpretation) — not page 0's;
 *   • its OWN high-depth gate, from its OWN `BitsPerSample`;
 *   • its OWN `colorIdentity`, returned on the payload so Stage 4 uses it
 *     instead of the file-level `decision.colorIdentity`.
 *
 * Three design constraints that MUST survive future edits:
 *
 * 1. SOURCE OF TRUTH. `bitDepth` / `dataFormat` / `trc` come from what the worker
 *    reports (`highDepth.sourceBitDepth` / `.format` / `.trc`, derived from the
 *    vips band format), NEVER from the IFD's `BitsPerSample`/`SampleFormat`. The
 *    IFD tag decides only ONE thing: whether to pay for the second vips read.
 *    `LibVipsHighDepth.format` is what the GPU upload derives `bytesPerRow` from
 *    — a guessed value mis-strides the whole image.
 *
 * 2. `dataFormat` AND `highDepthSource` ARE STRICTLY CO-PRESENT. This function
 *    builds pixels FIRST and mints the label AFTER, so "label claims rgba16float
 *    but `dec:` is missing" is structurally impossible here. That is STRONGER
 *    than the single-page path, where strategy mints the label first and the
 *    decoder produces pixels after, held consistent only by the Fail-Fast
 *    convention (a failing decoder must throw, `strategy.ts`). The causality is
 *    reversed here — there is no missing Fail-Fast branch to add.
 *
 * 3. `fallbackGamut` IS FOR THE GAMUT AXIS ONLY. `decision.colorIdentity`'s
 *    bitDepth/dataFormat/trc describe page 0 / the file, and mean nothing for
 *    page i, so they must never serve as a fallback. The parameter is typed as a
 *    bare `GamutId` precisely to make that misuse untypeable.
 *
 * CMYK pages stay on vips' built-in `colourspace('srgb')` (see the
 * `preserveColorSpace` comment below), NOT the single-page `vips-icc` channel's
 * precise Little-CMS conversion. This function fixes per-page LABELS and the
 * presence of RGB/grayscale high-depth pixels; CMYK conversion accuracy is a
 * separate, pre-existing gap.
 */
async function decodeAllPages(
  bytes: Uint8Array,
  pageCount: number,
  fallbackGamut: GamutId,
): Promise<DecodedPayload[]> {
  const pages: DecodedPayload[] = [];

  for (let i = 0; i < pageCount; i++) {
    const info = readTiffPageColorInfo(bytes, i);

    // ── 1. Per-page gamut: ICC outranks PhotometricInterpretation (same order
    //    as the file-level `extractTiffMetadata`). A page with no readable tag
    //    (malformed IFD, BigTIFF layout) falls back to the file-level gamut
    //    rather than guessing a value.
    const pageColorSpace = info.iccBytes
      ? inferColorSpaceFromIcc(parseIccProfileName(info.iccBytes) || '')
      : info.photometricInterpretation != null
        ? photometricToColorSpace(info.photometricInterpretation)
        : null;
    const gamut = pageColorSpace ? colorSpaceToGamut(pageColorSpace) : fallbackGamut;

    // ── 2. A CMYK page MUST stay colour-managed ──
    // Preserve mode skips the worker's `colourspace('srgb')`, and the worker's
    // RGBA completion is `if (!hasAlpha) bandjoin(255) else if (bands > 4)
    // extractBand(0,{n:4})`: CMYK is 4 bands and vips considers it alpha-less
    // (4 IS cmyk's expected band count), so it takes `bandjoin` → 5 bands, the
    // `else if` never runs → `.raw` emits 5 bytes/pixel and the main thread,
    // reading RGBA, shears the whole image. Single-page never exposes this: a
    // single-page CMYK TIFF goes down the `vips-icc` channel and never reads
    // CMYK in preserve mode. So CMYK pages keep colour management (identical to
    // the previous `tiffDecodePage` behaviour) while RGB / grayscale pages switch
    // to preserve mode to get source-encoded pixels.
    const isCmyk = pageColorSpace === 'cmyk';

    // ── 3. Per-page high-depth gate ──
    // This ONLY decides whether to pay for a second vips read on this page; the
    // real depth is whatever the worker reports (constraint 1 above). A missing
    // tag is treated as 8-bit (conservative — never pay the cost on a guess).
    //
    // CMYK pages are never gated in: the high-depth branch likewise does no
    // colourspace, so a 4-band CMYK ushort would hit `bandjoin(65535)` → 5 bands,
    // the same shear trap. (The single-page `vips-icc` branch's
    // `decode(bytes, { wantHighDepth: true })` does currently fall into that trap
    // for 16-bit CMYK — a pre-existing defect, out of scope here, but multi-page
    // will not add a second instance of it.)
    const wantHighDepth = !isCmyk && (info.bitsPerSample ?? 8) > 8;

    // ── 4. ONE pass → 8-bit + high-depth, same entry and same options as the
    //    single-page `vips` channel, aimed at page `i`.
    const { width, height, displayBlob: blob, highDepth } = await getLibVips().decode(bytes, {
      page: i,
      preserveColorSpace: !isCmyk,
      wantHighDepth,
      gamut,
    });

    // ── 5. Display blob + highDepthSource + the page's own colorIdentity ──
    const displayBlob = blob!;
    let highDepthSource: DecodedPayload['highDepthSource'];
    let colorIdentity: ColorIdentity;

    if (highDepth) {
      // >8-bit page OR 8-bit wide-gamut lifted page
      highDepthSource = { data: highDepth.data, width: highDepth.width, height: highDepth.height };
      colorIdentity = {
        gamut,
        trc: highDepth.trc,
        bitDepth: highDepth.sourceBitDepth as ColorIdentity['bitDepth'],
        dataFormat: highDepth.format,
      };
    } else {
      // Plain 8-bit page (including a malformed file whose IFD claims >8-bit but
      // which vips actually reads back as uchar).
      colorIdentity = { gamut, trc: 'srgb-trc', bitDepth: 8, dataFormat: undefined };
    }

    pages.push({ displayBlob, width, height, index: i, highDepthSource, colorIdentity });
  }

  return pages;
}
