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
 * engine/renderer — Public surface for the onscreen rendering subsystem.
 *
 * Provides:
 *   - getGpuEngine(): lazy-created IEngine singleton
 *   - getEngine(): alias to getGpuEngine() for backwards compatibility
 *   - Cache singletons (sourceBitmapCache, tileCache)
 */

import { WebGpuEngine } from '@opengpex/editor/core/gpu';
import type { IEngine } from '@opengpex/editor/core/gpu';

// ── Lazy WebGPU Engine Singleton (spec §5.1) ──
declare global {
  var __opengpex_v2_webgpu_engine__: IEngine | undefined;
}

let _gpuEngine: IEngine | null = null;

export function getGpuEngine(): IEngine {
  if (typeof globalThis !== 'undefined') {
    if (!globalThis.__opengpex_v2_webgpu_engine__) {
      globalThis.__opengpex_v2_webgpu_engine__ = new WebGpuEngine();
    }
    return globalThis.__opengpex_v2_webgpu_engine__;
  }
  if (!_gpuEngine) {
    _gpuEngine = new WebGpuEngine();
  }
  return _gpuEngine;
}

export const getEngine = getGpuEngine;

// ── Cache Singletons (render loop subscribe + lifecycle) ──
export { sourceBitmapCache } from './cache/SourceBitmapCache';
export { tileCache } from './cache/TileCache';
