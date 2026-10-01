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
 * metadata/dng.ts — Adobe DNG specification tags.
 *
 * SPLIT BY STANDARD, NOT BY VENDOR. Apple ProRAW is a *standard DNG*: the tags
 * it writes (`ProfileName`, `ProfileToneCurve`, …) are Adobe's published DNG
 * spec, not an Apple extension. Google Pixel RAW, Samsung Expert RAW, Hasselblad,
 * DJI and every Adobe DNG Converter product write the same tags, so one module
 * covers all of them — an `apple-raw.ts` / `pixel-raw.ts` split would be pure
 * duplication. Genuinely proprietary per-vendor blobs (Canon/Nikon/Sony/Fuji
 * MakerNotes) are a different standard and get their own module when they land.
 *
 * @module core/files/handlers/raw/metadata/dng
 */

import { validateTiffHeader, readU16, readU32, TYPE_SIZES } from '../../../metadata/tiff-ifd-reader';

/** DNG tag 50936 — `ProfileName`, the camera profile's human-readable name. */
export const DNG_TAG_PROFILE_NAME = 0xC6F8;

/**
 * DNG tag 50940 — `ProfileToneCurve`.
 *
 * ⚠️ Note: some documentation quotes `0xC6FA` for this tag; that value is
 * `ProfileHueSatMapData1` (50938). The DNG 1.2+ camera-profile block runs
 * 50936 `ProfileName` (0xC6F8) → 50937 `ProfileHueSatMapDims` → 50938/50939
 * `ProfileHueSatMapData1/2` → **50940 `ProfileToneCurve` (0xC6FC)** → 50941
 * `ProfileEmbedPolicy`. 50936 = 0xC6F8 is confirmed by the `ProfileName` tag
 * number this module already relied on, which pins the whole run.
 */
export const DNG_TAG_PROFILE_TONE_CURVE = 0xC6FC;

/**
 * DNG tag 50937 — `ProfileHueSatMapDims`: the `[hDiv, sDiv, vDiv]` grid size of
 * the HueSatMap tables (50938/50939). A LONG[3]; both HueSatMapData tags share it.
 */
export const DNG_TAG_HUE_SAT_MAP_DIMS = 0xC6F9;

/** DNG tag 50938 — `ProfileHueSatMapData1` (illuminant A / first reference). */
export const DNG_TAG_HUE_SAT_MAP_DATA1 = 0xC6FA;

/** DNG tag 50939 — `ProfileHueSatMapData2` (illuminant D65 / second reference). */
export const DNG_TAG_HUE_SAT_MAP_DATA2 = 0xC6FB;

/** DNG tag 50981 — `ProfileLookTableDims`: `[hDiv, sDiv, vDiv]` for the LookTable. */
export const DNG_TAG_LOOK_TABLE_DIMS = 0xC725;

/** DNG tag 50982 — `ProfileLookTableData`: the creative-Look 3D table (50981 dims). */
export const DNG_TAG_LOOK_TABLE_DATA = 0xC726;

/** TIFF IFD entry type 11 = FLOAT (IEEE binary32) — `ProfileToneCurve`'s type. */
const TIFF_TYPE_FLOAT = 11;

/** TIFF IFD entry type 4 = LONG (u32) — the `*Dims` tags' type. */
const TIFF_TYPE_LONG = 4;

/** One `(input, output)` control point of a DNG tone curve, both in [0, 1]. */
export type DngToneCurvePoint = readonly [number, number];

/** A DNG HueSatMap / LookTable grid size: `[hueDivisions, satDivisions, valDivisions]`. */
export type DngTableDims = readonly [number, number, number];

/**
 * A DNG `ProfileHueSatMap` (tags 50937/50938/50939).
 *
 * The map is a 3D grid (`dims = [hDiv, sDiv, vDiv]`) of `(hueShift°, satScale,
 * valScale)` triples that warps colour in a bounded HSV domain. `data1` is the
 * illuminant-A reference table (always present when the map exists); `data2` is
 * the D65 reference (optional — dual-illuminant profiles interpolate between the
 * two by colour temperature). Both share `dims`. Each `data*` run holds exactly
 * `hDiv * sDiv * vDiv * 3` floats in DNG nested-loop order (value outermost, hue
 * middle, saturation innermost).
 */
