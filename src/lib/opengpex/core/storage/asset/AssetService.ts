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

import { AssetRef } from '@opengpex/editor/core/types';
import { assetStore } from './AssetStore';
import type { StoredAsset, AssetEntry, ColorIdentity } from './AssetStore';
import { resourceTracker } from '@opengpex/editor/core/advanced/ResourceTracker';
import { calculateContentHash } from '@opengpex/editor/core/helpers/hash';
import { PERF_MON } from '@opengpex/editor/core/helpers/config';
import type { ImageAssetInput, ImageAssetPayload } from './AssetStore';

/**
 * The 8-bit sRGB colour-identity baseline applied when a caller supplies no
 * colour identity fields — an ordinary 8-bit sRGB display asset genuinely IS
 * sRGB / srgb-trc, so this is the correct identity, not a lossy fallback.
 */
/** How long a birth-protection stamp stays fresh (see `pendingRegistrations`). */
const PENDING_REGISTRATION_TTL_MS = 20_000;

/**
 * Age gate for the sweep's display-record orphan reclaim. A display record
 * that is store-orphaned (unreferenced by the document's frames + history)
 * is only auto-removed once it has ALSO been sitting in the store for at
 * least this long — the window covers import-in-flight registrations,
 * undo/redo transient reference gaps beyond the 2s GC debounce, and any
 * save-race the debounce cannot observe. Panel-side manual Purge bypasses
 * the gate (explicit user intent).
 */
const DISPLAY_ORPHAN_RECLAIM_AGE_MS = 10 * 60_000;

const DEFAULT_COLOR_IDENTITY: ColorIdentity = {
  gamut: 'srgb',
  trc: 'srgb-trc',
  bitDepth: 8,
  dataFormat: undefined,
};

/**
 * Strips the `#pageIndex` suffix off a unified asset id to recover the physical
 * `raw:` key (the source-file hash). Imported ids are `${sourceHash}#${index}`;
 * `raw:` is stored once per physical file under `sourceHash` alone, so every
 * `raw:` consumer (getRaw, the sweep raw scan) must derive the file hash this
 * way. Ids with no `#` (non-import assets) pass through unchanged. `dec:` and
 * the light record key off the WHOLE id and must NOT use this.
 */
function fileHashOf(id: string): string {
  return id.split('#')[0];
}

/**
 * Result of `storeBundle` — everything a caller needs to point a layer at the
 * ingested page. `assetId` is the page's unified content address: when a source
 * file exists it is `${sourceHash}#${pageIndex}` (the light record and `dec:`
 * live under this whole id; `raw:` lives under its `#` prefix `sourceHash`);
 * with no source file it falls back to the display asset's own hash. `url` is
 * always the 8-bit display ObjectURL, kept as the fallback bitmap even when the
 * asset is high-depth (the cache may be cold on a reload).
 */
export interface AssetBundle {
  assetId: string;
  url: string;
  colorIdentity: ColorIdentity;
}

/**
 * AssetState: Asset state machine
 */
export enum AssetState {
  ALLOCATED = 'allocated',   // Hash allocated, ready to process
  PROCESSING = 'processing', // Worker is slicing/decoding
  READY = 'ready',           // Ready, ObjectURL is valid
  STALE = 'stale'            // References reached zero, waiting for garbage collection
}

/**
 * InMemAsset — the in-memory active runtime asset (renamed from the former
 * `AssetEntry`, which named this the same as the shared base class and read
 * like an internal Map/Cache-entry implementation detail rather than "the
 * live in-memory state of an asset"). Extends the shared `AssetEntry` base
 * (geometry + colour identity + display blob) with GC/lifecycle tracking, so
 * it carries the colour identity that the persisted `StoredAsset` always had
 * but the old memory-side `AssetEntry` silently dropped.
 */
export interface InMemAsset extends AssetEntry {
  url: string;             // Active Object URL
  state: AssetState;
  owners: Set<string>;     // Reference holders (GC reference count)
  lastUsedAt: number;      // Last active timestamp (LRU eviction basis)
}

/**
 * One audited entry of the persistent asset store (see {@link AssetService.auditStore}).
 * `kind: 'display'` keys by content hash and carries the light-record metadata;
 * `raw:` (encoded source file) / `dec:` (decoded high-depth pixels) carry only
 * their payload byte size — they are bare payloads, not records.
 */
export interface AssetStoreAuditEntry {
  key: string;
  kind: 'display' | 'raw' | 'dec';
  size: number;
  width?: number;
  height?: number;
  timestamp?: number;
  sourceFileName?: string;
  dataFormat?: 'rgba16float' | 'rgba32float' | undefined;
}

/**
 * Lifecycle callbacks for decoupling AssetService from engine/worker layer.
 * Injected at construction time by EditorContext — AssetService itself has
 * zero knowledge of Worker, ImageDispatcher, or any engine internals.
 */
