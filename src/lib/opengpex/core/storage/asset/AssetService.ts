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
import { highDepthTextureCache } from '@opengpex/editor/core/engine';
import type { ImageAssetPayload } from './AssetStore';

/**
 * The 8-bit sRGB colour-identity baseline applied when a caller supplies no
 * colour identity fields — an ordinary 8-bit sRGB display asset genuinely IS
 * sRGB / srgb-trc, so this is the correct identity, not a lossy fallback.
 */
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
 * AssetInputOptions — the single object-shaped input for both `register` and
 * `inject`. Replaces the historical split between `register`'s
 * `dimensions: { w, h }` + `options` and `inject`'s `meta: { width, height }`
 * — two different names for the same geometry, two different parameter
 * shapes for the same intent. Colour identity is optional and flat (mirrors
 * `ColorIdentity`); omitted fields fall back to `DEFAULT_COLOR_IDENTITY`.
 */
export interface AssetInputOptions extends Partial<ColorIdentity> {
  width: number;
  height: number;
  dprScale?: number;
  precomputedHash?: string;
  sourceFileName?: string;
}

/**
 * Result of `storeBundle` — everything a caller needs to point a layer at the
 * ingested page. `assetId` is the page's unified content address: when a source
 * file exists it is `${sourceHash}#${pageIndex}` (the light record and `dec:`
 * live under this whole id; `raw:` lives under its `#` prefix `sourceHash`);
 * with no source file it falls back to the display asset's own hash. `url` is
 * always the 8-bit display ObjectURL, kept as the fallback bitmap even when the
 * asset is high-depth (§4.5.1 — the cache may be cold on a reload).
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
 * Lifecycle callbacks for decoupling AssetService from engine/worker layer.
 * Injected at construction time by EditorContext — AssetService itself has
 * zero knowledge of Worker, ImageDispatcher, or any engine internals.
 */
