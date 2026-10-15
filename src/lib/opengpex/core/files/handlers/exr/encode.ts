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
 * encode.ts — OpenEXR scanline writer (half-float RGBA, linear light).
 *
 * The HDR scene-referred export container: IEEE binary16 per channel, NO
 * transfer function, NO [0,1] clamp — the unbounded linear values survive
 * verbatim (the whole point of the container). Primaries travel in the
 * standard `chromaticities` header attribute (CIE 1931 xy) so any EXR reader
 * can colour-manage the pixels; the default is the WORKING gamut (ProPhoto
 * RGB, D50 white).
 *
 * FORMAT FACTS (spec: "The Structure of an OpenEXR File"; the probe's
 * original pit-② note claimed per-pixel interleaving — that was WRONG, and the
 * self-written reader that "validated" it merely mirrored the same assumption.
 * The honest tell was ffmpeg decoding our interleaved file as garbled values:
 * ffmpeg was FOLLOWING the spec. Device-external truth, not self-parse):
 *   • chlist entry = name\0 + pixelType(i32) + pLinear(u8) + 3 pad bytes
 *     (the pLinear field is FOUR bytes with its padding, not one) +
 *     xSampling(i32) + ySampling(i32);
 *   • channels are listed alphabetically (A, B, G, R) — and WITHIN A SCANLINE
 *     BLOCK each channel's pixels are stored PLANAR/CONTIGUOUS in that same
 *     order: the whole A row (width×2 bytes), then the whole B row, then G,
 *     then R — NOT per-pixel interleaved;
 *   • pixelType HALF = 1 (not the "intuitive" 3 = UINT).
 *   • Compression NONE stores one scanline per block: [y:i32][size:i32][data].
 *
 * The production deflate lane (EXR ZIP compression, id 3) additionally
 * requires the per-scanline difference predictor before zlib — it is NOT a
 * bare `CompressionStream('deflate')` of the pixel bytes and is deliberately
 * NOT implemented here (the MVP ships uncompressed; a ZIP lane must be
 * probe-validated against the OpenEXR toolchain first).
 */

/** CIE 1931 xy primaries per exportable gamut (the `chromaticities` attribute). */
const GAMUT_CHROMATICITIES: Record<string, readonly number[]> = {
  // Order: redX redY greenX greenY blueX blueY whiteX whiteY.
  srgb: [0.64, 0.33, 0.3, 0.6, 0.15, 0.06, 0.3127, 0.329],
  'display-p3': [0.68, 0.32, 0.265, 0.69, 0.15, 0.06, 0.3127, 0.329],
  'adobe-rgb': [0.64, 0.33, 0.21, 0.71, 0.15, 0.06, 0.3127, 0.329],
  // Working gamut (ProPhoto RGB, D50) — the readback's native space and the
  // default (the egest solver lands WORKING_GAMUT for wide intents).
  'prophoto-rgb': [0.7347, 0.2653, 0.1596, 0.8404, 0.0366, 0.0001, 0.3457, 0.3585],
};

/** Resolve the chromaticities for a target gamut (unknown → working gamut). */
export function chromaticitiesForGamut(gamut?: string): readonly number[] {
  return GAMUT_CHROMATICITIES[gamut ?? ''] ?? GAMUT_CHROMATICITIES['prophoto-rgb'];
}

/** ASCII bytes of a null-terminated name (EXR header string form). */
function writeName(bytes: number[], s: string): void {
  for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i));
  bytes.push(0);
}

/** int32/float32 payload as little-endian bytes. */
function leBytes(v: number, setter: (dv: DataView, o: number, x: number) => void): number[] {
  const buf = new ArrayBuffer(4);
  setter(new DataView(buf), 0, v);
  return [...new Uint8Array(buf)];
}
const leI32 = (v: number) => leBytes(v, (dv, o, x) => dv.setInt32(o, x, true));
const leF32 = (v: number) => leBytes(v, (dv, o, x) => dv.setFloat32(o, x, true));

interface ExrAttribute {
  readonly name: string;
  readonly type: string;
  readonly payload: readonly number[];
}

/**
 * Wrap half-float RGBA bit patterns (from `unpremultiplyEncodeLinearF16`) into
 * an uncompressed OpenEXR scanline file.
 *
 * @param halfBits - interleaved RGBA half-float BIT PATTERNS (Uint16Array),
 *                   length = width*height*4, straight (un-premultiplied)
 *                   LINEAR light; RGB unclamped, alpha ≤ 1.
 * @param width / height - pixel dimensions
 * @param gamut - gamut tag for the `chromaticities` attribute (the pixels'
 *                true primaries — the tag must never contradict them).
 */