export interface AssetServiceCallbacks {
  /**
   * Fired EXACTLY WHEN a stored record materializes into a live pool entry
   * (register fresh write / register disk-cache hit / hydrate) — the name says
   * the pool-liveness semantic, not the register call: same-session dedup (the
   * entry is already live and the engine caches already warm) fires nothing,
   * and `warmByAssetId` fires only on non-low-memory devices. `highDepthData` is
   * carried ONLY when the ingest path already confirmed a successful `storeDec`
   * persistence (the write-ordering authority stays on the asset side — the
   * handler may warm its cache with `persisted: true` on that strength alone);
   * absent on storeDec-failure degradation, and absent on the hydrate/warmByAssetId
   * paths which deliberately skip the `dec:` re-fetch (the engine's cold
   * `getOrFetch` recovery self-heals on demand).
   */
  onLoaded?: (assetId: string, blob: Blob, highDepthData?: Uint16Array | Float32Array) => void;
  /** Fired when the asset is revoked (pool eviction / GC / clear). */
  onReleased?: (assetId: string) => void;
}

/**
 * AssetService: Physical asset management service
 * Core responsibilities: Blob-to-Hash mapping, IDB storage, ObjectURL management, reference-counting GC.
 *
 * Phase 7.1: Zero Worker dependency — all Worker communication is handled via
 * event callbacks injected from EditorContext. AssetService does not import any
 * engine/worker modules.
 */
export class AssetService {
  private pool: Map<string, InMemAsset> = new Map();
  // Birth-protection stamps: assetId → registration time. Protects the
  // register→commit window (asset stored, document not yet referencing it)
  // from a concurrent sweep. TTL-bounded by design (2026-11-14 finding): the
  // former immortal Set pinned assets that were never "seen active" by any
  // sweep — registered→abandoned within one debounce window made them
  // permanently un-reclaimable (16 days of accumulation, zero reclaims).
  // 20s covers the slowest real register→dispatch chain (~1s worst case) with
  // two orders of magnitude of margin; a genuinely committed asset leaves the
  // stamp's protection the moment the document references it (activeIds).
  private pendingRegistrations: Map<string, number> = new Map();
  private activeSessions = 0; // Atomic session counter (used to suspend GC)
  private memoryClass: 'low' | 'mid' | 'high' = 'mid';
  private scanWarmTimeout: ReturnType<typeof setTimeout> | null = null;
  private callbacks: AssetServiceCallbacks;

  constructor(callbacks: AssetServiceCallbacks = {}) {
    this.callbacks = callbacks;
    this.detectMemoryClass();
    this.registerTransparentPixel();
  }

  /**
   * Update lifecycle callbacks after construction (e.g. when bridge becomes available).
   */
  setCallbacks(callbacks: AssetServiceCallbacks): void {
    this.callbacks = callbacks;
  }

  private detectMemoryClass(): void {
    if (typeof window === 'undefined') return;
    const mem = ('deviceMemory' in navigator ? (navigator as unknown as { deviceMemory: number }).deviceMemory : 4);
    if (mem <= 2) this.memoryClass = 'low';
    else if (mem >= 8) this.memoryClass = 'high';
  }

  private registerTransparentPixel() {
    const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    this.pool.set('asset-transparent-pixel', {
      id: 'asset-transparent-pixel',
      blob: new Blob([], { type: 'image/gif' }),
      url: TRANSPARENT_PIXEL,
      width: 1,
      height: 1,
      ...DEFAULT_COLOR_IDENTITY,
      state: AssetState.READY,
      owners: new Set(['system']),
      lastUsedAt: Date.now()
    });
  }

  /**
   * Compute content hash of a Blob for asset deduplication.
   * Delegates to the shared helper: SHA-256 (secure context) or MurmurHash3-128 (HTTP LAN fallback).
   */
  private calculateHash(blob: Blob): Promise<string> {
    return calculateContentHash(blob);
  }

