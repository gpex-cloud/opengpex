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
 * gain-map.ts — the files-layer SHARED gain-map support, one module for the
 * carrier contract's two halves:
 *
 *   1. INGEST — `liftBaseToF16`: the master-image lift every gain-map carrier
 *      runs while ingesting (HEIC `19-gm*`, JPEG `1-gm`).
 *   2. RUNTIME — `decodeGainMapData`: the metadata-carried coded image
 *      (`raw.gainMap`, extracted by the carrier handlers at ingest) decoded
 *      to the single-channel plane the presentation cache and the export lane
 *      consume.
 *
 * Both halves exist because a gain-map file ships TWO renditions and the
 * engine renders BOTH from ONE resident line — see `liftBaseToF16`'s doc for
 * why the master must never carry the baked gain, and `decodeGainMapData`'s
 * for how the plane reaches the view pass without touching the source blob.
 * Per-carrier knowledge (MPF/XMP byte surgery, worker aux decode, re-encode)
 * lives in each carrier handler's own gainmap module; this module is the
 * carrier-agnostic remainder both handlers share.
 *
 * @module core/files/shared/gain-map
 */

import type { DecodedPayload } from '../types';
import { srgbToLinear, linearFloatToFloat16 } from '@opengpex/editor/core/engine/color';

/**
 * sRGB-TRC-encoded RGBA-8 → straight linear f16 RGBA. Output geometry is the
 * input geometry; alpha passes through normalized (coverage is never
 * transfer-encoded).
 */
export function liftBaseToF16(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): DecodedPayload['highDepthSource'] {
  const linear = new Float32Array(width * height * 4);
  for (let i = 0; i < linear.length; i += 4) {
    linear[i] = srgbToLinear(rgba[i] / 255);
    linear[i + 1] = srgbToLinear(rgba[i + 1] / 255);
    linear[i + 2] = srgbToLinear(rgba[i + 2] / 255);
    linear[i + 3] = rgba[i + 3] / 255;
  }
  return { data: linearFloatToFloat16(linear), width, height };
}

// ─── RUNTIME: the metadata-carried plane decode ───

import type { GainMapData, ImageMetadata } from '../types';
import { EXIF_ORIENTATION_MAP } from './orientation';

/** Base64 → bytes (the inverse of the `raw.icc`/`raw.exif` convention — PURE
 * base64, never a data URL: a data-URL string fails `atob` and the caller
 * would negative-cache a perfectly good map). */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Decode one file's gain map from its metadata into the carrier-agnostic
 * {@link GainMapData}. Returns null when the metadata carries no gain map or
 * any decode step fails — the caller negative-caches and presents the
 * authoritative SDR base.
 */
export async function decodeGainMapData(metadata: ImageMetadata | undefined): Promise<GainMapData | null> {
  const gm = metadata?.raw?.gainMap;
  if (!gm || !gm.data) return null;

  const bytes = base64ToBytes(gm.data);
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: gm.mime });
  const bitmap = await createImageBitmap(blob, {
    colorSpaceConversion: 'none',
    imageOrientation: 'none',
  });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const raster = ctx.getImageData(0, 0, bitmap.width, bitmap.height);

    // EXIF orientation alignment — ONLY for planes still in FILE space
    // (`oriented` absent: the JPEG carrier's verbatim gain JPEG). The HEIC
    // carrier stores a display-space plane (libheif applies the aux item's
    // irot/imir at decode) and must NOT be rotated again — a second rotation
    // transposes the gain field against the master (ghosted HDR).
    const orientation = metadata.capture?.orientation ?? 1;
    const entry = gm.oriented ? undefined : EXIF_ORIENTATION_MAP[orientation];
    let rgba = raster.data;
    let width = bitmap.width;
    let height = bitmap.height;
    if (entry && orientation !== 1) {
      const { swapDims, dest } = entry;
      width = swapDims ? bitmap.height : bitmap.width;
      height = swapDims ? bitmap.width : bitmap.height;
      const out = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < bitmap.height; y++) {
        for (let x = 0; x < bitmap.width; x++) {
          const [dx, dy] = dest(x, y, bitmap.width, bitmap.height);
          const s = (y * bitmap.width + x) * 4;
          const d = (dy * width + dx) * 4;
          out[d] = raster.data[s];
          out[d + 1] = raster.data[s + 1];
          out[d + 2] = raster.data[s + 2];
          out[d + 3] = raster.data[s + 3];
        }
      }
      rgba = out;
    }

    const px = width * height;
    const map = new Uint8Array(px);
    for (let i = 0; i < px; i++) {
      map[i] = Math.round(0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]);
    }

    return {
      map,
      width,
      height,
      gainMin: gm.gainMin,
      gainMax: gm.gainMax,
      gamma: gm.gamma,
    };
  } finally {
    bitmap.close();
  }
}
