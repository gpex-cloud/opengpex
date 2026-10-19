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
 * ZIP (compression id 3) packs 16 scanlines per chunk: the chunk payload is
 * the 16 planar scanlines concatenated (same layout as 16 uncompressed
 * blocks), then transformed exactly the way OpenEXR's ImfZip does —
 *   1. BYTE SHUFFLE: even-indexed bytes of the chunk move to the first half,
 *      odd-indexed bytes to the second half (little-endian half floats have
 *      their HIGH bytes on odd indices; grouping them yields long runs of
 *      similar values for deflate to eat);
 *   2. DIFFERENTIAL PREDICTOR over the WHOLE shuffled chunk (no scanline
 *      boundaries): out[0] = in[0]; out[i] = (in[i] - in[i-1] + 128) & 255;
 *   3. zlib deflate (RFC 1950 — `CompressionStream('deflate')`, NOT
 *      'deflate-raw') of the whole transformed buffer.
 * The chunk header records the COMPRESSED byte size. Skipping the shuffle or
 * the +128 bias produces files the reference OpenEXR library decodes as
 * garbage — pinned by the exr2aces/Python-OpenEXR toolchain probe.
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

/** Compression attribute values this writer emits. */
export type ExrCompression = 'none' | 'zip';

const EXR_COMPRESSION_ID: Record<ExrCompression, number> = {
  none: 0, // NO_COMPRESSION
  zip: 3,  // ZIP — ZIP per chunk of 16 scanlines, per-scanline predictor + zlib
};

/** Scanlines packed into one ZIP chunk (the OpenEXR ZIP constant). */
export const ZIP_SCANLINES_PER_CHUNK = 16;

/**
 * Build the header (magic, version, attributes, terminating null) shared by
 * every compression lane.
 */
function buildExrHeader(width: number, height: number, gamut?: string, compression: ExrCompression = 'none'): Uint8Array {
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
    { name: 'compression', type: 'compression', payload: [EXR_COMPRESSION_ID[compression]] },
    { name: 'dataWindow', type: 'box2i', payload: dataWindow },
    { name: 'displayWindow', type: 'box2i', payload: dataWindow },
    { name: 'lineOrder', type: 'lineOrder', payload: [0] }, // INCREASING_Y
    { name: 'pixelAspectRatio', type: 'float', payload: leF32(1) },
    { name: 'screenWindowCenter', type: 'v2f', payload: [...leF32(0), ...leF32(0)] },
    { name: 'screenWindowWidth', type: 'float', payload: leF32(1) },
    { name: 'chromaticities', type: 'chromaticities', payload: chromaPayload },
  ];

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

  return new Uint8Array(bytes);
}

/**
 * Write one scanline in the spec layout — PLANAR per channel, alphabetical
 * order: the whole A row first (source RGBA position 3), then B (2), G (1),
 * R (0) — into `dst` at `dstOffset` (needs `width * 8` bytes).
 */
function writeScanlinePlanar(
  dst: Uint8Array,
  dv: DataView,
  dstOffset: number,
  halfBits: Uint16Array,
  width: number,
  y: number,
): void {
  const src = y * width * 4;
  let h = dstOffset;
  for (let x = 0; x < width; x++) dv.setUint16(h + x * 2, halfBits[src + x * 4 + 3], true); // A row
  h += width * 2;
  for (let x = 0; x < width; x++) dv.setUint16(h + x * 2, halfBits[src + x * 4 + 2], true); // B row
  h += width * 2;
  for (let x = 0; x < width; x++) dv.setUint16(h + x * 2, halfBits[src + x * 4 + 1], true); // G row
  h += width * 2;
  for (let x = 0; x < width; x++) dv.setUint16(h + x * 2, halfBits[src + x * 4 + 0], true); // R row
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

  const bytes = buildExrHeader(width, height, gamut, 'none');

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

  for (let y = 0; y < height; y++) {
    const h = pixelStart + y * (blockHeaderSize + scanlineBytes);
    dv.setInt32(h, y, true);
    dv.setUint32(h + 4, scanlineBytes, true);
    writeScanlinePlanar(out, dv, h + 8, halfBits, width, y);
  }

  return out;
}