export interface DngHueSatMap {
  dims: DngTableDims;
  data1: readonly number[];
  data2?: readonly number[];
}

/**
 * A DNG `ProfileLookTable` (tags 50981/50982).
 *
 * Same `(hueShift°, satScale, valScale)` grid structure as the HueSatMap, but a
 * single creative-Look table (Apple ProRAW's vivid look lives largely here).
 */
export interface DngLookTable {
  dims: DngTableDims;
  data: readonly number[];
}

/**
 * Read the DNG camera `ProfileName` out of an already-parsed ExifReader tag set.
 *
 * ExifReader surfaces the tag by NAME, so this is a typed accessor rather than a
 * byte walk — but it belongs here, not in the orchestrator, so every DNG tag has
 * exactly one place to be read from.
 */
export function readDngProfileName(
  exifTags: Record<string, { description?: string }> | undefined,
): string | undefined {
  return exifTags?.ProfileName?.description;
}

/**
 * Probe the SOURCE transfer characteristic from whatever colour NAME signals the
 * container yielded: an ST 2084 / PQ marker → `'pq'`, an HLG / BT.2100 marker →
 * `'hlg'`, `'sdr'` when a signal existed but named neither, `undefined` when
 * nothing was probed at all.
 *
 * FORWARD SEAM: write-only today. When HDR RAW lands, the rules table gains
 * a `transfer === 'pq'` row with `trc: 'pq'` and the shader's source-normalize
 * stage gains a PQ EOTF branch — both read this field, neither changes it.
 */
export function detectTransfer(
  signals: readonly (string | undefined)[],
): 'pq' | 'hlg' | 'sdr' | undefined {
  const hay = signals.filter(Boolean).join(' ').toLowerCase();
  if (!hay.trim()) return undefined;
  if (/\bst[\s-]?2084\b|\b2084\b|\bpq\b|perceptual\s*quantiz/.test(hay)) return 'pq';
  if (/\bhlg\b|hybrid\s*log|\barib\b|\bbt\.?2100\b/.test(hay)) return 'hlg';
  return 'sdr';
}

/**
 * Parse the DNG `ProfileToneCurve` (tag 50940) into `(input, output)` pairs.
 *
 * WIRE FORMAT (DNG 1.2 "ProfileToneCurve"): a FLOAT array of `2n` values laid
 * out as `[in₀, out₀, in₁, out₁, …]`, every value in [0, 1], strictly increasing
 * in `input`, conventionally anchored at `(0,0)` and `(1,1)`. An odd count, a
 * non-FLOAT type or fewer than two points is a malformed curve → `undefined`
 * (the caller degrades to the generic filmic baseline).
 *
 * This is the rendering-intent source for tone curve data. It is a
 * WRITE-ONLY metadata seam in this milestone: nothing samples it yet.
 *
 * Returns `undefined` rather than throwing on any malformed input — a RAW that
 * fails to yield a curve must still import.
 */
export function parseDngProfileToneCurve(bytes: Uint8Array): DngToneCurvePoint[] | undefined {
  const entry = findTiffEntry(bytes, DNG_TAG_PROFILE_TONE_CURVE);
  if (!entry) return undefined;

  const { isLE, entryOffset } = entry;
  const type = readU16(bytes, entryOffset + 2, isLE);
  if (type !== TIFF_TYPE_FLOAT) return undefined;

  const count = readU32(bytes, entryOffset + 4, isLE);
  // 2n values, at least 2 points (4 values). A 4-byte FLOAT array of count 1
  // would be stored inline, but a 1-value tone curve is meaningless anyway.
  if (count < 4 || count % 2 !== 0) return undefined;

  const byteLength = count * TYPE_SIZES[TIFF_TYPE_FLOAT];
  const at = readU32(bytes, entryOffset + 8, isLE);
  if (at + byteLength > bytes.length) return undefined;

  const view = new DataView(bytes.buffer, bytes.byteOffset + at, byteLength);
  const points: DngToneCurvePoint[] = [];
  for (let i = 0; i < count; i += 2) {
    const input = view.getFloat32(i * 4, isLE);
    const output = view.getFloat32(i * 4 + 4, isLE);
    if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;
    points.push([input, output]);
  }
  return points;
}

