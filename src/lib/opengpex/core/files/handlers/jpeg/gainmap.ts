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
 * JPEG gain-map (UltraHDR) carrier reader — the three facts an UltraHDR file
 * must give up before its HDR rendition can be reconstructed:
 *
 *   1. THE DETECTION KEY — the PRIMARY image's XMP in the Google GContainer
 *      form: an `hdrgm:Version` attribute plus a `Container:Directory` whose
 *      `rdf:Seq` names an `Item:Semantic="Primary"` and an
 *      `Item:Semantic="GainMap"` entry. The bare `hdrgm:*` numeric attributes
 *      on the primary are NOT the detection key: no mainstream consumer
 *      recognizes a primary XMP that carries them without the container
 *      directory (byte-compared against a gainmaps.com-produced file that
 *      macOS Photos / Chrome-class viewers do recognize).
 *   2. THE GAIN-MAP LOCATION — the MPF APP2 multi-picture directory (CIPA
 *      DC-007): a TIFF-styled IFD whose MP Entries give each secondary image's
 *      size and offset. Both byte orders are legal in the wild ("II"
 *      little-endian on gainmaps.com output, "MM" big-endian elsewhere), and
 *      every offset is measured from the MP Endian field — the TIFF header
 *      start, which sits 8 bytes into the APP2 payload ("MPF\0" + endian) —
 *      NOT from the segment marker. Entry 0 is the primary (DataOffset 0,
 *      attributes 0x030000); the first entry beyond it with a non-zero size is
 *      the gain map.
 *   3. THE PARAMETERS — the GAIN IMAGE's own embedded `hdrgm:*` XMP
 *      (GainMapMin / GainMapMax / Gamma, with OffsetSDR / OffsetHDR /
 *      HDRCapacity* / BaseRenditionIsHDR alongside). The gain image's XMP is
 *      the authoritative parameter record for this carrier; the primary's XMP
 *      never carries numbers.
 *
 * EXTRACTION CONTRACT: this module is the INGEST half — locate the gain JPEG
 * and read its parameters as pure byte surgery (segment walk, XMP text, MPF
 * IFD, SOF dims — node-runnable, golden-testable). The gain image's bytes go
 * VERBATIM into `metadata.raw.gainMap`; the RASTER half (createImageBitmap →
 * primary-orientation alignment → Rec. 709 reduction to the single-channel
 * plane) lives in the runtime decoder (`shared/gain-map`), which runs
 * once per session from the metadata alone — never from the source blob.
 *
 * Axis notes carried into the runtime contract:
 *   - The shared shape is SINGLE-channel, but the carrier allows a per-channel
 *     (RGB) map — real-world range from gray-replicated (most producers) to
 *     genuinely per-channel content (gainmaps.com writes one for colour-chart
 *     sources, measured on the committed sample: R==B with G carrying an extra
 *     patch). The runtime reduces to Rec. 709 luma — for a replicated map that
 *     is the value itself (lossless), and for a per-channel map it is the
 *     perceptually weighted single-number summary the XMP's single-set
 *     GainMapMin/Max/Gamma span assumes.
 *   - OffsetSDR/OffsetHDR (1/64 on gainmaps.com output, ~0 on Apple) are
 *     deliberately NOT carried: the presentation chain applies the offsetless
 *     `hdr = sdr·2^gain` statement, and a sub-1% rendition error on 1/64-offset
 *     files does not justify a second affine parameter through the shared
 *     shape and the view shader.
 *   - BaseRenditionIsHDR=True (an HDR base with an inverse map) is out of
 *     scope: such files still ingest, they just present without gain.
 *   - EXIF ORIENTATION ALIGNMENT: a gain map is aligned to the primary's
 *     FILE-space pixels and carries no orientation of its own, while the
 *     engine's master is the EXIF-uprighted decode — the runtime applies the
 *     PRIMARY's EXIF orientation (already in `metadata.capture.orientation`)
 *     to the gain raster before sampling. Our own exports always write
 *     Orientation=1, so the round trip is a no-op.
 *
 * @module core/files/handlers/jpeg/gainmap
 */


/** APP1 payload prefix that tags an XMP segment. */
const XMP_PREFIX = 'http://ns.adobe.com/xap/1.0/\0';

/** APP2 payload prefix that tags the multi-picture directory. */
const MPF_PREFIX = 'MPF\0';

