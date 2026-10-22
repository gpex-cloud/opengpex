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
 * AVIF container tag writer — post-encode metadata injection for jsquash output.
 *
 * @jsquash/avif encodes pixels but exposes no ICC/EXIF options (its wasm libavif
 * writes exactly one `colr` box with an `nclx` 2/2/6 "unspecified" payload, and
 * nothing else). The SDR CICP values are patched in place by `cicp.ts`; this
 * module handles everything that GROWS the file:
 *
 *   1. `injectAvifColourProfile` — append a `colr` box with an interleaved ICC
 *      payload (`prof`) into `meta/iprp/ipco` and associate it with the primary
 *      item via `ipma`. An AVIF item may carry both an `nclx` and a `prof`
 *      `colr` box (HEIF §A.2.1); the nclx stays first because it already exists.
 *
 *   2. `injectAvifExifItem` — append an `Exif` metadata item: an `infe` entry in
 *      `iinf`, an extent in `iloc`, a `cdsc` reference (item → primary) in
 *      `iref`, and the payload bytes in a NEW `mdat` appended at the end of the
 *      file. The Exif item data layout follows HEIF practice: a 4-byte
 *      big-endian offset to the TIFF header (written as 0) followed by the raw
 *      TIFF bytes.
 *
 * OFFSET SAFETY (the whole hard part)
 * -----------------------------------
 * Both injections rebuild the `meta` box, so it grows. libavif/jsquash lay the
 * file out as `ftyp | meta | mdat`, so every byte the existing `iloc` extents
 * point at (the coded AV1 image data) SHIFTS by the meta growth delta when meta
 * grows. Every injection therefore (a) computes the delta of its rebuilt meta
 * box, (b) rewrites every existing `iloc` entry's `base_offset` and extent
 * offsets by +delta — for `construction_method` 0 entries, where those values
 * are absolute file offsets — and only then appends its own data. `idat`-based
 * construction (method 1) offsets are relative to the `idat` box and are left
 * untouched (jsquash stills never produce them; if one appears the entry is
 * preserved verbatim rather than mis-shifted).
 *
 * Box layout knowledge mirrors the read side (`./metadata/container.ts`, which
 * is also what the tests use to read these files back). `mdat` pixels are never
 * touched — only appended to.
 *
 * @module core/files/handlers/avif/tagger
 */

import { readBoxHeader } from '../../metadata/isobmff-reader';

interface BoxSpan { type: string; dataOffset: number; boxEnd: number }

