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
   * Compute SHA-256 hash of a Blob using native Web Crypto API.
   * `crypto.subtle.digest` is implemented in native code and executes
   * asynchronously without blocking the main thread.
   */
  private async calculateHash(blob: Blob): Promise<string> {
    const buffer = await blob.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Compute TileMetadata from a Blob on the main thread.
   * `createImageBitmap` is async and executed by the browser's internal thread pool.
   */
  private async computeTileMeta(blob: Blob): Promise<TileMetadata> {
    const bitmap = await createImageBitmap(blob);
    const { width, height } = bitmap;
    bitmap.close();

    const tileSize = 256;
    return {
      width,
      height,
      tileSize,
      cols: Math.ceil(width / tileSize),
      rows: Math.ceil(height / tileSize),
      levels: Math.ceil(Math.log2(Math.max(width, height) / tileSize)) + 1,
      isTiled: width > 512 || height > 512,
    };
  }

  /**
   * Registers asset: calculates hash from Blob and stores it in the pool.
   *
   * Phase 5 Extension: Accepts an optional `rawBlob` for 16-bit fidelity.
   * When provided, the raw high-resolution source is stored alongside the
   * 8-bit display asset under a `raw:${hash}` key in IDB.
   */
  async register(blob: Blob, options?: { rawBlob?: Blob; dprScale?: number }): Promise<AssetRef> {
    const dprScale = options?.dprScale;
    const rawBlob = options?.rawBlob;

    const hash = await this.calculateHash(blob);
    this.pendingIds.add(hash);

    if (this.pool.has(hash)) {
      const entry = this.pool.get(hash)!;
      entry.state = AssetState.READY;
      if (dprScale !== undefined && entry.tileMeta) {
        entry.tileMeta.dprScale = dprScale;
      }
      // Store raw blob even if display asset already exists (idempotent)
      if (rawBlob) {
        assetStore.setRaw(hash, rawBlob).catch(err => {
          console.warn('[AssetService] Failed to store raw blob:', err);
        });
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
      // Store raw blob association
      if (rawBlob) {
        assetStore.setRaw(hash, rawBlob).catch(err => {
          console.warn('[AssetService] Failed to store raw blob:', err);
        });
      }
      const loadedEntry = this.pool.get(hash)!;
      const dim = loadedEntry.tileMeta
        ? { w: loadedEntry.tileMeta.width, h: loadedEntry.tileMeta.height }
        : { w: 0, h: 0 };
      return { id: hash, url: loadedEntry.url, dimensions: dim };
    }

    const tileMeta = await this.computeTileMeta(blob);
    if (dprScale !== undefined) {
      tileMeta.dprScale = dprScale;
    }
    await assetStore.set(hash, blob, tileMeta);

    // Phase 5: Store raw high-resolution source blob (fire-and-forget for performance)
    if (rawBlob) {
      assetStore.setRaw(hash, rawBlob).catch(err => {
        console.warn('[AssetService] Failed to store raw blob:', err);
      });
    }

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

    if (count > 0 && (typeof process !== 'undefined' && process.env.NODE_ENV === 'development')) {
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

    // Notify engine layer to warm Worker cache
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
      // 💡 Completely erased at the physical layer: prevents orphaned/zombie Blobs in IndexedDB from causing storage bloat
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