/** MPF IFD tags (CIPA DC-007). */
const TAG_NUMBER_OF_IMAGES = 0xb001;
const TAG_MP_ENTRY = 0xb002;

// ─── Segment walking ───────────────────────────────────────────────────────────

interface AppSegment {
  /** File offset of the marker (0xFF 0xMN). */
  readonly markerOffset: number;
  /** File offset of the payload (after the 2-byte length). */
  readonly payloadOffset: number;
  /** Payload length in bytes (the segment length field minus 2). */
  readonly payloadLength: number;
  readonly marker: number;
}

/** Byte-level prefix test against a JS string (ASCII/NUL prefixes only). */
function startsWith(bytes: Uint8Array, at: number, text: string): boolean {
  if (at + text.length > bytes.length) return false;
  for (let k = 0; k < text.length; k++) {
    if (bytes[at + k] !== text.charCodeAt(k)) return false;
  }
  return true;
}

/**
 * Walk the JPEG header (markers before the first SOS scan) collecting APPn
 * segments. Returns null on any structural surprise (no SOI, truncated
 * header) — callers treat that as "no metadata", never as an error.
 */
function walkAppSegments(bytes: Uint8Array): AppSegment[] | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const segments: AppSegment[] = [];
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return null; // desync — not a legal header walk
    const marker = bytes[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      i += 2; // standalone markers carry no length
      continue;
    }
    if (marker === 0xda) break; // SOS — entropy-coded data follows; header over
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (length < 2) return null;
    segments.push({ markerOffset: i, payloadOffset: i + 4, payloadLength: length - 2, marker });
    i += 2 + length;
  }
  return segments;
}

/** The text of the FIRST XMP APP1 payload (primary image), or null. */
export function findJpegXmp(bytes: Uint8Array): string | null {
  const segments = walkAppSegments(bytes);
  if (!segments) return null;
  const prefix = new TextEncoder().encode(XMP_PREFIX);
  for (const seg of segments) {
    if (seg.marker !== 0xe1) continue;
    if (seg.payloadLength <= prefix.length) continue;
    let match = true;
    for (let k = 0; k < prefix.length; k++) {
      if (bytes[seg.payloadOffset + k] !== prefix[k]) {
        match = false;
        break;
      }
    }
    if (match) {
      const start = seg.payloadOffset + prefix.length;
      return new TextDecoder().decode(bytes.subarray(start, seg.payloadOffset + seg.payloadLength));
    }
  }
  return null;
}

// ─── GContainer detection (the carrier's detection key) ──────────────────────

/**
 * Whether an XMP packet is the Google GContainer form naming a GainMap item —
 * THE JPEG gain-map detection key. Bare `hdrgm:*` attributes deliberately do
 * not satisfy this: the ecosystem (and this reader) recognizes only the
 * container-directory form, so a plain JPEG carrying stray hdrgm attributes
 * never routes to the gain-map lane.
 */
