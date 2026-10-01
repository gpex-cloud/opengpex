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

import type { GamutId, TRC, RenderIntent } from '@opengpex/editor/core/types';
import { AssetDriver } from '@opengpex/editor/core/storage/Driver';

/**
 * Metadata schema version. Bumped whenever `StoredAsset`'s internal shape
 * changes. Pure version STAMP — the value itself is not meaningful, it only
 * marks "the schema changed" so `get()` can reject stale-shape records
 * (no field-by-field migration; see the store's no-migration guard in `get`).
 */
export const ASSET_VERSION = 5;

/** Key prefix for original ENCODED source blobs (vips-redecodable; serves revert / lossless re-export). */
const RAW_KEY_PREFIX = 'raw:';

/**
 * Key prefix for DECODED high-depth naked pixels (`dec:${id}`).
 *
 * Renamed from the former `rawbuf:` — the `raw-` stem read confusingly close to
 * the `raw:` (encoded source) namespace. `dec` (decoded) and `raw` (undecoded
 * encoded source) now read as the opposites they are. Under this key we store
 * the BARE `Uint16Array` (IEEE binary16, RGBA interleaved) with NO wrapper
 * record: `StoredAsset` is the sole owner of geometry + color identity, so the
 * pixel bytes are the only thing here that cannot be derived elsewhere.
 */
const DEC_KEY_PREFIX = 'dec:';

/**
 * ColorIdentity — the flattened colour + format identity of one layer's
 * pixels: physical gamut, transfer characteristic, source bit depth, and the
 * high-depth predicate. Previously `gamut`/`trc` were nested under a separate
 * `ColorSpace` value object while `bitDepth`/`dataFormat` sat beside it at the
 * parent level — one identity split across two shapes for no reason. All four
 * axes now live flat on the same object, and every caller passes/reads one
 * object instead of a nested one plus two loose siblings.
 *
 * NOTE: distinct from `files/types.ts`'s `ColorSpaceId` (a SOURCE-semantic tag
 * that also carries `cmyk`/`grayscale`/`unknown`, used at the import entry).
 * `ColorIdentity` here answers "what gamut + TRC + depth are THIS layer's
 * pixels right now" — the storage/render identity. The two are neighbours,
 * not interchangeable.
 */
export interface ColorIdentity {
  gamut: GamutId; // srgb | display-p3 | adobe-rgb | prophoto-rgb | rec2020
  trc: TRC;       // srgb-trc | linear
  bitDepth: 1 | 2 | 4 | 8 | 10 | 12 | 14 | 16 | 32; // source depth axis (1/2/4 = sub-8-bit PNG indexed/grayscale)
  /** High-depth predicate: present ⟺ `dec:${id}` holds the f16 truth. */
  dataFormat?: 'rgba16float' | 'rgba32float';
  /**
   * The asset's OUT-OF-BOX RENDERING INTENT (RAW Route B §5.3, method (a)).
   * Omitted ⇒ `'sdr'` (Display-Referred passthrough) — correct for every
   * JPEG/PNG/TIFF/bitmap. Scene-linear RAW ingest tags this `'filmic'` and it is
   * carried FORWARD unchanged (never re-sniffed at render time); the GPU sampling
   * shader applies the tone-map at composite via `resolveSourceRenderIntent` →
   * `normalize_source_components`. Persisted alongside `trc`/`gamut` so a cold
   * reload renders identically.
   */
  renderIntent?: RenderIntent;
}

/**
 * HighDepthBuffer — the bare high-depth naked-pixel payload attached to an
 * `ImageAssetPayload`. Deliberately carries ONLY the pixel bytes + their own
 * geometry, which is EXIF-uprighted to match the payload's display
 * `width`/`height` (the file decoders rotate the naked buffer alongside the
 * display proxy — see `core/files` `rotateNakedRgba`) — colour identity
 * (`dataFormat` element-type discriminator, `trc`, `gamut`) is NOT duplicated
 * here, it lives on the sibling `ImageAssetPayload.colorIdentity`, the single
 * authority.
 */
export interface HighDepthBuffer {
  readonly data: Uint16Array | Float32Array;
  readonly width: number;
  readonly height: number;
}

/**
 * ImageAssetPayload — the general image-asset ingest contract that
 * `AssetService.storeBundle` consumes. Lives here, in the base storage layer,
 * specifically so `storage/asset` never has to import a producer-side type
 * (e.g. `core/files`'s `DecodedImage`) to know what it is being asked to
 * store — every producer (file decode, layer-composite bake, brush/text
 * rasterization) implements this same shape instead, converging on one
 * golden ingest path.
 */
export interface ImageAssetPayload {
  /** 8-bit display-ready bitmap (Canvas2D / WebGPU texture upload). */
  readonly displayBlob: Blob;
  readonly width: number;
  readonly height: number;

