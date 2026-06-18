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

import { IRenderer } from './protocol/IRenderer';
import { Canvas2dEngine } from './backends/canvas2d/Canvas2dEngine';

export type EngineType = 'canvas2d' | 'webgl';

/**
 * EngineFactory (Frontend display engine factory)
 * 
 * [Architectural Responsibility]
 * Responsible for instantiating renderer instances (implementing the IRenderer interface) with complete lifecycle and state management for the main thread (UI layer).
 * The engine it generates (e.g. Canvas2dEngine) is mainly called by StageComposer and CanvasStage to push pixels to the screen DOM.
 * 
 * [Physical Isolation Principle - Why not merge with EngineProvider?]
 * 1. Dependency isolation: This factory will import heavy frontend graphics libraries in the future (such as WebGL wrapper libraries, DOM Polyfills, etc.).
 * 2. Prevent Worker crash: If this file is merged with the EngineProvider used by Worker, the bundler will pack these few MBs
 *    containing DOM operations (like document.createElement) into worker.js, causing the background thread to crash upon startup.
 */
export class EngineFactory {
  static create(type: EngineType = 'canvas2d'): IRenderer {
    if (type === 'webgl') {
      console.warn('WebglEngine is not implemented yet. Falling back to Canvas2dEngine.');
      return new Canvas2dEngine();
    }
    
    return new Canvas2dEngine();
  }
}