  /**
   * Registers asset: calculates hash from the display blob and stores it in
   * the pool.
   *
   * @param input - `width`/`height` are required — callers must provide
   *   dimensions from their own decode context (e.g. DecodeResult, canvas
   *   size, resample output); AssetService no longer performs any image
   *   decoding internally. Also carries:
   *   - `dprScale`: Physical-to-logical pixel ratio for HiDPI assets.
   *   - `precomputedHash`: skip the content-hash computation.
   *   - `colorIdentity` (optional, partial): written into the light
   *     `StoredAsset`; omitted axes fall back to the 8-bit sRGB baseline (an
   *     ordinary 8-bit display asset). The heavy f16 payload itself is
   *     persisted separately via `storeDec`.
   */
  async register(input: ImageAssetInput): Promise<AssetRef> {
    const hash = input.precomputedHash ?? await this.calculateHash(input.displayBlob);
    this.pendingRegistrations.set(hash, Date.now());

    if (this.pool.has(hash)) {
      // Same-session dedup: the engine caches were warmed by the ORIGINAL
      // registration. No onLoaded re-fire — if the high-depth entry was
      // byte-budget-evicted since, the engine's cold getOrFetch recovery
      // rehydrates it from the persisted `dec:` payload on demand.
      const entry = this.pool.get(hash)!;
      entry.state = AssetState.READY;
      if (input.dprScale !== undefined) entry.dprScale = input.dprScale;
      if (input.sourceFileName !== undefined) entry.sourceFileName = input.sourceFileName;
      return { assetId: hash, url: entry.url, dimensions: { w: entry.width, h: entry.height } };
    }

    // ── Decide the record ──
    // Cached on disk: reuse it (patching dprScale/sourceFileName when this
    // registration carries fresher values). Not on disk: build it fresh and
    // persist. Both branches produce the SAME thing — one StoredAsset that
    // must become a live pool entry — so they fall through to the single
    // materialize + notify below.
    let record = await assetStore.get(hash);
    if (record) {
      const needsUpdate = (input.dprScale !== undefined && record.dprScale !== input.dprScale)
        || (input.sourceFileName !== undefined && record.sourceFileName !== input.sourceFileName);
      if (needsUpdate) {
        record = {
          ...record,
          ...(input.dprScale !== undefined ? { dprScale: input.dprScale } : {}),
          ...(input.sourceFileName !== undefined ? { sourceFileName: input.sourceFileName } : {}),
        };
        await assetStore.set(hash, record);
      }
    } else {
      record = {
        id: hash,
        width: input.width,
        height: input.height,
        dprScale: input.dprScale,
        sourceFileName: input.sourceFileName,
        gamut: input.colorIdentity?.gamut ?? DEFAULT_COLOR_IDENTITY.gamut,
        trc: input.colorIdentity?.trc ?? DEFAULT_COLOR_IDENTITY.trc,
        bitDepth: input.colorIdentity?.bitDepth ?? DEFAULT_COLOR_IDENTITY.bitDepth,
        blob: input.displayBlob,
        dataFormat: input.colorIdentity?.dataFormat,
        rawWhiteDomain: input.colorIdentity?.rawWhiteDomain,
        timestamp: Date.now(),
      };
      await assetStore.set(hash, record);
    }

    // ── Materialize + notify (ONE call, ONE onLoaded fire point) ──
    // Shared with hydrate/warmByAssetId; the confirmed-persisted high-depth payload
    // rides along to the engine cache-warm seam. No-op-safe: if a concurrent
    // register materialized the same hash in between, this is a no-op and the
    // engine caches were already warmed by that original registration.
    this.warmAsset(record, input.highDepthData);
    const url = this.pool.get(hash)!.url;

    return { assetId: hash, url, dimensions: { w: record.width, h: record.height } };
  }

  /**
   * Stores a raw source blob and returns its content hash as an independent ID.
   * Used for 16-bit TIFF/RAW imports and original GIF files — preserves
   * original data for lossless re-export. Stored under `raw:${hash}` key
   * in IDB, completely separate from any display asset's StoredAsset record.
   *
   * The returned hash is the source file's content address; `storeBundle` uses
   * it as the `#` prefix of `frame.assetId` (`${fileHash}#${pageIndex}`), so the
   * frame owns the reference to the source file. Lifecycle: source blob survives
   * layer deletion; only frame deletion triggers GC cleanup.
   */
  async storeRaw(rawBlob: Blob | undefined | null): Promise<string | undefined> {
    if (!rawBlob) return undefined;
    const hash = await this.calculateHash(rawBlob);
    await assetStore.setRaw(hash, rawBlob);
    return hash;
  }

  /**
   * Persists the DECODED high-depth naked pixels for `assetId` under `dec:${id}`
   * — the bare TypedArray, no wrapper: `Uint16Array` (f16) for
   * `dataFormat:'rgba16float'`, `Float32Array` for `'rgba32float'`. Used
   * by bake products (`PixelResult.toAsset`) and high-depth imports so a cold
   * reload/revert can warm `HighDepthCache` directly, without re-decoding
   * through vips. Geometry + colour identity are NOT stored here — they belong to
   * the light `StoredAsset` (the sole owner). Reclaimed by the grace-protected
   * `dec:` scan in `sweep`.
   *
   * Write ordering: callers persist `dec:` (heavy) BEFORE writing the light
   * record's `dataFormat`, so the predicate never claims a truth that is not yet
   * on disk.
   */
  async storeDec(assetId: string, data: Uint16Array | Float32Array): Promise<void> {
    await assetStore.setDec(assetId, data);
  }

