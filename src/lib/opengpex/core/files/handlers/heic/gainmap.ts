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
import { downscaleGainMap } from '@opengpex/editor/core/engine/color/gainMap';
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
    const params = extractHeicToneMapParams(view.idatPayload);
    if (!params) return;

    const out = await heicWorkerCall<DecodedAuxItem>('decodeItem', [bytes, aux.itemId], [
      bytes.buffer as ArrayBuffer,
    ]);
    const px = out.width * out.height;
    if (!out.rgba || out.rgba.length < px * 4) return;

    // The map is luminance-axis metadata: the worker's interleaved RGBA
    // replicates gray across RGB, so the R plane is the single authoritative
    // channel. Cap at the subsystem resolution contract before re-encode.
    const plane = new Uint8Array(px);
    for (let i = 0; i < px; i++) plane[i] = out.rgba[i * 4];
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
