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
 * ultrahdr.ts — UltraHDR (ISO 21496-1 gain map) JPEG assembler.
 *
 * Takes the finished SDR base JPEG and the finished gain-map JPEG and ASSEMBLES
 * the multi-picture container around them, writing every metadata segment the
 * ecosystem recognizes (each one is load-bearing — a file missing any of the
 * first two ingests as a plain JPEG):
 *
 *   1. PRIMARY XMP (APP1) in the Google GContainer form: `hdrgm:Version` plus
 *      a `Container:Directory` naming the Primary and GainMap items with the
 *      gain map's byte length. THIS is the detection key every mainstream
 *      consumer agrees on — a primary XMP carrying bare `hdrgm:*` numbers
 *      without the directory is recognized by none (byte-compared against a
 *      gainmaps.com-produced file that viewers do light up).
 *   2. ISO 21496-1 APP2 segments — the version-only header in the primary and
 *      the full 61-byte rational record in the gain image (the libultrahdr
 *      placement), for Android-class readers. All fields big-endian, all
 *      denominators 1e6, flags 0 (single channel, base-color-space
 *      application), headroom values mirroring the XMP.
 *   3. MPF APP2 (CIPA DC-007) multi-picture directory: entry 0 = the primary
 *      (attributes 0x030000, size = the primary's full extent IN THE
 *      CONTAINER — a strict reader decoding via entry 0 must see the inserted
 *      header segments and the entropy tail), entry 1 = the gain map.
 *   4. GAIN IMAGE self-describing XMP (APP1): the full `hdrgm:*` record
 *      (GainMapMin/Max/Gamma/OffsetSDR/OffsetHDR/HDRCapacity fields and
 *      BaseRenditionIsHDR) inside the gain JPEG itself — the primary never
 *      carries numbers, and a gain image without its own XMP makes the whole
 *      file unrecognizable.
 *
 * STRUCTURE FACTS (probe-validated against a gainmaps.com production file and
 * the libultrahdr writer; the pitfalls are load-bearing below):
 *   - an MP Entry is 16 bytes (attribute u32, size u32, offset u32, and the
 *     two dependent-image u16 fields in the last u32);
 *   - MPF offsets are measured from the MP Endian field — the TIFF header
 *     start, 8 bytes into the APP2 payload ("MPF\0" + endian) — NOT from the
 *     segment marker;
 *   - the gain map physically sits AFTER the primary's EOI (the entropy-coded
 *     scan must directly follow its SOS; a secondary image can never sit
 *     inside it);
 *   - the assembled file must IDEMPOTENTLY re-assemble: a base that already
 *     carries UltraHDR segments (a prior export re-exported) has its XMP APP1,
 *     MPF APP2 and ISO APP2 STRIPPED during the header copy (EXIF/ICC/JFIF
 *     preserved) and the geometry computed from the stripped run — otherwise a
 *     second assembly stacks a second directory and the file stops parsing.
 */

/** APP1 payload prefix that tags an XMP segment. */
const XMP_PREFIX = 'http://ns.adobe.com/xap/1.0/\0';

/** APP2 payload prefix that tags the multi-picture directory. */
const MPF_PREFIX = 'MPF\0';

/** APP2 payload prefix that tags an ISO 21496-1 gain-map metadata segment
 * (libultrahdr's `kIsoNameSpace`, null-terminated on the wire). */
export const ISO_IDENTIFIER = 'urn:iso:std:iso:ts:21496:-1\0';

/** The fixed common denominator of every rational in the ISO record. */
const ISO_DENOMINATOR = 1_000_000;

export interface UltraHdrAssembleOptions {
  /** Finished SDR base JPEG (bytes including its own SOI). */
  readonly baseJpeg: Uint8Array;
  /** Finished gain-map JPEG (same aspect; bytes including SOI). */
  readonly gainMapJpeg: Uint8Array;
  /** Minimum of the gain map's value range (log2 ratio space). */
  readonly gainMapMin: number;
  /** Maximum of the gain map's value range (log2 ratio space). */
  readonly gainMapMax: number;
  /** Gain map payload gamma (1 — the payload stores log2-linear values). */
  readonly gainMapGamma: number;
}

