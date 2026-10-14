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
 * ultrahdr.ts — UltraHDR (ISO 21496-1-style gain map) JPEG assembler.
 *
 * Takes the SDR base JPEG and the gain-map JPEG as finished encodes and
 * ASSEMBLES the multi-picture container around them:
 *   • XMP APP1 carrying the `hdrgm:*` metadata (Min/Max/Gamma describe the
 *     gain map payload's affine space; we store log2 ratios with γ = 1);
 *   • MPF APP2 with a two-entry Multi-Picture directory (entry 0 = the primary
 *     base, entry 1 = the gain map), followed by the gain-map SOI.
 *
 * STRUCTURE FACTS (probe P0-4c, validated by segment walk + Chrome/Safari
 * `createImageBitmap` decode of a hand-assembled file — the pitfalls the
 * probe hit are load-bearing below):
 *   • an MP Entry is 16 bytes (attribute u32, size u32, offset u32, and the
 *     two dependent-image u16 fields in the last u32);
 *   • the MPF TIFF header's "offset to first IFD" is relative to the MP
 *     Endian field — which sits at APP2-payload + 4 (after the "MPF\0" tag),
 *     NOT at the APP2 marker: forgetting the marker+length 4 bytes is the
 *     classic off-by-four;
 *   • offsets are BIG-endian ("MM") and measured from that same origin, so
 *     the gain-map DataOffset = (offset of gain map bytes in the FILE) −
 *     (MP Endian field position in the file).
 */

export interface UltraHdrAssembleOptions {
  /** Finished SDR base JPEG (bytes including its own SOI). */
  readonly baseJpeg: Uint8Array;
  /** Finished gain-map JPEG (grayscale, same aspect; bytes including SOI). */
  readonly gainMapJpeg: Uint8Array;
  /** Minimum of the gain map payload's value range (log2 ratio space). */
  readonly gainMapMin?: number;
  /** Maximum of the gain map payload's value range (log2 ratio space). */
  readonly gainMapMax: number;
  /** Gain map payload gamma (1.0 — the payload already stores log2 ratios). */
  readonly gainMapGamma?: number;
  /** Base image dimensions (declared in XMP hdrgm:BaseImageHeadroom context). */
  readonly width: number;
  readonly height: number;
  /** Gain map dimensions (may be downsampled). */
  readonly gainMapWidth: number;
  readonly gainMapHeight: number;
}

/** APP1 payload prefix that tags an XMP segment. */
const XMP_PREFIX = 'http://ns.adobe.com/xap/1.0/\0';

function buildXmpApp1(opts: UltraHdrAssembleOptions): Uint8Array {
  const min = opts.gainMapMin ?? 0;
  const xmp =
    `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/">` +
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about=""` +
    ` xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/"` +
    ` hdrgm:Version="1.0"` +
    ` hdrgm:Min="${min}"` +
    ` hdrgm:Max="${opts.gainMapMax}"` +
    ` hdrgm:Gamma="${opts.gainMapGamma ?? 1}"` +
    ` hdrgm:OffsetSDR="0"` +
    ` hdrgm:OffsetHDR="0"` +
    ` hdrgm:HDRCapacityMin="0"` +
    ` hdrgm:BaseRenditionIsHDR="False">` +
    `</rdf:Description>` +
    `</rdf:RDF>` +
    `</x:xmpmeta>` +
    `<?xpacket end="w"?>`;
  const prefix = new TextEncoder().encode(XMP_PREFIX);
  const payload = new TextEncoder().encode(xmp);
  // APP segment length counts its own 2 length bytes.
  const segLen = 2 + prefix.length + payload.length;
  const out = new Uint8Array(2 + segLen);
  out[0] = 0xff;
  out[1] = 0xe1; // APP1
  out[2] = (segLen >> 8) & 255;
  out[3] = segLen & 255;
  out.set(prefix, 4);
  out.set(payload, 4 + prefix.length);
  return out;
}

/**
 * Assemble the UltraHDR file. The standard layout inserts the XMP APP1 and
 * the MPF APP2 into the base JPEG's HEADER region (before its SOS), and the
 * gain map JPEG goes at the very END of the file — after the primary image's
 * EOI (the entropy-coded scan must directly follow its SOS; a secondary
 * image can never sit inside it).
 *   [SOI][APP0…][XMP APP1][MPF APP2][…headers…][SOS][scan][EOI][gain JPEG]
 * All MPF offsets are measured from the MP Endian field (see module header).
 */
export function assembleUltraHdr(opts: UltraHdrAssembleOptions): Uint8Array {
  const base = opts.baseJpeg;
  const gain = opts.gainMapJpeg;

  if (base[0] !== 0xff || base[1] !== 0xd8) throw new Error('[ultrahdr] base is not a JPEG (no SOI)');
  if (gain[0] !== 0xff || gain[1] !== 0xd8) throw new Error('[ultrahdr] gain map is not a JPEG (no SOI)');

  // Walk the base JPEG to the first SOS (FF DA): everything before it is
  // header segments — the XMP + MPF APP segments are inserted there.
  let sos = -1;
  for (let i = 2; i < base.length - 1; i++) {
    if (base[i] === 0xff && base[i + 1] === 0xda) { sos = i; break; }
    if (base[i] === 0xff && base[i + 1] !== 0x00 && base[i + 1] !== 0xff) {
      const marker = base[i + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) continue; // standalone
      const len = (base[i + 2] << 8) | base[i + 3];
      i += 1 + len; // skip the segment body
    }
  }
  if (sos < 0) throw new Error('[ultrahdr] base JPEG has no SOS marker');

  const xmp = buildXmpApp1(opts);
  // MPF APP2 geometry: it starts right after the (baseHead + XMP) run.
  const mpfPosInFile = sos + xmp.length;
  const mpEndianPos = mpfPosInFile + 2 /* FFE2 */ + 2 /* length */ + 4 /* "MPF\0" */;
  const headLen = sos + xmp.length + mpfSegmentLength();
  const tailLen = base.length - sos;
  const gainFileOffset = headLen + tailLen; // gain map appended at the file end
  const gainOffsetFromMpEndian = gainFileOffset - mpEndianPos;
  // CIPA DC-007: MP Entry 0's Individual Image Size is the PRIMARY image's
  // extent IN THE CONTAINER — which is the base JPEG PLUS the XMP + MPF
  // segments inserted into its header region (a strict reader decoding via
  // Entry 0 would otherwise truncate the primary's entropy tail and EOI).
  const primarySizeInContainer = headLen + tailLen;

  const mpf = buildMpfApp2(primarySizeInContainer, gain.length, gainOffsetFromMpEndian);

  const out = new Uint8Array(headLen + tailLen + gain.length);
  let o = 0;
  out.set(base.subarray(0, sos), o); o += sos;
  out.set(xmp, o); o += xmp.length;
  out.set(mpf, o); o += mpf.length;
  out.set(base.subarray(sos), o); o += tailLen;
  out.set(gain, o);
  return out;
}

/** Total byte length of the MPF APP2 segment (marker + length + payload). */
function mpfSegmentLength(): number {
  // The directory is fixed-size payload: 4 ("MPF\0") + 8 (TIFF header)
  // + 2 (entry count) + 3×12 (Version / NumImages / MPEntry tag headers)
  // + 4 (next-IFD 0) + 32 (2 MP entries) = 86; + 4 (marker+len) = 90.
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
  // "MPF\0"
  out[o++] = 0x4d; out[o++] = 0x50; out[o++] = 0x46; out[o++] = 0x00;
  // TIFF header (big-endian "MM"): byte-order u16, magic 42 u16, IFD offset u32.
  // The offsets are relative to the MP Endian field (== the TIFF header start).
  const tiffStart = o;
  dv.setUint16(o, 0x4d4d, false); o += 2;       // "MM" big-endian
  dv.setUint16(o, 42, false); o += 2;           // TIFF magic
  dv.setUint32(o, 8, false); o += 4;            // first IFD at TIFF byte 8 (pit)
  const ifdStart = o;
  // IFD0: entry count, then entries, then next-IFD = 0.
  dv.setUint16(o, 3, false); o += 2;

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

  // Entry 0: primary. Attributes 0x030000 (the conventional primary flag
  // set), size = the primary's full extent in the container (base + inserted
  // XMP/MPF), data offset 0 (the primary IS the container start).
  dv.setUint32(o, 0x030000, false); o += 4;
  dv.setUint32(o, primarySize, false); o += 4;
  dv.setUint32(o, 0, false); o += 4;
  dv.setUint32(o, 0, false); o += 4;

  // Entry 1: the gain map. Size = gain JPEG length; DataOffset measured from
  // the MP Endian field; dependent u16 fields 0 (16-byte entry, pit).
  dv.setUint32(o, 0x000000, false); o += 4;
  dv.setUint32(o, gainSize, false); o += 4;
  dv.setUint32(o, gainOffset, false); o += 4;
  dv.setUint32(o, 0, false); o += 4;

  return out;
}

export { mpfSegmentLength };
