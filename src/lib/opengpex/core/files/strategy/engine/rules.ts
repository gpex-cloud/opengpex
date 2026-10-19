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
 * Complete decision matrix rule table.
 *
 * Rules are declared in priority order, returning the first match via
 * `./matcher.ts`. Ids use the XY scheme: X = format family (1 BMP 2 GIF
 * 3 JPEG 4 TIFF 5 PNG 6 WebP 7 AVIF 8 HEIC 9 RAW V vector 0 cross-format
 * catch-all), Y = variant (grayscale occupies Y=1). CMYK is split into 01/02
 * by bitDepth (8/16) to keep `DecisionAction.dataFormat` statically typed.
 * The HEIC family spans ids 81–87 in physical order, pairwise disjoint
 * (carrier / depth / capability axes — order never decides the winner):
 * 81/82/85 the gain-map carrier rows (hard decode / no-capability proxy /
 * ≥10-bit capability-agnostic proxy), 83/84/86 the plain-SDR rows (hard
 * decode / no-capability downgrade / ≥10-bit proxy), 87 the unknown
 * (HDR colour tag) terminus.
 *
 * @module core/files/strategy/engine/rules
 */

import type { DecisionRule } from './types';

export const INGEST_DECISION_RULES: readonly DecisionRule[] = [
  // ── 1. BMP / GIF ───────────────────────────────────────────────
  {
    id: '11',
    condition: {
      format: 'bmp',
      bitDepth: 8,
      colorSpace: 'srgb',
    },
    action: {
      decodeChannel: 'image-bitmap',
      trc: 'srgb-trc',
      applyOrientation: 'none',
      description: 'BMP forced sRGB passthrough',
    },
  },
  {
    id: '21',
    condition: {
      format: 'gif',
      bitDepth: 8,
      colorSpace: 'srgb',
    },
    action: {
      decodeChannel: 'image-bitmap',
      trc: 'srgb-trc',
      applyOrientation: 'none',
      description: 'GIF single-frame static passthrough',
    },
  },
  {
    id: '22',
    condition: {
      format: 'gif',
      bitDepth: 8,
      colorSpace: 'srgb',
      isMultiFrame: true,
    },
    action: {
      decodeChannel: 'gifuct',
      trc: 'srgb-trc',
      applyOrientation: 'none',
      description: 'GIF multi-frame parse frame-by-frame',
    },
  },

  // ── 2. JPEG ─────────────────────────────────────────────────────────────
  {
    // 31: gain-map carriers (UltraHDR — a GContainer XMP directory naming a
    // GainMap item is present). Mirrors the HEIC 81 philosophy: the master
    // is the SDR base lifted to LINEAR f16 and the gain map is deliberately
    // NOT applied at ingest — the engine renders both HDR-ON and HDR-OFF from
    // that ONE resident f16 line (a baked master would make OFF the CLAMPED
    // HDR rendition instead of the file's authoritative SDR base). The lane
    // keeps the original bytes as the display proxy (a JPEG is browser-native;
    // a transcode could only degrade it) and retains the source file, which is
    // what lets the presentation cache re-parse the multi-picture container
    // for the gain map at view time (`FileService.decodeGainMap`). ORDER:
    // ahead of rule 1 — first-match-wins means a carrier must never be
    // captured by the verbatim row, whose retained=false would strand the
    // gain decode with no source file.
    id: '31',
    condition: {
      format: 'jpeg',
      hasGainmap: true,
      bitDepth: 8,
      colorSpace: ['srgb', 'display-p3'],
    },
    action: {
      decodeChannel: 'jpeg-hdr',
      trc: 'linear',
      dataFormat: 'rgba16float',
      applyOrientation: 'auto',
      description: 'JPEG gain-map carrier (31) — SDR base lifted to the linear f16 master, source retained',
    },
  },
  {
    id: '32',
    condition: {
      format: 'jpeg',
      bitDepth: 8,
      colorSpace: ['srgb', 'display-p3'],
    },
    action: {
      decodeChannel: 'image-bitmap',
      trc: 'srgb-trc',
      applyOrientation: 'auto',
      description: 'JPEG 8-bit standard (srgb/p3) browser passthrough',
    },
  },
  {
    id: '33',
    condition: {
      format: 'jpeg',
      bitDepth: 8,
      colorSpace: ['adobe-rgb', 'prophoto-rgb'],
    },
    action: {
      decodeChannel: 'wide-gamut-8',
      trc: 'linear',
      dataFormat: 'rgba16float',
      applyOrientation: 'auto',
      description: 'JPEG 8-bit wide-gamut lift to f16 and fold proxy',
    },
  },

  // ── 3. WebP ─────────────────────────────────────────────────────────────
  {
    id: '61',
    condition: {
      format: 'webp',
      bitDepth: 8,
      colorSpace: ['srgb', 'display-p3'],
    },
    action: {
      decodeChannel: 'image-bitmap',
      trc: 'srgb-trc',
      applyOrientation: 'auto',
      description: 'WebP 8-bit standard passthrough',
    },
  },
  // ── 4. PNG ──────────────────────────────────────────────────────────────
  {
    // Grayscale (PNG colour type 0/4): same achromatic fold to sRGB; the
    // browser replicates the single channel into RGB on decode.
    id: '51',
    condition: {
      format: 'png',
      bitDepth: 8,
      colorSpace: 'grayscale',
    },
    action: {
      decodeChannel: 'image-bitmap',
      trc: 'srgb-trc',
      applyOrientation: 'explicit',
      description: 'PNG 8-bit grayscale — sRGB fold, browser channel replication',
    },
  },
  {
    id: '52',
    condition: {
      format: 'png',
      bitDepth: 16,
      colorSpace: 'grayscale',
    },
    action: {
      decodeChannel: 'vips',
      trc: 'srgb-trc',
      dataFormat: 'rgba16float',
      applyOrientation: 'explicit',
      description: 'PNG 16-bit grayscale — vips dual product, source encoding kept',
    },
  },
  {
    id: '53',
    condition: {
      format: 'png',
      bitDepth: 8,
      colorSpace: ['srgb', 'display-p3'],
    },
    action: {
      decodeChannel: 'image-bitmap',
      trc: 'srgb-trc',
      applyOrientation: 'explicit', // Browser ignores eXIf
      description: 'PNG 8-bit standard passthrough',
    },
  },
  {
    id: '54',
    condition: {
      format: 'png',
      bitDepth: 8,
      colorSpace: ['adobe-rgb', 'prophoto-rgb'],
    },
    action: {
      decodeChannel: 'wide-gamut-8',
      trc: 'linear',
      dataFormat: 'rgba16float',
      applyOrientation: 'explicit',
      description: 'PNG 8-bit wide-gamut',
    },
  },
  {
    id: '55',
    condition: {
      format: 'png',
      bitDepth: 16,
      colorSpace: ['srgb', 'display-p3'],
    },
    action: {
      decodeChannel: 'vips',
      trc: 'srgb-trc',
      dataFormat: 'rgba16float',
      applyOrientation: 'explicit',
      description: 'PNG 16-bit standard high-precision',
    },
  },
  {
    id: '56',
    condition: {
      format: 'png',
      bitDepth: 16,
      colorSpace: ['adobe-rgb', 'prophoto-rgb'],
    },
    action: {
      decodeChannel: 'vips',
      trc: 'linear',
      dataFormat: 'rgba16float',
      applyOrientation: 'explicit',
      description: 'PNG 16-bit wide-gamut high-precision degamma',
    },
  },

  // ── 5. TIFF ─────────────────────────────────────────────────────────────
  // Multi-page TIFF is a SUPPORTED document form (trunk + branch frame
  // import, importer `frame/importers/multi-tiff.ts`), so every TIFF row
  // admits multi-frame contexts via an explicit isMultiFrame wildcard —
  // unlike the animated-sequence formats (WebP/AVIF/HEIC), whose rows omit
  // the axis and thus exclude multi-frame contexts under value equality.
  {
    // Grayscale (photometric 0/1): achromatic — no primaries exist, the gamut
    // folds to sRGB (vips interpretation 'b-w' needs no colourspace conversion).
    id: '41',
    condition: {
      isMultiFrame: '*',
      format: 'tiff',
      bitDepth: 8,
      colorSpace: 'grayscale',
    },
    action: {
      decodeChannel: 'vips',
      trc: 'srgb-trc',
      applyOrientation: 'explicit',
      description: 'TIFF 8-bit grayscale — vips sRGB fold',
    },
  },
  {
    id: '42',
    condition: {
      isMultiFrame: '*',
      format: 'tiff',
      bitDepth: 16,
      colorSpace: 'grayscale',
    },
    action: {
      decodeChannel: 'vips',
      trc: 'srgb-trc',
      dataFormat: 'rgba16float',
      applyOrientation: 'explicit',
      description: 'TIFF 16-bit grayscale — vips dual product, source encoding kept',
    },
  },
  {
    id: '43',
    condition: {
      isMultiFrame: '*',
      format: 'tiff',
      bitDepth: 8,
      colorSpace: ['srgb', 'display-p3'],
    },
    action: {
      decodeChannel: 'vips',
      trc: 'srgb-trc',
      applyOrientation: 'explicit',
      description: 'TIFF 8-bit standard (retain original file)',
    },
  },
  {
    id: '44',
    condition: {
      isMultiFrame: '*',
      format: 'tiff',
      bitDepth: 8,
      colorSpace: ['adobe-rgb', 'prophoto-rgb'],
    },
    action: {
      decodeChannel: 'vips',
      trc: 'linear',
      dataFormat: 'rgba16float',
      applyOrientation: 'explicit',
      description: 'TIFF 8-bit wide-gamut',
    },
  },
  {
    id: '45',
    condition: {
      isMultiFrame: '*',
      format: 'tiff',
      bitDepth: 16,
      colorSpace: ['srgb', 'display-p3'],
    },
    action: {
      decodeChannel: 'vips',
      trc: 'srgb-trc',
      dataFormat: 'rgba16float',
      applyOrientation: 'explicit',
      description: 'TIFF 16-bit standard high-precision',
    },
  },
  {
    id: '46',
    condition: {
      isMultiFrame: '*',
      format: 'tiff',
      bitDepth: 16,
      colorSpace: ['adobe-rgb', 'prophoto-rgb'],
    },
    action: {
      decodeChannel: 'vips',
      trc: 'linear',
      dataFormat: 'rgba16float',
      applyOrientation: 'explicit',
      description: 'TIFF 16-bit wide-gamut high-precision',
    },
  },
  {
    // colorSpace '*' on purpose, and it is NOT a violation of the
    // "unmappable tag → honest unsupported" policy: 32-bit implies float
    // samples (sampleFormat float), whose pixel values are already linear —
    // no colour conversion participates, so there is no tag to mistranslate.
    // Known accepted exception, not an oversight.
    id: '47',
    condition: {
      isMultiFrame: '*',
      format: 'tiff',
      bitDepth: (d) => d >= 32,
      colorSpace: '*',
    },
    action: {
      decodeChannel: 'vips',
      trc: 'linear',
      dataFormat: 'rgba32float',
      applyOrientation: 'explicit',
      description: 'TIFF 32-bit float passthrough',
    },
  },

  // ── 6. AVIF (labels 71/72/73/74/75) ───────────────────────────────
  // >8-bit is no longer clamped (probe: the jsquash/libavif wasm decoder
  // is bit-exact at native depth); high depth routes
  // to the avif-proxy channel and the metadata reports the TRUE depth.
  {
    id: '71',
    condition: {
      format: 'avif',
      bitDepth: 8,
      colorSpace: ['srgb', 'display-p3'],
    },
    action: {
      decodeChannel: 'image-bitmap',
      trc: 'srgb-trc',
      applyOrientation: 'explicit',
      description: 'AVIF 8-bit standard passthrough (71)',
    },
  },
  {
    // High-depth SDR: f16 direct (probe B-variant) — jsquash decodes bit-exact
    // at native depth; the 8-bit display proxy is produced browser-side
    // (createImageBitmap's 10→8 downgrade is faithful, meanDev ≤ 1.4/255).
    id: '72',
    condition: {
      format: 'avif',
      bitDepth: (d) => d >= 10,
      colorSpace: ['srgb', 'display-p3'],
    },
    action: {
      decodeChannel: 'avif-proxy',
      trc: 'srgb-trc',
      dataFormat: 'rgba16float',
      applyOrientation: 'explicit',
      description: 'AVIF ≥10-bit SDR (72) — avif-proxy f16 direct, metadata reports true depth',
    },
  },
  {
    // SDR BT.2020 (phase D4, gap #8 closure): primaries-9 SDR containers now
    // report `colorSpace: 'rec2020'` straight from the nclx map. The wasm proxy
    // delivers raw transfer code values bit-exactly; the BT.709/BT.2020 OETF
    // (the α/β piecewise curve both standards publish — the TRC the user
    // adjudicated for SDR BT.2020 in phase D4) is ours to invert onto the
    // f16-linear line in the source gamut. 8-bit BT.2020 stays below with the
    // honest fallback (rare container; not probed, not routed here).
    id: '73',
    condition: {
      format: 'avif',
      bitDepth: (d) => d >= 10,
      colorSpace: 'rec2020',
    },
    action: {
      decodeChannel: 'avif-proxy',
      trc: 'linear',
      dataFormat: 'rgba16float',
      applyOrientation: 'explicit',
      description: 'AVIF ≥10-bit SDR BT.2020 (73) — avif-proxy, BT.709 OETF inverse to linear f16 (rec2020)',
    },
  },
  {
    // HDR (PQ/HLG) — the wasm high-depth decode probe rewrote the evidence base:
    // the channel delivers RAW TRANSFER CODE VALUES bit-exactly (maxDev 0 on
    // lossless identity ramps), so the EOTF is ours to apply. Route to
    // avif-proxy; decode.ts applies the 203-nit-anchored PQ/HLG EOTF →
    // scene-linear f16 in the source gamut. One row for every supported
    // primaries set (sRGB/P3/BT.2020): the action is identical and the gamut
    // is derived from the colorSpace id (csToGamut), so a per-primaries split
    // would be documentation, not semantics (D4 closed gap #8 — the nclx map
    // reports 'rec2020' directly, no override hatch). A PQ file whose
    // primaries still report 'unknown' falls to rule 75's honest unsupported,
    // never a guessed gamut. Disjoint from the SDR rows below purely by the
    // transfer axis (they declare no transfer), never by row order.
    id: '74',
    condition: {
      format: 'avif',
      bitDepth: '*',
      colorSpace: ['srgb', 'display-p3', 'rec2020'],
      transfer: ['pq', 'hlg'],
    },
    action: {
      decodeChannel: 'avif-proxy',
      trc: 'linear',
      dataFormat: 'rgba16float',
      applyOrientation: 'explicit',
      description: 'AVIF PQ/HLG — wasm decode + own EOTF, scene-linear f16 in the source gamut',
    },
  },
  {
    // Remaining 'unknown'-colourSpace files (ICC-tagged oddities, sub-10-bit
    // BT.2020) and MULTI-FRAME HDR (the HDR rows above are single-frame):
    // honest unsupported — the browser's own HDR→SDR mapping is uncontrolled
    // (meanDev ≈ 30/255). SDR BT.2020 ≥10-bit moved UP to 73 (phase D4);
    // HEIC/MOV-carried BT.2020 stays here (D3-table scope). Mirrors HEIC 86.
    id: '75',
    condition: {
      format: 'avif',
      bitDepth: '*',
      colorSpace: 'unknown',
      transfer: '*',
      isMultiFrame: '*',
    },
    action: {
      decodeChannel: 'unsupported',
      trc: 'srgb-trc',
      applyOrientation: 'explicit',
      description: 'AVIF PQ/HLG multi-frame + odd-tag leftovers (75) — unsupported',
    },
  },
  // ── 7. HEIC (labels 81–87) ─────────────────────────────────────────
  // Capability axis: `FileService.decode` awaits the one-shot HEVC probe
  // (`handlers/heic/capability.ts`) and injects `hevcHardDecode: true` ONLY
  // on admission — the context never carries `false`, so "probe negative"
  // and "not probed" (plain calls, tests, no-WebCodecs runtimes) are one
  // state, spelled by OMITTING the condition. Condition vocabulary for the
  // two boolean axes (hevcHardDecode / hasGainmap) is therefore exactly:
  // `true` = admit, `'*'` = agnostic, undeclared = absent. Rows are grouped
  // 8-bit first; every row is pairwise disjoint (carrier / depth /
  // capability axes), so this order is presentation, never correctness.
  {
    // 81 / 82 / 85: gain-map carriers (an `hdrgainmap` auxiliary image
    // is present). The SDR base is lifted to the LINEAR f16 master — and the
    // gain map is deliberately NOT applied at ingest. The engine renders both
    // HDR-ON and HDR-OFF from the ONE resident f16 line (the presentation
    // switch only selects the view pipeline's clamp/extension, never the data
    // source): a master baked with hdr = sdr·2^gain would make OFF present the
    // CLAMPED HDR rendition instead of the file's authoritative SDR base — a
    // 2× sky pins its blue channel at white and the image hue-skews. The gain
    // application lives at the view pass (engine/color/gainMap.ts holds the
    // math); the linear f16 identity here is the precision-ready master that
    // application samples. Main decode follows the SAME capability gate as
    // 85 (fail-fast preserved); 87 still owns PQ/HLG (unknown colour tag) for
    // carriers and non-carriers alike.
    id: '81',
    condition: {
      format: 'heic',
      hasGainmap: true,
      bitDepth: 8,
      colorSpace: ['srgb', 'display-p3'],
      hevcHardDecode: true,
    },
    action: {
      decodeChannel: 'webcodecs-heic',
      trc: 'linear',
      dataFormat: 'rgba16float',
      applyOrientation: 'auto',
      description: 'HEIC gain-map 8-bit (81) — hard decode, SDR base lifted to the linear f16 master',
    },
  },
  {
    // 8-bit carrier WITHOUT capability: same linear-f16 SDR-base master via
    // the proxy. No hevcHardDecode declaration on purpose: under value
    // equality an undeclared condition matches only the capability-less
    // context — disjoint from 81 (true) by the capability axis and from 85
    // by depth.
    id: '82',
    condition: {
      format: 'heic',
      bitDepth: 8,
      colorSpace: ['srgb', 'display-p3'],
      hasGainmap: true,
    },
    action: {
      decodeChannel: 'libheif-proxy',
      trc: 'linear',
      dataFormat: 'rgba16float',
      applyOrientation: 'auto',
      description: 'HEIC 8-bit gain-map carrier without capability (82) — proxy, linear f16 SDR-base master',
    },
  },
  {
    // 8-bit SDR non-carrier WITH capability: 8-bit masters stay 8-bit (no f16
    // lift needed — there is no gain map whose application needs headroom), so
    // the srgb-trc 8-bit master is both cheapest and faithful. Disjoint from
    // 81/82 by the carrier axis (undeclared hasGainmap = non-carrier) and
    // from 86 by depth.
    id: '83',
    condition: {
      format: 'heic',
      bitDepth: 8,
      colorSpace: ['srgb', 'display-p3'],
      hevcHardDecode: true,
    },
    action: {
      decodeChannel: 'webcodecs-heic',
      trc: 'srgb-trc',
      applyOrientation: 'auto',
      description: 'HEIC 8-bit SDR with hard decode (83) — webcodecs main decode, 8-bit srgb-trc master',
    },
  },
  {
    // The declarative proxy downgrade: NON-CARRIERS the 84 gate does not
    // admit. Both boolean axes stay undeclared on purpose: no hasGainmap =
    // non-carrier, no hevcHardDecode = capability-less (probe negative or
    // not probed) — pairwise disjoint from every other HEIC row, zero
    // row-order dependence.
    id: '84',
    condition: {
      format: 'heic',
      bitDepth: 8,
      colorSpace: ['srgb', 'display-p3'],
    },
    action: {
      decodeChannel: 'libheif-proxy',
      trc: 'srgb-trc',
      applyOrientation: 'auto',
      description: 'HEIC 8-bit without HEVC hardware decode (84) — declarative proxy downgrade',
    },
  },
  {
    // Proxy twin of 81 at high depth: capability-agnostic (hevcHardDecode
    // '*' — the proxy main decode runs with or without hard-decode support)
    // — same linear f16 SDR-base master. bitDepth '*' on purpose: a gain-map
    // carrier is its own precision story (the map rides the file verbatim at
    // any base depth), and the proxy delivers 8-bit pixels regardless.
    id: '85',
    condition: {
      format: 'heic',
      bitDepth: (d) => d >= 10,
      colorSpace: ['srgb', 'display-p3'],
      hasGainmap: true,
      hevcHardDecode: '*',
    },
    action: {
      decodeChannel: 'libheif-proxy',
      trc: 'linear',
      dataFormat: 'rgba16float',
      applyOrientation: 'auto',
      description: 'HEIC ≥10-bit gain-map carrier (85) — proxy decode, SDR base lifted to the linear f16 master',
    },
  },
  {
    // ≥10-bit SDR delivers as 8-bit (no faithful webcodecs CPU path at any
    // high depth; probe-verified) — one row, not per-depth splits: the action
    // is identical for 10/12/14-bit, so the split would be documentation, not
    // semantics. The metadata reports the TRUE depth; only the ROUTE
    // degrades, and the loss is declared, never silent.
    id: '86',
    condition: {
      format: 'heic',
      bitDepth: (d) => d >= 10,
      colorSpace: ['srgb', 'display-p3'],
      hevcHardDecode: '*',
    },
    action: {
      decodeChannel: 'libheif-proxy',
      trc: 'srgb-trc',
      applyOrientation: 'auto',
      description: 'HEIC ≥10-bit SDR (86) — proxy delivers 8-bit, metadata reports the true depth',
    },
  },
  {
    // Family terminus, id-last by convention (mirrors the 00 catch-all): PQ /
    // HLG / BT.2020 resolve to colorSpace 'unknown' (nclxToColorSpace /
    // inferColorSpaceFromIcc). No tone mapping exists, and a wrong mapping is
    // worse than an honest error — so route unsupported rather than proxy.
    // No isMultiFrame condition: a multi-frame HDR file is equally unsupported.
    id: '87',
    condition: {
      format: 'heic',
      bitDepth: '*',
      colorSpace: 'unknown',
      transfer: '*',
      isMultiFrame: '*',
      hevcHardDecode: '*',
    },
    action: {
      decodeChannel: 'unsupported',
      trc: 'srgb-trc',
      applyOrientation: 'explicit',
      description: 'HEIC PQ/HLG/BT.2020 (87) — HDR tone mapping out of scope, unsupported',
    },
  },
  // ── 8. Camera RAW ────────────────────────────────────────────────────────
  {
    id: '91',
    condition: {
      format: 'raw',
      bitDepth: '*',
      colorSpace: '*',
      transfer: '*',
    },
    action: {
      decodeChannel: 'libraw',
      trc: 'linear',
      dataFormat: 'rgba16float',
      applyOrientation: 'auto',
      description: 'Camera RAW native linear restoration',
    },
  },
  {
    id: 'V1',
    condition: {
      format: ['svg', 'eps'],
      bitDepth: '*',
      colorSpace: '*',
    },
    action: {
      decodeChannel: 'vector',
      trc: 'srgb-trc',
      applyOrientation: 'none',
      description: 'Vector format 1:1 rasterization proxy',
    },
  },

  // ── 9. Vector ─────────────────────────────────────────────────────────────
  // The vector proxy sits after the raster/RAW families by convention (it is
  // format-disjoint from every row above; position is presentation only).

  // ── 10. Special color modes (CMYK & unrecognized) ──────────────────────────
  // CMYK is split into two rules with id=25 by bitDepth (8-bit / 16-bit) to
  // keep `dataFormat` statically typed:
  {
    id: '01',
    condition: {
      isMultiFrame: '*',
      format: '*',
      bitDepth: 8,
      colorSpace: 'cmyk',
    },
    action: {
      decodeChannel: 'vips-icc',
      trc: 'srgb-trc',
      applyOrientation: 'explicit',
      description: 'CMYK 8-bit convert to sRGB via ICC engine',
    },
  },
  {
    id: '02',
    condition: {
      isMultiFrame: '*',
      format: '*',
      bitDepth: 16,
      colorSpace: 'cmyk',
    },
    action: {
      decodeChannel: 'vips-icc',
      trc: 'srgb-trc',
      dataFormat: 'rgba16float',
      applyOrientation: 'explicit',
      description: 'CMYK 16-bit convert to sRGB via ICC engine (preserve depth)',
    },
  },

  // ── 10. Fallback terminus (Unsupported) ──────────────────────────────────
  {
    id: '00',
    condition: {
      format: '*',
      bitDepth: '*',
      colorSpace: '*',
      isMultiFrame: '*',
      transfer: '*',
      hasGainmap: '*',
      hevcHardDecode: '*',
    },
    action: {
      decodeChannel: 'unsupported',
      trc: 'srgb-trc',
      applyOrientation: 'explicit',
      description: 'Unsupported or sub-8-bit fallback',
    },
  },
];
