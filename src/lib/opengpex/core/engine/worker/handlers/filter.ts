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
 * Worker-side filter handler (spec §5.2).
 *
 * Responsibility:
 *   Instantiate an `IFilter` runtime (currently Canvas2dFilter) on demand
 *   inside the engine worker, execute the pixel work, and hand the
 *   resulting `ImageBitmap` back to the main thread via
 *   `Transferable` semantics.
 *
 * This handler is intentionally the *only* worker-side code that touches
 * `FilterFactory` — the rest of the worker never imports the filter
 * backends directly, which keeps their (potentially heavy) dependency
 * graph out of unrelated hot paths (merger, transformer, etc.).
 */

import type { FilterDescriptor, IFilter } from '@opengpex/editor/core/engine/protocol/IFilter';
import { FilterFactory } from '@opengpex/editor/core/engine/FilterFactory';

export interface ApplyFilterPayload {
  /** Owned bitmap (transferred from the main thread). */
  source: ImageBitmap;
  /** Fully normalized descriptor list (see `normalizeFilterDescriptors`). */
  filters: FilterDescriptor[];
  /**
   * Optional cache key echoed back to the main thread for bookkeeping.
   * We do NOT read it here — the main-thread `AsyncFilterCache` owns the
   * mapping between key and result.
   */
  key?: string;
}

export interface ApplyFilterResult {
  bitmap: ImageBitmap;
  key?: string;
}

// Lazy singleton — the first APPLY_FILTER call pays the module-load
// cost; subsequent calls hit the warm instance.
let cachedFilter: IFilter | null = null;

async function getFilter(): Promise<IFilter> {
  if (!cachedFilter) {
    cachedFilter = await FilterFactory.create('canvas2d');
  }
  return cachedFilter;
}

/**
 * Handle an `APPLY_FILTER` message.
 *
 * Contract:
 *   - `source` ownership is CONSUMED (the ImageBitmap belongs to the
 *     Worker after `postMessage(..., [source])`).
 *   - The returned `bitmap` MUST be listed as transferable by the caller
 *     so the ownership handoff back to the main thread is zero-copy.
 *   - If no filters are active, we still allocate a new bitmap identical
 *     to the source: this simplifies the AsyncFilterCache invariant that
 *     every cache entry is an owned bitmap the cache can dispose.
 */
export async function applyFilter(payload: ApplyFilterPayload): Promise<ApplyFilterResult> {
  const { source, filters, key } = payload;
  const runtime = await getFilter();

  // Empty filter chain — clone via `createImageBitmap` so we hand back an
  // independent bitmap the cache can dispose without racing the source.
  if (!filters || filters.length === 0) {
    const passthrough = await createImageBitmap(source);
    return { bitmap: passthrough, key };
  }

  const result = await runtime.apply(source, filters);
  // Canvas2dFilter's ImageBitmap-path always returns an `ImageBitmap` —
  // the HighRes path only fires when the input is `HighResPixelBuffer`,
  // which this handler never receives.
  if (!(result instanceof ImageBitmap)) {
    throw new Error(
      `[worker/handlers/filter] expected ImageBitmap result, got ${typeof result}`,
    );
  }
  return { bitmap: result, key };
}

export interface ApplyFilterTilePayload {
  jobs: Array<{
    key: string;
    bitmap: ImageBitmap;
    filters: FilterDescriptor[];
  }>;
}

export interface ApplyFilterTileResult {
  results: Array<{
    key: string;
    bitmap: ImageBitmap;
  }>;
}

export async function applyFilterTile(payload: ApplyFilterTilePayload): Promise<ApplyFilterTileResult> {
  const { jobs } = payload;
  const runtime = await getFilter();

  const results = await Promise.all(
    jobs.map(async (job) => {
      if (!job.filters || job.filters.length === 0) {
        const passthrough = await createImageBitmap(job.bitmap);
        return { key: job.key, bitmap: passthrough };
      }

      const result = await runtime.apply(job.bitmap, job.filters);
      if (!(result instanceof ImageBitmap)) {
        throw new Error(
          `[worker/handlers/filter] expected ImageBitmap result, got ${typeof result}`,
        );
      }
      return { key: job.key, bitmap: result };
    }),
  );

  return { results };
}
