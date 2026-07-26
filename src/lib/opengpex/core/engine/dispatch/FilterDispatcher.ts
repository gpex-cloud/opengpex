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
 * FilterDispatcher — orchestrates filter requests from main thread (Track B).
 *
 * Phase 6.9 refactor:
 * - Eliminates the blob encoding → SHA-256 hash → ENSURE_ASSET roundtrip.
 * - Source ImageBitmap is directly transferred to the Worker (zero-copy).
 * - Worker processes the bitmap and transfers a filtered result back.
 *
 * Dual-track architecture:
 * - Track A (main-thread, synchronous): FilterFastTrack provides <1ms LUT preview
 *   during slider interaction. Handled entirely in Canvas2dEngine.flush().
 * - Track B (this module, asynchronous): Full-quality filter via Worker, triggered
 *   on mouseUp. Result replaces Track A preview in the next rAF frame.
 *
 * Integration with FilterCache:
 *   FilterCache.initialize() injects a `dispatchFn` that calls this dispatcher.
 *   The cache manages scheduling, dedup, and stale-while-revalidate semantics.
 *   This dispatcher is a pure execution layer — it does NOT manage caching itself.
 *
 * Architecture: facade → FilterDispatcher → WorkerBridge → Worker (FilterHandler)
 */

import { WorkerBridge } from './bridge/WorkerBridge';
import type { FilterDescriptor } from '../protocol/IFilter';
import type { FilterJob } from '../protocol/jobs';
import type { FilterDispatchFn } from '../cache/FilterCache';

export class FilterDispatcher {
  constructor(private bridge: WorkerBridge) {}

  /**
   * Apply filters to an owned bitmap via Worker.
   *
   * The `source` MUST be a caller-owned clone — it will be transferred
   * (neutered) during the postMessage call.
   *
   * @param source - Owned ImageBitmap to filter (will be neutered)
   * @param descriptors - Ordered filter descriptors to apply
   * @param key - Optional cache key echoed back from the Worker
   * @returns Filtered ImageBitmap (transferred from Worker)
   */
  async apply(
    source: ImageBitmap,
    descriptors: FilterDescriptor[],
    key?: string,
  ): Promise<ImageBitmap> {
    const job: FilterJob = { type: 'FILTER', source, descriptors, key };
    const result = await this.bridge.request<{ bitmap: ImageBitmap; key?: string }>(
      job,
      [source], // transfer list — neuters `source`
    );
    return result.bitmap;
  }

  /**
   * Create a `FilterDispatchFn` compatible with FilterCache.initialize().
   *
   * This bridges the FilterCache's scheduling mechanism with the Worker pipeline:
   *   FilterCache.schedule() → clone → dispatchFn(key, owned, filters) → Worker → ImageBitmap
   *
   * The `source` parameter received here is already an owned clone produced by
   * FilterCache.dispatch(). We can transfer it directly without another clone.
   */
  createDispatchFn(): FilterDispatchFn {
    return async (key: string, source: ImageBitmap, filters: FilterDescriptor[]): Promise<ImageBitmap> => {
      // `source` is already an owned clone from FilterCache.dispatch() —
      // transfer directly to the Worker (no additional clone needed).
      return this.apply(source, filters, key);
    };
  }
}
