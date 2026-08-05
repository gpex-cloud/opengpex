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
 * Consumers: stage/layers/canvas2d/ (CanvasStage, StageComposer)
 *
 * Provides:
 *   - getEngine(): lazy-created IRenderer singleton (no module-load side-effect)
 *   - IRenderer protocol types (for StageComposer typing)
 *   - Cache singletons (subscribe/setDragging for render loop coordination)
 *
 * Internal modules (Canvas2dEngine internals, dispatchers, worker) are NOT
 * accessible through this barrel — consumers interact only via these exports.
 */

import { EngineFactory, type EngineType } from './rendering/onscreen/EngineFactory';
import { STAGE_RENDER_ENGINE } from '../helpers/config';
import type { IRenderer } from './protocol/IRenderer';

// ── Lazy Engine Singleton ──
let _engine: IRenderer | null = null;

/**
 * Returns the global onscreen renderer (lazy-created on first call).
 * Replaces the previous module-level `export const engine = ...` pattern
 * to eliminate module-load-time side effects.
 */
export function getEngine(): IRenderer {
  if (!_engine) {
    _engine = EngineFactory.create(STAGE_RENDER_ENGINE as EngineType);
  }
  return _engine;
}

// ── Protocol Types (for StageComposer) ──
export type { IRenderer, RenderCommand, DrawLayerOptions } from './protocol/IRenderer';

// ── Cache Singletons (render loop subscribe + lifecycle) ──
export { sourceBitmapCache } from './cache/SourceBitmapCache';
export { tileCache } from './cache/TileCache';
export { filterCache } from './cache/FilterCache';
