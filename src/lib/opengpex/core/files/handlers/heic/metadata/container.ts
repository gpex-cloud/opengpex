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
 * HEIC/HEIF full container parser — produces the {@link HeicFileView} that
 * phase-3 WebCodecs hardware decode consumes (tile manifest / hvcC / colour /
 * orientation) and that `extractHeicMetadata` reads its truths from.
 *
 * Peer of `isobmff-reader.ts` (which keeps its three point extractors for AVIF
 * and existing consumers); box primitives are imported from there. Every
 * non-obvious layout decision below is probe-verified against real Apple
 * 12/24/48MP grids and synthetic libheif/x265 files:
 *
 *   - pixi and auxC carry a 4-byte version/flags prefix (FullBox) on BOTH
 *     Apple and libheif-written files — confirmed by hex dump 2026-10-13;
   *   - irot angle = LOW 2 bits of the payload byte. Confirmed by a
   *     synthetic-file experiment (irot=0x03 transposes libheif output,
   *     irot=0xC0 does not): Apple photos carry irot=3 (90° CW) with EXIF 6 as
   *     the same-direction duplicate — an earlier probe's "angle is in the
   *     high bits ⇒ irot is decorative" reading was a mis-read;
 *   - ipma lives UNDER iprp (not directly in meta), can appear multiple
 *     times; flags bit0=0 → 1-byte associations (essential<<7|index),
 *     bit0=1 → 2-byte;
 *   - grid configuration boxes come in three real-world forms (box-headered
 *     22B / standard 14B / Apple compact 8B), and Apple stores them in idat
 *     (iloc construction_method 1);
 *   - tile sizes MUST be read per file from each tile's ispe (512×512,
 *     640×896 and 896×1024 all occur across Apple cameras);
 *   - aux items can be NESTED GRIDS (48MP gain map = 3×5@4032×3024);
 *   - unknown boxes (`clli`, `tmap`, …) are skipped.
 *
 * Payload gating: by default small metadata payloads (grid configs, EXIF, XMP)
 * are resolved but CODED IMAGE DATA (tiles / thumbnails / aux NALs) is NOT
 * copied out — `extractPayload: true` fills the `nalData` fields. Metadata-time
 * parsing must not memcpy tens of MB of tile data just to count boxes.
 *
 * @module core/files/handlers/heic/metadata/container
 */

import type { NclxParams } from '../../../metadata/isobmff-reader';
import { readBoxHeader, findTopLevelBox, findChildBox, getFourCC } from '../../../metadata/isobmff-reader';

// ═══════════════════════════════════════════════════════════════════════════════
// Public Types (probe-verified)
// ═══════════════════════════════════════════════════════════════════════════════

export interface HeicTile {
  itemId: number;
  /** Coded HEVC NAL stream (length-prefixed), empty unless `extractPayload`. */
  nalData: Uint8Array;
  /** Raster position within the grid (0-based); 0/0 for single-tile primaries. */
  gridRow: number;
  gridCol: number;
}

export interface HeicGrid {
  rows: number;
  cols: number;
  outputWidth: number;
  outputHeight: number;
  /** Which of the three real-world wire forms the config used. */
  form: 'box-header' | 'standard' | 'compact-u16';
}

export interface HeicAuxImage {
  itemId: number;
  /** e.g. `urn:com:apple:photo:2020:aux:hdrgainmap`. */
  auxType: string;
  payload: { kind: 'hvc1'; nalData: Uint8Array } | { kind: 'grid'; tiles: HeicTile[]; grid: HeicGrid };
}