  /**
   * One-shot ingest of a single image asset payload (the Golden Path): register
   * the display asset, store the shared raw source blob, and — if the payload
   * carries pre-decoded high-depth naked pixels — warm `HighDepthCache`
   * and persist them under the same unified id. Replaces the register→storeRaw→
   * conditional-repoint sequence that `single.ts`'s `importSingleImage`/
   * `revertSingleImage` used to duplicate verbatim.
   *
   * Takes the storage layer's own `ImageAssetPayload` contract, NOT
   * `core/files`'s `DecodedImage` — this base storage service must not
   * reverse-depend on a producer-side type to know what it is being asked to
   * store. Any producer (file decode's `DecodedImage`, engine composite bake's
   * `CompositedImage`) implements the same shape and converges on this one call.
   *
   * Unified id: when a `sourceBlob` exists the id is
   * `${sourceHash}#${pageIndex}` — the source file's content address plus its
   * zero-based page index, taken from `options.pageIndex` or (for callers still
   * passing a `DecodedImage` positionally) duck-typed off its own `index` field.
   * The light record and `dec:` key off this whole id (per-page); `raw:` keys
   * off the `#` prefix `sourceHash` alone (one physical file, one raw copy).
   * Multi-page callers therefore pass the SAME `sourceBlob` for every page and
   * share one `raw:` automatically — this is guaranteed by the id derivation,
   * not by any "pass it only once" convention. With no source file, or no page
   * index, the id falls back to the payload's own `precomputedHash` (or calculates
   * `calculateHash(payload.displayBlob)` when omitted).
   *
   * Callers and contract for `payload.precomputedHash`:
   * 1. Background: performance optimization to avoid redundant SHA-256 calculation of large displayBlobs on the main thread.
   * 2. The caller in the codebase:
   *    - `layer/services/resizing.ts`: returned via `ImageDispatcher.resample()`, where the Web Worker computes `data.hash` during the RESAMPLE task.
   * 3. Other internal pixel operations (e.g. merge, peel, fragment, frame create):
   *    Passed `CompositedImage`s have no precomputed hash (undefined), falling back automatically to `calculateHash(payload.displayBlob)` below.
   */
  async storeBundle(
    payload: ImageAssetPayload,
    sourceBlob?: Blob | null,
    options?: { pageIndex?: number; sourceFileName?: string }
  ): Promise<AssetBundle> {
    // 1. raw first: storeRaw self-hashes the source blob → raw:${fileHash},
    //    one physical file one copy — no new parameter needed.
    const fileHash = await this.storeRaw(sourceBlob);

    // 2. Unified id:
    //    - External imported source: content-address by source file hash + page index (${fileHash}#${pageIndex});
    //    - Internally generated asset (merge/bake/rasterize): content-address by display blob hash (reuse precomputedHash if provided, else compute now).
    const pageIndex = options?.pageIndex ?? (payload as { index?: number }).index;
    const hasSourceFile = fileHash !== undefined && pageIndex !== undefined;
    const finalId = hasSourceFile
      ? `${fileHash}#${pageIndex}`
      : (payload.precomputedHash ?? await this.calculateHash(payload.displayBlob));

    // Early birth protection: protect finalId before any await in storeDec
    // or register so sweep() cannot mis-identify this in-flight asset as an orphan.
    this.pendingRegistrations.set(finalId, Date.now());

    // 3. High-depth (write ordering): persist dec: (heavy) BEFORE writing
    //    the light record's dataFormat, so the light record never claims a truth
    //    that is not yet on disk. If storeDec fails (e.g. IDB quota exceeded),
    //    degrade dataFormat to undefined and STRIP the payload — the confirmed-
    //    persisted bytes are forwarded to `register` as bare `highDepthData`
    //    that rides the `onLoaded` callback (the engine-side handler warms
    //    its cache `persisted: true` on it); this service never wraps or
    //    re-shapes the pixels, it only rules whether they are disk-backed.
    //    register fires synchronously at its tail, so the entry still lands
    //    before storeBundle returns (import first frame unaffected).
    let effectiveColorIdentity = payload.colorIdentity;
    let highDepthData: Uint16Array | Float32Array | undefined;
    if (payload.highDepthData && payload.colorIdentity.dataFormat) {
      try {
        await this.storeDec(finalId, payload.highDepthData);
        highDepthData = payload.highDepthData;
      } catch (err) {
        console.error('[AssetService] storeDec failed, degrading dataFormat for', finalId, err);
        effectiveColorIdentity = {
          ...payload.colorIdentity,
          dataFormat: undefined,
        };
      }
    }

    // 4. Light record: hand register the full input — the effective
    //    colorIdentity (incl. dataFormat, incl. the storeDec-failure degrade),
    //    the sourceFileName (payload-first with options override), and the
    //    high-depth data — pinning the id via precomputedHash: finalId. A
    //    payload IS an `ImageAssetInput` with the identity adjudicated, so the
    //    whole shape passes through verbatim.
    const sourceFileName = options?.sourceFileName ?? payload.sourceFileName;
    const { assetId, url } = await this.register({
      ...payload,
      sourceFileName,
      colorIdentity: effectiveColorIdentity,
      precomputedHash: finalId,
      ...(highDepthData ? { highDepthData } : {}),
    });

    return { assetId, url, colorIdentity: effectiveColorIdentity };
  }



  /**
   * Reads a raw ENCODED source blob (the original imported file) by id, or null.
   * Facade over `assetStore.getRaw`. The caller passes the WHOLE unified id
   * (`${fileHash}#${index}`); `raw:` is keyed by `fileHash` alone, so we strip
   * the `#index` via `fileHashOf` before the lookup. `getDec` deliberately
   * does NOT strip — `dec:` keys off the whole id.
   */
  async getRaw(id: string): Promise<Blob | null> {
    return assetStore.getRaw(fileHashOf(id));
  }

  /**
   * Reads the persisted DECODED high-depth naked pixels (a bare `Uint16Array` of
   * f16 patterns, or a `Float32Array` for a 32-bit float source) by id, or null.
   * Facade over `assetStore.getDec` (symmetry with `storeDec`). The caller
   * reassembles a `HighDepthSource` using geometry + colour identity from the
   * light `StoredAsset` — whose `dataFormat` says which element type this is; a
   * `null` here when `dataFormat` said a truth should exist is a persist failure /
   * mis-GC to warn on, not a silent degrade.
   */
  async getDec(id: string): Promise<Uint16Array | Float32Array | null> {
    return assetStore.getDec(id);
  }

