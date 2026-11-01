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
import type { DngGainTableMap } from '@opengpex/editor/core/engine/color/raw/gainTableMap';

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

/** DNG tag 52525 — `ProfileGainTableMap`: the spatial gain-table map (DNG 1.5+). */
export const DNG_TAG_PROFILE_GAIN_TABLE_MAP = 0xCD2D;

/** DNG tag 50730 — `BaselineExposure`: the baked rendering offset (RATIONAL[1], in stops). */
export const DNG_TAG_BASELINE_EXPOSURE = 0xC62A;

/**
 * DNG tag 50712 — `LinearizationTable`: SHORT[] sensor-response LUT applied to
 * every raw sample before the black/white level math (DNG 1.4+). Phone linear-raw
 * writers ship tables (e.g. 2641 entries) that map 10-bit stored samples onto the full
 * 16-bit linear scale — a decoder that skips it renders every value at the
 * wrong level (measured 20261031: up to 187× at the shadows).
 */
export const DNG_TAG_LINEARIZATION_TABLE = 50712;
/** DNG tag 50713 — `BlackLevelRepeatDim`: SHORT[2] rows/cols of the black pattern. */
export const DNG_TAG_BLACK_LEVEL_REPEAT_DIM = 50713;
/** DNG tag 50714 — `BlackLevel`: the repeating black-level pattern (RATIONAL/SHORT[]). */
export const DNG_TAG_BLACK_LEVEL = 50714;
/** DNG tag 50717 — `WhiteLevel`: sensor saturation per plane (SHORT/LONG, count 1..planes). */
export const DNG_TAG_WHITE_LEVEL = 50717;
/** DNG tag 50829 — `ActiveArea`: LONG[4] (top, left, bottom, right) of the valid image. */
export const DNG_TAG_ACTIVE_AREA = 50829;
/** DNG tag 50739 — `ShadowScale`: scales the reference render's shadow pedestal. */
export const DNG_TAG_SHADOW_SCALE = 50739;

/** TIFF IFD entry type 5 = RATIONAL (u32/u32). */
const TIFF_TYPE_RATIONAL = 5;
/** TIFF IFD entry type 10 = SRATIONAL (i32/i32) — Apple writes BaselineExposure as this. */
const TIFF_TYPE_SRATIONAL = 10;

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

// ─── ProfileGainTableMap (DNG 1.5+, tag 52525) ────────────────────────────────

// The map's TYPE and application math live in engine/color/raw/gainTableMap (the
// render side owns the math; this module owns the bytes). Re-exported here so
// existing `metadata/dng` import sites keep resolving.
export type { DngGainTableMap } from '@opengpex/editor/core/engine/color/raw/gainTableMap';

/**
 * Sanity gate for a candidate header decode: a real map has a sane grid, a
 * per-pixel gain in a plausible range, and positive input weights. Used to
 * arbitrate endianness — ProRAW writes the payload BIG-ENDIAN inside a
 * little-endian TIFF, so the first decode uses the file's byte order and the
 * fallback retries the opposite one.
 */
function gainTableMapPlausible(m: DngGainTableMap): boolean {
  if (m.pointsV < 1 || m.pointsH < 1 || m.pointsN < 2 || m.pointsN > 65536) return false;
  if (!Number.isFinite(m.spacingV) || !Number.isFinite(m.spacingH)) return false;
  if (m.spacingV <= 0 || m.spacingH <= 0) return false;
  if (!m.weights.every(w => Number.isFinite(w) && w >= 0)) return false;
  if (m.weights.reduce((a, b) => a + b, 0) <= 0) return false;
  let min = Infinity, max = -Infinity;
  for (const t of m.tables) {
    for (const g of t) {
      if (!Number.isFinite(g) || g < 1e-4 || g > 256) return false;
      if (g < min) min = g;
      if (g > max) max = g;
    }
  }
  return max > min; // a constant table carries no signal — treat as absent
}

/**
 * Parse the DNG `ProfileGainTableMap` (tag 52525) — the spatial gain-table map
 * Apple ProRAW (and Adobe's Adaptive profile) bake their per-file tone shaping
 * into. Wire format (DNG 1.6, type UNDEFINED, byte count = 64 + 4·V·H·N):
 * BIG-endian LONG MapPointsV, LONG MapPointsH, DOUBLE MapSpacingV/H, DOUBLE
 * MapOriginV/H, LONG MapPointsN, FLOAT×5 MapInputWeights, then V·H tables of N
 * FLOAT gains. ⚠️ ProRAW writes the payload big-endian even inside a
 * little-endian ('II') TIFF — decode with the file's order first, then retry
 * the opposite; {@link gainTableMapPlausible} arbitrates.
 *
 * Read-only ingest seam: the tone-shaping consumer lives in the libraw decode
 * path (auto-gated per file). Any absent/short/implausible map → `undefined`
 * (a RAW must still import).
 */