/**
 * Materialize a quantized single-channel gain map as an sRGB canvas encode
 * source for the JPEG handler: the map byte replicated across RGB, alpha 255.
 * Real-world gain JPEGs store three identical channels (the ecosystem's
 * convention), and the reader samples the R plane — a replicated encode is
 * both spec-shaped and lossless-in-information. The caller JPEG-encodes the
 * returned canvas at high quality (a gain map is a smooth low-frequency
 * gradient; codec noise is far below the 8-bit quantization the format
 * already carries).
 */
export function buildGainMapEncodeSource(
  gainMap: { readonly map: Uint8Array; readonly width: number; readonly height: number },
): OffscreenCanvas {
  const canvas = new OffscreenCanvas(gainMap.width, gainMap.height);
  const ctx = canvas.getContext('2d')!;
  const imgData = ctx.createImageData(gainMap.width, gainMap.height);
  const px = gainMap.map.length;
  for (let i = 0; i < px; i++) {
    const v = gainMap.map[i];
    imgData.data[i * 4] = v;
    imgData.data[i * 4 + 1] = v;
    imgData.data[i * 4 + 2] = v;
    imgData.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

// ─── XMP builders ──────────────────────────────────────────────────────────────

const XMP_WRAPPER = (body: string): string =>
  `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
  body +
  `</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

/** The primary's GContainer XMP — the detection key. `gainLength` is the
 * assembled gain image's byte length (Item:Length). */
export function buildPrimaryGContainerXmp(gainLength: number): string {
  return XMP_WRAPPER(
    `<rdf:Description rdf:about=""` +
      ` xmlns:Container="http://ns.google.com/photos/1.0/container/"` +
      ` xmlns:Item="http://ns.google.com/photos/1.0/container/item/"` +
      ` xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/"` +
      ` hdrgm:Version="1.0">` +
      `<Container:Directory><rdf:Seq>` +
      `<rdf:li rdf:parseType="Resource">` +
      `<Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/>` +
      `</rdf:li>` +
      `<rdf:li rdf:parseType="Resource">` +
      `<Container:Item Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="${gainLength}"/>` +
      `</rdf:li>` +
      `</rdf:Seq></Container:Directory>` +
      `</rdf:Description>`,
  );
}

/** The gain image's self-describing hdrgm record — the authoritative parameter
 * store for this carrier. Offsets are 0: our pipeline (and the exported
 * statement) is the offsetless hdr = sdr·2^gain form. */
export function buildGainMapXmp(min: number, max: number, gamma: number): string {
  return XMP_WRAPPER(
    `<rdf:Description rdf:about=""` +
      ` xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/"` +
      ` hdrgm:Version="1.0"` +
      ` hdrgm:GainMapMin="${min}"` +
      ` hdrgm:GainMapMax="${max}"` +
      ` hdrgm:Gamma="${gamma}"` +
      ` hdrgm:OffsetSDR="0"` +
      ` hdrgm:OffsetHDR="0"` +
      ` hdrgm:HDRCapacityMin="0"` +
      ` hdrgm:HDRCapacityMax="${max}"` +
      ` hdrgm:BaseRenditionIsHDR="False"/>`,
  );
}

// ─── APP segment framing ───────────────────────────────────────────────────────

function buildAppSegment(marker: number, payload: Uint8Array): Uint8Array {
  // APP segment length counts its own 2 length bytes.
  const segLen = 2 + payload.length;
  if (segLen > 0xffff) throw new Error('[ultrahdr] APP segment exceeds 64KiB');
  const out = new Uint8Array(2 + segLen);
  out[0] = 0xff;
  out[1] = marker;
  out[2] = (segLen >> 8) & 255;
  out[3] = segLen & 255;
  out.set(payload, 4);
  return out;
}

function textPayload(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function xmpApp1(xmp: string): Uint8Array {
  const prefix = new TextEncoder().encode(XMP_PREFIX);
  const payload = new Uint8Array(prefix.length + textPayload(xmp).length);
  payload.set(prefix, 0);
  payload.set(textPayload(xmp), prefix.length);
  return buildAppSegment(0xe1, payload);
}

// ─── ISO 21496-1 metadata ──────────────────────────────────────────────────────

function isoIdentifierPayload(): Uint8Array {
  return textPayload(ISO_IDENTIFIER);
}

/**
 * The full 61-byte ISO 21496-1 gain-map metadata record (the libultrahdr
 * `encodeGainmapMetadata` statement): u16 minimum_version + u16 writer_version
 * + u8 flags + base/alternate headroom rationals + five single-channel
 * rational fields (min/max/gamma/base_offset/alternate_offset), all
 * big-endian, all denominators 1e6, flags 0 (single channel).
 */
export function buildIsoGainmapMetadata(
  min: number,
  max: number,
  gamma: number,
): Uint8Array {
  const out = new Uint8Array(61);
  const dv = new DataView(out.buffer);
  let o = 0;
  dv.setUint16(o, 0); o += 2; // minimum_version
  dv.setUint16(o, 0); o += 2; // writer_version
  out[o++] = 0; // flags: single channel, no base-color-space bit
  const rat = (v: number): number => Math.round(v * ISO_DENOMINATOR);
  const s32 = (v: number): void => {
    dv.setInt32(o, v); o += 4;
  };
  const u32 = (v: number): void => {
    dv.setUint32(o, v); o += 4;
  };
  u32(rat(0)); u32(ISO_DENOMINATOR); // base_hdr_headroom = 0 (SDR base)
  u32(rat(max)); u32(ISO_DENOMINATOR); // alternate_hdr_headroom = gain max
  s32(rat(min)); u32(ISO_DENOMINATOR); // gain_map_min (may be negative)
  s32(rat(max)); u32(ISO_DENOMINATOR); // gain_map_max
  u32(rat(gamma)); u32(ISO_DENOMINATOR); // gain_map_gamma
  s32(0); u32(ISO_DENOMINATOR); // base_offset
  s32(0); u32(ISO_DENOMINATOR); // alternate_offset
  return out;
}

function isoApp2(metadata: Uint8Array | null): Uint8Array {
  // Payload = identifier + (the metadata record | the 4 version-only bytes).
  const id = isoIdentifierPayload();
  const body = metadata ?? new Uint8Array(4); // version-only: 2×u16 zeroes
  const payload = new Uint8Array(id.length + body.length);
  payload.set(id, 0);
  payload.set(body, id.length);
  return buildAppSegment(0xe2, payload);
}

// ─── MPF multi-picture directory ───────────────────────────────────────────────

/** Total byte length of the MPF APP2 segment (marker + length + payload). */
export function mpfSegmentLength(): number {
  // Fixed-size directory: 4 ("MPF\0") + 8 (TIFF header) + 2 (entry count)
  // + 3×12 (Version / NumImages / MPEntry tag headers) + 4 (next-IFD 0)
  // + 32 (2 MP entries) = 86; + 4 (marker+len) = 90.
  return 90;
}

function buildMpfApp2(primarySize: number, gainSize: number, gainOffset: number): Uint8Array {
  const payloadLen = 86; // see mpfSegmentLength
  const out = new Uint8Array(4 + payloadLen);
  const dv = new DataView(out.buffer);
  out[0] = 0xff;
  out[1] = 0xe2; // APP2
  out[2] = ((2 + payloadLen) >> 8) & 255;
  out[3] = (2 + payloadLen) & 255;

  let o = 4;
  out[o++] = 0x4d; out[o++] = 0x50; out[o++] = 0x46; out[o++] = 0x00; // "MPF\0"
  // TIFF header (big-endian "MM"): byte-order u16, magic 42 u16, IFD offset u32.
  // The offsets are relative to the MP Endian field (== the TIFF header start).
  const tiffStart = o;
  dv.setUint16(o, 0x4d4d, false); o += 2;       // "MM" big-endian
  dv.setUint16(o, 42, false); o += 2;           // TIFF magic
  dv.setUint32(o, 8, false); o += 4;            // first IFD at TIFF byte 8
  const ifdStart = o;
  dv.setUint16(o, 3, false); o += 2;            // IFD0 entry count

  const writeEntry = (tag: number, type: number, count: number, valueOrOffset: number) => {
    dv.setUint16(o, tag, false); o += 2;
    dv.setUint16(o, type, false); o += 2;
    dv.setUint32(o, count, false); o += 4;
    dv.setUint32(o, valueOrOffset, false); o += 4;
  };

  // MPFVersion (0xB000, UNDEFINED 0x07, count 4, "0100" inline).
  writeEntry(0xb000, 7, 4, 0);
  out[o - 4] = 0x31; out[o - 3] = 0x30; out[o - 2] = 0x30; out[o - 1] = 0x30; // "0100"
  // NumberOfImages (0xB001, LONG, 1) = 2.
  writeEntry(0xb001, 4, 1, 2);
  // MPEntry (0xB002, UNDEFINED, count = 2×16) — value is an OFFSET to the
  // entries, which sit after the fixed IFD (where the payload has room).
  const mpEntryOffsetPlaceholder = o;
  writeEntry(0xb002, 7, 32, 0);
  dv.setUint32(o, 0, false); o += 4; // next IFD = 0

  // MP entries land at TIFF byte (ifdStart - tiffStart) + 2 + 3*12 + 4.
  const entriesAt = ifdStart - tiffStart + 2 + 36 + 4;
  dv.setUint32(mpEntryOffsetPlaceholder + 8, entriesAt, false);

  // Entry 0: primary. Attributes 0x030000 (the conventional primary flag),
  // size = the primary's full extent in the container (its own segments plus
  // everything this assembler inserts), data offset 0.
  dv.setUint32(o, 0x030000, false); o += 4;
  dv.setUint32(o, primarySize, false); o += 4;
  dv.setUint32(o, 0, false); o += 4;
  dv.setUint32(o, 0, false); o += 4;

  // Entry 1: the gain map. Size = gain JPEG length; DataOffset measured from
  // the MP Endian field; dependent u16 fields 0.
  dv.setUint32(o, 0, false); o += 4;
  dv.setUint32(o, gainSize, false); o += 4;
  dv.setUint32(o, gainOffset, false); o += 4;
  dv.setUint32(o, 0, false); o += 4;

  return out;
}

// ─── Header surgery ────────────────────────────────────────────────────────────

function startsWith(bytes: Uint8Array, at: number, text: string): boolean {
  if (at + text.length > bytes.length) return false;
  for (let k = 0; k < text.length; k++) {
    if (bytes[at + k] !== text.charCodeAt(k)) return false;
  }
  return true;
}

/**
 * Copy a JPEG's header run (SOI up to — not including — the first SOS) while
 * STRIPPING the UltraHDR segments (XMP APP1, MPF APP2, ISO APP2) and keeping
 * everything else verbatim (JFIF, EXIF, ICC). Returns the stripped run plus
 * the file offset where the first SOS begins in the SOURCE bytes, so the
 * caller can append the untouched entropy tail.
 */
function stripUltraHdrHeader(bytes: Uint8Array): { head: Uint8Array; sosInSource: number } {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('[ultrahdr] base is not a JPEG (no SOI)');
  }
  const head: number[] = [bytes[0], bytes[1]];
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) throw new Error('[ultrahdr] base header walk desynced');
    const marker = bytes[i + 1];
    if (marker === 0xda) break; // SOS — header over; tail is copied verbatim
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      head.push(bytes[i], bytes[i + 1]);
      i += 2;
      continue;
    }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (length < 2) throw new Error('[ultrahdr] base header has a degenerate segment length');
    const payloadAt = i + 4;
    const isXmp = marker === 0xe1 && startsWith(bytes, payloadAt, XMP_PREFIX);
    const isMpf = marker === 0xe2 && startsWith(bytes, payloadAt, MPF_PREFIX);
    const isIso = marker === 0xe2 && startsWith(bytes, payloadAt, ISO_IDENTIFIER);
    if (!isXmp && !isMpf && !isIso) {
      for (let k = i; k < i + 2 + length; k++) head.push(bytes[k]);
    }
    i += 2 + length;
  }
  if (i + 4 > bytes.length) throw new Error('[ultrahdr] base JPEG has no SOS marker');
  return { head: new Uint8Array(head), sosInSource: i };
}