export interface AssetServiceCallbacks {
  onRegistered?: (assetId: string, blob: Blob) => void;
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
  private pendingIds: Set<string> = new Set(); // Grace period for new assets
  private activeSessions = 0; // Atomic session counter (used to suspend GC)
  private memoryClass: 'low' | 'mid' | 'high' = 'mid';
  private prewarmTimeout: ReturnType<typeof setTimeout> | null = null;
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
   * Registers asset: calculates hash from Blob and stores it in the pool.
   *
   * @param blob - The binary data to register.
   * @param options - `width`/`height` are required — callers must provide
   *   dimensions from their own decode context (e.g. DecodeResult, canvas
   *   size, resample output); AssetService no longer performs any image
   *   decoding internally. Also carries:
   *   - `dprScale`: Physical-to-logical pixel ratio for HiDPI assets.
   *   - `precomputedHash`: skip the content-hash computation.
   *   - colour identity (`gamut` / `trc` / `bitDepth` / `dataFormat`): written
   *     into the light `StoredAsset`. Omitted ⇒ the 8-bit sRGB baseline (an
   *     ordinary 8-bit display asset). The heavy f16 payload itself is
   *     persisted separately via `storeDec`.
   */
  async register(blob: Blob, options: AssetInputOptions): Promise<AssetRef> {
    const { width, height, dprScale, precomputedHash, sourceFileName, ...identity } = options;

    const hash = precomputedHash ?? await this.calculateHash(blob);
    this.pendingIds.add(hash);

    if (this.pool.has(hash)) {
      const entry = this.pool.get(hash)!;
      entry.state = AssetState.READY;
      if (dprScale !== undefined) entry.dprScale = dprScale;
      if (sourceFileName !== undefined) entry.sourceFileName = sourceFileName;
      return { assetId: hash, url: entry.url, dimensions: { w: entry.width, h: entry.height } };
    }

    const cached = await assetStore.get(hash);
    if (cached) {
      const needsUpdate = (dprScale !== undefined && cached.dprScale !== dprScale)
        || (sourceFileName !== undefined && cached.sourceFileName !== sourceFileName);
      const record = needsUpdate
        ? {
            ...cached,
            ...(dprScale !== undefined ? { dprScale } : {}),
            ...(sourceFileName !== undefined ? { sourceFileName } : {}),
          }
        : cached;
      if (record !== cached) await assetStore.set(hash, record);
      this.loadEntry(record);
      const loadedEntry = this.pool.get(hash)!;
      return { assetId: hash, url: loadedEntry.url, dimensions: { w: loadedEntry.width, h: loadedEntry.height } };
    }

    const record: StoredAsset = {
      id: hash,
      width,
      height,
      dprScale,
      sourceFileName,
      gamut: identity.gamut ?? DEFAULT_COLOR_IDENTITY.gamut,
      trc: identity.trc ?? DEFAULT_COLOR_IDENTITY.trc,
      bitDepth: identity.bitDepth ?? DEFAULT_COLOR_IDENTITY.bitDepth,
      blob,
      dataFormat: identity.dataFormat,
      renderIntent: identity.renderIntent,
      timestamp: Date.now(),
    };
    await assetStore.set(hash, record);

    const url = URL.createObjectURL(blob);
    this.pool.set(hash, {
      ...record,
      url,
      state: AssetState.READY,
      owners: new Set(),
      lastUsedAt: Date.now()
    });
    resourceTracker.track(`asset:${hash}`, 'image_decoded', blob.size, `Image ${hash.slice(0, 8)}`);

    // Notify engine layer (ImageDispatcher subscribes to warm Worker cache)
    this.callbacks.onRegistered?.(hash, blob);

    return { assetId: hash, url, dimensions: { w: width, h: height } };
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
   * `dataFormat:'rgba16float'`, `Float32Array` for `'rgba32float'` (§6.5). Used
   * by bake products (`PixelResult.toAsset`) and high-depth imports so a cold
   * reload/revert can warm `HighDepthTextureCache` directly, without re-decoding
   * through vips. Geometry + colour identity are NOT stored here — they belong to
   * the light `StoredAsset` (the sole owner). Reclaimed by the grace-protected
   * `dec:` scan in `sweep`.
   *
   * §6.4 write ordering: callers persist `dec:` (heavy) BEFORE writing the light
   * record's `dataFormat`, so the predicate never claims a truth that is not yet
   * on disk.
   */
  async storeDec(assetId: string, data: Uint16Array | Float32Array): Promise<void> {
    await assetStore.setDec(assetId, data);
  }

  /**
   * One-shot ingest of a single image asset payload (the Golden Path): register
   * the display asset, store the shared raw source blob, and — if the payload
   * carries pre-decoded high-depth naked pixels — warm `HighDepthTextureCache`
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
   * Unified id (§2.1): when a `sourceBlob` exists the id is
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
   * 2. The 2 callers in the codebase:
   *    - `layer/services/resample.ts`: returned via `ImageDispatcher.resample()`, where the Web Worker computes `data.hash` during the RESAMPLE task;
   *    - `PixelFacade.rasterize.layer`: returned via `RasterizeDispatcher.layer()`, where the dispatcher precomputes `calculateHash(blob)` after rasterizing text/vectors to bitmaps.
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

    // Early birth protection (§2.3): protect finalId before any await in storeDec
    // or register so sweep() cannot mis-identify this in-flight asset as an orphan.
    this.pendingIds.add(finalId);

    // 3. High-depth (write ordering §6.4): persist dec: (heavy) BEFORE writing
    //    the light record's dataFormat, so the light record never claims a truth
    //    that is not yet on disk. If storeDec fails (e.g. IDB quota exceeded),
    //    degrade dataFormat to undefined rather than leaving a dangling claim.
    let effectiveColorIdentity = payload.colorIdentity;
    if (payload.highDepthSource && payload.colorIdentity.dataFormat) {
      const hd = payload.highDepthSource;
      try {
        await this.storeDec(finalId, hd.data);
        highDepthTextureCache.set(finalId, {
          data: hd.data,
          width: hd.width,
          height: hd.height,
          dataFormat: payload.colorIdentity.dataFormat,
          trc: payload.colorIdentity.trc,
          gamut: payload.colorIdentity.gamut,
          renderIntent: payload.colorIdentity.renderIntent,
        }, { persisted: true });
      } catch (err) {
        console.error('[AssetService] storeDec failed, degrading dataFormat for', finalId, err);
        effectiveColorIdentity = {
          ...payload.colorIdentity,
          dataFormat: undefined,
        };
      }
    }

    // 4. Light record: hand register the effective colorIdentity (incl. dataFormat),
    //    the HiDPI scale, and the sourceFileName (payload-first with options override),
    //    pinning the id via precomputedHash: finalId.
    const sourceFileName = options?.sourceFileName ?? payload.sourceFileName;
    const { assetId, url } = await this.register(payload.displayBlob, {
      width: payload.width,
      height: payload.height,
      dprScale: payload.dprScale,
      sourceFileName,
      ...effectiveColorIdentity,
      precomputedHash: finalId,
    });



    return { assetId, url, colorIdentity: effectiveColorIdentity };
  }



  /**
   * Reads a raw ENCODED source blob (the original imported file) by id, or null.
   * Facade over `assetStore.getRaw`. The caller passes the WHOLE unified id
   * (`${fileHash}#${index}`); `raw:` is keyed by `fileHash` alone, so we strip
   * the `#index` via `fileHashOf` before the lookup (§3.5). `getDec` deliberately
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
   * onto `register` (§5.3, option A) — passing `assetId` as `precomputedHash`
   * reuses `register`'s entire disk-write + pool-activation pipeline verbatim,
   * eliminating the 40+ lines that used to duplicate it line-for-line. Safe
   * because `assetId` here is always a content hash (from `PixelResult` or a
   * high-depth source hash), so a `register` cache-hit on that id is by
   * construction the same content, never a stale collision.
   */
  async inject(assetId: string, blob: Blob, options: AssetInputOptions): Promise<AssetRef> {
    return this.register(blob, { ...options, precomputedHash: assetId });
  }

  /**
   * Restores asset
   */
  async hydrate(activeIds?: Set<string>): Promise<void> {
    const start = Date.now();
    let count = 0;

    if (activeIds && activeIds.size > 0) {
      for (const id of activeIds) {
        if (this.pool.has(id)) continue;
        const item = await assetStore.get(id); // light-path get; guards stale schema
        if (item) {
          this.loadEntry(item);
          count++;
        }
      }
    } else {
      // No active-id hint: enumerate the LIGHT records only (getAll filters out
      // the heavy `raw:`/`dec:` prefixes) — never `iterate()` the mixed keyspace.
      const stored = await assetStore.getAll();
      for (const item of stored) {
        if (this.pool.has(item.id)) continue;
        this.loadEntry(item);
        count++;
      }
    }

    if (PERF_MON && count > 0) {
      console.debug(`[Assets] Hydrated ${count} active assets in ${Date.now() - start}ms`);
    }
  }

  private loadEntry(item: StoredAsset) {
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

    // Display asset: notify engine layer to warm Worker cache
    this.callbacks.onRegistered?.(item.id, item.blob);
  }

  /**
   * Warms up a single asset (L1-L3 pipeline)
   */
  async prewarm(assetId: string) {
    if (this.pool.has(assetId)) return;
    const hasPhysical = await assetStore.has(assetId);
    if (!hasPhysical) return;

    const item = await assetStore.get(assetId); // light-path get; guards stale schema
    if (item) {
      if (this.pool.has(assetId)) return; // Double check
      const url = URL.createObjectURL(item.blob);
      this.pool.set(item.id, {
        ...item,
        url,
        state: AssetState.READY,
        owners: new Set(),
        lastUsedAt: Date.now()
      });

      // Elastic warmup: L3 decoding is disabled for low-end devices
      if (this.memoryClass !== 'low') {
        this.callbacks.onRegistered?.(item.id, item.blob);
      }
    }
  }

  /**
   * Background predictive scheduling and perception scanning (debounced)
   */
  scanAndPrewarm(context: { historyPast?: { undoPatches?: { value: unknown; path: string }[] }[], activeLayerAssetIds?: string[] }) {
    if (this.prewarmTimeout) clearTimeout(this.prewarmTimeout);
    this.prewarmTimeout = setTimeout(() => {
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

      idsToPrewarm.forEach(id => this.prewarm(id));
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
      highDepthTextureCache.delete(id);
      resourceTracker.release(`asset:${id}`);
      // Notify engine layer to evict Worker cache
      this.callbacks.onReleased?.(id);
      // §6.4 delete ordering: erase the light record FIRST (so a concurrent
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
        this.pendingIds.delete(id);
      } else {
        this.release(id, 'slow-track');
      }

      // 💡 If it is a forced GC (e.g. deleting an artboard), ignore the 5-second grace period and suspension protection, and reclaim directly
      const isGracePeriodExpired = force || (now - asset.lastUsedAt > GRACE_PERIOD);
      const isNotProtected = force || !this.pendingIds.has(id);

      if (asset.owners.size === 0 && asset.state === AssetState.STALE && isNotProtected && isGracePeriodExpired) {
        toRevoke.push(id);
      }
    }
    toRevoke.forEach(id => this.revoke(id));

    // Build the protected set for the heavy-payload orphan-reclaim scan (§6.3):
    //   protected = activeIdsInState ∪ pendingIds (new-asset grace)
    //             ∪ pool entries still inside their grace window.
    // A high-depth asset orphaned during a single reload never enters the pool
    // → is never revoke()'d → its ~192MB `dec:` would leak forever without this
    // independent scan. Grace protection ALSO covers the `raw:` scan now (§2.3):
    // a just-written raw: has a naked window between storeRaw and the id landing
    // in activeIdsInState (addFrame commit + 2s debounce), so the raw branch must
    // consult pendingIds too — its former "grace-free by design" was a hazard.
    const decGracePeriod = force ? 0 : GRACE_PERIOD;
    const protectedHeavyIds = new Set<string>(activeIdsInState);
    for (const pid of this.pendingIds) protectedHeavyIds.add(pid);
    for (const [id, asset] of this.pool.entries()) {
      if (now - asset.lastUsedAt <= decGracePeriod) protectedHeavyIds.add(id);
    }
    // `raw:` is keyed by fileHash while the protected ids are `${fileHash}#${index}`,
    // so a precise `.has()` always misses — pre-extract the protected file hashes
    // once and test the raw scan by prefix membership against this set.
    const protectedFileHashes = new Set<string>();
    for (const pid of protectedHeavyIds) protectedFileHashes.add(fileHashOf(pid));

    // Clean up orphaned heavy payloads in IDB (not tracked by pool).
    // `raw:${fileHash}` = encoded source; `dec:${id}` = decoded f16 naked pixels.
    // When a frame is deleted, its frame.assetId disappears from activeIdsInState.
    assetStore.keys().then(allKeys => {
      for (const key of allKeys) {
        if (key.startsWith('raw:')) {
          // Encoded source, keyed by fileHash (one physical file, one copy) and
          // shared by every page: alive ⟺ any protected id carries this fileHash
          // as its `#` prefix. Same-source multi-page survives while any one page
          // is still live; a just-imported raw: is grace-protected via pendingIds.
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
        }
      }
    }).catch(err => {
      console.error('[AssetService] Heavy-payload GC scan failed:', err);
    });
  }

  async clear() {
    for (const [id] of this.pool) this.revoke(id);
    this.pool.clear();
    await assetStore.clear();
  }

  getPool(): Record<string, InMemAsset> {
    const obj: Record<string, InMemAsset> = {};
    for (const [id, entry] of this.pool.entries()) {
      obj[id] = entry;
    }
    return obj;
  }
}

export const createAssetService = (callbacks?: AssetServiceCallbacks) => new AssetService(callbacks);