export function isGainMapContainerXmp(xmp: string | null): boolean {
  if (!xmp) return false;
  return xmp.includes('Container:Directory') && /Item:Semantic=\s*["']GainMap["']/.test(xmp);
}

/** Cheap ingest-time gate: does this JPEG carry a GContainer gain map? */
export function detectJpegGainMap(bytes: Uint8Array): boolean {
  return isGainMapContainerXmp(findJpegXmp(bytes));
}

// ─── MPF multi-picture directory ───────────────────────────────────────────────

interface MpfEntry {
  readonly attributes: number;
  readonly size: number;
  /** Offset measured from the MP Endian field (the TIFF header start). */
  readonly dataOffset: number;
}

interface MpfDirectory {
  /** File offset of the TIFF byte-order field ("II"/"MM"). */
  readonly tiffOrigin: number;
  readonly entries: MpfEntry[];
}

/**
 * Locate and parse the MPF APP2 directory. Both byte orders are legal; every
 * offset the format stores is relative to the MP Endian field, which sits 8
 * bytes into the APP2 payload (after "MPF\0").
 */
export function findMpfDirectory(bytes: Uint8Array): MpfDirectory | null {
  const segments = walkAppSegments(bytes);
  if (!segments) return null;
  for (const seg of segments) {
    if (seg.marker !== 0xe2) continue;
    if (seg.payloadLength < 4 + 8) continue;
    if (!startsWith(bytes, seg.payloadOffset, MPF_PREFIX)) {
      continue; // not "MPF\0" (ICC profiles and ISO metadata are APP2s too)
    }
    const tiffOrigin = seg.payloadOffset + 4;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const order = String.fromCharCode(bytes[tiffOrigin], bytes[tiffOrigin + 1]);
    const little = order === 'II';
    if (!little && order !== 'MM') return null;
    if (dv.getUint16(tiffOrigin + 2, little) !== 42) return null;
    const firstIfd = dv.getUint32(tiffOrigin + 4, little);
    const ifd = tiffOrigin + firstIfd;
    if (ifd + 2 > bytes.length) return null;
    const entryCount = dv.getUint16(ifd, little);
    let imageCount = 0;
    let mpEntryValue = 0;
    for (let e = 0; e < entryCount; e++) {
      const at = ifd + 2 + e * 12;
      if (at + 12 > bytes.length) return null;
      const tag = dv.getUint16(at, little);
      if (tag === TAG_NUMBER_OF_IMAGES) imageCount = dv.getUint32(at + 8, little);
      if (tag === TAG_MP_ENTRY) mpEntryValue = dv.getUint32(at + 8, little);
    }
    if (imageCount < 2 || mpEntryValue === 0) return null;
    const entriesAt = tiffOrigin + mpEntryValue;
    if (entriesAt + imageCount * 16 > bytes.length) return null;
    const entries: MpfEntry[] = [];
    for (let e = 0; e < imageCount; e++) {
      const at = entriesAt + e * 16;
      entries.push({
        attributes: dv.getUint32(at, little),
        size: dv.getUint32(at + 4, little),
        dataOffset: dv.getUint32(at + 8, little),
      });
    }
    return { tiffOrigin, entries };
  }
  return null;
}

// ─── The gain image's own hdrgm XMP parameters ────────────────────────────────

export interface GainMapXmpParams {
  /** Map value at byte 0 (log2 ratio; the spec default is 0). */
  readonly gainMin: number;
  /** Map value at byte 255 (log2 ratio; REQUIRED — no sane default exists). */
  readonly gainMax: number;
  /** Payload gamma (spec default 1 = log2-linear quantization). */
  readonly gamma: number;
}

/**
 * Pull one `hdrgm:<name>` value out of an XMP packet — attribute form
 * (`hdrgm:Name="v"`) with either quote style, falling back to the element
 * form (`<hdrgm:Name>v</hdrgm:Name>`) some writers emit. XMP is XML but the
 * hdrgm vocabulary is a flat set of number/boolean attributes; a targeted
 * match keeps the parse dependency-free and node-runnable.
 */
function readHdrgmValue(xmp: string, name: string): string | null {
  const attr = xmp.match(new RegExp(`hdrgm:${name}\\s*=\\s*["']([^"']*)["']`));
  if (attr) return attr[1];
  const elem = xmp.match(new RegExp(`<hdrgm:${name}>([^<]*)</hdrgm:${name}>`));
  return elem ? elem[1] : null;
}

/**
 * Parse the gain image's hdrgm parameters. GainMapMax is REQUIRED (it defines
 * the top of the affine space — without it the map is meaningless); GainMapMin
 * and Gamma take their spec defaults (0 and 1) when absent.
 */
export function parseGainMapXmpParams(xmp: string | null): GainMapXmpParams | null {
  if (!xmp) return null;
  const maxRaw = readHdrgmValue(xmp, 'GainMapMax');
  if (maxRaw === null) return null;
  const gainMax = Number(maxRaw);
  if (!Number.isFinite(gainMax)) return null;
  const minRaw = readHdrgmValue(xmp, 'GainMapMin');
  const gainMin = minRaw === null ? 0 : Number(minRaw);
  const gammaRaw = readHdrgmValue(xmp, 'Gamma');
  const gamma = gammaRaw === null ? 1 : Number(gammaRaw);
  if (!Number.isFinite(gainMin) || !Number.isFinite(gamma) || gamma <= 0) return null;
  return { gainMin, gainMax, gamma };
}

// ─── Carrier compose (pure — the golden surface) ──────────────────────────────

export interface JpegGainMapCarrier {
  /** Absolute file offset of the gain JPEG's SOI. */
  readonly gainOffset: number;
  /** Length of the gain JPEG (SOI through EOI). */
  readonly gainLength: number;
  /** The gain JPEG's own bytes (a subarray view — no copy). */
  readonly gainBytes: Uint8Array;
  /** Coded pixel dimensions (from the gain JPEG's SOF), for metadata records
   * and tests — no raster decode needed to know them. */
  readonly width: number;
  readonly height: number;
  readonly params: GainMapXmpParams;
}

/** Coded dimensions from a JPEG's SOF0/SOF2 header (0×0 when unreadable). */
function readJpegSofDimensions(bytes: Uint8Array): { width: number; height: number } {
  let i = 2;
  while (i + 9 <= bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) { i += 2; continue; }
    if (marker === 0xda) break; // SOS — SOF must precede the scan
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if ((marker === 0xc0 || marker === 0xc2) && length >= 17) {
      // SOF: precision(1) height(2) width(2) components(1)...
      return {
        height: (bytes[i + 5] << 8) | bytes[i + 6],
        width: (bytes[i + 7] << 8) | bytes[i + 8],
      };
    }
    i += 2 + length;
  }
  return { width: 0, height: 0 };
}

