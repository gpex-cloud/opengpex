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
 * HighDepthCache — main-thread cache of decoded 16/32-bit source pixels,
 * keyed by asset id.
 *
 * The precision-axis sibling of `ImageBitmapCache`: where that holds 8-bit
 * `ImageBitmap`s, this holds GPU-ready float naked pixels (`HighDepthSource`)
 * for 16/32-bit sources, so `SceneAssembler` can dispatch a `{ kind: 'raw' }`
 * upload → an `rgba16float` / `rgba32float` resident texture (invariant A).
 *
 * TWO POPULATION PATHS (both full-precision ingestion, no 8-bit proxy two-stage):
 *   1. IMPORT-TIME WARM (`set`): `single.ts` decodes the 16-bit source and warms
 *      the cache BEFORE the frame is shown (16-bit decoded directly before first display), so
 *      the first render samples full precision — no flash, no upgrade stage.
 *   2. RELOAD FETCH (`getOrFetch`): on a cold reload/revert the cache is empty;
 *      the render loop's `getHighDepthSource` probes here, kicks a one-shot async
 *      decode from the IDB raw blob, and `notify()`s subscribers (CanvasStage →
 *      needsRender) so the next frame upgrades to the raw texture.
 *
 * `ensure` is the blocking sibling of path 2, for one-shot consumers (export /
 * internal bake) that have no "next frame" to catch a late `notify()`: it
 * awaits the same fetch `getOrFetch` would kick off and only returns once the
 * cache is actually warm (or the fetch failed/negative-cached).
 *
 * NEGATIVE CACHING: an asset whose true source depth is ≤ 8-bit (e.g. a
 * wide-gamut 8-bit TIFF that retained a raw blob) is recorded as `null` so it is
 * probed exactly once and thereafter stays on the zero-copy bitmap path
 * (invariant A: no needless f16 fattening).
 *
 * @module core/engine/sources/HighDepthCache
 */

import { recordCacheRead } from './cachePerf';

/** Decoded high-bit-depth naked pixels, GPU-ready for a direct float upload. */
export interface HighDepthSource {
  /**
   * Naked RGBA-interleaved pixels, in whichever container `dataFormat` names:
   * `Uint16Array` of IEEE binary16 bit patterns for `rgba16float` (see
   * color/float16), or a true `Float32Array` for `rgba32float` (32-bit float
   * sources pass through verbatim from vips).
   */
  readonly data: Uint16Array | Float32Array;
  readonly width: number;
  readonly height: number;
  /**
   * The container `data` actually is. `WebGpuEngine.uploadSource` derives
   * `bytesPerRow` from it (16 vs. 8 bytes/texel), so a value that disagrees with
   * `data`'s element size mis-strides every row — keep the two in lockstep.
   */
  readonly dataFormat: 'rgba16float' | 'rgba32float';
  /**
   * ⚠️ NO IDENTITY FIELDS HERE (trc / gamut / rawWhiteDomain were removed —
   * 2026-11-15): colour identity belongs to the asset's `ColorIdentity` (the
   * pool record — the SINGLE authority), and the scene assembly reads it from
   * there. `proxyBitmapGamut` derives the 8-bit proxy's canvas-representable
   * identity from the same record (the DNG proxy-cast lesson: identity is
   * PER-PIXEL-FORM — the proxy folds to Display P3, the master stays in its
   * source gamut). The entry carries only the attributes the naked bytes
   * cannot exist without.
   */
}

/** Fetches + decodes the raw source for `assetId`, or null if it is not high-depth. */
export type HighDepthFetcher = (assetId: string) => Promise<HighDepthSource | null>;

interface PositiveEntry {
  readonly source: HighDepthSource;
  /** Confirmed-durable `dec:` persistence — only then may the byte budget evict. */
  readonly persisted: boolean;
}

export function selectEvictions(
  entriesOldestFirst: Array<EvictionCandidate>,
  usedBytes: number,
  budgetBytes: number,
): { evictIds: string[]; remainingBytes: number } {
  let remaining = usedBytes;
  const evictIds: string[] = [];
  for (const entry of entriesOldestFirst) {
    if (remaining <= budgetBytes) break;
    if (!entry.persisted) continue; // unconfirmed persistence → pinned, never evicted
    evictIds.push(entry.id);
    remaining -= entry.byteLength;
  }
  return { evictIds, remainingBytes: remaining };
}