/**
 * Parse the DNG `ProfileHueSatMap` (tags 50937 dims + 50938/50939 data).
 *
 * Read-only ingest infrastructure — WRITE-ONLY this milestone: nothing samples
 * it yet. The display engine consumes it in subsequent pipelines.
 *
 * WIRE FORMAT (DNG 1.2 "ProfileHueSatMapDims / ...Data1 / ...Data2"):
 *   • 50937 `ProfileHueSatMapDims`: LONG[3] = `[hDiv, sDiv, vDiv]`, all ≥ 1.
 *   • 50938/50939: FLOAT[`hDiv*sDiv*vDiv*3`], `(hueShift°, satScale, valScale)`
 *     triples in nested-loop order (value outer, hue middle, saturation inner).
 * `data1` (illuminant A) is required; `data2` (D65) is returned only when present
 * AND its count matches the shared dims. Any malformed / absent tag, a count that
 * does not equal `hDiv*sDiv*vDiv*3`, a non-FLOAT/LONG type, or a non-finite value
 * degrades to `undefined` (data1) / dropped (data2) — a RAW must still import.
 */
export function parseDngHueSatMap(bytes: Uint8Array): DngHueSatMap | undefined {
  const dims = readDimsTag(bytes, DNG_TAG_HUE_SAT_MAP_DIMS);
  if (!dims) return undefined;

  const expected = dims[0] * dims[1] * dims[2] * 3;
  const data1 = readFloatRun(bytes, DNG_TAG_HUE_SAT_MAP_DATA1, expected);
  if (!data1) return undefined; // Data1 is the mandatory reference table.

  const data2 = readFloatRun(bytes, DNG_TAG_HUE_SAT_MAP_DATA2, expected);
  return data2 ? { dims, data1, data2 } : { dims, data1 };
}

/**
 * Parse the DNG `ProfileLookTable` (tags 50981 dims + 50982 data).
 *
 * Same grid structure and failure discipline as {@link parseDngHueSatMap}; a
 * single creative-Look table rather than a dual-illuminant pair. WRITE-ONLY.
 */
export function parseDngLookTable(bytes: Uint8Array): DngLookTable | undefined {
  const dims = readDimsTag(bytes, DNG_TAG_LOOK_TABLE_DIMS);
  if (!dims) return undefined;

  const expected = dims[0] * dims[1] * dims[2] * 3;
  const data = readFloatRun(bytes, DNG_TAG_LOOK_TABLE_DATA, expected);
  if (!data) return undefined;

  return { dims, data };
}

/**
 * Read a `*Dims` tag as a `[hDiv, sDiv, vDiv]` LONG triple, all strictly
 * positive. A 3×LONG run is 12 bytes, always out-of-line (> 4), so the value
 * field holds a file offset. Any type/count/bounds mismatch → `undefined`.
 */
function readDimsTag(bytes: Uint8Array, tagId: number): DngTableDims | undefined {
  const entry = findTiffEntry(bytes, tagId);
  if (!entry) return undefined;

  const { isLE, entryOffset } = entry;
  if (readU16(bytes, entryOffset + 2, isLE) !== TIFF_TYPE_LONG) return undefined;
  if (readU32(bytes, entryOffset + 4, isLE) !== 3) return undefined;

  const at = readU32(bytes, entryOffset + 8, isLE);
  if (at + 12 > bytes.length) return undefined;

  const h = readU32(bytes, at, isLE);
  const s = readU32(bytes, at + 4, isLE);
  const v = readU32(bytes, at + 8, isLE);
  if (h <= 0 || s <= 0 || v <= 0) return undefined;
  return [h, s, v];
}