/**
 * Locate the gain-map JPEG inside an UltraHDR file and parse its parameters —
 * everything except the raster decode. Returns null when any required fact is
 * missing: no GContainer XMP (the detection key), no MPF directory, no
 * secondary entry, or bytes that do not start with a JPEG SOI.
 */
export function extractJpegGainMapCarrier(bytes: Uint8Array): JpegGainMapCarrier | null {
  if (!isGainMapContainerXmp(findJpegXmp(bytes))) return null;
  const mpf = findMpfDirectory(bytes);
  if (!mpf) return null;
  // Entry 0 is the primary (DataOffset 0); the first entry beyond it with a
  // non-zero size is the gain map.
  for (let e = 1; e < mpf.entries.length; e++) {
    const entry = mpf.entries[e];
    if (entry.size === 0) continue;
    const gainOffset = mpf.tiffOrigin + entry.dataOffset;
    const gainLength = Math.min(entry.size, bytes.length - gainOffset);
    if (gainOffset < 0 || gainLength < 4) return null;
    if (bytes[gainOffset] !== 0xff || bytes[gainOffset + 1] !== 0xd8) return null;
    const gainBytes = bytes.subarray(gainOffset, gainOffset + gainLength);
    const params = parseGainMapXmpParams(findJpegXmp(gainBytes));
    if (!params) return null; // the gain image MUST carry its own hdrgm XMP
    const { width, height } = readJpegSofDimensions(gainBytes);
    return { gainOffset, gainLength, gainBytes, width, height, params };
  }
  return null;
}

// ─── EXIF orientation of the PRIMARY (for gain-map alignment) ─────────────────

/**
 * The primary image's EXIF Orientation tag (1..8), or 1 when absent/unreadable.
 * The gain map is stored in the primary's FILE space while the engine's master
 * texture is the EXIF-uprighted decode, so the reader must apply the same
 * transform to the gain raster to keep the two spatially aligned.
 */
export function readPrimaryExifOrientation(bytes: Uint8Array): number {
  const segments = walkAppSegments(bytes);
  if (!segments) return 1;
  for (const seg of segments) {
    if (seg.marker !== 0xe1) continue;
    // EXIF APP1 payload: "Exif\0\0" then a TIFF structure.
    if (seg.payloadLength < 14) continue;
    if (bytes[seg.payloadOffset] !== 0x45 || bytes[seg.payloadOffset + 1] !== 0x78 ||
        bytes[seg.payloadOffset + 2] !== 0x69 || bytes[seg.payloadOffset + 3] !== 0x66) {
      continue; // "Exif"
    }
    const tiff = seg.payloadOffset + 6;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const order = String.fromCharCode(bytes[tiff], bytes[tiff + 1]);
    const little = order === 'II';
    if (!little && order !== 'MM') return 1;
    if (dv.getUint16(tiff + 2, little) !== 42) return 1;
    const ifd0 = tiff + dv.getUint32(tiff + 4, little);
    if (ifd0 + 2 > bytes.length) return 1;
    const count = dv.getUint16(ifd0, little);
    for (let e = 0; e < count; e++) {
      const at = ifd0 + 2 + e * 12;
      if (at + 12 > bytes.length) return 1;
      if (dv.getUint16(at, little) !== 0x0112) continue; // Orientation
      const value = dv.getUint16(at + 8, little); // SHORT fits inline
      return value >= 1 && value <= 8 ? value : 1;
    }
    return 1;
  }
  return 1;
}