  /**
   * Injects asset: bypasses hash calculation, registers directly under a
   * caller-provided id (result provided by PixelResult, or a high-depth
   * import repointing its base layer at the source hash). Single-line proxy
   * onto `register` — passing `assetId` as `precomputedHash`
   * reuses `register`'s entire disk-write + pool-activation pipeline verbatim,
   * eliminating the 40+ lines that used to duplicate it line-for-line. Safe
   * because `assetId` here is always a content hash (from `PixelResult` or a
   * high-depth source hash), so a `register` cache-hit on that id is by
   * construction the same content, never a stale collision.
   */
  async inject(assetId: string, input: ImageAssetInput): Promise<AssetRef> {
    return this.register({ ...input, precomputedHash: assetId });
  }

  /**
   * Warms up the assets named by `activeIds` (the document-referenced set the
   * caller derives from frames + history). IDENTITY SEMANTIC: the caller's set
   * is authoritative in BOTH directions — an EMPTY set warms NOTHING (an empty
   * document owns no pixels; full-pool enumeration here once decoded every
   * asset in the store on any 0-frame boot, the 2026-11-14 crash-storm
   * finding). Late cold loads of a named asset self-heal through the
   * render-loop's `getOrFetch` recovery path, so under-warming is safe by
   * construction.
   */
  async hydrate(activeIds: Set<string>): Promise<void> {
    if (activeIds.size === 0) return;
    const start = Date.now();
    let count = 0;

    for (const id of activeIds) {
      if (this.pool.has(id)) continue;
      const item = await assetStore.get(id); // light-path get; guards stale schema
      if (item) {
        this.warmAsset(item);
        count++;
      }
    }

    if (PERF_MON && count > 0) {
      console.debug(`[Assets] Hydrated ${count} active assets in ${Date.now() - start}ms`);
    }
  }

  /**
   * warmAsset — the SINGLE door from a stored record to a live pool asset:
   * object URL + pool set + resource tracking, then (by default) the ONE
   * `onLoaded` notification — the engine cache-warm seam. `highDepthData` is
   * forwarded when the caller re-hydrated from a confirmed `dec:` payload.
   *
   * `notify: false` is the ONE deliberate bypass (predictive warm on
   * low-memory devices: skip the L3 decode cost, cold `getOrFetch` self-heals
   * on first read). The flag keeps the door singular — every materialization
   * in the service goes through this one function, so the runtime shape (and
   * the resourceTracker bookkeeping revoke depends on) can never drift the
   * way the former bypassed copy did.
   */
  private warmAsset(
    item: StoredAsset,
    highDepthData?: Uint16Array | Float32Array,
    options?: { notify?: boolean },
  ): void {
    if (this.pool.has(item.id)) return;
    // AssetEntry (id, blob, width, height, dprScale, gamut, trc, bitDepth,
    // dataFormat) is inherited straight off the persisted record — no
    // TileMetadata to rebuild (it is abolished; the WebGPU renderer has no
    // use for tiling).
    const url = URL.createObjectURL(item.blob);
    this.pool.set(item.id, {
      ...item,
      url,
      state: AssetState.READY,
      owners: new Set(),
      lastUsedAt: Date.now()
    });
    resourceTracker.track(`asset:${item.id}`, 'image_decoded', item.blob.size, `Hydrated ${item.id.slice(0, 8)}`);

    if (options?.notify === false) return;
    this.callbacks.onLoaded?.(item.id, item.blob, highDepthData);
  }

  /**
   * warmByAssetId — predictive single-asset warm (L1-L3 pipeline): check the
   * pool, then the store, then bring the record live. The DEFAULT path is the
   * same `warmAsset` chokepoint as everywhere else; low-memory devices pass
   * `notify: false` (skip the L3 decode cost — the cold `getOrFetch` recovery
   * self-heals on first read instead).
   */
  async warmByAssetId(assetId: string) {
    if (this.pool.has(assetId)) return;
    const hasPhysical = await assetStore.has(assetId);
    if (!hasPhysical) return;

    const item = await assetStore.get(assetId); // light-path get; guards stale schema
    if (!item || this.pool.has(assetId)) return; // Double check
    // Elastic warmup: L3 decoding is disabled for low-end devices
    this.warmAsset(item, undefined, { notify: this.memoryClass !== 'low' });
  }

  /**
   * Background predictive scheduling and perception scanning (debounced)
   */
  scanAndPrewarm(context: { historyPast?: { undoPatches?: { value: unknown; path: string }[] }[], activeLayerAssetIds?: string[] }) {
    if (this.scanWarmTimeout) clearTimeout(this.scanWarmTimeout);
    this.scanWarmTimeout = setTimeout(() => {
      const idsToPrewarm = new Set<string>();

      // 1. History Depth Prediction (Top 3)
      if (context.historyPast && Array.isArray(context.historyPast)) {
        const recentSteps = context.historyPast.slice(0, 3);
        for (const step of recentSteps) {
          if (step.undoPatches) {
            for (const patch of step.undoPatches) {
              if (typeof patch.value === 'string' && 
                 (patch.path.endsWith('/assetId') || patch.path.endsWith('/src'))) {
                idsToPrewarm.add(patch.value);
              }
            }
          }
        }
      }

      // 2. Layer Prediction
      if (context.activeLayerAssetIds) {
        context.activeLayerAssetIds.forEach(id => {
          if (id) idsToPrewarm.add(id);
        });
      }

      idsToPrewarm.forEach(id => this.warmByAssetId(id));
    }, 150);
  }

