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
 * Unified Ingest Decision.
 *
 * `resolveIngestDecision(metadata)` is the SINGLE authority that turns one
 * decoded file's objective `ImageMetadata` into the complete set of ingest
 * instructions the pipeline needs — the authoritative `colorIdentity` to
 * persist, source-blob retention, the content-bounds fast-skip, the decode
 * channel, and EXIF orientation responsibility — in ONE call, with a shape that
 * is directly consumable (no field translation downstream). The display-proxy
 * need is DERIVED from `decodeChannel` (image-bitmap ⟺ verbatim passthrough),
 * not carried as a separate field.
 *
 * Relationship to `color.ts` (which is KEPT — this module does NOT delete it):
 *   - OWNS every ingest-time judgement. `isWideGamut` (the shared wide-gamut
 *     predicate) and `shouldRetainSourceBlob` (with its own format→policy
 *     classification) both live HERE — `ingest.ts` no longer imports anything
 *     from `color.ts`. `colorSpace` is taken straight from `metadata.colorSpace`
 *     (each handler's `extractMetadata` already normalizes it).
 *   - SUPERSEDES the `getImportStrategy` / `IMPORT_PIPELINE` ingest table:
 *     `colorConversion` here adds the `bitDepth` axis (high-depth wide-gamut
 *     stays GPU-'none'; only 8-bit wide-gamut folds via CPU-'matrix'), which
 *     the flat `ColorSpaceId`-keyed table cannot express. Those ingest symbols
 *     are retired once every decoder consumes this module. The egest mirror
 *     lives in `./egest.ts::resolveEgestDecision`; `color.ts` keeps only the
 *     `FORMAT_COLOR_STRATEGY` capability table both sides read, plus the one
 *     source-ICC-dependent `resolveExportPixelConversion` question.
 *
 * The working/compositing gamut is an ENGINE constant ('display-p3', future
 * 'prophoto-rgb') — never derived from the image. The engine dictates the
 * working space; the image never does.
 *
 * @module core/files/strategy/ingest
 */

import type { GamutId } from '@opengpex/editor/core/types';
import type { ColorIdentity } from '@opengpex/editor/core/storage/asset/AssetStore';
import type { ColorSpaceId, ImageMetadata } from '../types';
import type { DecodeChannel, OrientationResponsibility, NormalizedMatchContext } from './engine/types';
import { matchRule } from './engine/matcher';
import { INGEST_DECISION_RULES } from './engine/rules';

// `DecodeChannel` / `OrientationResponsibility` are the decision engine's
// foundational vocabulary (defined in `./engine/types`, consumed by every rule
// `DecisionAction`). They are re-exported here so this module's public contract
// — and every downstream `IngestDecision` consumer — is unchanged, while the
// dependency flows one way: ingest → engine (never engine → ingest).
export type { DecodeChannel, OrientationResponsibility } from './engine/types';

/**
 * ColorSpaceId → GamutId, the ONLY mapping point.
 *
 * No `default` branch: when `ColorSpaceId` gains a member, this `switch` fails
 * to compile instead of silently returning a wrong gamut — the guarantee that
 * an inline `cs as GamutId` assertion could never give (the two are distinct
 * semantic axes, not a subset relation).
 *
 * `rec2020` is intentionally absent: it is not a `ColorSpaceId` member yet
 * (TRC ambiguity SDR/PQ/HLG). When it is added, this switch will force
 * the branch to be written rather than let it slip through.
 *
 * `cmyk`/`grayscale`/`unknown` are not gamuts. `cmyk` folds to 8-bit sRGB on
 * the vips-icc path; `unknown` routes to 'unsupported' (its identity is still
 * computed here but not consumed); `grayscale` takes the default path. All
 * three converge to 'srgb', and this function is the single place that lands.
 */
export function colorSpaceToGamut(cs: ColorSpaceId): GamutId {
  switch (cs) {
    case 'srgb':
    case 'cmyk':
    case 'grayscale':
    case 'unknown':
      return 'srgb';
    case 'display-p3':
      return 'display-p3';
    case 'adobe-rgb':
      return 'adobe-rgb';
    case 'prophoto-rgb':
      return 'prophoto-rgb';
  }
}

/**
 * Unified ingest decision output.
 *
 * `colorIdentity` IS the on-disk `AssetStore.ts::ColorIdentity` shape, so a
 * consumer can spread `...colorIdentity` straight into `AssetInputOptions`.
 *
 * ⚠️ The working/compositing colour space is NOT part of this decision — it is
 * an engine environment invariant (a fixed Display-P3 rgba16float linear-light
 * space today), never image-derived.
 */
export interface IngestDecision {
  /** 1. Authoritative colour identity — reflects the source's true physical properties. */
  readonly colorIdentity: ColorIdentity;
  /** 2. Pass-through source-file retention policy. */
  readonly retainSourceBlob: boolean;
  /** 3. Import-time acceleration signal (only formats known alpha-free may skip). */
  readonly skipContentBoundsScan: boolean;
  /**
   * 4. Assigned decode channel (single physical execution route).
   * `'unsupported'` = the catch-all was hit; the execution layer throws.
   *
   * The display-proxy need is DERIVED from this field, not stored separately:
   * `decodeChannel === 'image-bitmap'` ⟺ verbatim passthrough (the original file
   * bytes ARE the displayBlob); every other supported channel transcodes a
   * full-resolution 1:1 proxy, whose container is likewise derived from the
   * channel (`heic-to` → JPEG q0.95, every other → PNG).
   */
  readonly decodeChannel: DecodeChannel;
  /** 5. EXIF orientation responsibility (keeps displayBlob and dec: pixels co-oriented). */
  readonly applyOrientation: OrientationResponsibility;
}

/**
 * Shared wide-gamut predicate — the two "wider than P3" gamuts whose 8-bit
 * sources take the matrix fold (`gamut ∈ {adobe-rgb, prophoto-rgb}` ⇒
 * `decodeChannel: 'wide-gamut-8'` below) and whose high-depth sources are
 * delinearized on the naked f16 line (⇒ `trc: 'linear'`).
 *
 * `rec2020` is deliberately excluded: it travels the `vips-icc` / `unsupported`
 * path and carries a TRC ambiguity (SDR/PQ/HLG), so it is a separate gap
 * (matrix #8), NOT covered here.
 *
 * Owned by this module (moved out of `color.ts`): it is an ingest-decision
 * judgement, reused by the f16 delinearizers in `core/engine/color/wideGamutF16.ts`
 * (`wideGamut8ToF16` / `wideGamut16ToF16`).
 */
export function isWideGamut(cs: ColorSpaceId): cs is 'adobe-rgb' | 'prophoto-rgb' {
  return cs === 'adobe-rgb' || cs === 'prophoto-rgb';
}

/**
 * Determine whether to retain sourceBlob for pass-through lossless export
 * recovery — a module-local ingest-decision helper.
 *
 * Retention reduces to a ONE-LINE inference on the decode channel:
 *
 *     retainSourceBlob ⟺ decodeChannel !== 'image-bitmap'
 *
 * `image-bitmap`'s contract IS verbatim passthrough — the original file bytes
 * ARE the displayBlob (`png/decode.ts` `let displayBlob: Blob = file`) — which
 * is precisely the sufficient-and-necessary condition for "no separate raw copy
 * is needed": storing `raw:` there would be a byte-for-byte copy of the light
 * record's own blob, zero information gain, IDB/key count doubled. Every OTHER
 * channel transcodes a lossy/derived proxy, so the source file is the only
 * faithful original and must be kept for revert / lossless re-export.
 *
 * Why this supersedes the former three-tier `switch (format)`: that classifier
 * took `(format, bitDepth, colorSpace)` — WITHOUT the channel — so `unsupported`
 * (whose input carries no fixed format) got four different answers for the same
 * physical route. The channel is the axis that actually decides; keying off it
 * makes the four `unsupported` cells uniform (`true`; harmless — `unsupported`
 * never reaches `storeBundle`, its handler throws in the decode stage).
 *
 * The drift guard is NOT this function's `switch` (it had one, but the real
 * guard is stronger): the oracle test `ingestDecision.oracle.test.ts` pins the
 * full `IngestDecision` per case, catching any answer change. A new
 * `DecodeChannel` member defaults to `true` here (conservative: over-retain
 * wastes space, never drops data); a new format wanting verbatim MUST add
 * itself to the `image-bitmap` positive gate above, which trips the oracle.
 */
export function shouldRetainSourceBlob(channel: DecodeChannel): boolean {
  return channel !== 'image-bitmap';
}

/**
 * Resolve the complete ingest decision for one decoded file's metadata.
 *
 * This is the single call point, implemented as a declarative three-stage
 * pipeline:
 *   1. Pre-process — physical clamping (AVIF >8-bit degrades to 8-bit).
 *   2. Rule match — first-match-wins over `INGEST_DECISION_RULES`
 *      (`engine/rules.ts`).
 *   3. Post-process — assemble the authoritative `IngestDecision` (apply
 *      `colorSpaceToGamut`, derive `retainSourceBlob` / `skipContentBoundsScan`).
 *
 * The working gamut is a fixed engine invariant, not an input — the image never
 * dictates it.
 *
 * Fail-Fast: the matrix is normative, not tolerant. Where a decision requires
 * `dataFormat: 'rgba16float'` (high depth) but the decoder then fails, the
 * decoder MUST throw rather than silently degrade to 8-bit — otherwise metadata
 * would claim 16-bit while the `dec:` asset is missing. The `'unsupported'`
 * terminus (matrix row 26) carries no `dataFormat`: it produces no pixels, so
 * the execution layer throws rather than fabricating a phantom high-depth buffer.
 */
export function resolveIngestDecision(metadata: ImageMetadata): IngestDecision {
  const {
    sourceFormat: format,
    bitDepth: rawBitDepth,
    colorSpace: detectedColorSpace,
    hasAlpha,
    isMultiFrame = false,
  } = metadata;

  // 1. Pre-process: physical constraints and clamping.
  //    AVIF lacks a stable >8-bit decoder (browser passes 8-bit directly; vips-heif
  //    high-depth path is disabled due to shared singleton OOM hazards), clamped to 8-bit uniformly.
  const bitDepth = format === 'avif' ? Math.min(rawBitDepth, 8) : rawBitDepth;

  // 2. Rule Match: first-match-wins over the decision table.
  const ctx: NormalizedMatchContext = {
    format,
    bitDepth,
    colorSpace: detectedColorSpace,
    isMultiFrame,
  };
  const matched = matchRule(INGEST_DECISION_RULES, ctx);
  const { action } = matched;

  // 3. Post-process: assemble output contract.
  //    Gamut is determined by the input colorSpace via colorSpaceToGamut, not by rule actions.
  const gamut: GamutId = colorSpaceToGamut(detectedColorSpace);

  const colorIdentity: ColorIdentity = {
    gamut,
    trc: action.trc ?? 'srgb-trc',
    bitDepth: bitDepth as ColorIdentity['bitDepth'],
    dataFormat: action.dataFormat,
    // Explicit intent axis: fixed here and propagated forward, never re-sniffed during rendering.
    // Only RAW specifies 'filmic'; other actions default to undefined (treated as 'sdr' by consumers).
    renderIntent: action.renderIntent,
  };

  return {
    colorIdentity,
    // Principle: only image-bitmap passes through without proxy; others must retain sourceBlob.
    retainSourceBlob: action.decodeChannel !== 'image-bitmap',
    // Skip content bounds scan only when the image is strictly known to have no alpha.
    skipContentBoundsScan: hasAlpha === false,
    decodeChannel: action.decodeChannel,
    applyOrientation: action.applyOrientation,
  };
}
