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

import type { TRC } from '@opengpex/editor/core/types';
import type { ColorIdentity } from '@opengpex/editor/core/storage/asset/AssetStore';
import type { SourceFormat, ColorSpaceId } from '../../types';

/**
 * Decode channel / primary asset producer.
 * - 'image-bitmap': browser-native createImageBitmap (zero-copy / low overhead).
 *   POSITIVELY GATED (no longer the catch-all): admitted only for 8-bit,
 *   single-frame, whitelisted containers (jpeg/png/webp/bmp/gif/avif) whose
 *   gamut is canvas-native srgb/display-p3. Anything else falls to 'unsupported'.
 * - 'jpeg-hdr': gain-map JPEG (UltraHDR) base-rendition decode — browser
 *   primary decode with the ORIGINAL bytes kept as the display proxy, the SDR
 *   base lifted to the linear f16 master, and the source file retained so the
 *   presentation-time gain decode (`FileService.decodeGainMap`) can re-parse
 *   the multi-picture container. Serves ingest row 31.
 * - 'wide-gamut-8': 8-bit wide-gamut readback + matrix fold (f16 raw lift + P3 proxy)
 * - 'vips': LibVips native decode (single pass → 8-bit proxy + f16 naked pixels)
 * - 'vips-icc': LibVips ICC colour-conversion engine (CMYK only; unrecognized
 *   custom profiles / BT.2020 that resolve to 'unknown' route to 'unsupported')
 * - 'libraw': LibRaw native camera-raw decode
 * - 'libheif-proxy': HEIC proxy decode via the files-layer heic-worker
 *   (libheif wasm → RGBA-8 → iCCP-tagged PNG proxy). Serves HEIC rules 82/84/85/86
 *   (gain-map carriers, 10/12-bit sources, environments without HEVC hardware
 *   decode).
 * - 'webcodecs-heic': HEVC hardware decode via WebCodecs (HEIC rules 81/83).
 * - 'gifuct': gifuct-js per-frame RGBA animation parse
 * - 'vector': vector parser's internal 1:1 rasterization
 * - 'unsupported': CATCH-ALL TERMINUS. No specific supported spec matched (e.g.
 *   sub-8-bit PNG 1/2/4-bit, animated WebP/AVIF, an unmappable 'unknown' colour
 *   tag, HEIC HDR transfer functions (rule 87), not-yet-adapted formats). The
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
  | 'jpeg-hdr'
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
  /** `true` only for multi-frame carriers; ABSENT (undefined) = single-frame. */
  readonly isMultiFrame: boolean | undefined;
  /**
   * Environment capability: whether the runtime can hardware-
   * decode THIS file's HEVC profile (probe entry picked by hvcC profile_idc).
   * Injected by the decode entry (`FileService.decode` awaits the one-shot
   * HEVC capability probe (`handlers/heic/capability.ts`)) as `true` ONLY on
   * admission — the context never carries `false`, so "probe negative" and
   * "not probed" are one state spelled by omission (the declarative-safe
   * proxy downgrade, never a hard-decode guess). Capability is an
   * environment property, not a file property.
   */
  /** `true` = probe admitted; ABSENT = capability-less or non-HEIC. */
  readonly hevcHardDecode: true | undefined;
  /** Source transfer characteristic (`metadata.raw.transfer`), for the HDR rows. */
  readonly transfer: 'pq' | 'hlg' | 'sdr' | undefined;
  /**
   * Gain-map carrier flag (`metadata.raw.hasGainmap` — an Apple `hdrgainmap`
   * auxiliary image is present in the container). Admits the carrier rows
   * (31 / 81 / 82 / 83) ahead of the plain rows: a carrier's master must be
   * the linear f16 SDR base so the view-pass gain application has a
   * precision-ready line
   * to sample. Files without the flag default to `false` and never match
   * those rows.
   */
  /** true only for gain-map carriers; ABSENT (undefined) = non-carrier. */
  readonly hasGainmap: boolean | undefined;
}

/** Match condition stub for a single rule */
export interface DecisionCondition {
  readonly format: MatchPattern<SourceFormat>;
  readonly bitDepth: MatchPattern<number>;
  readonly colorSpace: MatchPattern<ColorSpaceId>;
  readonly isMultiFrame?: MatchPattern<boolean | undefined>; // undeclared = single-frame (value equality)
  readonly hevcHardDecode?: MatchPattern<boolean | undefined>; // Defaults to '*'
  /**
   * Source transfer characteristic (`metadata.raw.transfer`, the HDR seam):
   * `'pq' | 'hlg'` admit the HDR rows; real SDR files leave the field UNSET
   * (nothing assigns 'sdr' — dead vocabulary). 2026-10-19 semantics: an
   * UNDECLARED transfer condition matches only the undefined context
   * (SDR-only, by value equality); '*' is the transfer-agnostic wildcard
   * (terminus rows 76/00 and seam-free formats).
   */
  readonly transfer?: MatchPattern<'pq' | 'hlg' | 'sdr' | undefined>;
  /**
   * Gain-map carrier flag (`metadata.raw.hasGainmap`): `true` admits the
   * 19-gm rows (linear f16 SDR-base master). Absent pattern = '*'.
   */
  readonly hasGainmap?: MatchPattern<boolean | undefined>;
}

/** Decision action stub for a single rule */
export interface DecisionAction {
  /** Designated physical execution lane */
  readonly decodeChannel: DecodeChannel;
  /** Color transfer curve (defaults to 'srgb-trc') */
  readonly trc?: TRC;
  /** GPU storage container format (defaults to undefined, i.e. standard 8-bit) */
  readonly dataFormat?: ColorIdentity['dataFormat'];
  /** EXIF orientation responsibility */
  readonly applyOrientation: OrientationResponsibility;
  /** Rule note / description (e.g. "#1 JPEG 8-bit standard") */
  readonly description: string;
}

/** Complete decision rule declaration */
export interface DecisionRule {
  /**
   * Rule ID — the XY scheme: X = format family (1 BMP 2 GIF 3 JPEG 4 TIFF
   * 5 PNG 6 WebP 7 AVIF 8 HEIC 9 RAW V vector 0 cross-format catch-all),
   * Y = variant (grayscale occupies Y=1); every id is a string.
   */
  readonly id: number | string;
  readonly condition: DecisionCondition;
  readonly action: DecisionAction;
}