function byteLengthOf(source: HighDepthSource): number {
  return source.data.byteLength;
}

export const DEFAULT_HIGH_DEPTH_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;

export interface EvictionCandidate {
  id: string;
  byteLength: number;
  persisted: boolean;
}

export class HighDepthCache {
  private static instance: HighDepthCache;
  /** assetId → entry. A stored `null` is a NEGATIVE entry (known ≤8-bit), exempt
   * from byte accounting, recency and eviction. Map iteration/insertion order
   * doubles as recency order (oldest first) for the LRU sweep. */
  private cache = new Map<string, PositiveEntry | null>();
  private pending = new Map<string, Promise<HighDepthSource | null>>();
  private listeners = new Set<() => void>();
  private usedBytes = 0;
  private budgetBytes = DEFAULT_HIGH_DEPTH_BUDGET_BYTES;
  private constructor() {}
  static getInstance(): HighDepthCache {
    if (!HighDepthCache.instance) {
      HighDepthCache.instance = new HighDepthCache();
    }
    return HighDepthCache.instance;
  }
  /**
   * TEST SEAM — override the byte budget so the eviction/LRU/warn behaviour can
   * be exercised with a few tiny buffers instead of allocating real
   * multi-hundred-MB sources (which are memory-fragile and, at the 2GB default,
   * would need >2GB of allocations to cross the threshold at all). Production
   * code never calls this; the budget stays at `DEFAULT_HIGH_DEPTH_BUDGET_BYTES`.
   * Runs an immediate sweep so a lowered budget reclaims at once.
   */
  setBudgetBytesForTest(bytes: number): void {
    this.budgetBytes = bytes;
    this.evictIfNeeded();
  }
  // Subscription (mirrors ImageBitmapCache: late decode → redraw).
  subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }
  private notify(): void {
    this.listeners.forEach((cb) => cb());
  }
  /** Sync lookup — returns the high-depth source, or undefined (missing OR negative). */
  get(assetId: string): HighDepthSource | undefined {
    const entry = this.cache.get(assetId);
    if (entry === undefined) return undefined;
    if (entry === null) return undefined; // negative entry — never touched
    this.touch(assetId, entry);
    recordCacheRead(entry.source.dataFormat === 'rgba32float' ? 'highDepth32fHits' : 'highDepth16fHits');
    return entry.source;
  }
  /**
   * Import-time warm: store a decoded source so the first render is full-precision.
   *
   * `options.persisted` defaults to `false` (pinned/unevictable) — only the
   * caller that just confirmed a successful durable write (`AssetService`,
   * after `await storeDec` succeeds) should pass `{ persisted: true }`.
   */
  set(assetId: string, source: HighDepthSource, options?: { persisted?: boolean }): void {
    this.landPositive(assetId, source, options?.persisted ?? false);
    this.notify();
  }
  /** Moves a positive entry to the end of the Map (= most-recently-used). */
  private touch(assetId: string, entry: PositiveEntry): void {
    this.cache.delete(assetId);
    this.cache.set(assetId, entry);
  }
  /** Shared landing path for `set` and fetcher resolution: accounts bytes, touches recency, evicts if needed. */
  private landPositive(assetId: string, source: HighDepthSource, persisted: boolean): void {
    const prior = this.cache.get(assetId);
    if (prior) this.usedBytes -= byteLengthOf(prior.source);
    this.cache.delete(assetId);
    this.cache.set(assetId, { source, persisted });
    this.usedBytes += byteLengthOf(source);
    this.pending.delete(assetId);
    this.evictIfNeeded();
  }
  private evictIfNeeded(): void {
    if (this.usedBytes <= this.budgetBytes) return;
    const candidates: EvictionCandidate[] = [];
    for (const [id, entry] of this.cache) {
      if (entry === null) continue; // negative entries are exempt
      candidates.push({ id, byteLength: byteLengthOf(entry.source), persisted: entry.persisted });
    }
    const { evictIds, remainingBytes } = selectEvictions(candidates, this.usedBytes, this.budgetBytes);
    for (const id of evictIds) {
      this.cache.delete(id); // full delete, never null — must not lock the asset onto the 8-bit path
    }
    this.usedBytes = remainingBytes;
    if (this.usedBytes > this.budgetBytes) {
      console.warn('[HighDepthCache] working set exceeds budget; nothing left to evict', {
        usedBytes: this.usedBytes,
        budgetBytes: this.budgetBytes,
      });
    }
  }
  /**
   * Sync-return + async-fetch contract (mirrors ImageBitmapCache.getOrFetch):
   *   - Cached (positive or negative) → return the value synchronously.
   *   - Missing → kick off a one-shot `fetcher` decode; subscribers are notified
   *     when it lands (positive result); returns undefined for now.
   *
   * The `fetcher` MUST resolve `null` for a ≤8-bit source so it is negative-cached
   * and never re-probed (per-asset dispatch judged on true source depth).
   */
  getOrFetch(assetId: string, fetcher: HighDepthFetcher): HighDepthSource | undefined {
    const hit = this.cache.get(assetId);
    if (hit !== undefined) {
      if (hit === null) return undefined; // negative — never touched
      this.touch(assetId, hit);
      recordCacheRead(hit.source.dataFormat === 'rgba32float' ? 'highDepth32fHits' : 'highDepth16fHits');
      return hit.source;
    }
    if (this.pending.has(assetId)) return undefined;
    recordCacheRead('highDepthColdMisses');
    const promise = fetcher(assetId);
    this.pending.set(assetId, promise);
    promise.then(
      (source) => {
        if (this.pending.get(assetId) !== promise) return;
        if (source) {
          // Fetcher-resolved sources are rehydrated from confirmed IDB storage.
          this.landPositive(assetId, source, true);
          this.notify(); // only a positive result changes the picture
        } else {
          this.pending.delete(assetId);
          this.cache.set(assetId, null); // negative cache (one-shot)
        }
      },
      (err) => {
        if (this.pending.get(assetId) === promise) this.pending.delete(assetId);
        console.warn('[HighDepthCache] decode failed for', assetId, err);
      },
    );
    return undefined;
  }
  /**
   * Await-and-return contract for one-shot consumers (export/bake) that must
   * have the source resident BEFORE a synchronous read, unlike `getOrFetch`'s
   * "return what's cached now, notify subscribers later" contract for the
   * continuous render loop — there is no "next frame" to catch a late notify
   * in a one-shot export/bake, so the caller has to block on this instead.
   *
   * Shares the same `pending` dedup as `getOrFetch`: calling this for an
   * assetId that `getOrFetch` (or another `ensure`) already kicked off just
   * awaits that same in-flight promise, never double-fetches.
   */
  async ensure(assetId: string, fetcher: HighDepthFetcher): Promise<HighDepthSource | undefined> {
    const hit = this.cache.get(assetId);
    if (hit !== undefined) {
      if (hit === null) return undefined; // negative — never touched
      this.touch(assetId, hit);
      return hit.source;
    }
    let promise = this.pending.get(assetId);
    if (!promise) {
      promise = fetcher(assetId);
      this.pending.set(assetId, promise);
      promise.then(
        (source) => {
          if (this.pending.get(assetId) !== promise) return;
          if (source) {
            this.landPositive(assetId, source, true);
            this.notify();
          } else {
            this.pending.delete(assetId);
            this.cache.set(assetId, null); // negative cache (one-shot)
          }
        },
        (err) => {
          if (this.pending.get(assetId) === promise) this.pending.delete(assetId);
          console.warn('[HighDepthCache] decode failed for', assetId, err);
        },
      );
    }
    try {
      return (await promise) ?? undefined;
    } catch {
      return undefined; // already warned above; caller degrades to the 8-bit path
    }
  }
  delete(assetId: string): void {
    const entry = this.cache.get(assetId);
    if (entry) this.usedBytes -= byteLengthOf(entry.source);
    this.cache.delete(assetId);
    this.pending.delete(assetId);
  }
  clear(): void {
    this.cache.clear();
    this.pending.clear();
    this.usedBytes = 0;
  }
}

export const highDepthCache = HighDepthCache.getInstance();

// (The former createHighDepthChannelSeam read/write factory is gone — the
// declarative-solid batch removed the seam's only WRITE producer (the solid
// 1×1 registration) and the read side was a pure passthrough of `get`.
// Consumers wire `getHighDepthSource: (id) => highDepthCache.get(id)`
// directly; `set(..., { persisted })` remains the ingest-side write door.)