export function parseDngGainTableMap(bytes: Uint8Array): DngGainTableMap | undefined {
  const entry = findTiffEntry(bytes, DNG_TAG_PROFILE_GAIN_TABLE_MAP);
  if (!entry) return undefined;

  const { isLE, entryOffset } = entry;
  // Type UNDEFINED (7) in the wild; the byte count is what matters — a LONG
  // mislabel from another writer still carries the same payload semantics.
  const count = readU32(bytes, entryOffset + 4, isLE);
  const at = readU32(bytes, entryOffset + 8, isLE);
  if (count < 64 + 4 * 1 * 1 * 2 || at + count > bytes.length) return undefined;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const be of [!isLE, isLE]) {
    const pointsV = view.getUint32(at, !be);
    const pointsH = view.getUint32(at + 4, !be);
    const spacingV = view.getFloat64(at + 8, !be);
    const spacingH = view.getFloat64(at + 16, !be);
    const originV = view.getFloat64(at + 24, !be);
    const originH = view.getFloat64(at + 32, !be);
    const pointsN = view.getUint32(at + 40, !be);
    const weights = [0, 1, 2, 3, 4].map(k => view.getFloat32(at + 44 + k * 4, !be)) as
      [number, number, number, number, number];
    if (64 + 4 * pointsV * pointsH * pointsN !== count) continue;
    const tables: Float32Array[] = new Array(pointsV * pointsH);
    for (let i = 0; i < pointsV * pointsH; i++) {
      const t = new Float32Array(pointsN);
      for (let n = 0; n < pointsN; n++) t[n] = view.getFloat32(at + 64 + (i * pointsN + n) * 4, !be);
      tables[i] = t;
    }
    const candidate: DngGainTableMap = { pointsV, pointsH, pointsN, spacingV, spacingH, originV, originH, weights, tables };
    if (gainTableMapPlausible(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Parse the DNG `BaselineExposure` (tag 50730, RATIONAL[1]) — the baked
 * rendering offset in stops (+0.921 on Apple ProRAW). The GainTableMap's input
 * weights ASSUME this adjustment has been applied (DNG 1.6: the map "should be
 * applied after the BaselineExposure adjustment"); a consumer that skips it
 * reads the table at the wrong indices — the map's steep low-input region —
 * and bakes luminance plates into bright content (20261016 device finding).
 * Absent/malformed → `undefined` (treat as 0 stops).
 */
export function parseDngBaselineExposure(bytes: Uint8Array): number | undefined {
  const entry = findTiffEntry(bytes, DNG_TAG_BASELINE_EXPOSURE);
  if (!entry) return undefined;

  const { isLE, entryOffset } = entry;
  const type = readU16(bytes, entryOffset + 2, isLE);
  // Both rational spellings accepted: the spec says RATIONAL, Apple ProRAW
  // writes SRATIONAL (20261016 field finding — a strict RATIONAL check parsed
  // undefined on every real file and silently disabled the BE-shifted lookup).
  if (type !== TIFF_TYPE_RATIONAL && type !== TIFF_TYPE_SRATIONAL) return undefined;
  if (readU32(bytes, entryOffset + 4, isLE) < 1) return undefined;

  const at = readU32(bytes, entryOffset + 8, isLE);
  if (at + 8 > bytes.length) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const srational = type === TIFF_TYPE_SRATIONAL;
  const num = srational ? view.getInt32(at, isLE) : view.getUint32(at, isLE);
  const den = view.getUint32(at + 4, isLE);
  if (den === 0 || !Number.isFinite(num / den)) return undefined;
  return num / den;
}

// ─── Raw linearization block (levels + sensor LUT, DNG 1.4+ spec core) ────────

/**
 * Value location of a TIFF IFD entry per the standard rule: payloads of four
 * bytes or less live INLINE in the entry (offset +8); anything larger is an
 * absolute byte offset. Returns −1 when the payload would run past the buffer.
 */
function valueLocation(
  bytes: Uint8Array,
  entryOffset: number,
  isLE: boolean,
  type: number,
  count: number,
): number {
  const unit = TYPE_SIZES[type] ?? 4;
  if (unit * count <= 4) return entryOffset + 8;
  const at = readU32(bytes, entryOffset + 8, isLE);
  return at + unit * count <= bytes.length ? at : -1;
}


/**
 * The raw-stage level facts the decode side needs to rebuild the reference
 * pipeline's Stage2 exactly: sensor LUT, repeating black-level pattern, per-
 * plane white levels, and the valid-image rectangle. All values are plain
 * numbers — the stage math itself lives in `engine/color/raw/dng-stages.ts`.
 */
export interface DngLinearizationData {
  /**
   * Tag 50712, SHORT[] — sensor-response LUT indexed by the stored raw sample.
   * Absent on most files (identity); phone linear-raw writers ship a real table.
   */
  linearizationTable?: readonly number[];
  /** Tag 50714 — black level per (repeat row, repeat col, plane). */
  blackLevel: {
    rows: number;
    cols: number;
    /** `values[row * cols * planes + col * planes + plane]` — raw units. */
    values: number[];
  };
  /** Tag 50717 — white level per plane (raw units). Single value repeats. */
  whiteLevel: number[];
  /** Tag 50829 — `[top, left, bottom, right]`; defaults to the full frame. */
  activeArea?: readonly [number, number, number, number];
}

/**
 * Parse the raw-stage linearization tags (50712/50713/50714/50717/50829) in
 * one pass. Every member degrades individually to its documented default
 * (no LUT, zero black, 65535 white, full-frame active area) so a partially
 * broken raw IFD still yields a usable subset; the caller supplies the plane
 * count so the black pattern's per-plane stride is known without parsing the
 * photometric tag here.
 */
export function parseDngLinearizationData(
  bytes: Uint8Array,
  planes: number,
): DngLinearizationData {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // LinearizationTable: SHORT[], sane size bounds (2 .. 64k entries).
  let linearizationTable: number[] | undefined;
  {
    const entry = findTiffEntry(bytes, DNG_TAG_LINEARIZATION_TABLE);
    if (entry && readU16(bytes, entry.entryOffset + 2, entry.isLE) === TIFF_TYPE_SHORT) {
      const count = readU32(bytes, entry.entryOffset + 4, entry.isLE);
      if (count >= 2 && count <= 65536) {
        const at = readU32(bytes, entry.entryOffset + 8, entry.isLE);
        if (at + count * 2 <= bytes.length) {
          linearizationTable = new Array<number>(count);
          for (let i = 0; i < count; i++) {
            linearizationTable[i] = readU16(bytes, at + i * 2, entry.isLE);
          }
        }
      }
    }
  }

  // BlackLevelRepeatDim: SHORT[2] (rows, cols); defaults to 1×1. Four bytes
  // fit inline in the entry — the value location follows the TIFF rule.
  let repeatRows = 1;
  let repeatCols = 1;
  {
    const entry = findTiffEntry(bytes, DNG_TAG_BLACK_LEVEL_REPEAT_DIM);
    if (entry && readU16(bytes, entry.entryOffset + 2, entry.isLE) === TIFF_TYPE_SHORT) {
      if (readU32(bytes, entry.entryOffset + 4, entry.isLE) === 2) {
        const at = valueLocation(bytes, entry.entryOffset, entry.isLE, TIFF_TYPE_SHORT, 2);
        if (at >= 0 && at + 4 <= bytes.length) {
          const r = readU16(bytes, at, entry.isLE);
          const c = readU16(bytes, at + 2, entry.isLE);
          if (r > 0 && c > 0 && r * c * planes <= 64) {
            repeatRows = r;
            repeatCols = c;
          }
        }
      }
    }
  }

  // BlackLevel: RATIONAL[] (spec) or SHORT[] (lenient). The count is either
  // planes × repeatRows × repeatCols, one per plane, or a single global value;
  // shorter counts replicate across the repeat pattern.
  const blackCount = repeatRows * repeatCols * planes;
  const blackLevel = { rows: repeatRows, cols: repeatCols, values: new Array<number>(blackCount).fill(0) };
  {
    const entry = findTiffEntry(bytes, DNG_TAG_BLACK_LEVEL);
    if (entry) {
      const type = readU16(bytes, entry.entryOffset + 2, entry.isLE);
      const count = readU32(bytes, entry.entryOffset + 4, entry.isLE);
      if (count === blackCount || count === planes || count === 1) {
        const at = valueLocation(bytes, entry.entryOffset, entry.isLE, type, count);
        const perEntry = type === TIFF_TYPE_RATIONAL || type === TIFF_TYPE_SRATIONAL ? 8 : 2;
        if ((type === TIFF_TYPE_RATIONAL || type === TIFF_TYPE_SRATIONAL || type === TIFF_TYPE_SHORT) &&
            at + count * perEntry <= bytes.length) {
          const flat = new Array<number>(count).fill(0);
          for (let i = 0; i < count; i++) {
            let v: number;
            if (type === TIFF_TYPE_RATIONAL || type === TIFF_TYPE_SRATIONAL) {
              const num = type === TIFF_TYPE_SRATIONAL
                ? view.getInt32(at + i * 8, entry.isLE)
                : view.getUint32(at + i * 8, entry.isLE);
              const den = view.getUint32(at + i * 8 + 4, entry.isLE);
              v = den === 0 ? 0 : num / den;
            } else {
              v = readU16(bytes, at + i * 2, entry.isLE);
            }
            flat[i] = Number.isFinite(v) ? v : 0;
          }
          for (let r = 0; r < repeatRows; r++) {
            for (let c = 0; c < repeatCols; c++) {
              for (let p = 0; p < planes; p++) {
                const slot = (r * repeatCols + c) * planes + p;
                blackLevel.values[slot] = count === blackCount
                  ? flat[slot]
                  : count === planes
                    ? flat[p]
                    : flat[0];
              }
            }
          }
        }
      }
    }
  }

  // WhiteLevel: SHORT or LONG, count 1..planes. Absent → 65535 (spec default).
  const whiteLevel: number[] = new Array<number>(planes).fill(65535);
  {
    const entry = findTiffEntry(bytes, DNG_TAG_WHITE_LEVEL);
    if (entry) {
      const type = readU16(bytes, entry.entryOffset + 2, entry.isLE);
      const count = readU32(bytes, entry.entryOffset + 4, entry.isLE);
      if (type === TIFF_TYPE_SHORT || type === TIFF_TYPE_LONG) {
        if (count >= 1 && count <= planes) {
          const at = valueLocation(bytes, entry.entryOffset, entry.isLE, type, count);
          const perEntry = type === TIFF_TYPE_SHORT ? 2 : 4;
          if (at + count * perEntry <= bytes.length) {
            for (let p = 0; p < planes; p++) {
              const i = Math.min(p, count - 1);
              whiteLevel[p] = type === TIFF_TYPE_SHORT
                ? readU16(bytes, at + i * 2, entry.isLE)
                : readU32(bytes, at + i * 4, entry.isLE);
            }
          }
        }
      }
    }
  }

  // ActiveArea: LONG[4] (top, left, bottom, right).
  let activeArea: readonly [number, number, number, number] | undefined;
  {
    const entry = findTiffEntry(bytes, DNG_TAG_ACTIVE_AREA);
    if (entry && readU16(bytes, entry.entryOffset + 2, entry.isLE) === TIFF_TYPE_LONG) {
      if (readU32(bytes, entry.entryOffset + 4, entry.isLE) === 4) {
        const at = readU32(bytes, entry.entryOffset + 8, entry.isLE);
        if (at + 16 <= bytes.length) {
          const t = readU32(bytes, at, entry.isLE);
          const l = readU32(bytes, at + 4, entry.isLE);
          const b = readU32(bytes, at + 8, entry.isLE);
          const r = readU32(bytes, at + 12, entry.isLE);
          if (b > t && r > l) activeArea = [t, l, b, r];
        }
      }
    }
  }

  return { linearizationTable, blackLevel, whiteLevel, activeArea };
}

/**
 * Parse the DNG `ShadowScale` (tag 50739, RATIONAL[1]) — the factor the
 * reference render's shadow pedestal is scaled by (the exposure ramp's black
 * point = 0.005 × ShadowScale). Absent/malformed → `undefined` (treat as 1.0).
 */
export function parseDngShadowScale(bytes: Uint8Array): number | undefined {
  const entry = findTiffEntry(bytes, DNG_TAG_SHADOW_SCALE);
  if (!entry) return undefined;

  const { isLE, entryOffset } = entry;
  if (readU16(bytes, entryOffset + 2, isLE) !== TIFF_TYPE_RATIONAL) return undefined;
  if (readU32(bytes, entryOffset + 4, isLE) < 1) return undefined;

  const at = readU32(bytes, entryOffset + 8, isLE);
  if (at + 8 > bytes.length) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const num = view.getUint32(at, isLE);
  const den = view.getUint32(at + 4, isLE);
  if (den === 0 || !Number.isFinite(num / den)) return undefined;
  return num / den;
}

/**
 * Render-geometry and render-default facts the calibrated DNG chain needs
 * beyond the color profile: the CFA layout (absent ⟹ already-linear file),
 * the default crop window (relative to the active area), the stored
 * orientation, and the two profile render overrides.
 */
export interface DngRenderFacts {
  /** CFA pattern color indices (0=R 1=G 2=B), row-major; undefined for linear files. */
  cfaPattern?: { rows: number; cols: number; colors: Uint8Array };
  /** Tag 50711; only 1 (rectangular) is supported by the bilinear port. */
  cfaLayout: number;
  /** Tags 50719/50720 — origin + size inside the active area (pixels). */
  defaultCrop?: { x: number; y: number; width: number; height: number };
  /** Tag 274 — EXIF orientation of the stored pixels (1 = upright). */
  orientation: number;
  /** Tag 51109 — profile exposure offset (stops), added to BaselineExposure. */
  baselineExposureOffset: number;
  /** Tag 51110 — 1 = "None": the render applies no shadow pedestal. */
  defaultBlackRender: number;
  /**
   * Tag 50732 — the relative capture sharpening the camera model needs
   * (spec default 1.0). The reference pipeline only carries it; converters
   * apply it.
   */
  baselineSharpness: number;
}

function readRationalPair(bytes: Uint8Array, tagId: number): [number, number] | undefined {
  const entry = findTiffEntry(bytes, tagId);
  if (!entry) return undefined;
  const { isLE, entryOffset } = entry;
  const type = readU16(bytes, entryOffset + 2, isLE);
  if (readU32(bytes, entryOffset + 4, isLE) !== 2) return undefined;
  const at = valueLocation(bytes, entryOffset, isLE, type, 2);
  if (at < 0) return undefined;
  if (type === TIFF_TYPE_SHORT) return [readU16(bytes, at, isLE), readU16(bytes, at + 2, isLE)];
  if (type === TIFF_TYPE_LONG) return [readU32(bytes, at, isLE), readU32(bytes, at + 4, isLE)];
  if (type === TIFF_TYPE_RATIONAL) {
    const d0 = readU32(bytes, at + 4, isLE);
    const d1 = readU32(bytes, at + 12, isLE);
    if (d0 === 0 || d1 === 0) return undefined;
    return [readU32(bytes, at, isLE) / d0, readU32(bytes, at + 8, isLE) / d1];
  }
  return undefined;
}

/**
 * Find a tag in IFD0 ONLY. Camera-profile tags (DefaultBlackRender,
 * BaselineExposureOffset) are defined at IFD0 / camera-profile level; some
 * writers also drop copies into the raw SubIFD, which the reference reader
 * ignores — so must we.
 */
function findIfd0Entry(bytes: Uint8Array, tagId: number): { isLE: boolean; entryOffset: number } | null {
  const header = validateTiffHeader(bytes);
  if (!header) return null;
  const { isLE, ifd0Offset } = header;
  if (ifd0Offset + 2 > bytes.length) return null;
  const n = readU16(bytes, ifd0Offset, isLE);
  for (let i = 0; i < n; i++) {
    const e = ifd0Offset + 2 + i * 12;
    if (e + 12 > bytes.length) break;
    if (readU16(bytes, e, isLE) === tagId) return { isLE, entryOffset: e };
  }
  return null;
}

function readScalarShortOrLong(
  bytes: Uint8Array,
  tagId: number,
  find: typeof findTiffEntry = findTiffEntry,
): number | undefined {
  const entry = find(bytes, tagId);
  if (!entry) return undefined;
  const { isLE, entryOffset } = entry;
  const type = readU16(bytes, entryOffset + 2, isLE);
  if (type === TIFF_TYPE_SHORT) return readU16(bytes, entryOffset + 8, isLE);
  if (type === TIFF_TYPE_LONG) return readU32(bytes, entryOffset + 8, isLE);
  return undefined;
}

/** One unsigned RATIONAL from IFD0, or undefined when absent/malformed. */
function readIfd0Rational(bytes: Uint8Array, tagId: number): number | undefined {
  const entry = findIfd0Entry(bytes, tagId);
  if (!entry) return undefined;
  const { isLE, entryOffset } = entry;
  if (readU16(bytes, entryOffset + 2, isLE) !== TIFF_TYPE_RATIONAL) return undefined;
  const at = readU32(bytes, entryOffset + 8, isLE);
  if (at + 8 > bytes.length) return undefined;
  const den = readU32(bytes, at + 4, isLE);
  if (den === 0) return undefined;
  const v = readU32(bytes, at, isLE) / den;
  return Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Parse {@link DngRenderFacts}; every member degrades to its spec default. */
export function parseDngRenderFacts(bytes: Uint8Array): DngRenderFacts {
  let cfaPattern: DngRenderFacts['cfaPattern'];
  const dim = readRationalPair(bytes, 33421);
  const patEntry = findTiffEntry(bytes, 33422);
  if (dim && patEntry) {
    const [rows, cols] = dim;
    const { isLE, entryOffset } = patEntry;
    const count = readU32(bytes, entryOffset + 4, isLE);
    if (rows > 0 && cols > 0 && count === rows * cols && count <= 64) {
      const at = valueLocation(bytes, entryOffset, isLE, 1, count);
      if (at >= 0) cfaPattern = { rows, cols, colors: bytes.slice(at, at + count) };
    }
  }

  let defaultCrop: DngRenderFacts['defaultCrop'];
  const origin = readRationalPair(bytes, 50719);
  const size = readRationalPair(bytes, 50720);
  if (size) {
    defaultCrop = {
      x: Math.round(origin?.[0] ?? 0),
      y: Math.round(origin?.[1] ?? 0),
      width: Math.round(size[0]),
      height: Math.round(size[1]),
    };
  }

  let baselineExposureOffset = 0;
  {
    const entry = findIfd0Entry(bytes, 51109);
    if (entry) {
      const { isLE, entryOffset } = entry;
      const type = readU16(bytes, entryOffset + 2, isLE);
      if (type === TIFF_TYPE_SRATIONAL || type === TIFF_TYPE_RATIONAL) {
        const at = readU32(bytes, entryOffset + 8, isLE);
        if (at + 8 <= bytes.length) {
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          const num = type === TIFF_TYPE_SRATIONAL ? view.getInt32(at, isLE) : view.getUint32(at, isLE);
          const den = view.getUint32(at + 4, isLE);
          if (den !== 0) baselineExposureOffset = num / den;
        }
      }
    }
  }

  return {
    cfaPattern,
    cfaLayout: readScalarShortOrLong(bytes, 50711) ?? 1,
    defaultCrop,
    orientation: readScalarShortOrLong(bytes, 274) ?? 1,
    baselineExposureOffset,
    defaultBlackRender: readScalarShortOrLong(bytes, 51110, findIfd0Entry) ?? 0,
    baselineSharpness: readIfd0Rational(bytes, 50732) ?? 1,
  };
}

/**
 * The IFD0 preview JPEG of a DNG — the writer's own rendition of the photo,
 * stored as a single JPEG strip (StripOffsets/StripByteCounts, or the
 * JPEGInterchangeFormat pair). Phone writers put an ISO 21496-1 HDR gain map
 * inside this preview's MPF container; it is the only HDR description such
 * files carry (the raw data and camera profile are SDR). Returns a subarray
 * view, or null when IFD0 holds no JPEG.
 */
export function extractDngPreviewJpeg(bytes: Uint8Array): Uint8Array | null {
  const header = validateTiffHeader(bytes);
  if (!header) return null;
  const { isLE, ifd0Offset } = header;
  if (ifd0Offset + 2 > bytes.length) return null;
  const n = readU16(bytes, ifd0Offset, isLE);
  let offset = -1;
  let length = -1;
  for (let i = 0; i < n; i++) {
    const e = ifd0Offset + 2 + i * 12;
    if (e + 12 > bytes.length) break;
    const tag = readU16(bytes, e, isLE);
    const type = readU16(bytes, e + 2, isLE);
    const count = readU32(bytes, e + 4, isLE);
    if (count !== 1) continue;
    const value = type === TIFF_TYPE_SHORT ? readU16(bytes, e + 8, isLE) : readU32(bytes, e + 8, isLE);
    if (tag === 273 || tag === 513) offset = value;
    if (tag === 279 || tag === 514) length = value;
  }
  if (offset <= 0 || length < 4 || offset + length > bytes.length) return null;
  if (bytes[offset] !== 0xff || bytes[offset + 1] !== 0xd8) return null;
  return bytes.subarray(offset, offset + length);
}

// ─── Camera color profile block (DNG 1.4+ spec core) ──────────────────────────

/** Tag 50721 (0xC621) — `ColorMatrix1`: PCS-D50 XYZ → camera RGB under illuminant 1. */
export const DNG_TAG_COLOR_MATRIX_1 = 0xC621;
/** Tag 50722 (0xC622) — `ColorMatrix2` (dual-illuminant profiles only). */
export const DNG_TAG_COLOR_MATRIX_2 = 0xC622;
/** Tag 50723 (0xC623) — `CameraCalibration1`: per-unit sensor calibration under illuminant 1. */
export const DNG_TAG_CAMERA_CALIBRATION_1 = 0xC623;
/** Tag 50724 (0xC624) — `CameraCalibration2`. */
export const DNG_TAG_CAMERA_CALIBRATION_2 = 0xC624;
/** Tag 50727 (0xC627) — `AnalogBalance`: per-channel analog gain normalization. */
export const DNG_TAG_ANALOG_BALANCE = 0xC627;
/** Tag 50728 (0xC628) — `AsShotNeutral`: captured white-balance gains, G-normalized. */
export const DNG_TAG_AS_SHOT_NEUTRAL = 0xC628;
/** Tag 50778 (0xC65A) — `CalibrationIlluminant1` (EXIF light-source code for CM1). */
export const DNG_TAG_CALIBRATION_ILLUMINANT_1 = 0xC65A;
/** Tag 50779 (0xC65B) — `CalibrationIlluminant2`. */
export const DNG_TAG_CALIBRATION_ILLUMINANT_2 = 0xC65B;
/**
 * Tag 50964 (0xC714) — `ForwardMatrix1`: PCS-D50 → camera under illuminant 1.
 * ⚠️ NOT 50725/50726 — those are `ReductionMatrix1/2` (subsampling matrices for
 * 4+ channel sensors, irrelevant to a 3-channel chain).
 */
export const DNG_TAG_FORWARD_MATRIX_1 = 0xC714;
/** Tag 50965 (0xC715) — `ForwardMatrix2`. */
export const DNG_TAG_FORWARD_MATRIX_2 = 0xC715;

/**
 * The DNG camera color profile as PURE DATA, one interface away from the file
 * bytes so the render-side color math (`engine/color/raw/dng-spec.ts`, P2) never
 * touches TIFF structure.
 *
 * All matrices are ROW-MAJOR 9-tuples; all channel vectors are 3-tuples. Writers
 * store matrices as SRATIONAL (desktop DNG conversion tools) or FLOAT (phone
 * vendor RAW writers); both spellings are accepted per member. A member
 * whose tag is absent, mistyped, or out of bounds is `undefined` — the consumer
 * applies the spec's documented defaults (identity calibration, unit analog
 * balance, no forward matrix, illuminant 1 only).
 */
export interface DngCameraProfileData {
  /** Tag 50728. Required by the spec chain; absent → no principled rendering. */
  asShotNeutral?: readonly number[];
  /** Tag 50721. The one mandatory color matrix. */
  colorMatrix1?: readonly number[];
  /** Tag 50722. Present on dual-illuminant profiles. */
  colorMatrix2?: readonly number[];
  /** Tag 50778, EXIF light-source code (17 = A, 21 = D65; 0 = unknown). */
  calibrationIlluminant1?: number;
  /** Tag 50779. */
  calibrationIlluminant2?: number;
  /** Tag 50723. Spec default: identity. */
  cameraCalibration1?: readonly number[];
  /** Tag 50724. Spec default: identity. */
  cameraCalibration2?: readonly number[];
  /** Tag 50727. Spec default: all ones. */
  analogBalance?: readonly number[];
  /** Tag 50964. Absent on most natural-camera profiles (the XYZ-adapt branch applies). */
  forwardMatrix1?: readonly number[];
  /** Tag 50965. */
  forwardMatrix2?: readonly number[];
  /**
   * Tag 50730 via {@link parseDngBaselineExposure}, stops. The spec chain adds
   * a fixed `2^BE` gain; absent = 0 stops.
   */
  baselineExposure?: number;
}

/** TIFF IFD entry type 3 = SHORT (the illuminant tags' storage type). */
const TIFF_TYPE_SHORT = 3;

/**
 * Read one 3×3 matrix tag. Accepts SRATIONAL (10), RATIONAL (5) and FLOAT (11),
 * each count 9 (always out-of-line: 36 or 72 bytes). Any other type/count, an
 * out-of-bounds run, or a non-finite value yields `undefined`.
 */
function readMatrixTag(
  bytes: Uint8Array,
  tagId: number,
): readonly number[] | undefined {
  const entry = findTiffEntry(bytes, tagId);
  if (!entry) return undefined;

  const { isLE, entryOffset } = entry;
  const type = readU16(bytes, entryOffset + 2, isLE);
  const count = readU32(bytes, entryOffset + 4, isLE);
  if (count !== 9) return undefined;
  if (type !== TIFF_TYPE_SRATIONAL && type !== TIFF_TYPE_RATIONAL && type !== TIFF_TYPE_FLOAT) {
    return undefined;
  }

  const at = readU32(bytes, entryOffset + 8, isLE);
  const unit = type === TIFF_TYPE_FLOAT ? 4 : 8;
  if (at + unit * 9 > bytes.length) return undefined;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: number[] = new Array(9);
  for (let i = 0; i < 9; i++) {
    let v: number;
    if (type === TIFF_TYPE_FLOAT) {
      v = view.getFloat32(at + i * 4, isLE);
    } else {
      const num = type === TIFF_TYPE_SRATIONAL
        ? view.getInt32(at + i * 8, isLE)
        : view.getUint32(at + i * 8, isLE);
      const den = view.getUint32(at + i * 8 + 4, isLE);
      if (den === 0) return undefined;
      v = num / den;
    }
    if (!Number.isFinite(v)) return undefined;
    out[i] = v;
  }
  return out;
}

/**
 * Read one 3-channel rational vector tag (AsShotNeutral / AnalogBalance).
 * Accepts RATIONAL (5) and SRATIONAL (10), count 3 (24 bytes, out-of-line).
 * Zero denominators and non-finite values yield `undefined`.
 */
function readRationalTriple(
  bytes: Uint8Array,
  tagId: number,
): readonly number[] | undefined {
  const entry = findTiffEntry(bytes, tagId);
  if (!entry) return undefined;

  const { isLE, entryOffset } = entry;
  const type = readU16(bytes, entryOffset + 2, isLE);
  if (type !== TIFF_TYPE_RATIONAL && type !== TIFF_TYPE_SRATIONAL) return undefined;
  if (readU32(bytes, entryOffset + 4, isLE) !== 3) return undefined;

  const at = readU32(bytes, entryOffset + 8, isLE);
  if (at + 24 > bytes.length) return undefined;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: number[] = new Array(3);
  for (let i = 0; i < 3; i++) {
    const num = type === TIFF_TYPE_SRATIONAL
      ? view.getInt32(at + i * 8, isLE)
      : view.getUint32(at + i * 8, isLE);
    const den = view.getUint32(at + i * 8 + 4, isLE);
    if (den === 0) return undefined;
    const v = num / den;
    if (!Number.isFinite(v)) return undefined;
    out[i] = v;
  }
  return out;
}

/**
 * Read one SHORT illuminant tag (CalibrationIlluminant1/2). Count 1, 2 bytes,
 * stored inline. Anything else → `undefined`.
 */
function readIlluminantTag(bytes: Uint8Array, tagId: number): number | undefined {
  const entry = findTiffEntry(bytes, tagId);
  if (!entry) return undefined;

  const { isLE, entryOffset } = entry;
  if (readU16(bytes, entryOffset + 2, isLE) !== TIFF_TYPE_SHORT) return undefined;
  if (readU32(bytes, entryOffset + 4, isLE) !== 1) return undefined;
  return readU16(bytes, entryOffset + 8, isLE);
}

/**
 * Parse the complete DNG camera color profile in one pass.
 *
 * `asShotNeutral` + `colorMatrix1` are the minimum for a principled render
 * (single-illuminant chain); every other member carries the spec's documented
 * default when absent. BaselineExposure rides along because the spec chain and
 * the GainTableMap input both consume it (already parsed by
 * {@link parseDngBaselineExposure} — same tag, one read).
 *
 * Malformed members degrade individually to `undefined` (spec defaults), so a
 * partially-broken profile still renders; only a missing ColorMatrix1 disables
 * the first-principles chain entirely.
 */
export function parseDngCameraProfileData(bytes: Uint8Array): DngCameraProfileData {
  const asShotNeutral = readRationalTriple(bytes, DNG_TAG_AS_SHOT_NEUTRAL);
  const colorMatrix1 = readMatrixTag(bytes, DNG_TAG_COLOR_MATRIX_1);
  const colorMatrix2 = readMatrixTag(bytes, DNG_TAG_COLOR_MATRIX_2);
  const calibrationIlluminant1 = readIlluminantTag(bytes, DNG_TAG_CALIBRATION_ILLUMINANT_1);
  const calibrationIlluminant2 = readIlluminantTag(bytes, DNG_TAG_CALIBRATION_ILLUMINANT_2);

  // ColorMatrix2 without its illuminant code is unusable for interpolation —
  // drop the matrix so the consumer falls back to the single-illuminant chain
  // rather than guessing a temperature for it.
  const hasDual = colorMatrix2 !== undefined && calibrationIlluminant2 !== undefined;

  return {
    asShotNeutral,
    colorMatrix1,
    colorMatrix2: hasDual ? colorMatrix2 : undefined,
    calibrationIlluminant1,
    calibrationIlluminant2: hasDual ? calibrationIlluminant2 : undefined,
    cameraCalibration1: readMatrixTag(bytes, DNG_TAG_CAMERA_CALIBRATION_1),
    cameraCalibration2: readMatrixTag(bytes, DNG_TAG_CAMERA_CALIBRATION_2),
    analogBalance: readRationalTriple(bytes, DNG_TAG_ANALOG_BALANCE),
    forwardMatrix1: readMatrixTag(bytes, DNG_TAG_FORWARD_MATRIX_1),
    forwardMatrix2: readMatrixTag(bytes, DNG_TAG_FORWARD_MATRIX_2),
    baselineExposure: parseDngBaselineExposure(bytes),
  };
}