  /** Authoritative colour + bit-depth identity (gamut, trc, bitDepth, dataFormat). */
  readonly colorIdentity: ColorIdentity;

  /** 16/32-bit float naked pixels, present when `colorIdentity.dataFormat` is set. */
  readonly highDepthSource?: HighDepthBuffer;

  /** Physical/logical pixel ratio for HiDPI assets. */
  readonly dprScale?: number;
  /** Precomputed content hash; skips `AssetService`'s own hash computation. */
  readonly precomputedHash?: string;
  /** Original file name if available (e.g. from file decode/import). */
  readonly sourceFileName?: string;
}

/**
 * AssetEntry — the core image-asset base class: geometry, the 8-bit display
 * `blob`, and the flattened colour identity. Shared, unmodified, by both the
 * persisted shape (`StoredAsset`, below) and the in-memory shape (`InMemAsset`,
 * in `AssetService.ts`) — the single place these fields are declared, so the
 * two runtime shapes can never drift apart the way `StoredAsset` and the old
 * memory-side `AssetEntry` once did.
 */
export interface AssetEntry extends ColorIdentity {
  id: string; // content address. Imported assets: `${sha256(sourceFile)}#${pageIndex}` — the (file, page) content address; `raw:` keys off only the `#` prefix. Non-import assets (bake / thumbnail / composite): a plain display-content hash, no `#`.
  blob: Blob; // 8-bit display representation
  width: number;
  height: number;
  dprScale?: number; // HiDPI physical/logical pixel ratio
  sourceFileName?: string; // Original source file name for format routing on cold recovery
}

/**
 * StoredAsset — the SOLE OWNER of one layer's pixel colour identity, on disk.
 *
 * A light record (KB-scale): `AssetEntry` (geometry + colour identity + 8-bit
 * display blob) plus persistence metadata. The heavy f16 payload lives OUT of
 * this record, under `dec:${id}` (hydrated lazily); this record carries only
 * a light predicate, `dataFormat`, whose mere presence means "a high-depth
 * truth exists". Because IndexedDB deserialises a value whole, `get(id)`
 * naturally pulls only this light record — never the (per-entry up to ~192MB)
 * f16 buffer.
 */
export interface StoredAsset extends AssetEntry {
  timestamp: number; // persisted-at timestamp
  version?: number;  // schema version stamp (see ASSET_VERSION; no migration)
}

/**
 * AssetStore: Persistent asset store based on Driver (LocalForage)
 * Responsibility: Responsible for physically saving assets to IndexedDB.
 *
 * Storage topology — a single logical "layer pixels" lands under co-located
 * keys. Imported assets use a (file, page) content address `id` =
 * `${sha256(sourceFile)}#${pageIndex}`; the light record and `dec:` key off the
 * WHOLE id (per-page), while `raw:` keys off ONLY its `#` prefix (the file
 * hash) — one physical file, one raw copy, shared by every page. Non-import
 * assets (bake / thumbnail / composite) have a plain display-content-hash `id`
 * with no `#`, and their raw:/dec: (if any) key off that whole id.
 *   `${id}`             → light `StoredAsset` (identity + geometry + display blob) — always.
 *   `raw:${fileHash}`   → original ENCODED source blob (vips-redecodable) — when a source file exists; fileHash = id.split('#')[0].
 *   `dec:${id}`         → DECODED f16 naked pixels (bare Uint16Array) — for high-depth assets.
 */
export class AssetStore {
  /**
   * Returns all keys in the asset store (light-record enumeration + GC scans).
   */
  async keys(): Promise<string[]> {
    return AssetDriver.keys();
  }

  /**
   * Clears all assets
   */
  async clear(): Promise<void> {
    await AssetDriver.clear();
  }

  /**
   * Saves a whole light record. Stamps `id` + the current `version` so the
   * version marker is always authoritative at the single write chokepoint;
   * every other field is carried through verbatim from the value object.
   */
  async set(id: string, record: StoredAsset): Promise<void> {
    await AssetDriver.setItem(id, { ...record, id, version: ASSET_VERSION });
  }

  /**
   * Checks if asset exists in physical storage (O(1) preflight check, without reading Blob)
   */
  async has(id: string): Promise<boolean> {
    const keys = await AssetDriver.keys();
    return keys.includes(id);
  }

  /**
   * Gets the specified light record — deserialises ONLY the `${id}` key, never
   * touches `dec:${id}` (the physical basis for the heavy payload never being
   * dragged into memory by a `get()`).
   *
   * §7 no-migration guard: a record from an older schema (version below current,
   * or missing the flattened `gamut`/`trc`) is treated as ABSENT (returns
   * `null`) — a crash-protection guard that keeps stale-shape records out of
   * new code and lets the upper layer re-import/rebuild. NOT a field-by-field
   * migration.
   */
  async get(id: string): Promise<StoredAsset | null> {
    const rec = await AssetDriver.getItem<StoredAsset>(id);
    if (!rec) return null;
    if (rec.version !== ASSET_VERSION || !rec.gamut || !rec.trc) return null;
    return rec;
  }

