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
 * Rules are declared in priority order (row 1 → row 26), returning the first match via `./matcher.ts`.
 * CMYK (rule 25) is split into two rules with id=25 by bitDepth (8/16) to keep
 * `DecisionAction.dataFormat` statically typed.
 * The HEIC family carries the spec labels `19a`–`19e` (plus the `19-wg`
 * wide-gamut twin) — see the rule ids below for the authoritative semantics.
 *
 * @module core/files/strategy/engine/rules
 */

import type { DecisionRule } from './types';

export const INGEST_DECISION_RULES: readonly DecisionRule[] = [
  // ── 1. JPEG ─────────────────────────────────────────────────────────────
  {
    id: 1,
    condition: {
      format: 'jpeg',
      bitDepth: 8,
      colorSpace: ['srgb', 'display-p3'],
      isMultiFrame: false,
    },
    action: {
      decodeChannel: 'image-bitmap',
      trc: 'srgb-trc',
      applyOrientation: 'auto',
      description: 'JPEG 8-bit standard (srgb/p3) browser passthrough',
    },
  },
  {
    id: 2,
    condition: {
      format: 'jpeg',
      bitDepth: 8,
      colorSpace: ['adobe-rgb', 'prophoto-rgb'],
      isMultiFrame: false,
    },
    action: {
      decodeChannel: 'wide-gamut-8',
      trc: 'linear',
      dataFormat: 'rgba16float',
      applyOrientation: 'auto',
      description: 'JPEG 8-bit wide-gamut lift to f16 and fold proxy',
    },
  },

  // ── 2. WebP ─────────────────────────────────────────────────────────────
  {
    id: 3,
    condition: {
      format: 'webp',
      bitDepth: 8,
      colorSpace: ['srgb', 'display-p3'],
      isMultiFrame: false,
    },
    action: {
      decodeChannel: 'image-bitmap',
      trc: 'srgb-trc',
      applyOrientation: 'auto',
      description: 'WebP 8-bit standard passthrough',
    },
  },
  {
    id: 4,
    condition: {
      format: 'webp',
      bitDepth: 8,
      colorSpace: ['adobe-rgb', 'prophoto-rgb'],
      isMultiFrame: false,
    },
    action: {
      decodeChannel: 'wide-gamut-8',
      trc: 'linear',
      dataFormat: 'rgba16float',
      applyOrientation: 'auto',
      description: 'WebP 8-bit wide-gamut lift to f16',
    },
  },

  // ── 3. PNG ──────────────────────────────────────────────────────────────
  {
    id: 5,
    condition: {
      format: 'png',
      bitDepth: 8,
      colorSpace: ['srgb', 'display-p3'],
      isMultiFrame: false,
    },
    action: {
      decodeChannel: 'image-bitmap',
      trc: 'srgb-trc',
      applyOrientation: 'explicit', // Browser ignores eXIf
      description: 'PNG 8-bit standard passthrough',
    },
  },
  {
    id: 6,
    condition: {
      format: 'png',
      bitDepth: 8,
      colorSpace: ['adobe-rgb', 'prophoto-rgb'],
      isMultiFrame: false,
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
    id: 7,
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
    id: 8,
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

  // ── 4. TIFF ─────────────────────────────────────────────────────────────
  {
    id: 9,
    condition: {
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
    id: 10,
    condition: {
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
    id: 11,
    condition: {
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
    id: 12,
    condition: {
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
    id: 13,
    condition: {
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

  // ── 5. Camera RAW ────────────────────────────────────────────────────────
  {
    id: 14,
    condition: {
      format: 'raw',
      bitDepth: '*',
      colorSpace: '*',
    },
    action: {
      decodeChannel: 'libraw',
      trc: 'linear',
      dataFormat: 'rgba16float',
      applyOrientation: 'auto',
      description: 'Camera RAW native linear restoration',
    },
  },

  // ── 6. AVIF (labels 15a/15b/16-wg/18) ──────────────────────────────────
  // >8-bit is no longer clamped (probe: the jsquash/libavif wasm decoder
  // is bit-exact at native depth); high depth routes
  // to the avif-proxy channel and the metadata reports the TRUE depth.
  {
    // HDR (PQ/HLG) — the wasm high-depth decode probe rewrote the evidence base:
    // the channel delivers RAW TRANSFER CODE VALUES bit-exactly (maxDev 0 on
    // lossless identity ramps), so the EOTF is ours to apply. Route to
    // avif-proxy; decode.ts applies the 203-nit-anchored PQ/HLG EOTF →
    // scene-linear f16 in the source gamut. The SDR vocabulary rows
    // below never see these files (first-match order).
    id: '18-hdr-sdr-vocab',
    condition: {
      format: 'avif',
      bitDepth: '*',
      colorSpace: ['srgb', 'display-p3'],
      transfer: ['pq', 'hlg'],
      isMultiFrame: false,
    },
    action: {
      decodeChannel: 'avif-proxy',
      trc: 'linear',
      dataFormat: 'rgba16float',
      applyOrientation: 'explicit',
      description: 'AVIF PQ/HLG, sRGB/P3 primaries — wasm decode + own EOTF, scene-linear f16',
    },
  },
  {
    // Same as above for BT.2020 primaries: no ColorSpaceId member (gap #8), so
    // the row carries the authoritative gamutOverride ('rec2020' is a GamutId
    // the render graph already has a matrix for).
    id: '18-hdr-bt2020',
    condition: {
      format: 'avif',
      bitDepth: '*',
      colorSpace: 'unknown',
      transfer: ['pq', 'hlg'],
      isMultiFrame: false,
    },
    action: {
      decodeChannel: 'avif-proxy',
      trc: 'linear',
      dataFormat: 'rgba16float',
      gamutOverride: 'rec2020',
      applyOrientation: 'explicit',
      description: 'AVIF PQ/HLG, BT.2020 primaries — wasm decode + own EOTF, scene-linear f16 (rec2020)',
    },
  },
  {
    id: 15,
    condition: {
      format: 'avif',
      bitDepth: 8,
      colorSpace: ['srgb', 'display-p3'],
      isMultiFrame: false,
    },
    action: {
      decodeChannel: 'image-bitmap',
      trc: 'srgb-trc',
      applyOrientation: 'explicit',
      description: 'AVIF 8-bit standard passthrough (15a)',
    },
  },
  {
    // High-depth SDR: f16 direct (probe B-variant) — jsquash decodes bit-exact
    // at native depth; the 8-bit display proxy is produced browser-side
    // (createImageBitmap's 10→8 downgrade is faithful, meanDev ≤ 1.4/255).
    id: '15b',
    condition: {
      format: 'avif',
      bitDepth: (d) => d >= 10,
      colorSpace: ['srgb', 'display-p3'],
      isMultiFrame: false,
    },
    action: {
      decodeChannel: 'avif-proxy',
      trc: 'srgb-trc',
      dataFormat: 'rgba16float',
      applyOrientation: 'explicit',
      description: 'AVIF ≥10-bit SDR (15b) — avif-proxy f16 direct, metadata reports true depth',
    },
  },
  {
    id: 17,
    condition: {
      format: 'avif',
      bitDepth: 8,
      colorSpace: ['adobe-rgb', 'prophoto-rgb'],
      isMultiFrame: false,
    },
    action: {
      decodeChannel: 'wide-gamut-8',
      trc: 'linear',
      dataFormat: 'rgba16float',
      applyOrientation: 'explicit',
      description: 'AVIF 8-bit wide-gamut',
    },
  },
  {
    // High-depth wide gamut (type-reachable, rarely seen): mirror 19-wg —
    // proxy + de-gamma to true linear (PNG/TIFF row-8 semantics).
    id: '16-wg',
    condition: {
      format: 'avif',
      bitDepth: (d) => d >= 10,
      colorSpace: ['adobe-rgb', 'prophoto-rgb'],
      isMultiFrame: false,
    },
    action: {
      decodeChannel: 'avif-proxy',
      trc: 'linear',
      dataFormat: 'rgba16float',
      applyOrientation: 'explicit',
      description: 'AVIF ≥10-bit wide-gamut (16-wg) — avif-proxy, de-gamma to linear f16',
    },
  },
  {
    // Remaining 'unknown'-colourSpace files (SDR BT.2020, ICC-tagged oddities)
    // and MULTI-FRAME HDR (the HDR rows above are single-frame): honest
    // unsupported — the browser's own HDR→SDR mapping is uncontrolled
    // (meanDev ≈ 30/255) and SDR BT.2020 is the gap-#8 orbit. Mirrors HEIC 19d.
    id: '18',
    condition: {
      format: 'avif',
      bitDepth: '*',
      colorSpace: 'unknown',
    },
    action: {
      decodeChannel: 'unsupported',
      trc: 'srgb-trc',
      applyOrientation: 'explicit',
      description: 'AVIF PQ/HLG/BT.2020 (18) — HDR tone mapping out of scope, unsupported',
    },
  },

  // ── 7. HEIC (labels 19a–19e) ─────────────────────────────────────────
  // 19a is capability-gated: the decode entry awaits the one-shot
  // HEVC capability probe (`handlers/heic/capability.ts`) and injects `hevcHardDecode` into the decision
  // context. Without the flag (plain calls, tests, no-WebCodecs
  // runtimes) it defaults to `false` and 19e below owns the downgrade.
  {
    // 19-gm / 19-gm-proxy: gain-map carriers (an `hdrgainmap` auxiliary image
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
    // 19a (fail-fast preserved). ORDER: ahead of 19a/19e — first-match-wins
    // means a gain-map file must never be captured by the plain rows, whose
    // srgb-trc 8-bit master would strand the presentation slice; 19d still
    // owns PQ/HLG (unknown colour tag) for carriers and non-carriers alike.
    id: '19-gm',
    condition: {
      format: 'heic',
      hasGainmap: true,
      bitDepth: 8,
      colorSpace: ['srgb', 'display-p3'],
      isMultiFrame: false,
      hevcHardDecode: true,
    },
    action: {
      decodeChannel: 'webcodecs-heic',
      trc: 'linear',
      dataFormat: 'rgba16float',
      applyOrientation: 'auto',
      description: 'HEIC gain-map 8-bit (19-gm) — hard decode, SDR base lifted to the linear f16 master',
    },
  },
  {
    // Proxy twin of 19-gm: capability absent (or any depth) — same linear f16
    // SDR-base master, proxy main decode. bitDepth '*' on purpose: a gain-map
    // carrier is its own precision story (the map rides the file verbatim at
    // any base depth), and the proxy delivers 8-bit pixels regardless.
    id: '19-gm-proxy',
    condition: {
      format: 'heic',
      hasGainmap: true,
      bitDepth: '*',
      colorSpace: ['srgb', 'display-p3'],
      isMultiFrame: false,
    },
    action: {
      decodeChannel: 'libheif-proxy',
      trc: 'linear',
      dataFormat: 'rgba16float',
      applyOrientation: 'auto',
      description: 'HEIC gain-map carrier (19-gm-proxy) — proxy decode, SDR base lifted to the linear f16 master',
    },
  },
  {
    id: '19a',
    condition: {
      format: 'heic',
      bitDepth: 8,
      colorSpace: ['srgb', 'display-p3'],
      isMultiFrame: false,
      hevcHardDecode: true,
    },
    action: {
      decodeChannel: 'webcodecs-heic',
      trc: 'srgb-trc',
      applyOrientation: 'auto', // worker output is uprighted during composition (irot/imir + EXIF)
      description: 'HEIC 8-bit SDR (19a) — WebCodecs hardware decode, capability-gated',
    },
  },
  {
    // 10-bit delivers as 8-bit (no faithful webcodecs CPU path; probe-verified),
    // but the metadata reports the TRUE depth so 19b/19c are distinguishable
    // and the precision loss is declared, never silent.
    id: '19b',
    condition: {
      format: 'heic',
      bitDepth: 10,
      colorSpace: ['srgb', 'display-p3'],
      isMultiFrame: false,
    },
    action: {
      decodeChannel: 'libheif-proxy',
      trc: 'srgb-trc',
      applyOrientation: 'auto',
      description: 'HEIC 10-bit SDR (19b) — proxy delivers 8-bit, metadata reports 10',
    },
  },
  {
    id: '19c',
    condition: {
      format: 'heic',
      bitDepth: (d) => d >= 12,
      colorSpace: ['srgb', 'display-p3'],
      isMultiFrame: false,
    },
    action: {
      decodeChannel: 'libheif-proxy',
      trc: 'srgb-trc',
      applyOrientation: 'auto',
      description: 'HEIC ≥12-bit (19c) — proxy delivers 8-bit, metadata reports the true depth',
    },
  },
  {
    // PQ / HLG / BT.2020 resolve to colorSpace 'unknown' (nclxToColorSpace /
    // inferColorSpaceFromIcc): no tone mapping exists, and a wrong mapping is
    // worse than an honest error — so route unsupported rather than proxy.
    // No isMultiFrame condition: a multi-frame HDR file is equally unsupported.
    id: '19d',
    condition: {
      format: 'heic',
      bitDepth: '*',
      colorSpace: 'unknown',
    },
    action: {
      decodeChannel: 'unsupported',
      trc: 'srgb-trc',
      applyOrientation: 'explicit',
      description: 'HEIC PQ/HLG/BT.2020 (19d) — HDR tone mapping out of scope, unsupported',
    },
  },
  {
    // 19e: the declarative proxy downgrade — reachable whenever 19a's
    // capability gate does not admit the file (no WebCodecs, probe negative,
    // or plain decision calls where the flag defaults to false).
    id: '19e',
    condition: {
      format: 'heic',
      bitDepth: 8,
      colorSpace: ['srgb', 'display-p3'],
      isMultiFrame: false,
    },
    action: {
      decodeChannel: 'libheif-proxy',
      trc: 'srgb-trc',
      applyOrientation: 'auto',
      description: 'HEIC 8-bit without HEVC hardware decode (19e) — declarative proxy downgrade',
    },
  },
  {
    // Wide-gamut twin of 19a/19b/19c — adobe-rgb/prophoto twins take the same
    // wide-gamut lane as one row:
    // any depth ≥8 routes to the proxy, and the STANDING wide-gamut composition
    // applies (linear TRC + f16 container, mirroring jpeg/webp/png rows 2/4/6).
    // `adobe-rgb`/`prophoto-rgb` HEIC sources are type-reachable but unseen in
    // practice; the depth split needs no separate rows because the proxy
    // delivers 8-bit pixels and the f16 lift is uniform on the wide branch.
    id: '19-wg',
    condition: {
      format: 'heic',
      bitDepth: (d) => d >= 8,
      colorSpace: ['adobe-rgb', 'prophoto-rgb'],
      isMultiFrame: false,
    },
    action: {
      decodeChannel: 'libheif-proxy',
      trc: 'linear',
      dataFormat: 'rgba16float',
      applyOrientation: 'auto',
      description: 'HEIC wide-gamut (19-wg) — proxy + standing wide-gamut composition',
    },
  },

  // ── 8. BMP / GIF / Vector ───────────────────────────────────────────────
  {
    id: 21,
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
    id: 22,
    condition: {
      format: 'gif',
      bitDepth: 8,
      colorSpace: 'srgb',
      isMultiFrame: false,
    },
    action: {
      decodeChannel: 'image-bitmap',
      trc: 'srgb-trc',
      applyOrientation: 'none',
      description: 'GIF single-frame static passthrough',
    },
  },
  {
    id: 23,
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
  {
    id: 24,
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

  // ── 9. Special color modes (CMYK & unrecognized) ──────────────────────────
  // CMYK is split into two rules with id=25 by bitDepth (8-bit / 16-bit) to
  // keep `dataFormat` statically typed:
  {
    id: 25,
    condition: {
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
    id: 25,
    condition: {
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
    id: 26,
    condition: {
      format: '*',
      bitDepth: '*',
      colorSpace: '*',
      isMultiFrame: '*',
    },
    action: {
      decodeChannel: 'unsupported',
      trc: 'srgb-trc',
      applyOrientation: 'explicit',
      description: 'Unsupported or sub-8-bit fallback',
    },
  },
];
