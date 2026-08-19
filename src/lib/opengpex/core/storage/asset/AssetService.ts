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

import { TileMetadata, AssetRef } from '@opengpex/editor/core/types';
import { assetStore, ASSET_VERSION } from './AssetStore';
import { resourceTracker } from '@opengpex/editor/core/advanced/ResourceTracker';
import { calculateContentHash } from '@opengpex/editor/core/helpers/hash';
import { buildTileMeta } from '@opengpex/editor/core/helpers/tiling';
import { PERF_MON } from '@opengpex/editor/core/helpers/config';

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
 * AssetEntry: Asset entry in memory
 */
export interface AssetEntry {
  id: string;        // SHA-256 Hash
  blob: Blob;        // Raw binary data
  url: string;       // Active Object URL
  tileMeta?: TileMetadata; // Tile metadata
  state: AssetState;
  owners: Set<string>;     // Reference holders
  lastUsedAt: number;      // Last active timestamp
}

/**
 * Lifecycle callbacks for decoupling AssetService from engine/worker layer.
 * Injected at construction time by EditorContext — AssetService itself has
 * zero knowledge of Worker, ImageDispatcher, or any engine internals.
 */
export interface AssetServiceCallbacks {
  onRegistered?: (hash: string, blob: Blob) => void;
  onReleased?: (hash: string) => void;
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
  private pool: Map<string, AssetEntry> = new Map();
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
   * @param dimensions - Width and height of the asset. Required — callers must
   *   provide dimensions from their own decode context (e.g. DecodeResult,
   *   canvas size, resample output). AssetService no longer performs any
   *   image decoding internally.
   * @param options - Optional settings:
   *   - `dprScale`: Physical-to-logical pixel ratio for HiDPI assets.
   */
  async register(
    blob: Blob,
    dimensions: { w: number; h: number },
    options?: { dprScale?: number },
  ): Promise<AssetRef> {
    const dprScale = options?.dprScale;

    const hash = await this.calculateHash(blob);
    this.pendingIds.add(hash);

    if (this.pool.has(hash)) {
      const entry = this.pool.get(hash)!;
      entry.state = AssetState.READY;
      if (dprScale !== undefined && entry.tileMeta) {
        entry.tileMeta.dprScale = dprScale;
      }
      const dim = entry.tileMeta
        ? { w: entry.tileMeta.width, h: entry.tileMeta.height }
        : { w: 0, h: 0 };
      return { id: hash, url: entry.url, dimensions: dim };
    }

    const cached = await assetStore.get(hash);
    if (cached && cached.version === ASSET_VERSION) {
      if (dprScale !== undefined && cached.tileMeta) {
        cached.tileMeta.dprScale = dprScale;
        await assetStore.set(hash, cached.blob, cached.tileMeta);
      }
      this.loadEntry(cached);
      const loadedEntry = this.pool.get(hash)!;
      const dim = loadedEntry.tileMeta
        ? { w: loadedEntry.tileMeta.width, h: loadedEntry.tileMeta.height }
        : { w: 0, h: 0 };
      return { id: hash, url: loadedEntry.url, dimensions: dim };
    }

    const tileMeta = buildTileMeta(dimensions.w, dimensions.h);
    if (dprScale !== undefined) {
      tileMeta.dprScale = dprScale;
    }
    await assetStore.set(hash, blob, tileMeta);

    const url = URL.createObjectURL(blob);
    this.pool.set(hash, {
      id: hash,
      blob,
      url,
      tileMeta,
      state: AssetState.READY,
      owners: new Set(),
      lastUsedAt: Date.now()
    });
    resourceTracker.track(`asset:${hash}`, 'image_decoded', blob.size, `Image ${hash.slice(0, 8)}`);

    // Notify engine layer (ImageDispatcher subscribes to warm Worker cache)
    this.callbacks.onRegistered?.(hash, blob);

    return { id: hash, url, dimensions: { w: tileMeta.width, h: tileMeta.height } };
  }

  /**
   * Stores a raw source blob and returns its content hash as an independent ID.
   * Used for 16-bit TIFF/RAW imports and original GIF files — preserves
   * original data for lossless re-export. Stored under `raw:${hash}` key
   * in IDB, completely separate from any display asset's StoredAsset record.
   *
   * The returned hash is stored as `frame.assetId` — the frame owns the
   * reference to the source file. Lifecycle: source blob survives layer
   * deletion; only frame deletion triggers GC cleanup.
   */
  async storeRaw(rawBlob: Blob | undefined | null): Promise<string | undefined> {
    if (!rawBlob) return undefined;
    const hash = await this.calculateHash(rawBlob);
    await assetStore.setRaw(hash, rawBlob);
    return hash;
  }

