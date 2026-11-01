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
 * HEIC gain-map carrier reader — the two facts a HEIC file must give up before
 * its HDR rendition can be reconstructed:
 *
 *   1. the tone-map PARAMETERS (ISO 21496-1 `tmap` record), and
 *   2. the gain-map PIXELS (the hidden `hdrgainmap` auxiliary image, decoded
 *      per item through the shared HEIC worker).
 *
 * ── tmap parameter record ──
 * iOS 18+ writes the tone-map parameters as their own `tmap` ITEM, located via
 * iloc with construction method 1 — i.e. INSIDE the meta box's `idat` payload,
 * appended after the grid configuration records that share that box (verified
 * against a real Apple capture: idat = [grid config][grid config][tmap]).
 * iOS 17 captures predate `tmap` entirely (their meta idat holds only the grid
 * config) and carry the legacy Apple AGTM parameter block instead — see
 * `extractAppleLegacyToneMapParams` below for the fallback derivation. iOS 16
 * captures are one generation older still: their XMP carries only the gain map
 * version (65536 = 1.0, no headroom field), so the parameters come from the
 * Apple MakerNote — see `extractAppleV1ToneMapParams`. The v1 gain-map PLANE
 * also differs (Rec.709-OETF-encoded linear gain, not log2) and is converted
 * to the log2 contract at ingest before re-encoding.
 * The record is a 6-byte header followed by seven signed rational numbers,
 * each a (i32 numerator, u32 denominator) pair at stride 8 with the fixed
 * denominator 1_000_000, in ISO 21496-1 Annex C order:
 *
 *   [base_headroom, alternate_headroom, gain_map_min, gain_map_max,
 *    gamma, base_offset, alternate_offset]
 *
 * Apple capture ground truth (IMG_2589.HEIC, cross-checked against Finder's
 * reported headroom 3.929 = 2^1.974342):
 *   [0, 1.974342, -0.774902, 1.974342, 1.146484, 1e-5, 1e-5]
 *
 * The header length is NOT assumed: the parser runs an aligned scan over the
 * idat bytes looking for the first offset where seven consecutive stride-8
 * pairs all carry denominator 1_000_000. Grid configs contain u32 runs that
 * never satisfy seven matching denominators, so the scan locates the record
 * without trusting the header; `alternate_headroom ≡ gain_map_max` and
 * `gain_map_min ≤ gain_map_max` act as post-scan sanity gates. `gain_map_min`
 * being negative is legal (ISO 21496-1): those samples DARKEN in HDR, keeping
 * saturated highlights from blowing out — the application math applies the
 * real value (negative exponent), never clamps it to zero.
 *
 * ── auxiliary image extraction (INGEST) ──
 * Hidden aux items never appear in libheif's top-level image enumeration, so
 * the pixels are fetched by ITEM ID through the shared heic-worker (grid aux
 * items — the 48MP 3×5 form — decode through the same entry; libheif composes
 * derived grids internally). This runs ONCE AT INGEST, inside the decode
 * handler's "Converting…" phase: the plane is capped at the subsystem
 * resolution limit (`downscaleGainMap` — a full-size Apple capture is a
 * ~12 MB plane; the consumers sample it as a smooth low-frequency field) and
 * re-encoded as a compact JPEG into `metadata.raw.gainMap`. WHY RE-ENCODE:
 * the HEVC tiles are not browser-decodable, so a coded copy in metadata would
 * be unusable at runtime — the decoded-then-JPEG form is what makes the
 * metadata-carried contract work for this carrier. Any failure is fail-open:
 * `raw.gainMap` stays unset, the presentation negative-caches and presents
 * the authoritative SDR base.
 *
 * @module core/files/handlers/heic/gainmap
 */

import type { ImageMetadata } from '../../types';
import { parseHeicContainer } from './metadata/container';
import { heicWorkerCall } from './transcode';
import { downscaleGainMap } from '@opengpex/editor/core/engine/color/hdr/gainMap';
import { blobToBase64 } from '../../utils';

/** The ISO 21496-1 tmap record's fixed rational denominator. */
const TMAP_DENOMINATOR = 1_000_000;

/** Pairs of (i32 numerator, u32 denominator) in one tmap record. */
const TMAP_RATIONAL_COUNT = 7;

/** Bytes per rational pair. */
const TMAP_STRIDE = 8;