/**
 * Inject the UltraHDR header segments (XMP APP1, ISO APP2, MPF APP2) right
 * after the SOI of a finished JPEG — the same insertion the primary gets, used
 * for the gain image too (its self-describing XMP + full ISO record).
 */
function injectUltraHdrSegments(jpeg: Uint8Array, segments: Uint8Array[]): Uint8Array {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new Error('[ultrahdr] gain map is not a JPEG (no SOI)');
  }
  const injected = segments.reduce((n, s) => n + s.length, 0);
  const out = new Uint8Array(2 + injected + (jpeg.length - 2));
  out.set(jpeg.subarray(0, 2), 0);
  let o = 2;
  for (const seg of segments) {
    out.set(seg, o);
    o += seg.length;
  }
  out.set(jpeg.subarray(2), o);
  return out;
}

/**
 * Assemble the UltraHDR file:
 *   [SOI][XMP APP1][ISO APP2 (version-only)][MPF APP2][base header rest…]
 *   [SOS][scan][EOI][gain JPEG with its own XMP APP1 + ISO APP2 injected]
 * All MPF offsets are measured from the MP Endian field (see the module doc);
 * the geometry is computed AFTER the base's own stale UltraHDR segments are
 * stripped, which is what makes repeated assembly idempotent.
 */
