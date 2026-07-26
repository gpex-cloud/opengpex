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
 * EngineFactory — Engine V2 renderer creation entry point.
 *
 * Simplified factory that produces IRenderer instances.
 * Currently only supports 'canvas2d'; future extension to 'webgpu'.
 *
 * Usage:
 *   const engine = EngineFactory.create('canvas2d');
 *   engine.attach(ctx);
 */

import { Canvas2dEngine } from './Canvas2dEngine';
import type { IRenderer } from '../../protocol/IRenderer';

export type EngineType = 'canvas2d';

export const EngineFactory = {
  /**
   * Create a new rendering engine instance.
   *
   * @param type - The backend type. Currently only 'canvas2d' is supported.
   *              Future: 'webgpu' will be added when WebGPU backend is ready.
   * @returns A fresh IRenderer instance (not attached to any context yet).
   */
  create(type: EngineType): IRenderer {
    switch (type) {
      case 'canvas2d':
        return new Canvas2dEngine();
      default: {
        // Exhaustive check — if a new EngineType is added without a case,
        // TypeScript will error here at compile time.
        const _exhaustive: never = type;
        throw new Error(`[EngineFactory] Unknown engine type: ${_exhaustive}`);
      }
    }
  },
};
