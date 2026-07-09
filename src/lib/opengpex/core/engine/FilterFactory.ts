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

import type { IFilter } from './protocol/IFilter';

/**
 * Available IFilter backends.
 *
 * The names mirror `EngineFactory`'s `EngineType` union so upgrade paths
 * (Canvas2D → WebGL → WebGPU) stay symmetric between renderer and filter
 * runtimes (spec §8.5).
 */
export type FilterBackendType = 'canvas2d' | 'webgl' | 'webgpu';

/**
 * FilterFactory (Filter runtime factory)
 *
 * [Architectural Responsibility]
 * Mirrors `EngineFactory` — instantiates an `IFilter` implementation on
 * demand. Both main thread and Worker code paths request their IFilter
 * runtime through this factory so we can:
 *
 * 1. Swap backends (Canvas2D / WebGL / WebGPU) via a single call site.
 * 2. Keep the concrete backend imports out of the protocol module (so the
 *    protocol has zero runtime dependencies).
 * 3. Fail loudly when a caller asks for a backend that has not been wired
 *    up yet, rather than silently falling through to a placeholder.
 *
 * [Skeleton — Step 1]
 * Only the factory contract is defined at this stage. The `canvas2d`
 * implementation (`Canvas2dFilter`) is delivered in Step 2 and will be
 * dynamically imported here to avoid pulling ImageData loop code onto the
 * main-thread hot path when only the types are needed.
 */
export class FilterFactory {
  /**
   * Create an IFilter runtime instance.
   *
   * Step 1 note: this is a skeleton — invoking `create()` throws until the
   * corresponding backend module is delivered. Consumers should call this
   * lazily (e.g. inside a Worker handler) rather than at module top-level.
   */
  static async create(type: FilterBackendType = 'canvas2d'): Promise<IFilter> {
    switch (type) {
      case 'canvas2d': {
        // Delivered in Step 2 — dynamically imported so the LUT / ImageData
        // hot loops never ship into the main-thread chunk on their own.
        const { Canvas2dFilter } = await import(
          './backends/canvas2d/Canvas2dFilter'
        );
        return new Canvas2dFilter();
      }

      case 'webgl': {
        throw new Error(
          '[FilterFactory] webgl backend is a future upgrade (spec §8.3).',
        );
      }
      case 'webgpu': {
        throw new Error(
          '[FilterFactory] webgpu backend is a future upgrade (spec §8.5).',
        );
      }
      default: {
        // Exhaustiveness guard — TypeScript will error if a new backend type
        // is added without extending this switch.
        const _never: never = type;
        throw new Error(`[FilterFactory] unknown backend: ${String(_never)}`);
      }
    }
  }
}
