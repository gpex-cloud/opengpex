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
 * Rendering Engine Architecture:
 * 
 * 1. Interface abstraction:
 *    Export concrete implementation (currently canvas2dEngine) via 'engine' alias.
 *    This allows callers (e.g. StageRenderer, PixelService) to program only against the generic engine interface.
 *    If upgrading to WebGL/WebGPU or connecting a WASM driver in the future, just modify the export source here without changing business logic.
 * 
 * 2. Dependency decoupling:
 *    The engine layer remains pure JS implementation and is strictly forbidden from depending on React Context.
 *    All external dependencies (e.g. AssetService, GeometryService) are injected via method parameters,
 *    ensuring the engine is capable of running independently in non-UI environments like WebWorker and Node.js.
 */

export { createPixelService } from './PixelService';
export { createWorkerProxy } from './WorkerProxy';
export { EngineFactory } from './EngineFactory';

// Frontend display engine statically locked by global config
import { STAGE_RENDER_ENGINE } from '../helpers/config';
import { EngineFactory } from './EngineFactory';
export const engine = EngineFactory.create(STAGE_RENDER_ENGINE);