export function assembleUltraHdr(opts: UltraHdrAssembleOptions): Uint8Array {
  const base = opts.baseJpeg;
  const gain = opts.gainMapJpeg;

  // Fail-fast SOI gates: a non-JPEG here is a caller contract break (the
  // classic forms: an un-awaited Promise stringified into the buffer, or the
  // PNG fallback from a mis-typed encode MIME) and must throw, not emit a
  // silently-broken file.
  const { head, sosInSource } = stripUltraHdrHeader(base);
  if (gain.length < 4 || gain[0] !== 0xff || gain[1] !== 0xd8) {
    throw new Error('[ultrahdr] gain map is not a JPEG (no SOI)');
  }

  const gainAssembled = injectUltraHdrSegments(gain, [
    xmpApp1(buildGainMapXmp(opts.gainMapMin, opts.gainMapMax, opts.gainMapGamma)),
    isoApp2(buildIsoGainmapMetadata(opts.gainMapMin, opts.gainMapMax, opts.gainMapGamma)),
  ]);

  const xmp = xmpApp1(buildPrimaryGContainerXmp(gainAssembled.length));
  const iso = isoApp2(null);
  const mpf = buildMpfApp2(0, 0, 0); // placeholder; geometry patched below

  // Layout: [SOI][XMP][ISO][MPF][preserved base header…][SOS tail][gain].
  const mpfPosInFile = 2 + xmp.length + iso.length;
  const mpEndianPos = mpfPosInFile + 8; // marker(2) + length(2) + "MPF\0"(4)
  const preservedLength = head.length - 2; // the stripped-over kept segments
  const baseTailLength = base.length - sosInSource;
  const gainFileOffset = mpfPosInFile + mpf.length + preservedLength + baseTailLength;
  // Entry 0's size is the PRIMARY's extent in the container: everything from
  // the container SOI up to (not including) the gain map's SOI.
  const primarySizeInContainer = gainFileOffset;

  // Patch the two load-bearing MP Entry fields (size of entry 0, offset and
  // size of entry 1) in place — the directory structure itself is fixed-size.
  const entriesAt = 4 + 8 + 2 + 36 + 4; // payload: MPF\0 + TIFF header + count + 3 entries + next-IFD
  const dv = new DataView(mpf.buffer);
  dv.setUint32(4 + entriesAt + 4, primarySizeInContainer, false);
  dv.setUint32(4 + entriesAt + 20, gainAssembled.length, false);
  dv.setUint32(4 + entriesAt + 24, gainFileOffset - mpEndianPos, false);

  const out = new Uint8Array(gainFileOffset + gainAssembled.length);
  let o = 0;
  out.set(head.subarray(0, 2), o); o += 2; // SOI
  out.set(xmp, o); o += xmp.length;
  out.set(iso, o); o += iso.length;
  out.set(mpf, o); o += mpf.length;
  out.set(head.subarray(2), o); o += preservedLength; // EXIF / ICC / JFIF / … kept verbatim
  out.set(base.subarray(sosInSource), o); o += baseTailLength;
  out.set(gainAssembled, o);
  return out;
}
