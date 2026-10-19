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
 * The working/compositing gamut is an ENGINE constant ('prophoto-rgb') — never
 * derived from the image. The engine dictates the working space; the image never
 * does.
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
 * `rec2020` maps to itself (D4, gap #8 closure): the primaries were already a
 * `GamutId` the render graph has a matrix for (shader `case 4u`); the SDR
 * transfer travels on `IngestDecision.transfer` ('bt709' for SDR BT.2020
 * containers), so the two axes stay orthogonal here.
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
    case 'rec2020':
      return 'rec2020';
  }
}

/**
 * Unified ingest decision output.
 *
 * `colorIdentity` IS the on-disk `AssetStore.ts::ColorIdentity` shape, so a
 * consumer can spread `...colorIdentity` straight into `AssetInputOptions`.
 *
 * ⚠️ The working/compositing colour space is NOT part of this decision — it is
 * an engine environment invariant (a fixed ProPhoto RGB rgba16float linear-light
 * space), never image-derived.
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
   * channel (`libheif-proxy` → iCCP-tagged PNG, every other → PNG).
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
 * Environment inputs for {@link resolveIngestDecision} — runtime capabilities
 * probed OUTSIDE this function (the decision stays a synchronous pure function
 * of `{metadata, env}`).
 */
export interface IngestEnvironment {
  /**
   * HEVC hardware-decode capability for THIS file's profile —
   * probe entry picked by hvcC profile_idc, injected by `FileService.decode`
   * after awaiting the one-shot HEVC capability probe (`handlers/heic/capability.ts`)).
   * The context never carries `false`: omitted = no hard decode (probe
   * negative or not probed — the same decision state, the declarative proxy
   * downgrade); `true` admits the `webcodecs-heic` route (rules 81/83).
   */
  readonly hevcHardDecode?: true;
}

/**
 * Resolve the complete ingest decision for one decoded file's metadata.
 *
 * This is the single call point, implemented as a declarative three-stage
 * pipeline:
 *   1. Pre-process — physical clamping (AVIF >8-bit degrades to 8-bit) and the
 *      capability context assembly (HEIC `hevcHardDecode`).
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
export function resolveIngestDecision(metadata: ImageMetadata, env?: IngestEnvironment): IngestDecision {
  const {
    sourceFormat: format,
    bitDepth: rawBitDepth,
    colorSpace: detectedColorSpace,
    hasAlpha,
    isMultiFrame: rawIsMultiFrame,
  } = metadata;
  // HDR seam: the container's transfer characteristic (PQ/HLG) routes the HDR
  // decision rows; 'sdr'/undefined is the SDR vocabulary.
  const transfer = metadata.raw?.transfer;
  // Gain-map carrier flag: admits the carrier rows 31 / 81 / 82 / 85 (linear
  // f16 SDR-base master).
  const hasGainmap = metadata.raw?.hasGainmap === true ? true : undefined;

  // 1. Pre-process: physical constraints. The old AVIF >8→8-bit clamp is gone
  //    (2026-10-13): the isolated jsquash/libavif wasm decoder is bit-exact at
  //    native depth (gpex-cloud/probes/avif), so high depth routes to the
  //    avif-proxy channel with the true depth declared — no clamping anywhere.
  const bitDepth = rawBitDepth;

  // 2. Rule Match: first-match-wins over the decision table.
  const ctx: NormalizedMatchContext = {
    format,
    bitDepth,
    colorSpace: detectedColorSpace,
    isMultiFrame: rawIsMultiFrame === true ? true : undefined,
    // undefined-preserving: the capability probe is a HEIC-only runtime concern;
    // other formats never inject it, so undeclared hevcHardDecode conditions
    // (value equality) match them naturally.
    hevcHardDecode: env?.hevcHardDecode,
    transfer,
    hasGainmap: hasGainmap === true ? true : undefined,
  };
  const matched = matchRule(INGEST_DECISION_RULES, ctx);
  const { action } = matched;

  // 3. Post-process: assemble output contract.
  //    Gamut is determined by the input colorSpace via colorSpaceToGamut, never
  //    by rule actions — no exceptions. (The former `gamutOverride` hatch lived
  //    here for BT.2020 HDR while gap #8 was open; D4 closed the vocabulary gap,
  //    so metadata reports 'rec2020' directly and the hatch is gone. An
  //    unnameable gamut now routes to 'unsupported' upstream instead.)
  const gamut: GamutId = colorSpaceToGamut(detectedColorSpace);

  const colorIdentity: ColorIdentity = {
    gamut,
    trc: action.trc ?? 'srgb-trc',
    bitDepth: bitDepth as ColorIdentity['bitDepth'],
    dataFormat: action.dataFormat,
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
