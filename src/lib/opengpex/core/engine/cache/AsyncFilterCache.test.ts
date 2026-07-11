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
 * AsyncFilterCache — Step 8 unit tests
 *
 * Focus areas (spec §5.2 / §5.3 / §5.5):
 *   1. LRU eviction respects `MAX_ENTRIES` and drops the oldest entry
 *      first, calling `.close()` on the evicted bitmap (memory safety).
 *   2. `setDragging(true)` suppresses `schedule()` — this is the
 *      Dual-Track preview "don't drown the worker" guarantee. On
 *      `setDragging(false)` we notify subscribers and the next
 *      schedule call proceeds normally.
 *   3. `clearAsset(id)` sweeps all keys tied to that assetId AND
 *      clears the `lastKeyByAsset` pointer so `getStale()` doesn't
 *      keep serving hollow references.
 *
 * The suite deliberately avoids DOM / OffscreenCanvas / real ImageBitmap:
 *   - `workerBridge` is fully mocked so no real worker spins up.
 *   - `createImageBitmap` is polyfilled to return a proxy object with
 *     `.close()` we can observe.
 *
 * This mirrors the pattern already used by
 * `Canvas2dFilter.test.ts` (16-bit lane) — pure-function-level testing
 * with the DOM edges stubbed at the module boundary. See vitest.config.ts
 * header: node env, no jsdom, DOM-free by design.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Test-side polyfills ──────────────────────────────────────────
// AsyncFilterCache clones every source via `createImageBitmap(source)`
// before transferring to the worker. In a node vitest run there is no
// browser API. We install a fake that returns a resolved Promise with
// a bitmap-shaped proxy that tracks `.close()` calls (essential for
// the LRU eviction assertion below).
interface FakeBitmap {
  __id: string;
  __closed: boolean;
  close: () => void;
  width: number;
  height: number;
}

let fakeBitmapCounter = 0;
function newFakeBitmap(id?: string): FakeBitmap {
  const b: FakeBitmap = {
    __id: id ?? `fake-${++fakeBitmapCounter}`,
    __closed: false,
    close() { b.__closed = true; },
    width: 16,
    height: 16,
  };
  return b;
}

// Install BEFORE importing AsyncFilterCache so the module picks up the
// polyfilled global. The cache is a singleton so we must reset it
// between tests via `clear()`.
(globalThis as unknown as { createImageBitmap: (b: FakeBitmap) => Promise<FakeBitmap> })
  .createImageBitmap = async (b: FakeBitmap) => b;
// `ImageBitmap` type check inside AsyncFilterCache is a real
// `instanceof ImageBitmap`; but the cache itself doesn't do that check
// (only Canvas2dEngine does). So we don't need to install the class.

// ── Mock workerBridge — we drive the "APPLY_FILTER" result by hand ──
type PendingJob = { key: string; resolve: (v: { bitmap: FakeBitmap; key: string }) => void };
const pendingJobs: PendingJob[] = [];
vi.mock('@opengpex/editor/core/engine/worker/WorkerBridge', () => ({
  workerBridge: {
    request: vi.fn(
      (_channel: string, args: { source: FakeBitmap; key: string }) =>
        new Promise<{ bitmap: FakeBitmap; key: string }>((resolve) => {
          pendingJobs.push({ key: args.key, resolve });
        }),
    ),
  },
}));

// After all mocks/polyfills, we can import the module under test.
import { asyncFilterCache } from './AsyncFilterCache';

/**
 * Flush the current microtask queue so the schedule() → dispatch()
 * chain has a chance to enqueue its `.then()` handler. We call this
 * after every `schedule()` invocation.
 */
