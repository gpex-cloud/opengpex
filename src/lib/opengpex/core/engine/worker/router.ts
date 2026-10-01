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
 * router.ts — Worker-side job dispatcher.
 *
 * Receives a Job from the main thread (via entry.worker.ts) and routes it
 * to the appropriate handler.
 *
 * v2 note: the FILTER route is GONE. Filtering was the Worker's job only because
 * the main thread could not afford per-pixel CPU work; in v2 adjustments and
 * convolutions run in `AdjustPass` / `FilterPass` shaders on data already
 * resident in VRAM, so there is nothing to dispatch.
 *
 * COMPOSITE is ALSO gone: there is no separate Worker
 * compositor. `render()` and `export()` (readback) share ONE GPU RenderGraph, and
 * internal layer-subset composites now run on the main-thread engine via
 * `CompositeDispatcher` → `getGpuEngine().export()`. The Worker no longer loads
 * wasm-vips at all: ICC colour transforms (formerly the `ICC` route) moved to the
 * files-layer shared lib-vips worker (`core/files/shared/lib-vips.ts`) alongside
 * TIFF/PNG container ops (20260912). The old `handlers/compositor.ts` stub is
 * retired.
 *
 * RASTERIZE is ALSO gone (20260912 dead-code cleanup): the Worker-side
 * `RasterizeHandler` never received a job. Text rasterization runs on the MAIN
 * thread (`RasterizeDispatcher.layer` → OffscreenCanvas + `drawLayerInstance`)
 * because Worker `FontFace` access is unreliable; the `mask` sub-path mapped to a
 * `WorkerProxy.bakeMasks` facade that was never implemented or called.
 *
 * The Worker's surviving remit is decode / resample /
 * pixel-extract / histogram — i.e. codec and CPU-analysis duties that
 * have nothing to do with compositing.
 */

import type { Job } from '../protocol/jobs';
import { workerCache } from './cache/WorkerCache';
import { DecoderHandler } from './handlers/decoder';
import { ResampleHandler } from './handlers/resample';
import { ExtractPixelsHandler } from './handlers/extract-pixels';
import { HistogramHandler } from './handlers/histogram';

// ─── Handler singletons (instantiated once per Worker lifetime) ───

const decoderHandler = new DecoderHandler();
const resampleHandler = new ResampleHandler();
const extractPixelsHandler = new ExtractPixelsHandler();
const histogramHandler = new HistogramHandler();

export interface RouterResult {
  result: unknown;
  transfer?: Transferable[];
}

export async function router(job: Job): Promise<RouterResult> {
  switch (job.type) {
    case 'ENSURE_ASSET': {
      await workerCache.ingest(job.hash, job.blob);
      return { result: true };
    }

    case 'FORGET': {
      workerCache.evict(job.hash);
      return { result: true };
    }

    case 'DECODE':
      return decoderHandler.handle(job);

    case 'RESAMPLE':
      return resampleHandler.handle(job);

    case 'EXTRACT_PIXELS':
      return extractPixelsHandler.handle(job);

    case 'HISTOGRAM':
      return histogramHandler.handle(job);

    default:
      throw new Error(`[router] Unknown job type: ${(job as { type: string }).type}`);
  }
}