  /**
   * Gets all LIGHT records (light-path enumeration — MANDATORY under the prefix
   * scheme). The main keyspace mixes `${id}` (light) with `raw:`/`dec:` (heavy);
   * an undifferentiated `iterate()` would deserialise every `dec:` value (a
   * ~192MB naked Uint16Array) into memory (the poison path). So: enumerate
   * `keys()`, filter out the `raw:`/`dec:` prefixes, and `get()` each bare id.
   */
  async getAll(): Promise<StoredAsset[]> {
    const allKeys = await AssetDriver.keys();
    const assets: StoredAsset[] = [];
    for (const key of allKeys) {
      if (key.startsWith(RAW_KEY_PREFIX) || key.startsWith(DEC_KEY_PREFIX)) continue;
      const rec = await this.get(key);
      if (rec) assets.push(rec);
    }
    return assets;
  }

  /**
   * Deletes specified light record from physical storage.
   */
  async remove(id: string): Promise<void> {
    await AssetDriver.removeItem(id);
  }

  // ─── Raw (ENCODED) Source Storage — UNCHANGED ───────────────────────────────

  /**
   * Stores a high-resolution raw ENCODED source blob associated with an asset.
   * Used for 16-bit TIFF/PNG/RAW imports and original GIF files to preserve
   * original data for lossless re-export / revert.
   * The raw blob is stored in the same IDB but under a `raw:${id}` key.
   */
  async setRaw(id: string, rawBlob: Blob): Promise<void> {
    await AssetDriver.setItem(`${RAW_KEY_PREFIX}${id}`, rawBlob);
  }

  /**
   * Retrieves the high-resolution raw ENCODED source blob for an asset.
   * Returns null if no raw source exists (8-bit source or pixel-edited asset).
   */
  async getRaw(id: string): Promise<Blob | null> {
    return AssetDriver.getItem<Blob>(`${RAW_KEY_PREFIX}${id}`);
  }

  /**
   * Checks whether a high-resolution raw ENCODED source exists for the given asset.
   * Used by the export path to determine if 16-bit export is available.
   */
  async hasRaw(id: string): Promise<boolean> {
    const keys = await AssetDriver.keys();
    return keys.includes(`${RAW_KEY_PREFIX}${id}`);
  }

  /**
   * Deletes a raw ENCODED source blob by its hash.
   * Called by GC sweep when raw:${hash} is no longer referenced by any frame.
   */
  async removeRaw(id: string): Promise<void> {
    await AssetDriver.removeItem(`${RAW_KEY_PREFIX}${id}`);
  }

  // ─── Decoded High-Depth Naked-Pixel Storage (`dec:${id}`) ────────────────────

  /**
   * Persists the DECODED high-depth naked pixels under `dec:${id}` — the BARE
   * TypedArray, no wrapper record: a `Uint16Array` (IEEE binary16, RGBA
   * interleaved) for `dataFormat:'rgba16float'`, or a `Float32Array` for a true
   * 32-bit float source (`'rgba32float'`, §6.5). The store itself is BYTE-AGNOSTIC
   * — IndexedDB's structured clone round-trips the concrete TypedArray
   * constructor — so widening this took no schema/`ASSET_VERSION` migration; the
   * light record's `dataFormat` remains the sole discriminator on read. Geometry
   * and colour identity live in `StoredAsset`; only the irreducible pixel bytes
   * live here. Distinct from `raw:` (encoded source) — no collision, and the
   * encoded-file getRaw/hasRaw/GC semantics are untouched.
   */
  async setDec(id: string, data: Uint16Array | Float32Array): Promise<void> {
    await AssetDriver.setItem(`${DEC_KEY_PREFIX}${id}`, data);
  }

  /**
   * Retrieves the decoded high-depth naked pixels for an asset, or null if none.
   * The caller reassembles a `HighDepthSource` using geometry + colour identity
   * from the light `StoredAsset` — `dataFormat` says which of the two element
   * types came back (a `null` return when the light record's `dataFormat` said a
   * truth SHOULD exist is a persist failure / mis-GC — the caller warns
   * explicitly rather than silently degrading).
   */
  async getDec(id: string): Promise<Uint16Array | Float32Array | null> {
    return AssetDriver.getItem<Uint16Array | Float32Array>(`${DEC_KEY_PREFIX}${id}`);
  }

  /**
   * Deletes the decoded high-depth naked pixels. Called by the GC reclaim scan
   * and the delete-ordering path when `dec:${id}` is no longer referenced.
   */
  async removeDec(id: string): Promise<void> {
    await AssetDriver.removeItem(`${DEC_KEY_PREFIX}${id}`);
  }
}

/**
 * Export singleton for internal use by AssetService
 */
export const assetStore = new AssetStore();
