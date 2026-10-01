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
 *   - `SourceBitmapCache` — 8-bit bitmap decoded pixel cache (upload source for `IEngine.uploadSource()`).
 *   - `SolidColorSource`  — 1×1 solid color fill source (stateless pure function output).
 *
 * Dependency direction: sources sits above color/gpu leaves, only depending downwards on color operators;
 * no upward dependency on pipeline / facade / gpu hardware layer.
 */

// ── 8-bit bitmap cache ──
export { sourceBitmapCache } from './SourceBitmapCache';

// ── 16/32-bit high-precision source + cache ──
export {
  highDepthTextureCache,
  selectEvictions,
  DEFAULT_HIGH_DEPTH_BUDGET_BYTES,
} from './HighDepthSource';
export type {
  HighDepthSource,
  HighDepthFetcher,
  EvictionCandidate,
} from './HighDepthSource';

// ── 1×1 solid color source ──
export {
  buildSolidColorSource,
  SOLID_COLOR_SOURCE_FORMAT,
} from './SolidColorSource';
export type { SolidColorSource } from './SolidColorSource';
