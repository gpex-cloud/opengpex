/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * Unified Egest Decision — the export mirror of `resolveIngestDecision`.
 *
 * `resolveEgestDecision(request)` is the SINGLE authority that turns "user asked
 * for format F, gamut G, depth D" plus the DOCUMENT's own gamut into the complete
 * set of export instructions: which gamut the pixels must be encoded into, which
 * physical encode lane carries them, how to tag the canvas, whether to embed an
 * ICC profile, and whether the unedited-file pass-through is still colour-legal.
 *
 * ONE-WAY CONSTRAINT SOLVE (no more three-gate clamp)
 * ---------------------------------------------------
 * Adding the third lane `'raw-8'` (`RawPixelSource { data: Uint8Array, bitDepth: 8 }`
 * straight to vips) broke the old circular dependency between "which gamut" and
 * "which lane". The container's `supportedGamuts` is now the SOLE authority for
 * gamut convergence, because a container that can hold a gamut already implies the
 * system has a lane that can carry it. The derivation is therefore strictly
 * one-way and reads as two algebraic lines:
 *
 *   intent ──[container capability decides]──▶ targetGamut
 *   targetGamut + depth ──[one-way split]──▶ channel
 *
 * The former "wide gamut FORCES 16-bit" rule and the `clampGamut` lane gate are
 * both gone: an 8-bit wide-gamut export now flows to `'raw-8'` instead of being
 * forced up to `'raw-16'` (no file-size doubling) or clamped down to P3.
 *
 * COLOUR PROVENANCE — ONE SOURCE, SHARED WITH BAKE
 * -----------------------------------------------
 * `sourceGamut` is the gamut of the DOCUMENT ROOT ASSET (`assets.get(frame.assetId)
 * ?.gamut`), exactly the value `CompositeDispatcher` derives for the internal bake.
 * It is deliberately NOT `frame.metadata.colorSpace`: that field is a snapshot of
 * the originally-imported file header which never updates when the root asset is
 * replaced (bake / resample / branch-from-selection / RAW recover), so reading it
 * here would let export and bake disagree about the same document's gamut.
 *
 * BAKE IS NOT EGEST
 * ------------------------
 * This module is for EXPORT TO AN EXTERNAL FILE only. The internal composite
 * ("bake": merge / peel / branch / fragment / AI-bridge) has no format axis and no
 * user choice — its gamut is a deterministic lookup of the document's own gamut,
 * owned by `CompositeDispatcher`. Do not route bake through here.
 *
 * WHAT STAYS OUT
 * --------------
 * The WORKING gamut is NOT on this decision. It is the engine invariant
 * `core/engine/color/gamut.ts::WORKING_GAMUT` ('display-p3'), and the only consumer that
 * needs it (`ExportDispatcher`, feeding `unpremultiplyEncodeGamut`'s `sourceGamut`)
 * imports the constant directly.
 *
 * @module core/files/strategy/egest
 */

import type { GamutId } from '@opengpex/editor/core/types';
import { WORKING_GAMUT, toCanvasColorSpace } from '@opengpex/editor/core/engine/color';
import type { SourceFormat } from '../types';
import {
  FORMAT_EGEST_CAPABILITIES,
  type EgestChannel,
  type FormatEgestCapability,
} from './engine/egest/capabilities';

// The capability map + its types now live in the Egest constraint-solver engine
// (`engine/egest/capabilities.ts`). Re-export them here so existing consumers
// (`core/files/index.ts` barrel, `ImageInfoDrawer/hooks.ts`, the oracle test)
// keep resolving them from `strategy/egest` unchanged.
export { FORMAT_EGEST_CAPABILITIES };
export type { EgestChannel, FormatEgestCapability };

/** Everything the export command knows before it touches the GPU. */
export interface EgestRequest {
  /** Normalized output container (`mimeToFormat[config.format]`). */
  readonly format: SourceFormat;
  /**
   * The DOCUMENT's own gamut = `assets.get(frame.assetId)?.gamut`, the same value
   * `CompositeDispatcher` derives for the internal bake ("bit depth and gamut sharing the same source").
   *
   * `[!IMPORTANT]` NOT `frame.metadata.colorSpace`. That is a frozen snapshot of the
   * originally-imported file header; it does not follow the root asset when the
   * document is baked / resampled / branched, so using it here would let export and
   * bake disagree about the same document. Omitted ⇒ `'srgb'`.
   */
  readonly sourceGamut?: GamutId;
  /** Explicit user/agent gamut request. Omitted ⇒ round-trip the source gamut. */
  readonly requestedGamut?: GamutId;
  /** Explicit user depth request (`config.exportBitDepth`). Omitted ⇒ 8. */
  readonly requestedBitDepth?: 8 | 16;
  /** ICC embed toggle. Omitted ⇒ the format's default (embed when supported). */
  readonly embedIccOverride?: boolean;
}

/** Unified egest decision output. */
export interface EgestDecision {
  /** 1. The document's own gamut, for the pass-through comparison below. */
  readonly sourceGamut: GamutId;
  /**
   * 2. The user's gamut INTENT, before any container clamp. This — not `targetGamut`
   *    — is the axis the pass-through gate compares, so an
   *    "Adobe RGB → sRGB" request cannot ship the original Adobe RGB bytes just
   *    because the clamp happened to land back on P3.
   */
  readonly requestedGamut: GamutId;
  /**
   * 3. The gamut the pixels are ACTUALLY encoded into = intent clamped to what the
   *    chosen container can carry. Drives the terminal encode matrix, the canvas
   *    tag AND the embedded stock profile, so those three cannot disagree. This is
   *    the value that travels on as `ExportRequest.targetGamut` and
   *    `ExportMetadataConfig.targetGamut` — same name, same meaning, all the way
   *    down to the handlers.
   */
  readonly targetGamut: GamutId;
  /** 4. Terminal encode quantization (8 → `Uint8*Array`, 16 → `Uint16Array`). */
  readonly bitDepth: 8 | 16;
  /** 5. Physical encode lane (see {@link EgestChannel}). */
  readonly channel: EgestChannel;
  /**
   * 6. Canvas `colorSpace` tag for the `'canvas-8'` lane. Meaningless on the raw
   *    lanes (no canvas exists there) — reported anyway so the field is never
   *    conditionally absent, but only the `'canvas-8'` lane may read it.
   *
   *    It exists so the EGEST mapping (`toCanvasColorSpace`: only an exact
   *    `display-p3` target tags `'display-p3'`) is chosen once, here, and cannot be
   *    confused at a call site with the DISPLAY-track mapping.
   */
  readonly canvasColorSpace: PredefinedColorSpace;
  /** 7. Whether an ICC profile is written (format capability ∧ user toggle). */
  readonly embedIcc: boolean;
  /**
   * 8. The COLOUR half of the pass-through gate: true when the requested output
   * gamut equals the document's gamut, so shipping the original bytes cannot
   * silently change the colour. The caller ANDs this with its own non-colour
   * conditions (unedited history, no clip, no resize, format match, a retained
   * source blob) — those are not colour decisions and stay out of this module.
   *
   * `[!IMPORTANT]` Compares `requestedGamut` (the INTENT), never the clamped
   * `targetGamut` — an "Adobe RGB → sRGB" request cannot ship the original Adobe RGB
   * bytes just because the container clamp happened to land back on the working gamut.
   */
  readonly gamutPassThroughEligible: boolean;
}

function lookupCapability(format: SourceFormat): FormatEgestCapability {
  return FORMAT_EGEST_CAPABILITIES[format] ?? FORMAT_EGEST_CAPABILITIES.unknown;
}

/**
 * Whether an ICC profile is written into the exported file.
 *
 * Purely `(format, userToggle)`: the format capability is a hard gate (a BMP has
 * nowhere to put a profile, so `true` cannot override it) and within a capable
 * format the industry default is to embed. The pixels' gamut is NOT an input —
 * every gamut this pipeline can emit has a stock profile, and the encoder picks
 * between that and the source's verbatim profile itself.
 */
export function resolveEmbedIcc(format: SourceFormat, userOverride?: boolean): boolean {
  return lookupCapability(format).supportsIccEmbed ? (userOverride ?? true) : false;
}

/**
 * Resolve the complete egest decision for one export request — a strictly
 * one-way constraint solve:
 *
 *   1. Pre-process: validate the format has an encode lane; normalize intent
 *      (`rec2020` has no matrix/stock ICC → safely downgrades to `WORKING_GAMUT`).
 *   2. Gamut convergence: the container's `supportedGamuts` is the SOLE
 *      judge. Intent that the container can hold survives; otherwise fall back to
 *      `WORKING_GAMUT`, else `'srgb'`. (No lane gate — the three-gate clamp is gone.)
 *   3. Depth & channel split (one-way):
 *      - 16-bit requested AND container has `'raw-16'` → 16-bit `'raw-16'`.
 *      - else 8-bit; a canvas-safe target (srgb / display-p3) → `'canvas-8'`,
 *        a wide-gamut target (adobe-rgb / prophoto-rgb) → `'raw-8'`.
 *   4. Post-process: assemble the output contract.
 *
 * Pure and dependency-light (one capability table, no I/O), so it runs identically
 * in the browser and under vitest.
 *
 * @throws if the format has no encode channel at all (`heic`/`raw`) — a caller bug
 * (attempting to export a decode-only format), not a degrade-able edge case.
 */
export function resolveEgestDecision(request: EgestRequest): EgestDecision {
  const {
    format,
    sourceGamut: requestSourceGamut,
    requestedGamut: explicitGamut,
    requestedBitDepth,
    embedIccOverride,
  } = request;

  // 1. Pre-process: capability lookup + intent normalization.
  const cap = lookupCapability(format);
  if (cap.supportedChannels.length === 0) {
    throw new Error(`[egest] format "${format}" has no encode channel — cannot export`);
  }

  const sourceGamut: GamutId = requestSourceGamut ?? 'srgb';
  const requestedGamut: GamutId = explicitGamut ?? sourceGamut;
  // rec2020 has no conversion matrix and no stock ICC — painless downgrade to WORKING.
  const emittableIntent: GamutId = requestedGamut === 'rec2020' ? WORKING_GAMUT : requestedGamut;

  // 2. Gamut convergence. Container capability is the only judge.
  const targetGamut: GamutId = cap.supportedGamuts.includes(emittableIntent)
    ? emittableIntent
    : cap.supportedGamuts.includes(WORKING_GAMUT)
      ? WORKING_GAMUT
      : 'srgb';

  // 3. Depth & channel split (one-way direct match).
  let bitDepth: 8 | 16;
  let channel: EgestChannel;
  if (requestedBitDepth === 16 && cap.supportedChannels.includes('raw-16')) {
    bitDepth = 16;
    channel = 'raw-16';
  } else {
    bitDepth = 8;
    // A wide-gamut target (adobe-rgb / prophoto-rgb) has no browser canvas form —
    // route it to the raw-8 lane; canvas-safe targets take the fast canvas lane.
    const isCanvasSafe = targetGamut === 'srgb' || targetGamut === 'display-p3';
    channel = isCanvasSafe ? 'canvas-8' : 'raw-8';
  }

  // 4. Post-process: assemble output contract.
  return {
    sourceGamut,
    requestedGamut,
    targetGamut,
    bitDepth,
    channel,
    canvasColorSpace: toCanvasColorSpace(targetGamut),
    embedIcc: resolveEmbedIcc(format, embedIccOverride),
    gamutPassThroughEligible: requestedGamut === sourceGamut,
  };
}
