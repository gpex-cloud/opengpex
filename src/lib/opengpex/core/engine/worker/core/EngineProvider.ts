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

import { drawLayerInstance as canvas2dPainter } from '../../backends/canvas2d/painter';

import { WORKER_RENDER_ENGINE } from '@opengpex/editor/core/helpers/config';

export type EngineType = 'canvas2d' | 'wasm';

/**
 * EngineProvider (Background computation engine proxy)
 * 
 * [Architectural Responsibility]
 * Provides pure, stateless atomic drawing functions (like drawLayerInstance) for data processors (merger, transformer, etc.) in offscreen Worker thread.
 * It does not instantiate a complete engine (IRenderer), only dispatches pixel computation capabilities as needed.
 * 
 * [Physical Isolation Principle - Why not merge with EngineFactory?]
 * 1. Avoid main thread bloating: If merged with main thread Factory, the bundler (Webpack/Vite) will pack the future massive
 *    compiled WASM binary packages into main.js, causing blockages in initial page loading.
 * 2. Pure environment: This file is in the worker/ directory to ensure all imported dependencies are 100% independent of the DOM.
 */
export class EngineProvider {
  static get drawLayerInstance() {
    if (WORKER_RENDER_ENGINE === 'wasm') {
      console.warn('[Worker] WASM painter not implemented. Falling back to canvas2d.');
      return canvas2dPainter;
    }
    return canvas2dPainter;
  }
}
