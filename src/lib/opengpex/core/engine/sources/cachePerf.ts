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
 * along with this program.  See <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * cachePerf — PERF_MON-gated hit/miss counters for the render-source caches.
 *
 * PURPOSE (the memory-residency audit): a 16-bit import lands FOUR
 * full-resolution copies (worker bitmap, main-thread decoded bitmap,
 * high-depth float pixels, GPU texture). Before skipping any warm step the
 * audit needs MEASURED read counts: if the 8-bit bitmap copies of
 * high-depth-truth sources are never read after import, their warm steps can
 * be dropped (~96MB/image saved). This module counts cache reads, bucketed so
 * a 16-bit source's bitmap reads are distinguishable from an 8-bit source's.
 *
 * COST: every counter is a plain object field bump; the module is inert
 * (record early-returns) unless PERF_MON is compiled in, so the render path
 * pays one boolean branch per cache read when instrumentation is off.
 *
 * INSPECTION: `cachePerfSnapshot()` returns the live counters (attach a
 * console log to it in a real-machine session or call it from a probe).
 *
 * @module core/engine/sources/cachePerf
 */

import { PERF_MON } from '@opengpex/editor/core/helpers/config';

/** Read buckets. `16f`/`32f` = high-depth float reads by container; `bitmap`
 * = decoded-ImageBitmap reads; `*-cold` = a getOrFetch miss that kicked a
 * one-shot decode. */
export interface CachePerfCounters {
  bitmapHits: number;
  bitmapColdMisses: number;
  highDepth16fHits: number;
  highDepth32fHits: number;
  highDepthColdMisses: number;
  /** Worker-realm reads (these counters live in the WORKER's module instance —
   * read them via the CACHE_PERF_SNAPSHOT job, not the main-thread snapshot). */
  workerBitmapHits: number;
  workerBlobHits: number;
}

const counters: CachePerfCounters = {
  bitmapHits: 0,
  bitmapColdMisses: 0,
  highDepth16fHits: 0,
  highDepth32fHits: 0,
  highDepthColdMisses: 0,
  workerBitmapHits: 0,
  workerBlobHits: 0,
};

/** Record one cache read. No-op unless PERF_MON is on. */
export function recordCacheRead(kind: keyof CachePerfCounters): void {
  if (!PERF_MON) return;
  counters[kind]++;
}

/** Live counter snapshot for real-machine inspection. */
export function cachePerfSnapshot(): CachePerfCounters {
  return { ...counters };
}

/** Reset all counters (probe sessions / tests). */
export function resetCachePerf(): void {
  for (const k of Object.keys(counters) as (keyof CachePerfCounters)[]) {
    counters[k] = 0;
  }
}