/**
 * Deflate `data` into a zlib (RFC 1950) stream — the wrapper EXR requires for
 * its compressed chunks ('deflate', not 'deflate-raw').
 */
async function deflateZlib(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const pipe = new CompressionStream('deflate');
  const writer = pipe.writable.getWriter();
  void writer.write(data);
  void writer.close();
  const chunks: Uint8Array[] = [];
  const reader = pipe.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/**
 * The OpenEXR ImfZip transform over one chunk's raw scanline bytes: even/odd
 * byte split, then a +128-biased first-difference predictor across the whole
 * shuffled buffer. Operates on a copy; returns the transformed bytes ready
 * for zlib.
 */
function zipTransform(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const n = raw.length;
  const shuffled = new Uint8Array(n);
  const half = (n + 1) >> 1;
  for (let even = 0, odd = half, i = 0; i < n; i++) {
    if ((i & 1) === 0) shuffled[even++] = raw[i];
    else shuffled[odd++] = raw[i];
  }
  let prev = shuffled[0];
  for (let i = 1; i < n; i++) {
    const cur = shuffled[i];
    shuffled[i] = (cur - prev + 128) & 255;
    prev = cur;
  }
  return shuffled;
}

/**
 * Wrap half-float RGBA bit patterns into a ZIP-compressed OpenEXR scanline
 * file: 16 scanlines per chunk, per-scanline difference predictor, then zlib.
 * Pixel semantics are identical to `encodeExrHalf` — only the container
 * packing differs (readers decompress to the exact same half-float rows).
 */
export async function encodeExrHalfZip(
  halfBits: Uint16Array,
  width: number,
  height: number,
  gamut?: string,
): Promise<Uint8Array> {
  if (halfBits.length !== width * height * 4) {
    throw new Error(
      `[encodeExr] buffer mismatch: got ${halfBits.length}, need ${width * height * 4}`,
    );
  }

  const bytes = buildExrHeader(width, height, gamut, 'zip');
  const headerLen = bytes.length;
  const scanlineBytes = width * 8;              // 4 channels × half (2 bytes)
  const chunkCount = Math.ceil(height / ZIP_SCANLINES_PER_CHUNK);
  const pixelStart = headerLen + chunkCount * 8; // offset table: one u64 per CHUNK

  // Compress every chunk first (compressed sizes are needed for the layout).
  const raw = new Uint8Array(ZIP_SCANLINES_PER_CHUNK * scanlineBytes);
  const rawDv = new DataView(raw.buffer);
  const chunks: Uint8Array[] = [];
  for (let c = 0; c < chunkCount; c++) {
    const firstLine = c * ZIP_SCANLINES_PER_CHUNK;
    const lines = Math.min(ZIP_SCANLINES_PER_CHUNK, height - firstLine);
    for (let l = 0; l < lines; l++) {
      writeScanlinePlanar(raw, rawDv, l * scanlineBytes, halfBits, width, firstLine + l);
    }
    const chunkRaw = raw.subarray(0, lines * scanlineBytes);
    chunks.push(await deflateZlib(zipTransform(chunkRaw)));
  }

  const totalSize =
    pixelStart +
    chunks.reduce((n, c) => n + 8 + c.length, 0); // per chunk: y:i32 + dataSize:i32 + payload
  const out = new Uint8Array(totalSize);
  out.set(bytes, 0);
  const dv = new DataView(out.buffer);

  // Offset table: absolute file offset of each chunk.
  let offset = pixelStart;
  for (let c = 0; c < chunkCount; c++) {
    dv.setBigUint64(headerLen + c * 8, BigInt(offset), true);
    offset += 8 + chunks[c].length;
  }

  // Chunk bodies: [firstLineY:i32][compressedSize:i32][deflated predictor bytes].
  offset = pixelStart;
  for (let c = 0; c < chunkCount; c++) {
    dv.setInt32(offset, c * ZIP_SCANLINES_PER_CHUNK, true);
    dv.setUint32(offset + 4, chunks[c].length, true);
    out.set(chunks[c], offset + 8);
    offset += 8 + chunks[c].length;
  }

  return out;
}