async function flushMicrotasks() {
  // Two turns are enough: schedule() → createImageBitmap().then(...) → workerBridge.request()
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Resolve every pending worker job with a fresh FakeBitmap. Returns
 * the bitmaps stored in the cache, in job-submission order.
 */
async function resolveAllPending(): Promise<FakeBitmap[]> {
  const bmps: FakeBitmap[] = [];
  while (pendingJobs.length > 0) {
    const job = pendingJobs.shift()!;
    const bmp = newFakeBitmap(job.key);
    bmps.push(bmp);
    job.resolve({ bitmap: bmp, key: job.key });
  }
  // Give the `.then((res) => this.store(res.bitmap))` chain a turn.
  await Promise.resolve();
  await Promise.resolve();
  return bmps;
}

/**
 * Build a Layer stub with a curves recipe. We vary the mid control-point
 * y-coordinate (`mid`) to force a distinct cache key per layer while
 * still producing a non-empty descriptor list from
 * `normalizeFilterDescriptors`.
 *
 * `curves.rgb` is a `[number, number][]` of control points in the
 * production model (see `core/types/models.ts::CurvesState`); a two-point
 * identity curve `[[0,0],[1,1]]` would be an identity map and get
 * short-circuited to empty, so we bump the mid point.
 */
function makeLayer(assetId: string, mid: number) {
  return {
    assetId,
    adjustments: undefined,
    curves: {
      rgb: [
        [0, 0],
        [0.5, mid],
        [1, 1],
      ] as [number, number][],
    },
    levels: undefined,
    channelMix: undefined,
  } as unknown as Parameters<typeof asyncFilterCache.get>[0];
}

describe('AsyncFilterCache', () => {
  beforeEach(() => {
    asyncFilterCache.clear();
    asyncFilterCache.setDragging(false);
    pendingJobs.length = 0;
    fakeBitmapCounter = 0;
  });

  // ────────────────────────────────────────────────────────────
  // LRU (spec §5.5)
  // ────────────────────────────────────────────────────────────

  it('caps at 12 entries and evicts the least-recently-used bitmap on overflow', async () => {
    // Fill the cache with 12 distinct recipes.
    const bmps: FakeBitmap[] = [];
    for (let i = 0; i < 12; i++) {
      const layer = makeLayer(`asset-${i}`, 0.5 + i * 0.01);
      const src = newFakeBitmap(`src-${i}`);
      asyncFilterCache.schedule(layer, src as unknown as ImageBitmap);
      await flushMicrotasks();
    }
    bmps.push(...(await resolveAllPending()));
    expect(asyncFilterCache.size()).toBe(12);
    // No bitmaps have been closed yet.
    expect(bmps.every((b) => !b.__closed)).toBe(true);

    // Add a 13th entry — the FIRST (oldest) entry must be evicted and
    // its bitmap closed.
    const oldestBitmap = bmps[0];
    const overflowLayer = makeLayer('asset-overflow', 0.9);
    asyncFilterCache.schedule(overflowLayer, newFakeBitmap('src-overflow') as unknown as ImageBitmap);
    await flushMicrotasks();
    await resolveAllPending();

    expect(asyncFilterCache.size()).toBe(12);
    expect(oldestBitmap.__closed).toBe(true);
    // All others still live.
    for (let i = 1; i < bmps.length; i++) expect(bmps[i].__closed).toBe(false);
  });

  it('touches on get, so re-accessed entries survive eviction', async () => {
    // Fill to capacity.
    const layers = Array.from({ length: 12 }, (_, i) => makeLayer(`asset-${i}`, 0.5 + i * 0.01));
    for (const layer of layers) {
      asyncFilterCache.schedule(layer, newFakeBitmap() as unknown as ImageBitmap);
      await flushMicrotasks();
    }
    const bmps = await resolveAllPending();

    // Touch the OLDEST entry via `get()` — now the second-oldest is the
    // LRU tail.
    const survivor = asyncFilterCache.get(layers[0]);
    expect(survivor).toBe(bmps[0]);

    // Add a 13th entry: the SECOND-oldest (layer 1) must be evicted, not layer 0.
    asyncFilterCache.schedule(makeLayer('asset-x', 0.85), newFakeBitmap() as unknown as ImageBitmap);
    await flushMicrotasks();
    await resolveAllPending();

    expect(bmps[0].__closed).toBe(false);
    expect(bmps[1].__closed).toBe(true);
  });

  // ────────────────────────────────────────────────────────────
  // Dual-Track dragging (spec §5.3)
  // ────────────────────────────────────────────────────────────

  it('schedule() still dispatches while dragging (live-feedback contract)', async () => {
    // Post-fix (2026-07-10 UX regression report): dragging no longer gates
    // schedule(). The flag is now purely observational — future consumers
    // (LUT preview overlay, TileFilterCache) can query it without changing
    // the dispatch behaviour today. Preserving live worker jobs during a
    // drag is what the user experiences as "curves updates in real time".
    const layer = makeLayer('asset-drag', 0.7);
    const src = newFakeBitmap() as unknown as ImageBitmap;

    asyncFilterCache.setDragging(true);
    const scheduled = asyncFilterCache.schedule(layer, src);
    await flushMicrotasks();

    expect(scheduled).toBe(true);
    expect(pendingJobs.length).toBe(1);
    expect(asyncFilterCache.isPending(layer)).toBe(true);
  });

  it('setDragging(true→false) still notifies subscribers so caches downstream can react', () => {
    const notified = vi.fn();
    asyncFilterCache.subscribe(notified);
    asyncFilterCache.setDragging(true);
    expect(notified).not.toHaveBeenCalled();
    asyncFilterCache.setDragging(false);
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it('setDragging is idempotent — same value in a row is a no-op', () => {
    const notified = vi.fn();
    asyncFilterCache.subscribe(notified);
    asyncFilterCache.setDragging(false); // already false
    expect(notified).not.toHaveBeenCalled();
    asyncFilterCache.setDragging(true);
    asyncFilterCache.setDragging(true); // already true
    expect(notified).not.toHaveBeenCalled();
    asyncFilterCache.setDragging(false); // transition true → false: notify
    expect(notified).toHaveBeenCalledTimes(1);
  });


  // ────────────────────────────────────────────────────────────
  // clearAsset / forget lifecycle
  // ────────────────────────────────────────────────────────────

  it('clearAsset closes every cached bitmap tied to that assetId', async () => {
    const layerA = makeLayer('asset-A', 0.6);
    const layerB = makeLayer('asset-B', 0.6);
    asyncFilterCache.schedule(layerA, newFakeBitmap() as unknown as ImageBitmap);
    asyncFilterCache.schedule(layerB, newFakeBitmap() as unknown as ImageBitmap);
    await flushMicrotasks();
    const [bmpA, bmpB] = await resolveAllPending();

    asyncFilterCache.clearAsset('asset-A');
    expect(bmpA.__closed).toBe(true);
    expect(bmpB.__closed).toBe(false);
    expect(asyncFilterCache.get(layerA)).toBeNull();
    expect(asyncFilterCache.get(layerB)).toBe(bmpB);

    // getStale for A must also return null after clearAsset.
    expect(asyncFilterCache.getStale(layerA)).toBeNull();
  });
});