  resolve(assetId?: string, fallbackSrc?: string): string {
    if (assetId) {
      const url = this.getURL(assetId);
      if (url) return url;
    }
    return fallbackSrc || '';
  }

  acquire(assetId: string, ownerId: string) {
    const asset = this.pool.get(assetId);
    if (asset) {
      asset.owners.add(ownerId);
      asset.state = AssetState.READY;
      asset.lastUsedAt = Date.now();
    }
  }

  release(assetId: string, ownerId: string) {
    const asset = this.pool.get(assetId);
    if (asset) {
      asset.owners.delete(ownerId);
      asset.lastUsedAt = Date.now();
      if (asset.owners.size === 0) asset.state = AssetState.STALE;
    }
  }

  get(assetId: string): InMemAsset | undefined {
    return this.pool.get(assetId);
  }

  getURL(assetId: string): string | undefined {
    return this.pool.get(assetId)?.url;
  }

  private revoke(id: string) {
    const asset = this.pool.get(id);
    if (asset) {
      URL.revokeObjectURL(asset.url);
      this.pool.delete(id);
      resourceTracker.release(`asset:${id}`);
      // Notify engine layer to evict its caches (Worker cache + high-depth
      // channel) — the eviction handlers live engine-side via this seam.
      this.callbacks.onReleased?.(id);
      // Delete ordering: erase the light record FIRST (so a concurrent
      // get() sees the asset as absent), THEN the heavy `dec:` payload; any
      // residual `dec:` is a safety net for the grace-protected reclaim scan.
      // Raw blobs (raw:${hash}) are cleaned separately by the raw orphan sweep.
      assetStore.remove(id)
        .then(() => assetStore.removeDec(id))
        .catch(err => {
          console.error(`[AssetService] Failed to remove physical asset ${id} from store:`, err);
        });
    }
  }

  beginSession() { this.activeSessions++; }
  endSession() { this.activeSessions = Math.max(0, this.activeSessions - 1); }
  async withSession<T>(task: () => Promise<T>): Promise<T> {
    try { this.beginSession(); return await task(); } finally { this.endSession(); }
  }

