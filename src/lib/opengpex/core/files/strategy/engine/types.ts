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
 * Declarative ingest decision engine — condition & action type stubs.
 *
 * A lightweight, dependency-free, strongly-typed rule model that maps the
 * ingest decision matrix onto a declarative rule table. See `./rules.ts` for the table and `./matcher.ts` for
 * the first-match-wins evaluator.
 *
 * @module core/files/strategy/engine/types
 */

import type { TRC, GamutId } from '@opengpex/editor/core/types';
import type { ColorIdentity } from '@opengpex/editor/core/storage/asset/AssetStore';
import type { SourceFormat, ColorSpaceId } from '../../types';

/**
 * Decode channel / primary asset producer.
 * - 'image-bitmap': browser-native createImageBitmap (zero-copy / low overhead).
 *   POSITIVELY GATED (no longer the catch-all): admitted only for 8-bit,
 *   single-frame, whitelisted containers (jpeg/png/webp/bmp/gif/avif) whose
 *   gamut is canvas-native srgb/display-p3. Anything else falls to 'unsupported'.
 * - 'wide-gamut-8': 8-bit wide-gamut readback + matrix fold (f16 raw lift + P3 proxy)
 * - 'vips': LibVips native decode (single pass → 8-bit proxy + f16 naked pixels)
 * - 'vips-icc': LibVips ICC colour-conversion engine (CMYK only; unrecognized
 *   custom profiles / BT.2020 that resolve to 'unknown' route to 'unsupported')
 * - 'libraw': LibRaw native camera-raw decode
 * - 'libheif-proxy': HEIC proxy decode via the files-layer heic-worker
 *   (libheif wasm → RGBA-8 → iCCP-tagged PNG proxy). Serves HEIC rules 19b/19c/19e
 *   (10/12-bit sources, environments without HEVC hardware decode) — and, during
 *   the phase-1 bridge, 19a as well.
 * - 'webcodecs-heic': HEVC hardware decode via WebCodecs (HEIC rule 19a).
 *   Declared now, wired in the WebCodecs stage — no rule routes to it yet.
 * - 'gifuct': gifuct-js per-frame RGBA animation parse
 * - 'vector': vector parser's internal 1:1 rasterization
 * - 'unsupported': CATCH-ALL TERMINUS. No specific supported spec matched (e.g.
 *   sub-8-bit PNG 1/2/4-bit, animated WebP/AVIF, an unmappable 'unknown' colour
 *   tag, HEIC HDR transfer functions (rule 19d), not-yet-adapted formats). The
 *   decision reports this faithfully; the execution layer throws a "not yet
 *   supported" error rather than force-decoding (Fail-Fast). Supporting a spec
 *   later means promoting it to a concrete rule in the decision table.
 *
 * Foundational vocabulary of the decision engine: the `DecisionAction` route
 * a rule binds. `ingest.ts` composes it into the public `IngestDecision` and
 * re-exports this type, so the outward contract is unchanged.
 */
export type DecodeChannel =
  | 'image-bitmap'
  | 'wide-gamut-8'
  | 'vips'
  | 'vips-icc'
  | 'libraw'
  | 'libheif-proxy'
  | 'webcodecs-heic'
  | 'avif-proxy'
  | 'gifuct'
  | 'vector'
  | 'unsupported';

/**
 * EXIF orientation responsibility.
 * - 'auto': the underlying/browser pipeline already uprights (JPEG / LibRaw / HEIC)
 * - 'explicit': the underlying decode does NOT rotate (PNG eXIf, TIFF / LibVips
 *   naked pixels) — the pipeline must run applyExifOrientation itself
 * - 'none': no EXIF concept (BMP / GIF / vector)
 */
export type OrientationResponsibility = 'auto' | 'explicit' | 'none';

/** Matching pattern for decision input conditions */
export type MatchPattern<T> = T | readonly T[] | ((val: T) => boolean) | '*';

/** Normalized matching input context */
export interface NormalizedMatchContext {
  readonly format: SourceFormat;
  readonly bitDepth: number;
  readonly colorSpace: ColorSpaceId;
  readonly isMultiFrame: boolean;
  /**
   * Environment capability: whether the runtime can hardware-
   * decode THIS file's HEVC profile (probe entry picked by hvcC profile_idc).
   * Injected by the decode entry (`FileService.decode` awaits the one-shot
   * HEVC capability probe (`handlers/heic/capability.ts`)); plain decision calls default to `false`, which
   * is the declarative-safe route (19e proxy downgrade, never a hard-decode
   * guess). Defaults follow the principle that capability is an environment
   * property, not a file property.
   */
  readonly hevcHardDecode: boolean;
  /** Source transfer characteristic (`metadata.raw.transfer`), for the HDR rows. */
  readonly transfer: 'pq' | 'hlg' | 'sdr' | undefined;
  /**
   * Gain-map carrier flag (`metadata.raw.hasGainmap` — an Apple `hdrgainmap`
   * auxiliary image is present in the container). Admits the 19-gm rebuild
   * rows ahead of the plain HEIC rows: a carrier's master must be the linear
   * f16 SDR base so the view-pass gain application has a precision-ready line
   * to sample. Files without the flag default to `false` and never match
   * those rows.
   */
  readonly hasGainmap: boolean;
}

/** Match condition stub for a single rule */
export interface DecisionCondition {
  readonly format: MatchPattern<SourceFormat>;
  readonly bitDepth: MatchPattern<number>;
  readonly colorSpace: MatchPattern<ColorSpaceId>;
  readonly isMultiFrame?: MatchPattern<boolean>; // Defaults to '*'
  readonly hevcHardDecode?: MatchPattern<boolean>; // Defaults to '*'
  /**
   * Source transfer characteristic (`metadata.raw.transfer`, the HDR seam):
   * `'pq' | 'hlg'` admit the HDR ingest rows; `'sdr' | undefined` matches the
   * SDR rows. Absent pattern = '*'.
   */
  readonly transfer?: MatchPattern<'pq' | 'hlg' | 'sdr' | undefined>;
  /**
   * Gain-map carrier flag (`metadata.raw.hasGainmap`): `true` admits the
   * 19-gm rows (linear f16 SDR-base master). Absent pattern = '*'.
   */
  readonly hasGainmap?: MatchPattern<boolean>;
}

/** Decision action stub for a single rule */
export interface DecisionAction {
  /** Designated physical execution lane */
  readonly decodeChannel: DecodeChannel;
  /** Color transfer curve (defaults to 'srgb-trc') */
  readonly trc?: TRC;
  /** GPU storage container format (defaults to undefined, i.e. standard 8-bit) */
  readonly dataFormat?: ColorIdentity['dataFormat'];
  /**
   * HDR rows only: overrides the post-process `colorSpaceToGamut` mapping for
   * sources whose primaries live outside the SDR `ColorSpaceId` vocabulary
   * (BT.2020 → 'rec2020'; gap #8). Deliberate, documented exception — the row
   * is where the container's true primaries are known.
   */
  readonly gamutOverride?: GamutId;
  /** EXIF orientation responsibility */
  readonly applyOrientation: OrientationResponsibility;
  /** Rule note / description (e.g. "#1 JPEG 8-bit standard") */
  readonly description: string;
}

/** Complete decision rule declaration */
export interface DecisionRule {
  /**
   * Rule ID — the numeric matrix rows (1 ~ 26) or the spec-table labels of the
   * HEIC family ('19a' ~ '19e').
   */
  readonly id: number | string;
  readonly condition: DecisionCondition;
  readonly action: DecisionAction;
}