/**
 * Read a FLOAT[`expectedCount`] value run of a HueSatMap / LookTable data tag.
 *
 * The count must equal the dims-derived `expectedCount` exactly (a table whose
 * declared grid does not match its payload is corrupt), be a positive multiple
 * of 3 (whole `(hue, sat, val)` triples), fit within the buffer, and hold only
 * finite floats — otherwise `undefined`. A HueSatMap/LookTable run is always far
 * larger than 4 bytes, hence always out-of-line.
 */
function readFloatRun(
  bytes: Uint8Array,
  tagId: number,
  expectedCount: number,
): readonly number[] | undefined {
  if (expectedCount <= 0 || expectedCount % 3 !== 0) return undefined;

  const entry = findTiffEntry(bytes, tagId);
  if (!entry) return undefined;

  const { isLE, entryOffset } = entry;
  if (readU16(bytes, entryOffset + 2, isLE) !== TIFF_TYPE_FLOAT) return undefined;
  if (readU32(bytes, entryOffset + 4, isLE) !== expectedCount) return undefined;

  const byteLength = expectedCount * TYPE_SIZES[TIFF_TYPE_FLOAT];
  const at = readU32(bytes, entryOffset + 8, isLE);
  if (at + byteLength > bytes.length) return undefined;

  const view = new DataView(bytes.buffer, bytes.byteOffset + at, byteLength);
  const data: number[] = new Array(expectedCount);
  for (let i = 0; i < expectedCount; i++) {
    const f = view.getFloat32(i * 4, isLE);
    if (!Number.isFinite(f)) return undefined;
    data[i] = f;
  }
  return data;
}

/**
 * Locate one tag's 12-byte IFD entry anywhere in a classic-TIFF tree: the IFD0
 * linked list plus every SubIFD (tag 0x014A) reachable from it, breadth-first.
 *
 * DNG writes the camera-profile block into IFD0 in practice, but Adobe DNG
 * Converter and the `ExtraCameraProfiles` path can nest it, so the walk mirrors
 * `collectTiffIccCandidates`' BFS instead of assuming IFD0. Returns the entry
 * POSITION (not the value), leaving type/count/offset decoding to the caller —
 * that is what keeps this usable for a future second DNG tag.
 */
function findTiffEntry(
  bytes: Uint8Array,
  tagId: number,
): { isLE: boolean; entryOffset: number } | null {
  const header = validateTiffHeader(bytes);
  if (!header) return null;

  const { isLE } = header;
  const visited = new Set<number>();
  const queue: number[] = [header.ifd0Offset];
  let guard = 0;
  const maxIfds = 64; // same magnitude guard as the ICC tree walk

  while (queue.length > 0 && guard++ < maxIfds) {
    const ifdOffset = queue.shift()!;
    if (ifdOffset <= 0 || ifdOffset + 2 > bytes.length || visited.has(ifdOffset)) continue;
    visited.add(ifdOffset);

    const entryCount = readU16(bytes, ifdOffset, isLE);
    const entriesStart = ifdOffset + 2;
    if (entriesStart + entryCount * 12 + 4 > bytes.length) continue;

    for (let i = 0; i < entryCount; i++) {
      const entryOffset = entriesStart + i * 12;
      const id = readU16(bytes, entryOffset, isLE);
      if (id === tagId) return { isLE, entryOffset };
      if (id === 0x014A) { // SubIFDs — enqueue every referenced IFD offset
        const type = readU16(bytes, entryOffset + 2, isLE);
        const count = readU32(bytes, entryOffset + 4, isLE);
        const size = (TYPE_SIZES[type] || 4) * count;
        const base = size <= 4 ? entryOffset + 8 : readU32(bytes, entryOffset + 8, isLE);
        for (let k = 0; k < count; k++) {
          if (base + k * 4 + 4 > bytes.length) break;
          const off = readU32(bytes, base + k * 4, isLE);
          if (off > 0) queue.push(off);
        }
      }
    }

    const next = readU32(bytes, entriesStart + entryCount * 12, isLE);
    if (next > 0) queue.push(next);
  }

  return null;
}