  sweep(activeIdsInState: Set<string>, force = false) {
    if (this.activeSessions > 0) return;
    const toRevoke: string[] = [];
    const now = Date.now();
    const GRACE_PERIOD = force ? 0 : 5000;

    for (const [id, asset] of this.pool.entries()) {
      if (id === 'asset-transparent-pixel') continue; // Protect built-in transparent pixel asset from garbage collection
      if (activeIdsInState.has(id)) {
        this.acquire(id, 'slow-track');
        this.pendingRegistrations.delete(id);
      } else {
        // Release WITHOUT the lastUsedAt refresh `release()` performs: the
        // grace period must measure the time since the last real USE (an
        // active sighting), not since the last sweep — the refresh made
        // `now - lastUsedAt > GRACE_PERIOD` permanently false for every
        // non-active asset, so the revoke pipeline below was unreachable.
        asset.owners.delete('slow-track');
        if (asset.owners.size === 0) asset.state = AssetState.STALE;
      }

      // 💡 If it is a forced GC (e.g. deleting an artboard), ignore the 5-second grace period and suspension protection, and reclaim directly
      const isGracePeriodExpired = force || (now - asset.lastUsedAt > GRACE_PERIOD);
      // TTL-aware birth protection: a stamp protects ONLY while fresh. An
      // expired stamp no longer pins — an asset registered more than
      // PENDING_REGISTRATION_TTL_MS ago that the document still has not
      // referenced is an orphan by definition (the legitimate register→commit
      // chain is milliseconds), so it falls through to the normal
      // STALE → grace → revoke pipeline like any other unreferenced asset.
      const stampTime = this.pendingRegistrations.get(id);
      const isNotProtected = force || stampTime === undefined || (now - stampTime > PENDING_REGISTRATION_TTL_MS);

      if (asset.owners.size === 0 && asset.state === AssetState.STALE && isNotProtected && isGracePeriodExpired) {
        toRevoke.push(id);
      }
    }
    toRevoke.forEach(id => this.revoke(id));

    // Build the protected set for the heavy-payload orphan-reclaim scan:
    //   protected = activeIdsInState ∪ fresh pendingRegistrations (new-asset grace)
    //             ∪ pool entries still inside their grace window.
    // A high-depth asset orphaned during a single reload never enters the pool
    // → is never revoke()'d → its ~192MB `dec:` would leak forever without this
    // independent scan. Grace protection ALSO covers the `raw:` scan now:
    // a just-written raw: has a naked window between storeRaw and the id landing
    // in activeIdsInState (addFrame commit + 2s debounce), so the raw branch must
    // consult pendingRegistrations too — its former "grace-free by design" was a hazard.
    const decGracePeriod = force ? 0 : GRACE_PERIOD;
    const protectedHeavyIds = new Set<string>(activeIdsInState);
    // Fresh stamps only — an expired stamp stops protecting the heavy
    // payloads too (same TTL rule as the pool revocation above).
    for (const [pid, stampTime] of this.pendingRegistrations) {
      if (now - stampTime <= PENDING_REGISTRATION_TTL_MS) protectedHeavyIds.add(pid);
    }
    for (const [id, asset] of this.pool.entries()) {
      if (now - asset.lastUsedAt <= decGracePeriod) protectedHeavyIds.add(id);
    }
    // Hygiene: drop expired stamps so the map stays bounded (a stamp whose
    // asset was never referenced is dead weight after its TTL anyway).
    for (const [pid, stampTime] of this.pendingRegistrations) {
      if (now - stampTime > PENDING_REGISTRATION_TTL_MS) this.pendingRegistrations.delete(pid);
    }
    // `raw:` is keyed by fileHash while the protected ids are `${fileHash}#${index}`,
    // so a precise `.has()` always misses — pre-extract the protected file hashes
    // once and test the raw scan by prefix membership against this set.
    const protectedFileHashes = new Set<string>();
    for (const pid of protectedHeavyIds) protectedFileHashes.add(fileHashOf(pid));

    // Clean up orphaned heavy payloads in IDB (not tracked by pool).
    // `raw:${fileHash}` = encoded source; `dec:${id}` = decoded f16 naked pixels.
    // When a frame is deleted, its frame.assetId disappears from activeIdsInState.
    assetStore.keys().then(async (allKeys) => {
      // Display records orphaned by the SAME protected set the raw:/dec:
      // scans trust — the third keyspace, closed into the same auto-reclaim
      // policy (the panel's manual Purge stays as the immediate bypass path).
      const displayCandidates: string[] = [];
      for (const key of allKeys) {
        if (key.startsWith('raw:')) {
          // Encoded source, keyed by fileHash (one physical file, one copy) and
          // shared by every page: alive ⟺ any protected id carries this fileHash
          // as its `#` prefix. Same-source multi-page survives while any one page
          // is still live; a just-imported raw: is grace-protected via a fresh pendingRegistrations stamp.
          const fileHash = key.slice(4);
          if (!protectedFileHashes.has(fileHash)) {
            assetStore.removeRaw(fileHash).catch(err => {
              console.error(`[AssetService] Failed to remove orphaned raw blob ${fileHash}:`, err);
            });
          }
        } else if (key.startsWith('dec:')) {
          // Decoded f16 naked pixels (bake products / high-depth imports).
          // Grace-protected: reclaim only when NOT in the protected set. Keyed by
          // the WHOLE id (per-page), so a precise `.has()` is correct here.
          const decId = key.slice(4);
          if (!protectedHeavyIds.has(decId)) {
            assetStore.removeDec(decId).catch(err => {
              console.error(`[AssetService] Failed to remove orphaned dec buffer ${decId}:`, err);
            });
          }
        } else if (key !== 'asset-transparent-pixel' && !protectedHeavyIds.has(key)) {
          displayCandidates.push(key);
        }
      }
      // Display-record reclaim: the protected set answers "orphaned"; the
      // record's own persisted timestamp answers "aged" — BOTH must hold
      // before auto-removal. `force` (panel Force GC / artboard deletion)
      // bypasses the age gate; a missing timestamp on a legacy record is
      // never auto-removed (manual Purge handles those). Removing a display
      // record orphans its raw:/dec: companions, which the scans above (or
      // the next sweep) reclaim through the same protected set — no extra
      // cascade code.
      if (displayCandidates.length === 0) return;
      const removals: Array<Promise<unknown>> = [];
      let removed = 0;
      let bytes = 0;
      for (const key of displayCandidates) {
        const record = await assetStore.get(key);
        if (!record) continue;
        if (!force && (!record.timestamp || now - record.timestamp < DISPLAY_ORPHAN_RECLAIM_AGE_MS)) continue;
        bytes += record.blob instanceof Blob ? record.blob.size : 0;
        removals.push(assetStore.remove(key));
        this.callbacks.onReleased?.(key);
        removed++;
      }
      await Promise.all(removals);
      if (removed > 0) {
        // Non-silent by contract: one aggregated audit line per reclaim batch.
        console.info(`[AssetService] Display-orphan sweep: removed ${removed} store records (${(bytes / 1024).toFixed(1)} KB)`);
      }
    }).catch(err => {
      console.error('[AssetService] Heavy-payload GC scan failed:', err);
    });
  }

  async clear() {
    for (const [id] of this.pool) this.revoke(id);
    this.pool.clear();
    this.pendingRegistrations.clear();
    await assetStore.clear();
  }

  getPool(): Record<string, InMemAsset> {
    const obj: Record<string, InMemAsset> = {};
    for (const [id, entry] of this.pool.entries()) {
      obj[id] = entry;
    }
    return obj;
  }

