/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * AVIF full container parser — produces the {@link AvifFileView} that
 * `extractAvifMetadata` reads its truths from (bit depth / alpha / size /
 * sequence / colour / EXIF / XMP).
 *
 * Sibling of `handlers/heic/metadata/container.ts`: same ISOBMFF box family,
 * a strictly smaller surface (no grid/tile assembly — AVIF stills are single
 * items), plus the AV1-specific `av1C`. Box primitives are imported from
 * `metadata/isobmff-reader.ts` (the shared home); every non-obvious layout
 * decision below is probe-verified against synthetic avifenc/libavif samples
 * (probe 2026-10-13):
 *
 *   - `ispe`, `pixi` and `auxC` are FullBoxes (4-byte version/flags prefix) —
 *     the HEIC lesson repeats verbatim in AVIF; bare payload reads misalign;
 *   - av1C byte 2 bit layout (ISO 23091-2): seq_tier(7),
 *     high_bitdepth(6), twelve_bit(5), monochrome(4), chroma_subsampling_x(3),
 *     chroma_subsampling_y(2), chroma_sample_position(0-1) — reading
 *     high_bitdepth from bit 7 misclassifies every 10/12-bit file as 8-bit;
 *   - the alpha aux URN written by libavif is
 *     `urn:mpeg:mpegB:cicp:systems:auxiliary:alpha` (CICP systems form); the
 *     AVIF spec's `urn:mpeg:avif:aux:alpha:0` form is accepted too;
 *   - animated AVIF is an ISOBMFF *sequence*: top-level `moov` + an av01
 *     video-like track. Still images have no moov — its presence is the
 *     multi-frame verdict (`isSequence`);
 *   - `irot` angle = LOW 2 bits of its payload byte (same as HEIC);
 *   - EXIF item data carries a 4-byte big-endian TIFF offset prefix
 *     (handled by `locateItemData` callers — stripped here).
 *
 * Payload gating: metadata items (EXIF/XMP) are resolved; coded image data
 * (mdat av01 extents) is never copied — the pixel bytes stay in the retained
 * source blob and the decode channel reads them itself.
 *
 * @module core/files/handlers/avif/metadata/container
 */

import {
  readBoxHeader,
  getFourCC,
  locateItemData,
  type NclxParams,
} from '../../../metadata/isobmff-reader';

// ═══════════════════════════════════════════════════════════════════════════════
// Public Types (probe-verified)
// ═══════════════════════════════════════════════════════════════════════════════

export interface Av1CFields {
  seqProfile: number;
  seqLevelIdx: number;
  highBitdepth: boolean;
  twelveBit: boolean;
  monochrome: boolean;
  chromaSubsamplingX: boolean;
  chromaSubsamplingY: boolean;
  /** 8 | 10 | 12 — derived from high_bitdepth/twelve_bit. */
  bits: 8 | 10 | 12;
}

export interface AvifPrimary {
  itemId: number;
  av1C: Av1CFields | null;
  ispe: { width: number; height: number } | null;
  pixi: { channels: number; bits: number[] } | null;
  /** colr nclx on the primary (null when the file tags colour via ICC only). */
  nclx: NclxParams | null;
  /** colr prof/rICC bytes on the primary. */
  icc: Uint8Array | null;
  irotQuarterTurns: 0 | 1 | 2 | 3;
  /** 0 = vertical axis, 1 = horizontal axis; null when no imir property. */
  imirAxis: 0 | 1 | null;
}