  /**
   * Injects asset: bypasses hash and metadata calculation, registers directly (result provided by PixelResult)
   */
  async inject(hash: string, blob: Blob, tileMeta: TileMetadata): Promise<string> {
    this.pendingIds.add(hash);
    if (this.pool.has(hash)) return hash;

    await assetStore.set(hash, blob, tileMeta);
    const url = URL.createObjectURL(blob);
    this.pool.set(hash, {
      id: hash,
      blob,
      url,
      tileMeta,
      state: AssetState.READY,
      owners: new Set(),
      lastUsedAt: Date.now()
    });
    resourceTracker.track(`asset:${hash}`, 'image_decoded', blob.size, `Injected ${hash.slice(0, 8)}`);

    // Notify engine layer
    this.callbacks.onRegistered?.(hash, blob);
    return hash;
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
        const item = await assetStore.get(id);
        if (item && item.version === ASSET_VERSION) {
          this.loadEntry(item);
          count++;
        }
      }
    } else {
      const stored = await assetStore.getAll();
      for (const item of stored) {
        if (this.pool.has(item.id)) continue;
        if (item.version === ASSET_VERSION) {
          this.loadEntry(item);
          count++;
        }
      }
    }

    if (PERF_MON && count > 0) {
      console.debug(`[Assets] Hydrated ${count} active assets in ${Date.now() - start}ms`);
    }
  }

  private loadEntry(item: import('./AssetStore').StoredAsset) {
    if (this.pool.has(item.id)) return;
    const url = URL.createObjectURL(item.blob);
    this.pool.set(item.id, {
      id: item.id,
      blob: item.blob,
      url,
      tileMeta: item.tileMeta,
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
  async prewarm(id: string) {
    if (this.pool.has(id)) return;
    const hasPhysical = await assetStore.has(id);
    if (!hasPhysical) return;

    const item = await assetStore.get(id);
    if (item && item.version === ASSET_VERSION) {
      if (this.pool.has(id)) return; // Double check
      const url = URL.createObjectURL(item.blob);
      this.pool.set(item.id, {
        id: item.id,
        blob: item.blob,
        url,
        tileMeta: item.tileMeta,
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

  acquire(id: string, ownerId: string) {
    const asset = this.pool.get(id);
    if (asset) {
      asset.owners.add(ownerId);
      asset.state = AssetState.READY;
      asset.lastUsedAt = Date.now();
    }
  }

  release(id: string, ownerId: string) {
    const asset = this.pool.get(id);
    if (asset) {
      asset.owners.delete(ownerId);
      asset.lastUsedAt = Date.now();
      if (asset.owners.size === 0) asset.state = AssetState.STALE;
    }
  }

  get(id: string): AssetEntry | undefined {
    return this.pool.get(id);
  }

  getURL(id: string): string | undefined {
    return this.pool.get(id)?.url;
  }

  private revoke(id: string) {
    const asset = this.pool.get(id);
    if (asset) {
      URL.revokeObjectURL(asset.url);
      this.pool.delete(id);
      resourceTracker.release(`asset:${id}`);
      // Notify engine layer to evict Worker cache
      this.callbacks.onReleased?.(id);
      // Erase display asset from IDB. Raw blobs (raw:${hash}) are cleaned
      // separately by the raw orphan sweep at the end of sweep().
      assetStore.remove(id).catch(err => {
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

    // Clean up orphaned raw blobs in IDB (not tracked by pool).
    // Raw blobs are stored under `raw:${hash}` keys. When a frame is deleted,
    // its frame.assetId (the raw hash) disappears from activeIdsInState.
    assetStore.keys().then(allKeys => {
      for (const key of allKeys) {
        if (key.startsWith('raw:')) {
          const rawId = key.slice(4);
          if (!activeIdsInState.has(rawId)) {
            assetStore.removeRaw(rawId).catch(err => {
              console.error(`[AssetService] Failed to remove orphaned raw blob ${rawId}:`, err);
            });
          }
        }
      }
    }).catch(err => {
      console.error('[AssetService] Raw blob GC scan failed:', err);
    });
  }

  async clear() {
    for (const [id] of this.pool) this.revoke(id);
    this.pool.clear();
    await assetStore.clear();
  }

  getPool(): Record<string, AssetEntry> {
    const obj: Record<string, AssetEntry> = {};
    for (const [id, entry] of this.pool.entries()) {
      obj[id] = entry;
    }
    return obj;
  }
}

export const createAssetService = (callbacks?: AssetServiceCallbacks) => new AssetService(callbacks);