  /**
   * Light-weight IDB audit for diagnostics UIs: scans the ENTIRE asset store
   * (display records + `raw:`/`dec:` heavy payloads) and returns per-entry
   * METADATA only — never blob bytes for display assets (a Blob reference
   * deserializes cheaply; `blob.size` is metadata, not a copy). `raw:`/`dec:`
   * values ARE their payloads, so they are read ONE AT A TIME sequentially to
   * cap peak memory, sized, and immediately released. The in-memory `pool`
   * only ever knows what THIS session hydrated; this method is the store-level
   * truth diagnostics need (orphan detection, dead-weight accounting).
   */
  async auditStore(): Promise<AssetStoreAuditEntry[]> {
    const entries: AssetStoreAuditEntry[] = [];
    const keys = await assetStore.keys();
    const displayKeys = keys.filter((k) => !k.startsWith('raw:') && !k.startsWith('dec:'));
    // Display records first (cheap: Blob refs only), then heavy payloads one-by-one.
    for (const key of displayKeys) {
      const record = await assetStore.get(key);
      if (!record) continue;
      entries.push({
        key,
        kind: 'display',
        size: record.blob instanceof Blob ? record.blob.size : -1,
        width: record.width,
        height: record.height,
        timestamp: record.timestamp,
        sourceFileName: record.sourceFileName,
        dataFormat: record.dataFormat,
      });
    }
    for (const key of keys) {
      if (key.startsWith('raw:')) {
        const blob = await assetStore.getRaw(key.slice(4));
        if (blob) entries.push({ key, kind: 'raw', size: blob.size });
      } else if (key.startsWith('dec:')) {
        const data = await assetStore.getDec(key.slice(4));
        if (data) entries.push({ key, kind: 'dec', size: data.byteLength });
      }
    }
    return entries;
  }

  /**
   * Purges every persisted entry NOT protected by `referencedIds` (the
   * document-referenced set the caller derives from the CURRENT state —
   * frames + history, the same authority as `sweep`). Protection is
   * deliberately OVER-broad (数据安全不对称: a falsely-kept entry wastes
   * space, a falsely-deleted one destroys user pixels):
   *   `referencedIds` ∪ fresh pendingRegistrations (birth grace) ∪ session pool ∪ the
   *   system placeholder. `raw:` blobs stay while ANY protected id carries
   *   their file-hash prefix (multi-page sharing).
   *
   * Unlike `sweep`, this scans the STORE keys directly, so it reaches
   * entries the session pool never hydrated (the class of dead weight
   * `sweep` structurally cannot see). Each purged display/dec id fires
   * `onReleased` so engine-side caches (high-depth channel, worker cache)
   * evict through the sanctioned seam — this service stays engine-agnostic.
   * Callers should refresh their audit afterwards.
   */
  async purgeOrphans(referencedIds: Set<string>): Promise<{ removed: number; bytes: number }> {
    const protectedIds = new Set<string>(referencedIds);
    protectedIds.add('asset-transparent-pixel');
    // Fresh stamps only — an expired stamp no longer pins (TTL rule).
    for (const [pid, stampTime] of this.pendingRegistrations) {
      if (Date.now() - stampTime <= PENDING_REGISTRATION_TTL_MS) protectedIds.add(pid);
    }
    for (const id of this.pool.keys()) protectedIds.add(id);
    const protectedFileHashes = new Set<string>();
    for (const id of protectedIds) protectedFileHashes.add(fileHashOf(id));

    const keys = await assetStore.keys();
    const removals: Array<Promise<unknown>> = [];
    let removed = 0;
    let bytes = 0;
    for (const key of keys) {
      if (key.startsWith('raw:')) {
        if (protectedFileHashes.has(key.slice(4))) continue;
        removals.push(assetStore.removeRaw(key.slice(4)));
        removed++;
      } else if (key.startsWith('dec:')) {
        // `dec:` keys off the WHOLE bare asset id (no prefix) — strip before
        // testing the protected set. `removeDec` adds the prefix itself, so it
        // takes the bare id too; and the engine seam is released with the bare
        // id its caches are keyed by.
        const decId = key.slice(4);
        if (protectedIds.has(decId)) continue;
        removals.push(assetStore.removeDec(decId));
        removed++;
        this.callbacks.onReleased?.(decId);
      } else {
        if (protectedIds.has(key)) continue;
        const record = await assetStore.get(key);
        if (!record) continue;
        bytes += record.blob instanceof Blob ? record.blob.size : 0;
        removals.push(assetStore.remove(key));
        removed++;
        this.callbacks.onReleased?.(key);
      }
    }
    await Promise.all(removals);
    return { removed, bytes };
  }

  /**
   * On-demand preview URL for ONE persisted entry (diagnostics UI). `display`
   * and `raw:` entries hold decodable image blobs → ObjectURL (the caller owns
   * revoking). `dec:` entries are naked float pixel arrays with no container —
   * no preview is possible without a full render pass, so null. Reads the
   * single record fresh from the store (works for entries the session pool
   * never hydrated).
   */
  async getAssetPreviewUrl(key: string): Promise<string | null> {
    try {
      if (key.startsWith('dec:')) return null;
      if (key.startsWith('raw:')) {
        const blob = await assetStore.getRaw(key.slice(4));
        return blob ? URL.createObjectURL(blob) : null;
      }
      const record = await assetStore.get(key);
      return record?.blob instanceof Blob ? URL.createObjectURL(record.blob) : null;
    } catch {
      return null;
    }
  }
}

export const createAssetService = (callbacks?: AssetServiceCallbacks) => new AssetService(callbacks);
