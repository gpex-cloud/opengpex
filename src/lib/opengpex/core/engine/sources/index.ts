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
 * engine/sources — unified source containers for pipeline input.
 *
 * Consolidates image carriers of varying precision consumed by the pipeline:
 *   - `HighDepthSource`   — 16/32-bit raw float buffer source + its cache/singleton.
 *   - `ImageBitmapCache` — 8-bit bitmap decoded pixel cache (upload source for `IEngine.uploadSource()`).
 *   (Solid color fills are DECLARATIVE scene sources — `pipeline/scene/translators/solid.ts` —
 *   not byte carriers; they own no source container here.)
 *
 * Dependency direction: sources sits above color/gpu leaves, only depending downwards on color operators;
 * no upward dependency on pipeline / facade / gpu hardware layer.
 */

// ── 8-bit bitmap cache ──
export { imageBitmapCache } from './ImageBitmapCache';

// ── 16/32-bit high-precision source + cache ──
export {
  highDepthCache,
  selectEvictions,
  DEFAULT_HIGH_DEPTH_BUDGET_BYTES,
} from './HighDepthCache';
export type {
  HighDepthSource,
  HighDepthFetcher,
  EvictionCandidate,
} from './HighDepthCache';

// ── gain map (presentation adjunct) + cache ──
export { gainMapCache } from './GainMapCache';
export type { GainMapData, GainMapFetcher } from './GainMapCache';

// ── PERF_MON-gated cache audit counters (memory-residency audit, ⑧a) ──
export {
  recordCacheRead,
  cachePerfSnapshot,
  resetCachePerf,
} from './cachePerf';
export type { CachePerfCounters } from './cachePerf';