export interface HeicFileView {
  primary: {
    itemId: number;
    kind: 'hvc1' | 'grid';
    /** hvcC profile_idc — 3 = Main Still (Apple); picks the capability probe entry. */
    profileIdc: number;
    /** WebCodecs HEVC codec string derived from hvcC (e.g. `hvc1.3.70000000.L90.B0`). */
    codecString: string;
    /** hvcC record verbatim = `VideoDecoderConfig.description`. */
    hvcCDescription: Uint8Array;
    /** Coded size of ONE tile (primary's own ispe for hvc1, tile ispe for grids). */
    codedWidth: number;
    codedHeight: number;
    tiles: HeicTile[];
    grid?: HeicGrid;
  };
  color: { nclx?: NclxParams; icc?: Uint8Array };
  /** pixi on the primary (grid items carry it) — hvcC bitDepthLumaMinus8 fallback. */
  bitDepth: 8 | 10 | 12;
  orientation: {
    irotQuarterTurns: 0 | 1 | 2 | 3;
    /** 0 = vertical axis, 1 = horizontal axis; null when no imir property. */
    imirAxis: 0 | 1 | null;
    exifOrientation: number | null;
  };
  metadata: { exif?: Uint8Array; xmp?: string };
  auxImages: HeicAuxImage[];
  /**
   * The meta box's `idat` payload verbatim (iloc construction-method-1 storage).
   * Inherently small (grid configs + the ISO 21496-1 `tmap` gain-map parameter
   * record are the only real-world contents), so it is resolved unconditionally
   * alongside the other metadata items. The gain-map reader scans it for the
   * `tmap` parameter record; undefined when the file has no idat box.
   */
  idatPayload?: Uint8Array;
  thumbnails: { itemId: number; nalData: Uint8Array }[];
  /** More than one top-level image item (burst / sequence) — routes `unsupported`. */
  isMultiFrame: boolean;
  /** Reserved for Live-Photo companion detection (not yet detected). */
  companionVideoDetected: boolean;
  /** Non-fatal skips (unknown boxes, unreadable optional payloads). */
  warnings: string[];
}