interface MetaParts {
  /** File offset of the `meta` box header. */
  metaOffset: number;
  metaBoxEnd: number;
  /** version+flags 4 bytes of the meta FullBox. */
  metaVersionFlags: Uint8Array;
  /** Children of meta, in order, as (start, end) file spans. */
  children: BoxSpan[];
  /** Primary item id from `pitm` (v0, 2-byte). */
  primaryItemId: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Embed an ICC profile into the AVIF as an additional `colr` box (payload type
 * `prof`) associated with the primary item. The pre-existing `nclx` `colr` box
 * written by the encoder is left as-is (it keeps its position ahead of the new
 * `prof`). Returns the original bytes unchanged if the container shape is not
 * as expected — a missing tag must never destroy an otherwise valid export.
 */
export function injectAvifColourProfile(bytes: Uint8Array, iccBytes: Uint8Array): Uint8Array {
  try {
    const meta = parseMetaParts(bytes);
    if (!meta) return bytes;

    const iprp = meta.children.find((c) => c.type === 'iprp');
    if (!iprp) return bytes;
    const iprpChildren = childSpans(bytes, iprp.dataOffset, iprp.boxEnd);
    const ipco = iprpChildren.find((c) => c.type === 'ipco');
    if (!ipco) return bytes;

    const ipcoChildren = childSpans(bytes, ipco.dataOffset, ipco.boxEnd);
    // ipco property indices are 1-based over its children.
    const profIndex = ipcoChildren.length + 1;

    // Build the new property box: colr = colour_type 'prof' + interleaved ICC bytes.
    const profPayload = new Uint8Array(4 + iccBytes.length);
    writeFourCC(profPayload, 0, 'prof');
    profPayload.set(iccBytes, 4);
    const profBox = wrapBox('colr', profPayload);

    // Rebuild ipco: every existing property verbatim, then the new one last so
    // the existing 1-based indices referenced by ipma stay valid.
    const newIpco = rebuildBox(
      bytes,
      ipco,
      [...ipcoChildren.map((c) => bytes.slice(c.dataOffset - 8, c.boxEnd)), profBox],
      ipco.dataOffset,
    );

    // Rebuild every ipma, appending the new association indices to the primary
    // item's entry (or adding an entry when the encoder associated none).
    const newIprpChildren: Uint8Array[] = [];
    let ipmaRebuilt = false;
    for (const child of iprpChildren) {
      if (child.type === 'ipma') {
        const rebuilt = associateIpma(bytes, child, meta.primaryItemId, [profIndex]);
        if (!rebuilt) return bytes;
        newIprpChildren.push(rebuilt);
        ipmaRebuilt = true;
      } else if (child.type === 'ipco') {
        newIprpChildren.push(newIpco);
      } else {
        newIprpChildren.push(bytes.slice(child.dataOffset - 8, child.boxEnd));
      }
    }
    if (!ipmaRebuilt) {
      const fresh = buildIpma(meta.primaryItemId, [profIndex]);
      newIprpChildren.push(fresh);
    }
    const iprpHeaderEnd = iprp.dataOffset;
    const newIprp = rebuildBox(bytes, iprp, newIprpChildren, iprpHeaderEnd);

    const newMeta = rebuildMeta(bytes, meta, new Map([[iprp, newIprp]]));
    // No iloc-reachable data precedes the meta growth in a way we must shift:
    // iloc extents point at mdat, which sits AFTER meta, so their absolute
    // offsets shift by the meta growth delta.
    return spliceMetaAndShiftIloc(bytes, meta, newMeta);
  } catch {
    return bytes;
  }
}

/**
 * Inject an `Exif` metadata item into the AVIF: `infe` entry in `iinf`, `iloc`
 * extent, `cdsc` reference to the primary item in `iref`, and the payload
 * (4-byte TIFF-offset prefix + TIFF bytes) in a new trailing `mdat`.
 * Returns the original bytes unchanged if the container shape is unexpected.
 */
export function injectAvifExifItem(bytes: Uint8Array, exifTiffBytes: Uint8Array): Uint8Array {
  try {
    const meta = parseMetaParts(bytes);
    if (!meta) return bytes;

    const iinf = meta.children.find((c) => c.type === 'iinf');
    const iloc = meta.children.find((c) => c.type === 'iloc');
    if (!iinf || !iloc) return bytes;

    // Next free item id = max existing id + 1 (walk iinf's infe entries).
    const nextItemId = maxItemId(bytes, iinf) + 1;
    if (nextItemId > 0xffff) return bytes; // iinf v0 / 2-byte id world

    // ── iinf: append an infe v2 entry, bump entry count ──
    const newIinf = appendInfe(bytes, iinf, nextItemId, 'Exif');

    // ── iloc: re-serialized below together with the offset shift (the extent
    // for the new item needs the final post-rebuild file offset, which is only
    // known once the new meta size is fixed — two passes). ──

    // ── rebuild meta with all replacements, then fix iloc offsets ──
    const replacements = new Map<BoxSpan, Uint8Array>();
    replacements.set(iinf, newIinf);

    // ── iref: cdsc exifItem → primary (create the box when absent) ──
    const foundIref = meta.children.find((c) => c.type === 'iref');
    const appendedChildren: Uint8Array[] = [];
    if (foundIref) {
      const rebuilt = appendCdscReference(bytes, foundIref, nextItemId, meta.primaryItemId);
      if (!rebuilt) return bytes;
      replacements.set(foundIref, rebuilt);
    } else {
      appendedChildren.push(buildIrefV0(nextItemId, meta.primaryItemId));
    }

    // First pass: rebuild meta with the CURRENT iloc bytes to learn the meta
    // growth delta from the iinf/iref changes alone…
    const newMeta = rebuildMeta(bytes, meta, replacements, appendedChildren);
    const delta = newMeta.length - (meta.metaBoxEnd - meta.metaOffset);
    const beforeMetaLength = meta.metaOffset;
    const afterMetaLength = bytes.length - meta.metaBoxEnd;
    const metaBaseOffset = beforeMetaLength + newMeta.length + afterMetaLength + 8; // +8 = mdat header

    const exifPayload = new Uint8Array(4 + exifTiffBytes.length);
    // Big-endian offset from the start of the Exif item data to the TIFF header.
    exifPayload.set(exifTiffBytes, 4);

    // …then re-serialize iloc: shift existing entries and place the new item's
    // extent. Two feedback terms settle together: the rewritten iloc grows the
    // meta box (moving the appended mdat AND the existing mdat), and the new
    // extent's absolute offset must match the final layout. Iterate until the
    // layout and the written offsets agree (the iloc byte size is independent
    // of the offset values, so this converges after one extra pass).
    let ilocGrowth = 0;
    let finalMeta = newMeta;
    for (let pass = 0; pass < 3; pass++) {
      const newIloc = rewriteIloc(bytes, iloc, delta + ilocGrowth, [
        { itemId: nextItemId, dataOffset: metaBaseOffset + ilocGrowth, dataLength: exifPayload.length },
      ]);
      if (!newIloc) return bytes;
      replacements.set(iloc, newIloc);
      finalMeta = rebuildMeta(bytes, meta, replacements, appendedChildren);
      const growth = finalMeta.length - newMeta.length;
      if (growth === ilocGrowth) break;
      ilocGrowth = growth;
    }

    // ── assemble: [before meta][new meta][after meta][new mdat] ──
    const mdatBox = wrapBox('mdat', exifPayload);
    const result = new Uint8Array(
      beforeMetaLength + finalMeta.length + afterMetaLength + mdatBox.length,
    );
    result.set(bytes.subarray(0, meta.metaOffset), 0);
    result.set(finalMeta, beforeMetaLength);
    result.set(bytes.subarray(meta.metaBoxEnd), beforeMetaLength + finalMeta.length);
    result.set(mdatBox, beforeMetaLength + finalMeta.length + afterMetaLength);
    return result;
  } catch {
    return bytes;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Container structure parsing
// ═══════════════════════════════════════════════════════════════════════════════

function childSpans(bytes: Uint8Array, start: number, end: number): BoxSpan[] {
  const spans: BoxSpan[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    const header = readBoxHeader(bytes, pos);
    if (!header || header.boxEnd > end) break;
    spans.push({ type: header.type, dataOffset: header.dataOffset, boxEnd: header.boxEnd });
    pos = header.boxEnd;
  }
  return spans;
}

/** Locate the meta FullBox and its children plus the primary item id. */
function parseMetaParts(bytes: Uint8Array): MetaParts | null {
  let pos = 0;
  while (pos + 8 <= bytes.length) {
    const header = readBoxHeader(bytes, pos);
    if (!header) return null;
    if (header.type === 'meta') {
      // meta is a FullBox: 4 bytes version/flags, then plain child boxes.
      const contentStart = header.dataOffset + 4;
      const children = childSpans(bytes, contentStart, header.boxEnd);
      let primaryItemId = 0;
      const pitm = children.find((c) => c.type === 'pitm');
      if (pitm && pitm.boxEnd - pitm.dataOffset >= 6) {
        // pitm is a FullBox: skip its 4 version/flags bytes, id is 2-byte (v0).
        primaryItemId = (bytes[pitm.dataOffset + 4] << 8) | bytes[pitm.dataOffset + 5];
      }
      if (primaryItemId === 0) return null;
      return {
        metaOffset: header.dataOffset - 8,
        metaBoxEnd: header.boxEnd,
        metaVersionFlags: bytes.slice(header.dataOffset, header.dataOffset + 4),
        children,
        primaryItemId,
      };
    }
    pos = header.boxEnd;
  }
  return null;
}

/** Highest item id declared in iinf's infe entries (any infe version). */
function maxItemId(bytes: Uint8Array, iinf: BoxSpan): number {
  const version = bytes[iinf.dataOffset] & 0x7f;
  let pos = iinf.dataOffset + 4;
  let entryCount: number;
  if (version === 0) {
    entryCount = (bytes[pos] << 8) | bytes[pos + 1];
    pos += 2;
  } else {
    entryCount = u32(bytes, pos);
    pos += 4;
  }
  let max = 0;
  const entriesEnd = iinf.boxEnd;
  let p = pos;
  for (let i = 0; i < entryCount && p + 8 <= entriesEnd; i++) {
    const size = u32(bytes, p);
    if (size < 8 || p + size > entriesEnd) break;
    const infeVersion = bytes[p + 8] & 0x7f;
    const idPos = p + 12; // after infe version/flags
    const id = infeVersion >= 3 ? u32(bytes, idPos) : (bytes[idPos] << 8) | bytes[idPos + 1];
    if (id > max) max = id;
    p += size;
  }
  return max;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Box builders
// ═══════════════════════════════════════════════════════════════════════════════

function wrapBox(type: string, payload: Uint8Array): Uint8Array {
  const box = new Uint8Array(8 + payload.length);
  writeU32(box, 0, box.length);
  writeFourCC(box, 4, type);
  box.set(payload, 8);
  return box;
}

/** Rebuild a container box: original 8-byte header re-sized, new children inside. */
function rebuildBox(
  bytes: Uint8Array,
  original: BoxSpan,
  children: Uint8Array[],
  headerDataStart: number,
): Uint8Array {
  const prefix = bytes.subarray(original.dataOffset, headerDataStart);
  let payloadLength = prefix.length;
  for (const child of children) payloadLength += child.length;
  const out = new Uint8Array(8 + payloadLength);
  writeU32(out, 0, out.length);
  out.set(bytes.subarray(original.dataOffset - 4, original.dataOffset), 4); // box type
  out.set(prefix, 8);
  let pos = 8 + prefix.length;
  for (const child of children) {
    out.set(child, pos);
    pos += child.length;
  }
  return out;
}

/**
 * Rebuild the meta FullBox with some children replaced and some appended.
 * `replacementMap` maps original child spans to their rebuilt box bytes;
 * unmapped children are copied verbatim; `appendedChildren` go last.
 */
function rebuildMeta(
  bytes: Uint8Array,
  meta: MetaParts,
  replacementMap: Map<BoxSpan, Uint8Array>,
  appendedChildren: Uint8Array[] = [],
): Uint8Array {
  const children: Uint8Array[] = [];
  for (const child of meta.children) {
    children.push(replacementMap.get(child) ?? bytes.slice(child.dataOffset - 8, child.boxEnd));
  }
  children.push(...appendedChildren);

  let payloadLength = meta.metaVersionFlags.length;
  for (const child of children) payloadLength += child.length;
  const out = new Uint8Array(8 + payloadLength);
  writeU32(out, 0, out.length);
  writeFourCC(out, 4, 'meta');
  out.set(meta.metaVersionFlags, 8);
  let pos = 12;
  for (const child of children) {
    out.set(child, pos);
    pos += child.length;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ipma (item → property association)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Re-serialize one ipma with `newIndices` appended to the target item's
 * association (an association entry is added when the item has none). Version
 * and flags (index width) are preserved; all indices involved must fit the
 * existing width.
 */
function associateIpma(
  bytes: Uint8Array,
  ipma: BoxSpan,
  targetItemId: number,
  newIndices: number[],
): Uint8Array | null {
  const version = bytes[ipma.dataOffset] & 0x7f;
  const flags = (bytes[ipma.dataOffset + 1] << 16) | (bytes[ipma.dataOffset + 2] << 8) | bytes[ipma.dataOffset + 3];
  const twoByteIndices = (flags & 1) === 1;
  const maxIndex = twoByteIndices ? 0x7fff : 0x7f;
  for (const idx of newIndices) if (idx > maxIndex) return null;

  let p = ipma.dataOffset + 4;
  const entryCount = u32(bytes, p);
  p += 4;

  interface Entry { itemId: number; indices: number[] }
  const entries: Entry[] = [];
  for (let i = 0; i < entryCount && p < ipma.boxEnd; i++) {
    let itemId: number;
    if (version < 1) {
      itemId = (bytes[p] << 8) | bytes[p + 1];
      p += 2;
    } else {
      itemId = u32(bytes, p);
      p += 4;
    }
    const assocCount = bytes[p++];
    const indices: number[] = [];
    for (let k = 0; k < assocCount && p < ipma.boxEnd; k++) {
      if (twoByteIndices) {
        indices.push(((bytes[p] << 8) | bytes[p + 1]) & 0x7fff);
        p += 2;
      } else {
        indices.push(bytes[p] & 0x7f);
        p += 1;
      }
    }
    entries.push({ itemId, indices });
  }

  const target = entries.find((e) => e.itemId === targetItemId);
  if (target) target.indices.push(...newIndices);
  else entries.push({ itemId: targetItemId, indices: [...newIndices] });

  // Serialize. Item id width follows the version; drop stale essential bits —
  // `prof` colr is a non-essential property (viewers fall back to nclx).
  const parts: Uint8Array[] = [];
  let total = 4 + 4;
  for (const entry of entries) {
    const idSize = version < 1 ? 2 : 4;
    const size = idSize + 1 + entry.indices.length * (twoByteIndices ? 2 : 1);
    const buf = new Uint8Array(size);
    let q = 0;
    if (version < 1) {
      buf[q++] = (entry.itemId >> 8) & 0xff;
      buf[q++] = entry.itemId & 0xff;
    } else {
      writeU32(buf, q, entry.itemId);
      q += 4;
    }
    buf[q++] = entry.indices.length;
    for (const idx of entry.indices) {
      if (twoByteIndices) {
        buf[q++] = (idx >> 8) & 0x7f;
        buf[q++] = idx & 0xff;
      } else {
        buf[q++] = idx & 0x7f;
      }
    }
    parts.push(buf);
    total += size;
  }
  const out = new Uint8Array(8 + total);
  writeU32(out, 0, out.length);
  writeFourCC(out, 4, 'ipma');
  out[8] = bytes[ipma.dataOffset]; // version
  out[9] = bytes[ipma.dataOffset + 1];
  out[10] = bytes[ipma.dataOffset + 2];
  out[11] = bytes[ipma.dataOffset + 3];
  writeU32(out, 12, entries.length);
  let pos = 16;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

/** Fresh single-entry ipma (v0, 1-byte indices) for the primary item. */
function buildIpma(targetItemId: number, indices: number[]): Uint8Array {
  const out = new Uint8Array(8 + 4 + 4 + 3 + indices.length);
  writeU32(out, 0, out.length);
  writeFourCC(out, 4, 'ipma');
  out[8] = 0; // version 0
  out[11] = 0; // flags 0 → 1-byte indices
  writeU32(out, 12, 1); // one association entry
  out[16] = (targetItemId >> 8) & 0xff;
  out[17] = targetItemId & 0xff;
  out[18] = indices.length;
  indices.forEach((idx, i) => {
    out[19 + i] = idx & 0x7f;
  });
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// iinf / infe (item information)
// ═══════════════════════════════════════════════════════════════════════════════

/** Rebuild iinf with a new infe v2 entry appended (item type, empty name). */
function appendInfe(bytes: Uint8Array, iinf: BoxSpan, itemId: number, itemType: string): Uint8Array {
  const version = bytes[iinf.dataOffset] & 0x7f;
  const countFieldSize = version === 0 ? 2 : 4;
  const entriesStart = iinf.dataOffset + 4 + countFieldSize;
  const originalEntries = bytes.slice(entriesStart, iinf.boxEnd);

  const infe = new Uint8Array(8 + 4 + 2 + 2 + 4 + 1);
  writeU32(infe, 0, infe.length);
  writeFourCC(infe, 4, 'infe');
  infe[8] = 2; // version 2
  writeU16(infe, 12, itemId);
  writeU16(infe, 14, 0); // item_protection_index
  writeFourCC(infe, 16, itemType);
  infe[20] = 0; // empty item_name

  const newCount = countEntries(bytes, iinf) + 1;
  const out = new Uint8Array(8 + 4 + countFieldSize + originalEntries.length + infe.length);
  writeU32(out, 0, out.length);
  writeFourCC(out, 4, 'iinf');
  out[8] = bytes[iinf.dataOffset]; // keep version
  let pos = 12;
  if (version === 0) writeU16(out, pos, newCount);
  else writeU32(out, pos, newCount);
  pos += countFieldSize;
  out.set(originalEntries, pos);
  pos += originalEntries.length;
  out.set(infe, pos);
  return out;
}

function countEntries(bytes: Uint8Array, iinf: BoxSpan): number {
  const version = bytes[iinf.dataOffset] & 0x7f;
  const p = iinf.dataOffset + 4;
  return version === 0 ? (bytes[p] << 8) | bytes[p + 1] : u32(bytes, p);
}

// ═══════════════════════════════════════════════════════════════════════════════
// iref (item references)
// ═══════════════════════════════════════════════════════════════════════════════

/** Append/extend a `cdsc` reference (from = Exif item, to = primary) in iref. */
function appendCdscReference(
  bytes: Uint8Array,
  iref: BoxSpan,
  fromItemId: number,
  toItemId: number,
): Uint8Array | null {
  const version = bytes[iref.dataOffset] & 0x7f;
  if (version > 1) return null;
  const idSize = version === 0 ? 2 : 4;
  const children = childSpans(bytes, iref.dataOffset + 4, iref.boxEnd);
  const outChildren: Uint8Array[] = [];
  let extended = false;
  for (const child of children) {
    const raw = bytes.slice(child.dataOffset - 8, child.boxEnd);
    if (child.type === 'cdsc' && !extended) {
      const payload = bytes.subarray(child.dataOffset, child.boxEnd);
      const count = (payload[idSize] << 8) | payload[idSize + 1];
      const extendedPayload = new Uint8Array(payload.length + idSize);
      extendedPayload.set(payload, 0);
      if (idSize === 2) {
        extendedPayload[idSize] = (count + 1) >> 8;
        extendedPayload[idSize + 1] = (count + 1) & 0xff;
        writeU16(extendedPayload, payload.length, toItemId);
      } else {
        extendedPayload[idSize] = (count + 1) >>> 24;
        extendedPayload[idSize + 1] = ((count + 1) >> 16) & 0xff;
        extendedPayload[idSize + 2] = ((count + 1) >> 8) & 0xff;
        extendedPayload[idSize + 3] = (count + 1) & 0xff;
        writeU32(extendedPayload, payload.length, toItemId);
      }
      const resized = new Uint8Array(extendedPayload.length + 8);
      writeU32(resized, 0, resized.length);
      writeFourCC(resized, 4, 'cdsc');
      resized.set(extendedPayload, 8);
      outChildren.push(resized);
      extended = true;
    } else {
      outChildren.push(raw);
    }
  }
  if (!extended) {
    const cdsc = new Uint8Array(8 + idSize + 2 + idSize);
    writeU32(cdsc, 0, cdsc.length);
    writeFourCC(cdsc, 4, 'cdsc');
    let q = 8;
    if (idSize === 2) {
      writeU16(cdsc, q, fromItemId);
      q += 2;
      writeU16(cdsc, q, 1);
      q += 2;
      writeU16(cdsc, q, toItemId);
    } else {
      writeU32(cdsc, q, fromItemId);
      q += 4;
      writeU16(cdsc, q, 1);
      q += 2;
      writeU32(cdsc, q, toItemId);
    }
    outChildren.push(cdsc);
  }
  return rebuildBox(bytes, iref, outChildren, iref.dataOffset + 4);
}

/** Fresh iref v0 with a single cdsc box. */
function buildIrefV0(fromItemId: number, toItemId: number): Uint8Array {
  const cdsc = new Uint8Array(8 + 6);
  writeU32(cdsc, 0, cdsc.length);
  writeFourCC(cdsc, 4, 'cdsc');
  writeU16(cdsc, 8, fromItemId);
  writeU16(cdsc, 10, 1);
  writeU16(cdsc, 12, toItemId);
  const iref = new Uint8Array(8 + 4 + cdsc.length);
  writeU32(iref, 0, iref.length);
  writeFourCC(iref, 4, 'iref');
  iref[8] = 0; // version 0
  iref.set(cdsc, 12);
  return iref;
}

// ═══════════════════════════════════════════════════════════════════════════════
// iloc (item location) — full re-serialization
// ═══════════════════════════════════════════════════════════════════════════════

interface IlocAppendedEntry { itemId: number; dataOffset: number; dataLength: number }

/**
 * Re-serialize the iloc box: every `construction_method` 0 entry's base_offset
 * and extent offsets shift by `delta` (meta growth moved the mdat), entries are
 * preserved with their original field widths, and `appended` entries are added.
 * Returns null when the layout is one this writer cannot safely rewrite.
 */
function rewriteIloc(
  bytes: Uint8Array,
  iloc: BoxSpan,
  delta: number,
  appended: IlocAppendedEntry[],
): Uint8Array | null {
  const version = bytes[iloc.dataOffset] & 0x7f;
  if (version > 2) return null;
  const sizesByte = bytes[iloc.dataOffset + 4];
  const offsetSize = (sizesByte >> 4) & 0x0f;
  const lengthSize = sizesByte & 0x0f;
  // v1/v2 add a second byte: base_offset_size (hi nibble) + item index size.
  const baseOffsetSize = (bytes[iloc.dataOffset + 5] >> 4) & 0x0f;
  // v1/v2: low nibble of byte 5 is index_size (per-extent extent_index field).
  const indexSize = version >= 1 ? bytes[iloc.dataOffset + 5] & 0x0f : 0;
  const idSize = version === 2 ? 4 : 2;
  // Offsets wider than 4 bytes cannot be patched with the u32 writer here.
  if (offsetSize > 4 || lengthSize > 4 || baseOffsetSize > 4 || indexSize > 4) return null;

  let p = iloc.dataOffset + 4 + 2;
  let itemCount: number;
  if (version < 2) {
    itemCount = (bytes[p] << 8) | bytes[p + 1];
    p += 2;
  } else {
    itemCount = u32(bytes, p);
    p += 4;
  }

  interface Extent { index: number; offset: number; length: number }
  interface Entry {
    itemId: number;
    constructionMethod: number;
    dataReferenceIndex: number;
    baseOffset: number;
    extents: Extent[];
  }
  const entries: Entry[] = [];
  for (let i = 0; i < itemCount && p + 6 <= iloc.boxEnd; i++) {
    const itemId = readUint(bytes, p, idSize);
    p += idSize;
    let constructionMethod = 0;
    if (version >= 1) {
      constructionMethod = (bytes[p] << 8) | bytes[p + 1];
      p += 2;
    }
    const dataReferenceIndex = (bytes[p] << 8) | bytes[p + 1];
    p += 2;
    const baseOffset = readUint(bytes, p, baseOffsetSize);
    p += baseOffsetSize;
    const extentCount = (bytes[p] << 8) | bytes[p + 1];
    p += 2;
    const extents: Extent[] = [];
    for (let k = 0; k < extentCount; k++) {
      const index = readUint(bytes, p, indexSize);
      p += indexSize;
      const offset = readUint(bytes, p, offsetSize);
      p += offsetSize;
      const length = readUint(bytes, p, lengthSize);
      p += lengthSize;
      extents.push({ index, offset, length });
    }
    entries.push({ itemId, constructionMethod, dataReferenceIndex, baseOffset, extents });
  }

  // Shift absolute file offsets of in-file data (method 0, no external reference).
  for (const entry of entries) {
    if (entry.constructionMethod !== 0 || entry.dataReferenceIndex !== 0) continue;
    if (entry.baseOffset !== 0) entry.baseOffset += delta;
    for (const extent of entry.extents) extent.offset += delta;
  }

  // Append the new entries (always in-file, method 0).
  for (const item of appended) {
    entries.push({
      itemId: item.itemId,
      constructionMethod: 0,
      dataReferenceIndex: 0,
      baseOffset: 0,
      extents: [{ index: 0, offset: item.dataOffset, length: item.dataLength }],
    });
  }

  // Serialize with the ORIGINAL field widths.
  const newCount = entries.length;
  const body: Uint8Array[] = [];
  let bodyLength = 0;
  for (const entry of entries) {
    const size =
      idSize +
      (version >= 1 ? 2 : 0) +
      2 +
      baseOffsetSize +
      2 +
      entry.extents.length * (indexSize + offsetSize + lengthSize);
    const buf = new Uint8Array(size);
    let q = 0;
    writeUint(buf, q, entry.itemId, idSize);
    q += idSize;
    if (version >= 1) {
      writeUint(buf, q, entry.constructionMethod, 2);
      q += 2;
    }
    writeUint(buf, q, entry.dataReferenceIndex, 2);
    q += 2;
    writeUint(buf, q, entry.baseOffset, baseOffsetSize);
    q += baseOffsetSize;
    writeUint(buf, q, entry.extents.length, 2);
    q += 2;
    for (const extent of entry.extents) {
      writeUint(buf, q, extent.index, indexSize);
      q += indexSize;
      writeUint(buf, q, extent.offset, offsetSize);
      q += offsetSize;
      writeUint(buf, q, extent.length, lengthSize);
      q += lengthSize;
    }
    body.push(buf);
    bodyLength += size;
  }

  const countFieldSize = version < 2 ? 2 : 4;
  const out = new Uint8Array(8 + 4 + 2 + countFieldSize + bodyLength);
  writeU32(out, 0, out.length);
  writeFourCC(out, 4, 'iloc');
  out[8] = bytes[iloc.dataOffset]; // keep version
  out[9] = bytes[iloc.dataOffset + 1]; // keep flags verbatim
  out[10] = bytes[iloc.dataOffset + 2];
  out[11] = bytes[iloc.dataOffset + 3];
  out[12] = sizesByte; // offset/length/base sizes verbatim
  out[13] = bytes[iloc.dataOffset + 5];
  let pos = 14 + countFieldSize;
  if (version < 2) writeU16(out, 14, newCount);
  else writeU32(out, 14, newCount);
  for (const part of body) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Shared low-level byte helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Rebuild the whole file after meta grew: splice in the new meta bytes and
 * shift every iloc extent by the growth delta. Used by the colour-profile path
 * (the EXIF path folds the shift into its own iloc rewrite).
 */
function spliceMetaAndShiftIloc(bytes: Uint8Array, meta: MetaParts, newMeta: Uint8Array): Uint8Array {
  const delta = newMeta.length - (meta.metaBoxEnd - meta.metaOffset);
  if (delta === 0) {
    const same = new Uint8Array(bytes.length);
    same.set(bytes.subarray(0, meta.metaOffset), 0);
    same.set(newMeta, meta.metaOffset);
    same.set(bytes.subarray(meta.metaBoxEnd), meta.metaOffset + newMeta.length);
    return same;
  }

  // Patch the iloc (still in its ORIGINAL position inside the new meta) by
  // rewriting it once more with the delta applied. Locate it in newMeta.
  const newIlocSpan = childSpans(newMeta, 12, newMeta.length).find((c) => c.type === 'iloc');
  if (!newIlocSpan) {
    // No iloc — nothing can dangle; a plain splice is safe.
    const out = new Uint8Array(bytes.length + delta);
    out.set(bytes.subarray(0, meta.metaOffset), 0);
    out.set(newMeta, meta.metaOffset);
    out.set(bytes.subarray(meta.metaBoxEnd), meta.metaOffset + newMeta.length);
    return out;
  }
  const patched = rewriteIloc(
    newMeta,
    { type: 'iloc', dataOffset: newIlocSpan.dataOffset, boxEnd: newIlocSpan.boxEnd },
    delta,
    [],
  );
  const finalMeta = patched
    ? spliceBytes(newMeta, newIlocSpan.dataOffset - 8, newIlocSpan.boxEnd, patched)
    : newMeta;
  const finalDelta = finalMeta.length - (meta.metaBoxEnd - meta.metaOffset);
  if (finalDelta !== delta) {
    // A width upgrade changed the delta — re-derive until stable (at most two
    // iterations in practice: widths grow once, then converge).
    return spliceMetaAndShiftIloc(bytes, meta, finalMeta);
  }
  const out = new Uint8Array(bytes.length + delta);
  out.set(bytes.subarray(0, meta.metaOffset), 0);
  out.set(finalMeta, meta.metaOffset);
  out.set(bytes.subarray(meta.metaBoxEnd), meta.metaOffset + finalMeta.length);
  return out;
}

function spliceBytes(bytes: Uint8Array, start: number, end: number, replacement: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length - (end - start) + replacement.length);
  out.set(bytes.subarray(0, start), 0);
  out.set(replacement, start);
  out.set(bytes.subarray(end), start + replacement.length);
  return out;
}

function readUint(bytes: Uint8Array, offset: number, size: number): number {
  let value = 0;
  for (let i = 0; i < size; i++) value = value * 0x100 + bytes[offset + i];
  return value;
}

function writeUint(bytes: Uint8Array, offset: number, value: number, size: number): void {
  for (let i = size - 1; i >= 0; i--) {
    bytes[offset + i] = value & 0xff;
    value = Math.floor(value / 0x100);
  }
}

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >> 16) & 0xff;
  bytes[offset + 2] = (value >> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function writeFourCC(bytes: Uint8Array, offset: number, value: string): void {
  for (let i = 0; i < 4; i++) bytes[offset + i] = value.charCodeAt(i);
}

function u32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}