export interface AvifFileView {
  ftyp: { major: string; compat: string[] };
  /** Top-level `moov` present — an AVIF image sequence (animated). */
  isSequence: boolean;
  primaryItemId: number | null;
  primary: AvifPrimary;
  /** pixi first channel → av1C bits fallback → 8. NEVER clamped. */
  bitDepth: 8 | 10 | 12;
  /** Alpha aux item (auxC alpha URN) referenced to the primary via `auxl`. */
  hasAlpha: boolean;
  metadata: { exif?: Uint8Array; xmp?: string };
  itemCount: number;
  /** Non-fatal skips (unknown boxes, unreadable optional payloads). */
  warnings: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Parsing
// ═══════════════════════════════════════════════════════════════════════════════

interface BoxSpan { type: string; dataOffset: number; boxEnd: number }

interface AvifItem {
  id: number;
  type: string;
  name: string;
  contentType?: string;
  props: AvifProperty[];
}

interface AvifProperty {
  index: number; // 1-based ipco position
  type: string;
  av1C?: Av1CFields;
  ispe?: { width: number; height: number };
  pixi?: { channels: number; bits: number[] };
  nclx?: NclxParams;
  iccBytes?: Uint8Array;
  auxType?: string;
  irotQuarterTurns?: 0 | 1 | 2 | 3;
  imirAxis?: 0 | 1;
}

interface ItemAssociation { itemId: number; indices: number[] }

/** Alpha auxiliary URNs (both the CICP-systems form libavif writes and the
 *  AVIF-spec form — probe-verified 2026-10-13). */
const ALPHA_AUX_URNS = [
  'urn:mpeg:mpegB:cicp:systems:auxiliary:alpha',
  'urn:mpeg:avif:aux:alpha:0',
];

const XMP_CONTENT_TYPE = 'application/rdf+xml';

export function parseAvifContainer(bytes: Uint8Array): AvifFileView {
  const warnings: string[] = [];
  const view: AvifFileView = {
    ftyp: { major: '', compat: [] },
    isSequence: false,
    primaryItemId: null,
    primary: {
      itemId: 0,
      av1C: null,
      ispe: null,
      pixi: null,
      nclx: null,
      icc: null,
      irotQuarterTurns: 0,
      imirAxis: null,
    },
    bitDepth: 8,
    hasAlpha: false,
    metadata: {},
    itemCount: 0,
    warnings,
  };

  // ── top-level walk: ftyp brands, moov presence, meta payload ──
  let metaContent: Uint8Array | null = null;
  let pos = 0;
  while (pos + 8 <= bytes.length) {
    const header = readBoxHeader(bytes, pos);
    if (!header) break;
    if (header.type === 'ftyp') {
      const p = bytes.subarray(header.dataOffset, header.boxEnd);
      if (p.length >= 8) {
        view.ftyp.major = getFourCC(p, 0);
        for (let o = 8; o + 4 <= p.length; o += 4) view.ftyp.compat.push(getFourCC(p, o));
      }
    } else if (header.type === 'moov') {
      view.isSequence = true;
    } else if (header.type === 'meta' && !metaContent) {
      // meta is a FullBox: skip 4 bytes (version + flags)
      metaContent = bytes.subarray(header.dataOffset + 4, header.boxEnd);
    }
    pos = header.boxEnd;
  }
  if (!metaContent) {
    warnings.push('no meta box');
    return view;
  }

  // ── item information (iinf → infe entries) ──
  const items = parseIinf(metaContent);
  view.itemCount = items.length;

  // ── primary item id (pitm, v0 = 2-byte id) ──
  const pitmPayload = findChild(metaContent, 'pitm');
  if (pitmPayload && pitmPayload.length >= 6 && pitmPayload[0] === 0) {
    view.primaryItemId = (pitmPayload[4] << 8) | pitmPayload[5];
  }

  // ── property pool + associations (iprp → ipco / ipma+) ──
  const { pool, associations } = parseIpcoAndIpma(metaContent);

  // ── item references (iref: auxl / cdsc / Thmb) ──
  const refs = parseIref(metaContent);

  // ── attach associated properties per item ──
  for (const assoc of associations) {
    const item = items.find((i) => i.id === assoc.itemId);
    if (!item) continue;
    for (const idx of assoc.indices) {
      const prop = pool[idx - 1];
      if (prop) item.props.push(prop);
    }
  }

  // ── primary view ──
  const primaryItem = items.find((i) => i.id === view.primaryItemId)
    ?? items.find((i) => i.type === 'av01');
  if (primaryItem) {
    view.primaryItemId = primaryItem.id;
    view.primary.itemId = primaryItem.id;
    for (const prop of primaryItem.props) {
      if (prop.av1C) view.primary.av1C = prop.av1C;
      else if (prop.ispe) view.primary.ispe = prop.ispe;
      else if (prop.pixi) view.primary.pixi = prop.pixi;
      else if (prop.nclx) view.primary.nclx = prop.nclx;
      else if (prop.iccBytes) view.primary.icc = prop.iccBytes;
      else if (prop.irotQuarterTurns !== undefined) view.primary.irotQuarterTurns = prop.irotQuarterTurns;
      else if (prop.imirAxis !== undefined) view.primary.imirAxis = prop.imirAxis;
    }
  }

  // ── bit depth truth: pixi (grid/primary declarations) → av1C fallback ──
  if (view.primary.pixi && view.primary.pixi.bits.length > 0) {
    const depth = view.primary.pixi.bits[0];
    if (depth === 8 || depth === 10 || depth === 12) view.bitDepth = depth;
    else warnings.push(`pixi declares unsupported depth ${depth}`);
  } else if (view.primary.av1C) {
    view.bitDepth = view.primary.av1C.bits;
  }

  // ── alpha: aux item with an alpha URN, referenced to the primary via auxl ──
  for (const ref of refs) {
    if (ref.kind !== 'auxl' || !ref.to.includes(view.primaryItemId ?? -1)) continue;
    const auxItem = items.find((i) => i.id === ref.from);
    const auxType = auxItem?.props.find((p) => p.auxType !== undefined)?.auxType;
    if (auxType && ALPHA_AUX_URNS.includes(auxType)) {
      view.hasAlpha = true;
      break;
    }
  }

  // ── EXIF / XMP: cdsc-linked to the primary, else the first such item ──
  const exifItem = pickMetadataItem(items, refs, view.primaryItemId, 'Exif');
  if (exifItem) {
    const data = locateItemData(metaContent, exifItem.id, bytes);
    if (data && data.length > 4) {
      // 4-byte BE offset prefix: where the TIFF header starts after the prefix
      const tiffOffset = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
      const dataStart = 4 + tiffOffset;
      if (dataStart < data.length) view.metadata.exif = data.subarray(dataStart);
    } else {
      warnings.push('Exif item unreadable');
    }
  }
  const xmpItem = pickMetadataItem(items, refs, view.primaryItemId, 'mime', XMP_CONTENT_TYPE);
  if (xmpItem) {
    const data = locateItemData(metaContent, xmpItem.id, bytes);
    if (data) view.metadata.xmp = new TextDecoder().decode(data);
  }

  return view;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Internal: box walkers
// ═══════════════════════════════════════════════════════════════════════════════

function* childBoxes(payload: Uint8Array): Generator<BoxSpan> {
  let pos = 0;
  while (pos + 8 <= payload.length) {
    const header = readBoxHeader(payload, pos);
    if (!header) return;
    yield { type: header.type, dataOffset: header.dataOffset, boxEnd: header.boxEnd };
    pos = header.boxEnd;
  }
}

function findChild(payload: Uint8Array, targetType: string): Uint8Array | null {
  for (const box of childBoxes(payload)) {
    if (box.type === targetType) return payload.subarray(box.dataOffset, box.boxEnd);
  }
  return null;
}

/** iinf → infe entries (id / type / name / content-type). */
function parseIinf(metaContent: Uint8Array): AvifItem[] {
  const iinfPayload = findChild(metaContent, 'iinf');
  if (!iinfPayload || iinfPayload.length < 4) return [];
  const iinfVersion = iinfPayload[0] & 0x7f;
  let pos = 4; // version + flags
  let entryCount: number;
  if (iinfVersion === 0) {
    if (pos + 2 > iinfPayload.length) return [];
    entryCount = (iinfPayload[pos] << 8) | iinfPayload[pos + 1];
    pos += 2;
  } else {
    entryCount = (iinfPayload[pos] << 24) | (iinfPayload[pos + 1] << 16) | (iinfPayload[pos + 2] << 8) | iinfPayload[pos + 3];
    pos += 4;
  }
  const items: AvifItem[] = [];
  const entries = iinfPayload.subarray(pos);
  for (const box of childBoxes(entries)) {
    if (box.type !== 'infe') continue;
    const infe = entries.subarray(box.dataOffset, box.boxEnd);
    if (infe.length < 8) continue;
    const version = infe[0] & 0x7f;
    let p = 4; // version + flags
    let id = -1;
    if (version >= 3) {
      id = (infe[p] << 24) | (infe[p + 1] << 16) | (infe[p + 2] << 8) | infe[p + 3];
      p += 4;
    } else {
      id = (infe[p] << 8) | infe[p + 1];
      p += 2;
    }
    p += 2; // item_protection_index
    let type = '';
    let name = '';
    let contentType: string | undefined;
    if (version >= 2) {
      type = getFourCC(infe, p);
      p += 4;
      const nameEnd = readCString(infe, p);
      name = text(infe, p, nameEnd);
      p = nameEnd + 1;
      if (type === 'mime') {
        const ctEnd = readCString(infe, p);
        contentType = text(infe, p, ctEnd);
      }
    }
    items.push({ id, type, name, contentType, props: [] });
    if (items.length >= entryCount) break;
  }
  return items;
}

/** iprp → (ipco, ipma+): property pool + ALL association boxes. */
function parseIpcoAndIpma(metaContent: Uint8Array): {
  pool: AvifProperty[];
  associations: ItemAssociation[];
} {
  const pool: AvifProperty[] = [];
  const associations: ItemAssociation[] = [];
  const iprpPayload = findChild(metaContent, 'iprp');
  if (!iprpPayload) return { pool, associations };

  let ipcoPayload: Uint8Array | null = null;
  const ipmaPayloads: Uint8Array[] = [];
  for (const box of childBoxes(iprpPayload)) {
    if (box.type === 'ipco') ipcoPayload = iprpPayload.subarray(box.dataOffset, box.boxEnd);
    else if (box.type === 'ipma') ipmaPayloads.push(iprpPayload.subarray(box.dataOffset, box.boxEnd));
  }
  if (!ipcoPayload) return { pool, associations };

  // property pool
  for (const box of childBoxes(ipcoPayload)) {
    const payload = ipcoPayload.subarray(box.dataOffset, box.boxEnd);
    const prop: AvifProperty = { index: pool.length + 1, type: box.type };
    if (box.type === 'av1C') prop.av1C = parseAv1C(payload);
    else if (box.type === 'ispe') prop.ispe = { width: u32(payload, 4), height: u32(payload, 8) }; // FullBox
    else if (box.type === 'pixi') prop.pixi = parsePixi(payload) ?? undefined;
    else if (box.type === 'colr') parseColr(payload, prop);
    else if (box.type === 'auxC') prop.auxType = text(payload, 4, payload.length).replace(/\0.*$/, '');
    else if (box.type === 'irot') prop.irotQuarterTurns = (payload[0] & 0x03) as 0 | 1 | 2 | 3; // LOW 2 bits
    else if (box.type === 'imir') prop.imirAxis = (payload[0] & 0x01) as 0 | 1;
    pool.push(prop);
  }

  // associations (ipma may appear multiple times — HEIC lesson)
  for (const ipma of ipmaPayloads) {
    if (ipma.length < 8) continue;
    const version = ipma[0] & 0x7f;
    const flags = (ipma[1] << 16) | (ipma[2] << 8) | ipma[3];
    const twoByte = (flags & 1) === 1;
    let p = 4;
    const count = u32(ipma, p);
    p += 4;
    for (let i = 0; i < count && p < ipma.length; i++) {
      let itemId: number;
      if (version < 1) {
        itemId = (ipma[p] << 8) | ipma[p + 1];
        p += 2;
      } else {
        itemId = u32(ipma, p);
        p += 4;
      }
      const assocCount = ipma[p++];
      const indices: number[] = [];
      for (let k = 0; k < assocCount && p < ipma.length; k++) {
        if (twoByte) {
          indices.push(((ipma[p] << 8) | ipma[p + 1]) & 0x7fff);
          p += 2;
        } else {
          indices.push(ipma[p] & 0x7f);
          p += 1;
        }
      }
      associations.push({ itemId, indices });
    }
  }
  return { pool, associations };
}

/** iref (v0/v1): typed references between items. */
function parseIref(metaContent: Uint8Array): Array<{ kind: string; from: number; to: number[] }> {
  const irefPayload = findChild(metaContent, 'iref');
  if (!irefPayload || irefPayload.length < 4) return [];
  const version = irefPayload[0] & 0x7f;
  const refs: Array<{ kind: string; from: number; to: number[] }> = [];
  const refBoxes = irefPayload.subarray(4);
  for (const box of childBoxes(refBoxes)) {
    const payload = refBoxes.subarray(box.dataOffset, box.boxEnd);
    let p = 0;
    let from: number;
    if (version === 0) {
      from = (payload[p] << 8) | payload[p + 1];
      p += 2;
    } else {
      from = u32(payload, p);
      p += 4;
    }
    const count = (payload[p] << 8) | payload[p + 1];
    p += 2;
    const to: number[] = [];
    for (let i = 0; i < count; i++) {
      if (version === 0) {
        to.push((payload[p] << 8) | payload[p + 1]);
        p += 2;
      } else {
        to.push(u32(payload, p));
        p += 4;
      }
    }
    refs.push({ kind: box.type, from, to });
  }
  return refs;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Internal: property payload decoders
// ═══════════════════════════════════════════════════════════════════════════════

/** av1C (ISO/IEC 23001-18) — 4-byte fixed record. */
function parseAv1C(payload: Uint8Array): Av1CFields {
  // byte 0: marker(1) version(7); byte 1: seq_profile(3) seq_level_idx(5)
  // byte 2: seq_tier(7) high_bitdepth(6) twelve_bit(5) monochrome(4)
  //         chroma_subsampling_x(3) chroma_subsampling_y(2) chroma_sample_position(0-1)
  const b1 = payload[1] ?? 0;
  const b2 = payload[2] ?? 0;
  const highBitdepth = ((b2 >> 6) & 1) === 1;
  const twelveBit = ((b2 >> 5) & 1) === 1;
  return {
    seqProfile: (b1 >> 5) & 0x07,
    seqLevelIdx: b1 & 0x1f,
    highBitdepth,
    twelveBit,
    monochrome: ((b2 >> 4) & 1) === 1,
    chromaSubsamplingX: ((b2 >> 3) & 1) === 1,
    chromaSubsamplingY: ((b2 >> 2) & 1) === 1,
    bits: highBitdepth ? (twelveBit ? 12 : 10) : 8,
  };
}

/** pixi (FullBox): [version+flags 4B][num_channels 1B][bits_per_channel × n]. */
function parsePixi(payload: Uint8Array): { channels: number; bits: number[] } | null {
  if (payload.length < 5) return null;
  const numChannels = payload[4];
  if (numChannels === 0 || payload.length < 5 + numChannels) return null;
  return { channels: numChannels, bits: Array.from({ length: numChannels }, (_, i) => payload[5 + i]) };
}

/** colr: `nclx` (CICP triple + full-range flag) or `prof`/`rICC` (ICC bytes). */
function parseColr(payload: Uint8Array, prop: AvifProperty): void {
  if (payload.length < 5) return;
  const colourType = getFourCC(payload, 0);
  if (colourType === 'nclx' && payload.length >= 11) {
    prop.nclx = {
      colourPrimaries: (payload[4] << 8) | payload[5],
      transferCharacteristics: (payload[6] << 8) | payload[7],
      matrixCoefficients: (payload[8] << 8) | payload[9],
      fullRangeFlag: (payload[10] & 0x80) !== 0,
    };
  } else if (colourType === 'prof' || colourType === 'rICC') {
    prop.iccBytes = payload.slice(4);
  }
}

/** cdsc-linked metadata item for the primary; falls back to the first match. */
function pickMetadataItem(
  items: AvifItem[],
  refs: Array<{ kind: string; from: number; to: number[] }>,
  primaryItemId: number | null,
  type: string,
  contentType?: string,
): AvifItem | null {
  const matches = items.filter((i) => i.type === type && (contentType === undefined || i.contentType === contentType));
  if (matches.length === 0) return null;
  if (primaryItemId != null) {
    for (const ref of refs) {
      if (ref.kind !== 'cdsc' || !ref.to.includes(primaryItemId)) continue;
      const linked = matches.find((m) => m.id === ref.from);
      if (linked) return linked;
    }
  }
  return matches[0];
}

function readCString(bytes: Uint8Array, start: number): number {
  let end = start;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return end;
}

function text(bytes: Uint8Array, start: number, end: number): string {
  return end <= start ? '' : new TextDecoder().decode(bytes.subarray(start, end));
}

function u32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}