export interface ParseHeicContainerOptions {
  /** Copy coded image payloads out (tiles/thumbnails/aux NALs). Default false. */
  extractPayload?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Internal structure types
// ═══════════════════════════════════════════════════════════════════════════════

interface BoxSpan { type: string; dataOffset: number; boxEnd: number }

interface HeifItem {
  id: number;
  type: string;
  name: string;
  contentType?: string;
  hidden: boolean;
  /** Associated property objects, in association order. */
  props: HeicProperty[];
}

interface HeicProperty {
  index: number; // 1-based ipco position
  type: string;
  hvcCBytes?: Uint8Array;
  hvcCFields?: HvcCFields;
  nclx?: NclxParams;
  iccBytes?: Uint8Array;
  ispe?: { width: number; height: number };
  pixiBits?: number[];
  auxType?: string;
  irotQuarterTurns?: 0 | 1 | 2 | 3;
  imirAxis?: 0 | 1;
}

interface HvcCFields {
  profileSpace: number;
  tierFlag: number;
  profileIdc: number;
  compatFlags: number;
  levelIdc: number;
  bitDepthLumaMinus8: number;
  bitDepthChromaMinus8: number;
  codecString: string;
}

interface ItemLocation {
  constructionMethod: 0 | 1;
  extents: Array<{ offset: number; length: number }>;
}

interface ItemReference { kind: string; from: number; to: number[] }

// ═══════════════════════════════════════════════════════════════════════════════
// Parser entry
// ═══════════════════════════════════════════════════════════════════════════════

const HEIC_BRANDS = new Set(['heic', 'heix', 'mif1', 'msf1', 'hevc', 'heim', 'mif2']);

export function parseHeicContainer(
  bytes: Uint8Array,
  opts: ParseHeicContainerOptions = {},
): HeicFileView {
  const warnings: string[] = [];
  const extractPayload = opts.extractPayload ?? false;

  // ── 1. ftyp: brand validation (compatible brands are a bare 4CC array) ────
  const ftypPayload = findTopLevelBox(bytes, 'ftyp');
  if (ftypPayload && ftypPayload.length >= 4) {
    const brands = new Set<string>([getFourCC(ftypPayload, 0)]);
    for (let o = 8; o + 4 <= ftypPayload.length; o += 4) brands.add(getFourCC(ftypPayload, o));
    if (![...brands].some((b) => HEIC_BRANDS.has(b))) {
      throw new Error(`heic-container: no known HEIF brand (got ${[...brands].join(',')})`);
    }
  }

  // ── 2-5. meta and its children ─────────────────────────────────────────────
  const metaPayload = findTopLevelBox(bytes, 'meta');
  if (!metaPayload || metaPayload.length < 4) throw new Error('heic-container: no meta box');
  const metaContent = metaPayload.subarray(4); // full-box: skip version+flags

  const pitmId = parsePitm(metaContent);

  const items = parseIinf(metaContent);
  if (items.length === 0) throw new Error('heic-container: empty iinf');
  const itemById = new Map<number, HeifItem>();
  for (const item of items) itemById.set(item.id, item);

  const { props, associations } = parseIpmaAssociatedProperties(metaContent, warnings);
  for (const item of items) {
    const assoc = associations.get(item.id) ?? [];
    item.props = assoc
      .map((idx) => props[idx - 1])
      .filter((p): p is HeicProperty => p !== undefined);
  }

  const refs = parseIref(metaContent);

  const locations = parseIlocAll(metaContent);
  if (locations.size === 0) throw new Error('heic-container: no usable iloc');
  const idatPayload = findChildBox(metaContent, 'idat');

  const resolveItem = (itemId: number): Uint8Array | null =>
    resolveLocatedItem(bytes, locations.get(itemId), idatPayload);

  // ── classification: which image items are top-level? ───────────────────────
  // thmb/auxl items are the `from` of their reference; coded tiles are the
  // `to` of a dimg FROM A GRID item. The grid-qualifier matters: iOS 18's
  // `tmap` (tile map) is its own item whose dimg points AT the primary grid
  // and its gain map (48MP probe file) — those targets are described, not
  // tiled, and must stay top-level.
  const imageItems = items.filter((i) => i.type === 'hvc1' || i.type === 'grid');
  const gridItemIds = new Set(items.filter((i) => i.type === 'grid').map((i) => i.id));
  const thumbItems = new Set(refs.filter((r) => r.kind === 'thmb').map((r) => r.from));
  const auxItems = new Set(refs.filter((r) => r.kind === 'auxl').map((r) => r.from));
  const dimgTargets = new Set(
    refs.filter((r) => r.kind === 'dimg' && gridItemIds.has(r.from)).flatMap((r) => r.to),
  );
  const topLevel = imageItems.filter(
    (i) => !thumbItems.has(i.id) && !auxItems.has(i.id) && !dimgTargets.has(i.id),
  );
  const isMultiFrame = topLevel.length > 1;

  // Primary: pitm when it names a top-level image item, else the first one.
  const pitmItem = itemById.get(pitmId);
  const primaryItem =
    pitmItem && topLevel.includes(pitmItem) ? pitmItem : topLevel[0];
  if (!primaryItem) throw new Error('heic-container: no primary image item');

  // ── 6-7. primary dispatch: grid (dimg expansion) or single hvc1 ───────────
  let grid: HeicGrid | undefined;
  let tileItems: Array<{ item: HeifItem; row: number; col: number }>;

  if (primaryItem.type === 'grid') {
    const configData = resolveItem(primaryItem.id);
    if (!configData) throw new Error(`heic-container: grid item ${primaryItem.id} payload unreadable`);
    grid = parseGridConfig(configData, warnings);
    const dimg = refs.find((r) => r.kind === 'dimg' && r.from === primaryItem.id);
    const tileIds = dimg ? dimg.to : [];
    if (tileIds.length === 0) throw new Error('heic-container: grid has no dimg tiles');
    if (tileIds.length !== grid.rows * grid.cols) {
      warnings.push(`grid declares ${grid.rows}×${grid.cols} but dimg lists ${tileIds.length} tiles`);
    }
    tileItems = tileIds.map((id, i) => {
      const item = itemById.get(id);
      if (!item) throw new Error(`heic-container: dimg tile ${id} missing from iinf`);
      // Tiles arrive in raster order (spec) — derive row/col from position.
      return { item, row: Math.floor(i / grid!.cols), col: i % grid!.cols };
    });
  } else {
    tileItems = [{ item: primaryItem, row: 0, col: 0 }];
  }

  // ── hvcC: the primary's own (hvc1), else the first tile's (grid has none) ─
  const codecSourceItem = pickProp(primaryItem, 'hvcC') ? primaryItem : tileItems[0]?.item;
  const hvcCProp = codecSourceItem ? pickProp(codecSourceItem, 'hvcC') : undefined;
  if (!hvcCProp?.hvcCFields || !hvcCProp.hvcCBytes) {
    throw new Error('heic-container: no hvcC on primary/tiles — cannot decode');
  }

  // Coded size: per-file ispe (512×512 / 640×896 / 896×1024 all observed).
  const codedIspe = pickProp(codecSourceItem, 'ispe')?.ispe
    ?? pickProp(tileItems[0]?.item, 'ispe')?.ispe;
  const codedWidth = codedIspe?.width ?? 0;
  const codedHeight = codedIspe?.height ?? 0;
  if (!codedWidth || !codedHeight) warnings.push('no ispe on coded items — coded size unknown');

  const tiles: HeicTile[] = tileItems.map(({ item, row, col }) => ({
    itemId: item.id,
    nalData: extractPayload ? (resolveItem(item.id) ?? new Uint8Array(0)) : new Uint8Array(0),
    gridRow: row,
    gridCol: col,
  }));

  // ── bit depth: pixi on the primary (grid items carry it), hvcC fallback ───
  const pixiBits = pickProp(primaryItem, 'pixi')?.pixiBits;
  const hvcCDepth = hvcCProp.hvcCFields.bitDepthLumaMinus8 + 8;
  let bitDepth: 8 | 10 | 12;
  if (pixiBits && pixiBits.length > 0 && pixiBits[0] >= 1 && pixiBits[0] <= 16) {
    const d = pixiBits[0];
    bitDepth = d <= 8 ? 8 : d <= 10 ? 10 : 12;
  } else if (hvcCDepth <= 12) {
    bitDepth = hvcCDepth as 8 | 10 | 12;
  } else {
    bitDepth = 8;
    warnings.push(`implausible depths (pixi ${pixiBits?.[0]}, hvcC ${hvcCDepth}) — reporting 8`);
  }

  // ── colour: primary's colr (nclx or ICC) ───────────────────────────────────
  const color: HeicFileView['color'] = {};
  const nclxProp = primaryItem.props.find((p) => p.type === 'colr' && p.nclx);
  const iccProp = primaryItem.props.find((p) => p.type === 'colr' && p.iccBytes);
  if (nclxProp?.nclx) color.nclx = nclxProp.nclx;
  if (iccProp?.iccBytes) color.icc = iccProp.iccBytes;

  // ── 8-9. orientation: container props + EXIF tag, both recorded ───────────
  // Application precedence: irot/imir non-zero = container
  // authoritative; else EXIF 5..8. Apple photos: irot=3 + EXIF 6 — same
  // rotation tagged twice, so either branch produces the same upright image.
  const orientation: HeicFileView['orientation'] = {
    irotQuarterTurns: pickProp(primaryItem, 'irot')?.irotQuarterTurns ?? 0,
    imirAxis: (pickProp(primaryItem, 'imir')?.imirAxis ?? null) as 0 | 1 | null,
    exifOrientation: null,
  };

  // ── metadata items: EXIF (prefix+TIFF) and XMP (mime rdf) ─────────────────
  const metadata: HeicFileView['metadata'] = {};
  const cdscSources = new Set(
    refs.filter((r) => r.kind === 'cdsc' && r.to.includes(primaryItem.id)).map((r) => r.from),
  );
  for (const item of items) {
    if (item.type === 'Exif' && (cdscSources.size === 0 || cdscSources.has(item.id))) {
      const data = resolveItem(item.id);
      if (data && data.length > 4) {
        const tiffOffset = readU32(data, 0);
        const tiff = data.subarray(4 + tiffOffset);
        metadata.exif = tiff;
        orientation.exifOrientation = parseExifOrientationTag(tiff);
      }
    } else if (item.type === 'mime' && /rdf\+xml/i.test(item.contentType ?? '')) {
      const data = resolveItem(item.id);
      if (data && metadata.xmp === undefined) {
        metadata.xmp = new TextDecoder('utf-8', { fatal: false }).decode(data);
      }
    }
  }

  // ── aux images (auxl pointing at primary): single hvc1 or NESTED grid ─────
  const auxImages: HeicAuxImage[] = [];
  for (const ref of refs) {
    if (ref.kind !== 'auxl' || !ref.to.includes(primaryItem.id)) continue;
    const auxItem = itemById.get(ref.from);
    if (!auxItem) continue;
    const auxType = pickProp(auxItem, 'auxC')?.auxType ?? '';
    if (auxItem.type === 'grid') {
      const cfg = resolveItem(auxItem.id);
      const auxGrid = cfg ? parseGridConfig(cfg, warnings) : undefined;
      if (!auxGrid) warnings.push(`aux item ${ref.from} (${auxType}) is a grid without a readable config`);
      const auxDimg = refs.find((r) => r.kind === 'dimg' && r.from === auxItem.id);
      const cols = auxGrid?.cols ?? 1;
      const auxTiles: HeicTile[] = (auxDimg?.to ?? []).map((id, i) => ({
        itemId: id,
        nalData: extractPayload ? (resolveItem(id) ?? new Uint8Array(0)) : new Uint8Array(0),
        gridRow: Math.floor(i / cols),
        gridCol: i % cols,
      }));
      auxImages.push({
        itemId: auxItem.id,
        auxType,
        payload: {
          kind: 'grid',
          tiles: auxTiles,
          grid: auxGrid ?? { rows: 0, cols: 0, outputWidth: 0, outputHeight: 0, form: 'compact-u16' },
        },
      });
    } else {
      auxImages.push({
        itemId: auxItem.id,
        auxType,
        payload: {
          kind: 'hvc1',
          nalData: extractPayload ? (resolveItem(auxItem.id) ?? new Uint8Array(0)) : new Uint8Array(0),
        },
      });
    }
  }

  // ── thumbnails (thmb pointing at primary) ──────────────────────────────────
  const thumbnails: HeicFileView['thumbnails'] = [];
  for (const ref of refs) {
    if (ref.kind !== 'thmb' || !ref.to.includes(primaryItem.id)) continue;
    const thumbItem = itemById.get(ref.from);
    if (!thumbItem || thumbItem.type !== 'hvc1') {
      if (thumbItem) warnings.push(`thumbnail item ${ref.from} has unsupported type ${thumbItem.type}`);
      continue;
    }
    thumbnails.push({
      itemId: thumbItem.id,
      nalData: extractPayload ? (resolveItem(thumbItem.id) ?? new Uint8Array(0)) : new Uint8Array(0),
    });
  }

  return {
    primary: {
      itemId: primaryItem.id,
      kind: primaryItem.type as 'hvc1' | 'grid',
      profileIdc: hvcCProp.hvcCFields.profileIdc,
      codecString: hvcCProp.hvcCFields.codecString,
      hvcCDescription: hvcCProp.hvcCBytes,
      codedWidth,
      codedHeight,
      tiles,
      grid,
    },
    color,
    bitDepth,
    orientation,
    metadata,
    auxImages,
    idatPayload: idatPayload ?? undefined,
    thumbnails,
    isMultiFrame,
    companionVideoDetected: false, // reserved (Live Photo companion detection)
    warnings,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Box-level parsers
// ═══════════════════════════════════════════════════════════════════════════════

function readU32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function readU16(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}

/** Iterate direct children of a payload range. */
function* childBoxes(payload: Uint8Array): Generator<BoxSpan> {
  let pos = 0;
  while (pos + 8 <= payload.length) {
    const header = readBoxHeader(payload, pos);
    if (!header) return;
    yield { type: header.type, dataOffset: header.dataOffset, boxEnd: header.boxEnd };
    pos = header.boxEnd;
  }
}

function readCStr(bytes: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end && bytes[i] !== 0; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function parsePitm(metaContent: Uint8Array): number {
  const pitm = findChildBox(metaContent, 'pitm');
  if (!pitm || pitm.length < 6) return -1;
  // version 0 → 16-bit id, version 1 → 32-bit; item_ID follows version+flags.
  return pitm[0] === 0 ? readU16(pitm, 4) : readU32(pitm, 4);
}

function parseIinf(metaContent: Uint8Array): HeifItem[] {
  const iinfPayload = findChildBox(metaContent, 'iinf');
  if (!iinfPayload || iinfPayload.length < 4) return [];
  const version = iinfPayload[0];
  let pos = 4;
  const entryCount = version === 0 ? readU16(iinfPayload, pos) : readU32(iinfPayload, pos);
  pos += version === 0 ? 2 : 4;

  const items: HeifItem[] = [];
  for (let i = 0; i < entryCount; i++) {
    const header = readBoxHeader(iinfPayload, pos);
    if (!header || header.type !== 'infe') break;
    const infeVersion = iinfPayload[header.dataOffset];
    const flags = (iinfPayload[header.dataOffset + 1] << 16)
      | (iinfPayload[header.dataOffset + 2] << 8)
      | iinfPayload[header.dataOffset + 3];
    let q = header.dataOffset + 4;
    const idSize = infeVersion >= 3 ? 4 : 2;
    const id = idSize === 4 ? readU32(iinfPayload, q) : readU16(iinfPayload, q);
    q += idSize + 2; // item_ID + protection_index
    let type = '?';
    let contentType: string | undefined;
    if (infeVersion >= 2) {
      type = getFourCC(iinfPayload, q);
      q += 4;
      // item_name, then (mime items) content_type / content_encoding —
      // null-terminated strings back to back.
      const name = readCStr(iinfPayload, q, header.boxEnd);
      q += name.length + 1;
      if (type === 'mime' && q < header.boxEnd) {
        contentType = readCStr(iinfPayload, q, header.boxEnd);
      }
    }
    items.push({ id, type, name: '', contentType, hidden: (flags & 1) !== 0, props: [] });
    pos = header.boxEnd;
  }
  return items;
}

/**
 * Walk iprp → (ipco, ipma+) — property pool plus ALL association boxes, both
 * polarity forms. Returns the 1-based property pool and per-item index lists.
 */
function parseIpmaAssociatedProperties(
  metaContent: Uint8Array,
  warnings: string[],
): { props: HeicProperty[]; associations: Map<number, number[]> } {
  const iprpPayload = findChildBox(metaContent, 'iprp');
  if (!iprpPayload) throw new Error('heic-container: no iprp box');
  const ipcoPayload = findChildBox(iprpPayload, 'ipco');
  if (!ipcoPayload) throw new Error('heic-container: no ipco box');

  // ── property pool ──
  const props: HeicProperty[] = [];
  for (const box of childBoxes(ipcoPayload)) {
    const prop: HeicProperty = { index: props.length + 1, type: box.type };
    const payload = ipcoPayload.subarray(box.dataOffset, box.boxEnd);
    try {
      switch (box.type) {
        case 'hvcC':
          prop.hvcCBytes = payload;
          prop.hvcCFields = parseHvcCFields(payload);
          break;
        case 'colr':
          if (payload.length >= 4) {
            const kind = getFourCC(payload, 0);
            if (kind === 'nclx' && payload.length >= 11) {
              prop.nclx = {
                colourPrimaries: readU16(payload, 4),
                transferCharacteristics: readU16(payload, 6),
                matrixCoefficients: readU16(payload, 8),
                fullRangeFlag: (payload[10] & 0x80) !== 0,
              };
            } else if (kind === 'prof' || kind === 'rICC') {
              prop.iccBytes = payload.slice(4);
            }
          }
          break;
        case 'ispe':
          // FullBox: [version+flags 4B][width u32][height u32]
          if (payload.length >= 12) prop.ispe = { width: readU32(payload, 4), height: readU32(payload, 8) };
          break;
        case 'pixi':
          // FullBox: [version+flags 4B][num_channels][bits × n]
          if (payload.length >= 6) {
            const n = payload[4];
            prop.pixiBits = [];
            for (let i = 0; i < n && 5 + i < payload.length; i++) prop.pixiBits.push(payload[5 + i]);
          }
          break;
        case 'auxC':
          // FullBox prefix on real files (4 zero bytes on Apple AND libheif
          // output); tolerate plain-string writers too.
          prop.auxType = payload.length > 4 && payload[0] === 0 && payload[1] === 0
            ? readCStr(payload, 4, payload.length)
            : readCStr(payload, 0, payload.length);
          break;
        case 'irot':
          // Angle = LOW 2 bits (empirically settled: 0x03 rotates, 0xC0 does not).
          prop.irotQuarterTurns = (payload[0] & 0x03) as 0 | 1 | 2 | 3;
          break;
        case 'imir':
          prop.imirAxis = (payload[0] & 0x01) as 0 | 1;
          break;
        default:
          break; // unknown property boxes are legal — keep the index slot
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(`property #${prop.index} (${box.type}) unreadable: ${msg}`);
    }
    props.push(prop);
  }

  // ── associations (ipma sits under iprp; multiple boxes allowed) ──
  const associations = new Map<number, number[]>();
  for (const box of childBoxes(iprpPayload)) {
    if (box.type !== 'ipma') continue;
    const payload = iprpPayload.subarray(box.dataOffset, box.boxEnd);
    if (payload.length < 8) continue;
    const version = payload[0];
    const flags = (payload[1] << 16) | (payload[2] << 8) | payload[3];
    // flags bit0: 0 → 1-byte (essential<<7|index), 1 → 2-byte (essential<<15|index)
    const indexSize = (flags & 1) === 1 ? 2 : 1;
    let pos = 4;
    const entryCount = readU32(payload, pos);
    pos += 4;
    for (let i = 0; i < entryCount && pos + 1 <= payload.length; i++) {
      const itemId = version === 0 ? readU16(payload, pos) : readU32(payload, pos);
      pos += version === 0 ? 2 : 4;
      const count = payload[pos];
      pos += 1;
      const list = associations.get(itemId) ?? [];
      for (let j = 0; j < count && pos + indexSize <= payload.length; j++) {
        const index = indexSize === 1 ? payload[pos] & 0x7f : readU16(payload, pos) & 0x7fff;
        pos += indexSize;
        if (index > 0) list.push(index); // index 0 = essential-only marker
      }
      associations.set(itemId, list);
    }
  }

  return { props, associations };
}

/** hvcC record → header fields + WebCodecs codec string. */
function parseHvcCFields(payload: Uint8Array): HvcCFields {
  if (payload.length < 23) throw new Error('hvcC shorter than 23 bytes');
  if (payload[0] !== 1) throw new Error(`hvcC configurationVersion ${payload[0]} unsupported`);
  const byte1 = payload[1];
  const profileSpace = (byte1 >> 6) & 0x03;
  const tierFlag = (byte1 >> 5) & 0x01;
  const profileIdc = byte1 & 0x1f;
  const compatFlags = readU32(payload, 2);
  // Constraint flags: 48-bit hex, trailing zero bytes trimmed, uppercase —
  // reproduces the probe-validated canned form (`…L90.B0`).
  let constraintHex = '';
  for (let i = 6; i < 12; i++) constraintHex += payload[i].toString(16).padStart(2, '0');
  const constraintCompact = (constraintHex.replace(/(00)+$/, '') || '0').toUpperCase();
  // NOTE: compat is emitted as full-width hex (`70000000` for MainStill, the
  // probe-validated form). Non-Apple Main streams with compat 0x60000000 will
  // read `60000000` where some tools print the canonical `6` — the phase-3
  // capability probe revalidates the string against the real decoder anyway.
  const levelIdc = payload[12];
  const codecString =
    `hvc1.${profileSpace ? `${profileSpace}.` : ''}${profileIdc}.` +
    `${compatFlags.toString(16)}.${tierFlag ? 'H' : 'L'}${levelIdc}.${constraintCompact}`;
  return {
    profileSpace,
    tierFlag,
    profileIdc,
    compatFlags,
    levelIdc,
    bitDepthLumaMinus8: payload[17] & 0x07,
    bitDepthChromaMinus8: payload[18] & 0x07,
    codecString,
  };
}

/**
 * Grid configuration — three real-world wire forms:
 * (a) 22B with box header, (b) 14B standard payload, (c) Apple compact 8B
 * (`[ver][flags][rows-1][cols-1][w u16][h u16]`). Real files disambiguate by
 * iloc extent length; here payload length does.
 */
function parseGridConfig(data: Uint8Array, warnings: string[]): HeicGrid {
  if (data.length >= 22 && getFourCC(data, 4) === 'grid') { // 4CC sits after the size field
    return {
      form: 'box-header',
      rows: data[12] + 1,
      cols: data[13] + 1,
      outputWidth: readU32(data, 14),
      outputHeight: readU32(data, 18),
    };
  }
  if (data.length >= 14) {
    return {
      form: 'standard',
      rows: data[4] + 1,
      cols: data[5] + 1,
      outputWidth: readU32(data, 6),
      outputHeight: readU32(data, 10),
    };
  }
  if (data.length >= 8) {
    return {
      form: 'compact-u16',
      rows: data[2] + 1,
      cols: data[3] + 1,
      outputWidth: readU16(data, 4),
      outputHeight: readU16(data, 6),
    };
  }
  warnings.push(`grid config payload too short (${data.length}B)`);
  throw new Error('heic-container: grid config unreadable');
}

function parseIref(metaContent: Uint8Array): ItemReference[] {
  const irefPayload = findChildBox(metaContent, 'iref');
  if (!irefPayload) return [];
  const version = irefPayload[0];
  const idSize = version === 0 ? 2 : 4;
  const refs: ItemReference[] = [];
  // Reference entries live after the version+flags — iterate THAT span so the
  // child box offsets and the payload slices share one coordinate system.
  // Single-item files may legitimately lack iref — the caller treats [] as
  // "no thumbnails/aux/tiles".
  const entries = irefPayload.subarray(4);
  for (const box of childBoxes(entries)) {
    const payload = entries.subarray(box.dataOffset, box.boxEnd);
    if (payload.length < idSize * 2) continue;
    let pos = 0;
    const from = idSize === 2 ? readU16(payload, pos) : readU32(payload, pos);
    pos += idSize;
    const count = idSize === 2 ? readU16(payload, pos) : readU32(payload, pos);
    pos += idSize;
    const to: number[] = [];
    for (let i = 0; i < count && pos + idSize <= payload.length; i++) {
      to.push(idSize === 2 ? readU16(payload, pos) : readU32(payload, pos));
      pos += idSize;
    }
    refs.push({ kind: box.type, from, to });
  }
  return refs;
}

function parseIlocAll(metaContent: Uint8Array): Map<number, ItemLocation> {
  const ilocPayload = findChildBox(metaContent, 'iloc');
  if (!ilocPayload || ilocPayload.length < 8) return new Map();
  const version = ilocPayload[0];
  let pos = 4;
  const offsetSize = ilocPayload[pos] >> 4;
  const lengthSize = ilocPayload[pos] & 0x0f;
  const baseOffsetSize = ilocPayload[pos + 1] >> 4;
  const indexSize = version >= 1 ? ilocPayload[pos + 1] & 0x0f : 0;
  pos += 2;
  const itemCount = version < 2 ? readU16(ilocPayload, pos) : readU32(ilocPayload, pos);
  pos += version < 2 ? 2 : 4;

  const readVar = (o: number, size: number): number => {
    if (size === 4) return readU32(ilocPayload, o);
    if (size === 8) return readU32(ilocPayload, o) * 0x100000000 + readU32(ilocPayload, o + 4);
    return 0;
  };

  const map = new Map<number, ItemLocation>();
  for (let i = 0; i < itemCount; i++) {
    if (pos >= ilocPayload.length) break;
    const itemId = version < 2 ? readU16(ilocPayload, pos) : readU32(ilocPayload, pos);
    pos += version < 2 ? 2 : 4;
    let constructionMethod: 0 | 1 = 0;
    if (version >= 1) {
      constructionMethod = (readU16(ilocPayload, pos) & 0x0f) as 0 | 1;
      pos += 2;
    }
    pos += 2; // data_reference_index
    const baseOffset = readVar(pos, baseOffsetSize);
    pos += baseOffsetSize;
    const extentCount = readU16(ilocPayload, pos);
    pos += 2;
    const extents: Array<{ offset: number; length: number }> = [];
    for (let e = 0; e < extentCount; e++) {
      if (version >= 1 && indexSize > 0) pos += indexSize;
      const offset = readVar(pos, offsetSize);
      pos += offsetSize;
      const length = readVar(pos, lengthSize);
      pos += lengthSize;
      extents.push({ offset: baseOffset + offset, length });
    }
    map.set(itemId, { constructionMethod, extents });
  }
  return map;
}

/** Resolve one item's bytes (method 0 = mdat absolute, method 1 = idat-relative). */
function resolveLocatedItem(
  fileBytes: Uint8Array,
  loc: ItemLocation | undefined,
  idatPayload: Uint8Array | null,
): Uint8Array | null {
  if (!loc || loc.extents.length === 0) return null;
  const chunks: Uint8Array[] = [];
  for (const ext of loc.extents) {
    if (loc.constructionMethod === 1) {
      if (!idatPayload) return null;
      if (ext.offset + ext.length <= idatPayload.length) {
        chunks.push(idatPayload.subarray(ext.offset, ext.offset + ext.length));
      }
    } else if (ext.offset + ext.length <= fileBytes.length) {
      chunks.push(fileBytes.subarray(ext.offset, ext.offset + ext.length));
    }
  }
  if (chunks.length === 0) return null;
  if (chunks.length === 1) return chunks[0];
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** First associated property whose type matches. */
function pickProp(item: HeifItem, type: string): HeicProperty | undefined {
  return item.props.find((p) => p.type === type);
}

/** EXIF TIFF IFD0 Orientation tag (0x0112) from stripped TIFF bytes. */
function parseExifOrientationTag(tiff: Uint8Array): number | null {
  try {
    if (tiff.length < 8) return null;
    const le = tiff[0] === 0x49 && tiff[1] === 0x49; // 'II'
    const read16 = (o: number) => (le ? tiff[o] | (tiff[o + 1] << 8) : (tiff[o] << 8) | tiff[o + 1]);
    const read32 = (o: number) => (le
      ? (tiff[o] | (tiff[o + 1] << 8) | (tiff[o + 2] << 16) | (tiff[o + 3] << 24)) >>> 0
      : readU32(tiff, o));
    const magic = read16(2);
    if (magic !== 42 && magic !== 0x4f52 && magic !== 0x5352) return null;
    const ifd0 = read32(4);
    if (ifd0 + 2 > tiff.length) return null;
    const entries = read16(ifd0);
    for (let i = 0; i < entries; i++) {
      const e = ifd0 + 2 + i * 12;
      if (e + 12 > tiff.length) break;
      if (read16(e) === 0x0112) return read16(e + 8);
    }
    return null;
  } catch {
    return null;
  }
}