export function encodeExrHalf(
  halfBits: Uint16Array,
  width: number,
  height: number,
  gamut?: string,
): Uint8Array {
  if (halfBits.length !== width * height * 4) {
    throw new Error(
      `[encodeExr] buffer mismatch: got ${halfBits.length}, need ${width * height * 4}`,
    );
  }

  // ── Header attributes (order matters only for readability; offsets are computed) ──
  const channelsPayload: number[] = [];
  // Alphabetical order is a hard OpenEXR requirement.
  for (const name of ['A', 'B', 'G', 'R']) {
    writeName(channelsPayload, name);
    channelsPayload.push(...leI32(1)); // pixelType HALF = 1
    channelsPayload.push(0, 0, 0, 0);  // pLinear(u8) + 3 reserved bytes
    channelsPayload.push(...leI32(1)); // xSampling = 1
    channelsPayload.push(...leI32(1)); // ySampling = 1
  }
  channelsPayload.push(0); // null byte terminating the chlist

  const dataWindow: number[] = [...leI32(0), ...leI32(0), ...leI32(width - 1), ...leI32(height - 1)];

  const chroma = chromaticitiesForGamut(gamut);
  const chromaPayload: number[] = [];
  for (const v of chroma) chromaPayload.push(...leF32(v));

  const attributes: readonly ExrAttribute[] = [
    { name: 'channels', type: 'chlist', payload: channelsPayload },
    { name: 'compression', type: 'compression', payload: [0] }, // NO_COMPRESSION
    { name: 'dataWindow', type: 'box2i', payload: dataWindow },
    { name: 'displayWindow', type: 'box2i', payload: dataWindow },
    { name: 'lineOrder', type: 'lineOrder', payload: [0] }, // INCREASING_Y
    { name: 'pixelAspectRatio', type: 'float', payload: leF32(1) },
    { name: 'screenWindowCenter', type: 'v2f', payload: [...leF32(0), ...leF32(0)] },
    { name: 'screenWindowWidth', type: 'float', payload: leF32(1) },
    { name: 'chromaticities', type: 'chromaticities', payload: chromaPayload },
  ];

  // ── Header ──
  const bytes: number[] = [];
  bytes.push(0x76, 0x2f, 0x31, 0x01); // magic
  bytes.push(2, 0, 0, 0);             // version 2: scanline, single part
  for (const attr of attributes) {
    writeName(bytes, attr.name);
    writeName(bytes, attr.type);
    const len = attr.payload.length;
    bytes.push(len & 255, (len >> 8) & 255, (len >> 16) & 255, (len >>> 24) & 255);
    for (const b of attr.payload) bytes.push(b);
  }
  bytes.push(0); // end-of-attributes null

  const headerLen = bytes.length;
  const scanlineBytes = width * 8; // 4 channels × half (2 bytes)
  const blockHeaderSize = 8;       // y:i32 + dataSize:i32
  const pixelStart = headerLen + height * 8; // offset table: one u64 per scanline
  const totalSize = pixelStart + height * (blockHeaderSize + scanlineBytes);

  const out = new Uint8Array(totalSize);
  out.set(bytes, 0);
  const dv = new DataView(out.buffer);

  // Offset table: absolute file offset of each scanline block.
  for (let y = 0; y < height; y++) {
    dv.setBigUint64(
      headerLen + y * 8,
      BigInt(pixelStart + y * (blockHeaderSize + scanlineBytes)),
      true,
    );
  }

  // Scanline blocks: PLANAR per channel, alphabetical order (see the format
  // facts above) — the whole A row first (source RGBA position 3), then the
  // whole B row (2), then G (1), then R (0).
  const rowBytes = width * 2;
  for (let y = 0; y < height; y++) {
    let h = pixelStart + y * (blockHeaderSize + scanlineBytes);
    dv.setInt32(h, y, true);
    dv.setUint32(h + 4, scanlineBytes, true);
    h += 8;
    const src = y * width * 4;
    for (let x = 0; x < width; x++) {
      dv.setUint16(h + x * 2, halfBits[src + x * 4 + 3], true); // A row
    }
    h += rowBytes;
    for (let x = 0; x < width; x++) {
      dv.setUint16(h + x * 2, halfBits[src + x * 4 + 2], true); // B row
    }
    h += rowBytes;
    for (let x = 0; x < width; x++) {
      dv.setUint16(h + x * 2, halfBits[src + x * 4 + 1], true); // G row
    }
    h += rowBytes;
    for (let x = 0; x < width; x++) {
      dv.setUint16(h + x * 2, halfBits[src + x * 4 + 0], true); // R row
    }
  }

  return out;
}