/** The seven Annex C parameters, in wire order. */
export interface HeicToneMapParams {
  /** SDR rendition's intended headroom (log2 stops above diffuse white). */
  readonly baseHeadroom: number;
  /** HDR rendition's intended headroom — ≡ gainMapMax on Apple captures. */
  readonly alternateHeadroom: number;
  /** Map value at byte 0 (log2 ratio; may be negative). */
  readonly gainMapMin: number;
  /** Map value at byte 255 (log2 ratio). */
  readonly gainMapMax: number;
  /** Payload gamma (>0; 1 = log2-linear quantization). */
  readonly gamma: number;
  /** SDR channel offset (dimensionless; ≈0 on Apple captures). */
  readonly baseOffset: number;
  /** HDR channel offset (dimensionless; ≈0 on Apple captures). */
  readonly alternateOffset: number;
}

/**
 * Locate and decode the ISO 21496-1 `tmap` parameter record inside a meta
 * `idat` payload by the aligned denominator scan described in the module doc.
 * Returns null when no candidate position passes (no record, or a foreign
 * idat layout).
 */
export function extractHeicToneMapParams(idatPayload: Uint8Array | undefined): HeicToneMapParams | null {
  if (!idatPayload) return null;
  const dv = new DataView(idatPayload.buffer, idatPayload.byteOffset, idatPayload.byteLength);
  const need = 6 /* observed header floor */ + TMAP_RATIONAL_COUNT * TMAP_STRIDE;
  // One-byte-granularity scan: the record is not word-aligned relative to the
  // idat start (the two grid configs ahead of it on real files are even-length,
  // but nothing in the format promises that).
  for (let start = 0; start + need <= idatPayload.length; start++) {
    let ok = true;
    for (let k = 0; k < TMAP_RATIONAL_COUNT; k++) {
      const denPos = start + 6 + k * TMAP_STRIDE + 4;
      if (dv.getUint32(denPos) !== TMAP_DENOMINATOR) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    const num = (k: number) => dv.getInt32(start + 6 + k * TMAP_STRIDE);
    const params: HeicToneMapParams = {
      baseHeadroom: num(0) / TMAP_DENOMINATOR,
      alternateHeadroom: num(1) / TMAP_DENOMINATOR,
      gainMapMin: num(2) / TMAP_DENOMINATOR,
      gainMapMax: num(3) / TMAP_DENOMINATOR,
      gamma: num(4) / TMAP_DENOMINATOR,
      baseOffset: num(5) / TMAP_DENOMINATOR,
      alternateOffset: num(6) / TMAP_DENOMINATOR,
    };
    // Post-scan sanity gates (ISO 21496-1 invariants) — a u32 run could in
    // principle satisfy the denominator test without being a record.
    if (
      !(params.gamma > 0) ||
      params.gainMapMin > params.gainMapMax ||
      params.alternateHeadroom !== params.gainMapMax
    ) {
      continue;
    }
    return params;
  }
  return null;
}

/**
 * Legacy Apple AGTM parameter fallback for pre-`tmap` captures (iOS 17 and
 * earlier). Those files carry no ISO 21496-1 record; the tone-map intent lives
 * in the XMP packet as the Apple `HDRGainMap/1.0` namespace:
 *
 *   <HDRGainMap:HDRGainMapHeadroom>4.765632</HDRGainMap:HDRGainMapHeadroom>
 *   <HDRGainMap:HDRGainMapVersion>131072</HDRGainMap:HDRGainMapVersion>
 *
 * The headroom is the HDR rendition's intended PEAK headroom as a LINEAR
 * multiplier of SDR diffuse white (element text, decimal). The legacy payload
 * is log2-linear — byte 0 encodes gain 1× (map value 0) and byte 255 encodes
 * the peak headroom — so the map parameters follow directly:
 * `alternateHeadroom = gainMapMax = log2(headroom)`, `gainMapMin = 0`,
 * `gamma = 1`, offsets 0.
 *
 * ORACLE (IMG_2589.HEIC, iOS 26, which carries BOTH forms): its XMP reports
 * 3.929491 and its ISO record reports alternateHeadroom 1.974342, and
 * 2^1.974342 = 3.929491 — the log2 conversion reproduces the authoritative
 * record exactly. Returns null when the XMP is missing or the headroom is not
 * a positive finite number (fail-open, same contract as the tmap scan).
 */
export function extractAppleLegacyToneMapParams(xmp: string | undefined): HeicToneMapParams | null {
  if (!xmp) return null;
  const match = xmp.match(/<HDRGainMap:HDRGainMapHeadroom>\s*([0-9.eE+-]+)\s*<\//);
  if (!match) return null;
  const linearHeadroom = Number(match[1]);
  if (!Number.isFinite(linearHeadroom) || linearHeadroom <= 0) return null;
  const alternateHeadroom = Math.log2(linearHeadroom);
  return {
    baseHeadroom: 0,
    alternateHeadroom,
    gainMapMin: 0,
    gainMapMax: alternateHeadroom,
    gamma: 1,
    baseOffset: 0,
    alternateOffset: 0,
  };
}

// ── Legacy v1 (iOS 16 and earlier) — Apple MakerNote parameters ──────────────

/**
 * The two Apple MakerNote scalars the legacy headroom derivation consumes:
 * Apple EXIF tag 0x0021 (`HDRHeadroom`) and 0x0030 (`HDRGain`), each a
 * rational64s. Units are opaque display-normalized values — only Apple's
 * piecewise formula (below) gives them meaning.
 */
export interface AppleMakerHdrTags {
  readonly headroom: number;
  readonly gain: number;
}

/**
 * Read the Apple MakerNote HDR scalars (tags 0x0021 / 0x0030) from stripped
 * EXIF TIFF bytes.
 *
 * Apple's MakerNote layout (verified byte-level against a real iOS 16
 * capture): after the Exif sub-IFD's `MakerNote` pointer (tag 0x927C) sits a
 * 14-byte header — the ASCII `Apple iOS\0` (10B), a 2-byte version pair, and
 * `MM\0` — followed by a u16 entry count, then count × 12-byte entries of
 * (tag u16, type u16, count u32, value offset u32). Value offsets are
 * RELATIVE TO THE MAKER NOTE START (not to the enclosing TIFF, not inline —
 * an 8-byte rational never fits the 4-byte offset field anyway). Returns
 * null when any step is missing, the header does not match Apple's signature,
 * or either tag is absent / not a single SRATIONAL (type 10, count 1).
 */
export function parseAppleMakerHdrTags(exif: Uint8Array | undefined): AppleMakerHdrTags | null {
  if (!exif || exif.length < 8) return null;
  const be = exif[0] === 0x4d && exif[1] === 0x4d; // 'MM' big-endian; 'II' little
  const u16 = (o: number) => (be ? (exif[o] << 8) | exif[o + 1] : exif[o] | (exif[o + 1] << 8));
  const i32 = (o: number) =>
    be
      ? (((exif[o] << 24) | (exif[o + 1] << 16) | (exif[o + 2] << 8) | exif[o + 3]) | 0)
      : ((exif[o] | (exif[o + 1] << 8) | (exif[o + 2] << 16) | (exif[o + 3] << 24)) | 0);
  const u32 = (o: number) => i32(o) >>> 0;

  // IFD0 → Exif sub-IFD (0x8769) → MakerNote (0x927C).
  const ifd0 = u32(4);
  const findTag = (ifdOffset: number, tag: number): { type: number; count: number; valueField: number } | null => {
    const entries = u16(ifdOffset);
    for (let k = 0; k < entries; k++) {
      const e = ifdOffset + 2 + k * 12;
      if (e + 12 > exif.length) return null;
      if (u16(e) === tag) {
        const type = u16(e + 2);
        const count = u32(e + 4);
        // Standard TIFF: values >4 bytes live at an ABSOLUTE TIFF offset kept
        // in the value field; small values sit inline in the field itself.
        const byteLen = (type === 3 ? 2 : type === 4 || type === 10 ? 4 : 1) * count;
        return { type, count, valueField: byteLen > 4 ? u32(e + 8) : e + 8 };
      }
    }
    return null;
  };
  if (ifd0 + 2 > exif.length) return null;
  const exifIfdPtr = findTag(ifd0, 0x8769);
  if (!exifIfdPtr) return null;
  // The Exif sub-IFD pointer is a LONG whose inline value IS the offset.
  const exifIfd = u32(exifIfdPtr.valueField);
  const makerPtr = findTag(exifIfd, 0x927c);
  if (!makerPtr) return null;

  // MakerNote is UNDEFINED-typed data: its value field (already dereferenced
  // by findTag for values >4 bytes) IS the absolute TIFF offset of the block.
  const makerStart = makerPtr.valueField;
  if (makerStart + 16 > exif.length) return null;
  // Signature: "Apple iOS\0\0\x01" + "MM" + u16 entry count.
  const sig = 'Apple iOS\0';
  for (let k = 0; k < sig.length; k++) {
    if (exif[makerStart + k] !== sig.charCodeAt(k)) return null;
  }
  if (exif[makerStart + 10] !== 0 || exif[makerStart + 11] !== 1) return null;
  if (exif[makerStart + 12] !== 0x4d || exif[makerStart + 13] !== 0x4d) return null;
  const entryCount = u16(makerStart + 14);

  const readRational = (entryOffset: number): number | null => {
    const type = u16(entryOffset + 2);
    const count = u32(entryOffset + 4);
    if (type !== 10 || count !== 1) return null;
    const valueOffset = makerStart + u32(entryOffset + 8);
    if (valueOffset + 8 > exif.length) return null;
    const num = i32(valueOffset);
    const den = u32(valueOffset + 4);
    if (den === 0) return null;
    return num / den;
  };

  let headroom: number | null = null;
  let gain: number | null = null;
  for (let k = 0; k < entryCount; k++) {
    const e = makerStart + 16 + k * 12;
    if (e + 12 > exif.length) break;
    const tag = u16(e);
    if (tag === 0x21) headroom = readRational(e);
    else if (tag === 0x30) gain = readRational(e);
    if (headroom !== null && gain !== null) break;
  }
  if (headroom === null || gain === null) return null;
  return { headroom, gain };
}

/**
 * Legacy v1 (HDRGainMapVersion 65536, iOS 16 and earlier) parameter fallback.
 * Those captures carry the tone-map intent ONLY in the Apple MakerNote, and
 * Apple's own documentation ("Applying Apple HDR effect to your photos",
 * developer.apple.com) defines the derivation verbatim:
 *
 *   if headroom < 1: stops = gain <= 0.01 ? -20·gain + 1.8 : -0.101·gain + 1.601
 *   else:            stops = gain <= 0.01 ? -70·gain + 3.0 : -0.303·gain + 2.303
 *   linearHeadroom = 2^max(stops, 0)
 *
 * ORACLE: the formula reproduces the authoritative parameters of the newer
 * carriers exactly — IMG_8028.HEIC (iOS 17) computes 4.76555 linear against
 * its XMP-reported 4.765632, and IMG_2589.HEIC (iOS 26) computes 2^1.974345 =
 * 3.92950 against its ISO tmap alternateHeadroom 1.974342. The v1 GAIN-MAP
 * PLANE is NOT log2 (it is Rec.709-OETF-encoded linear gain applied as
 * `hdr = sdr · (1 + (headroom−1) · g)`), so the caller must also re-map the
 * plane bytes into the log2 contract (see `appleV1SampleToLog2`); these
 * params describe the CONVERTED plane: min 0 (factor 1× at byte 0), max
 * log2(headroom), gamma 1. Returns null when the tags are unreadable or the
 * derived headroom does not exceed SDR white (a no-op map, fail-open).
 */
export function extractAppleV1ToneMapParams(exif: Uint8Array | undefined): HeicToneMapParams | null {
  const tags = parseAppleMakerHdrTags(exif);
  if (!tags) return null;
  const stops =
    tags.headroom < 1
      ? tags.gain <= 0.01
        ? -20 * tags.gain + 1.8
        : -0.101 * tags.gain + 1.601
      : tags.gain <= 0.01
        ? -70 * tags.gain + 3.0
        : -0.303 * tags.gain + 2.303;
  const headroomLinear = Math.pow(2, Math.max(stops, 0));
  if (!Number.isFinite(headroomLinear) || headroomLinear <= 1) return null;
  const alternateHeadroom = Math.log2(headroomLinear);
  return {
    baseHeadroom: 0,
    alternateHeadroom,
    gainMapMin: 0,
    gainMapMax: alternateHeadroom,
    gamma: 1,
    baseOffset: 0,
    alternateOffset: 0,
  };
}

/**
 * Convert ONE legacy v1 gain-map sample (Rec.709-OETF-encoded linear gain,
 * 0..255) into the log2-contract byte our runtime consumes. Apple applies v1
 * as `factor = 1 + (headroom−1) · g` with `g` the LINEARIZED map value — the
 * byte must first pass the Rec.709 inverse OETF (v ≤ 0.081 → v/4.5, else the
 * 1.099/0.099 power law), then the resulting factor lands in the log2 domain
 * shared with byte 255 = log2(headroom). Endpoints are exact: byte 0 → factor
 * 1 → log2 0, byte 255 → factor headroom → log2(headroom) (the full range).
 */
export function appleV1SampleToLog2(byte: number, headroomLinear: number): number {
  const v = byte / 255;
  const linear = v <= 0.081 ? v / 4.5 : Math.pow((v + 0.099) / 1.099, 1 / 0.45);
  const factor = 1 + (headroomLinear - 1) * linear;
  return Math.round((255 * Math.log2(factor)) / Math.log2(headroomLinear));
}

/** Shape returned by the heic worker's per-item decode. */
interface DecodedAuxItem {
  readonly rgba: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/** The auxC type string every current gain-map producer writes. */
const GAINMAP_AUX_TYPE = 'hdrgainmap';

/**
 * Extract the gain map into `metadata.raw.gainMap` — the INGEST-side half of
 * the contract (runs inside the decode handler's converting phase): container
 * parse → tone-map parameters → per-item worker decode → resolution cap →
 * compact JPEG re-encode → base64. Fail-open: any failure leaves
 * `raw.gainMap` unset (the presentation treats that as "no gain map").
 *
 * Reads its OWN copy of the file bytes — the decode handler's buffer may
 * already have been transferred to the worker by an earlier call.
 */
export async function extractHeicGainMapInto(file: File, metadata: ImageMetadata): Promise<void> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    // Parse BEFORE the worker call: `heicWorkerCall` transfers the buffer, but
    // the extracted view payloads are standalone copies and stay valid.
    const view = parseHeicContainer(bytes, { extractPayload: true });
    const aux = view.auxImages.find((a) => a.auxType.includes(GAINMAP_AUX_TYPE));
    if (!aux) return;
    // Parameter carriers by capture generation, most authoritative first:
    // ISO 21496-1 tmap (iOS 18+) → Apple v2 XMP headroom (iOS 17) → Apple v1
    // MakerNote derivation (iOS 16 and earlier).
    const isoParams = extractHeicToneMapParams(view.idatPayload);
    const xmpParams = isoParams ? null : extractAppleLegacyToneMapParams(view.metadata.xmp);
    const v1Params = isoParams || xmpParams
      ? null
      : extractAppleV1ToneMapParams(view.metadata.exif);
    const params = isoParams ?? xmpParams ?? v1Params;
    if (!params) return;

    const out = await heicWorkerCall<DecodedAuxItem>('decodeItem', [bytes, aux.itemId], [
      bytes.buffer as ArrayBuffer,
    ]);
    const px = out.width * out.height;
    if (!out.rgba || out.rgba.length < px * 4) return;

    // The map is luminance-axis metadata: the worker's interleaved RGBA
    // replicates gray across RGB, so the R plane is the single authoritative
    // channel. Legacy v1 planes are Rec.709-OETF-encoded LINEAR gain — re-map
    // each byte into the log2 contract BEFORE downsampling so the box filter
    // keeps averaging in the applied (log2) domain like every other carrier.
    const plane = new Uint8Array(px);
    if (v1Params) {
      const headroomLinear = Math.pow(2, v1Params.alternateHeadroom);
      for (let i = 0; i < px; i++) plane[i] = appleV1SampleToLog2(out.rgba[i * 4], headroomLinear);
    } else {
      for (let i = 0; i < px; i++) plane[i] = out.rgba[i * 4];
    }
    const capped = downscaleGainMap({
      map: plane,
      width: out.width,
      height: out.height,
      gainMin: params.gainMapMin,
      gainMax: params.gainMapMax,
      gamma: params.gamma,
    });

    // Gray-replicated RGBA → canvas → compact JPEG (a smooth low-frequency
    // field at q≈0.95: ±1/255 codec noise is far below the 8-bit precision the
    // format already carries).
    const canvas = new OffscreenCanvas(capped.width, capped.height);
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(capped.width, capped.height);
    for (let i = 0; i < capped.map.length; i++) {
      img.data[i * 4] = capped.map[i];
      img.data[i * 4 + 1] = capped.map[i];
      img.data[i * 4 + 2] = capped.map[i];
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 });

    // `blobToBase64` returns a DATA URL (its piexif-oriented contract); the
    // `raw.gainMap.data` convention is PURE base64 (the runtime atob-decodes
    // it), so strip the `data:…;base64,` prefix.
    const dataUrl = await blobToBase64(blob);
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);

    metadata.raw.gainMap = {
      mime: 'image/jpeg',
      data: base64,
      width: capped.width,
      height: capped.height,
      gainMin: capped.gainMin,
      gainMax: capped.gainMax,
      gamma: capped.gamma,
      oriented: true, // libheif already applied the aux item's irot/imir at decode
    };
  } catch (err) {
    console.warn('[heic gainmap] extraction failed; presenting without HDR gain', err);
  }
}
