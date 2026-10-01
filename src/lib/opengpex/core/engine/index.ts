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
 * engine/ — Barrel export module (Facade layer).
 *
 * Public surface (Tier 1 — Context/Service construction):
 *   - createPixelFacade (factory for PixelService)
 *   - WorkerBridge (transport layer for main↔worker communication)
 *
 * Public surface (Tier 2 — Rendering-layer facade):
 *   - getGpuEngine, sourceBitmapCache, highDepthTextureCache
 *   - GpuDevice
 *   - SceneAssembler, SceneContentCache
 *   - Scene channel-mask constants + `SceneChannelMask` type
 * Rendering-layer consumers (CanvasStage/Viewport/LayersDrawer/AssetService)
 * import these from here instead of reaching into `pipeline/*`, `gpu/device/*`,
 * `sources/*` deep paths — avoiding direct deep imports across layers.
 *
 * Other public sub-paths:
 *   - engine/color               → Colour-science operator sub-domain barrel
 *                                  (kept as a sub-path deliberately; not folded
 *                                  into the top-level barrel to maintain separation)
 *   - engine/types               → Type-only exports (core/types layer)
 *   - engine/utils/sample-utils  → Lazy terminal encode + world→texel indexing
 *                                  for a `SampledPixels` (sampler/mosaic)
 *   - engine/utils/pixel-utils   → Pure pixel/colour-space helpers
 *
 * (The two LUT generators are imported directly by consumers from
 * `core/engine/color/luts`.)
 *
 * Internal modules (dispatchers, results, caches, worker handlers) are NOT
 * re-exported here; consumers should use the appropriate sub-path barrel
 * or interact through the PixelService facade.
 */

// ── Facade ──
export { createPixelFacade } from './PixelFacade';
export type { PixelFacadeDeps } from './PixelFacade';

// ── Bridge (needed by EditorContext to construct) ──
export { WorkerBridge } from './dispatch/bridge/WorkerBridge';

// ── Rendering-layer facade ──
export { getGpuEngine } from './pipeline/WebGpuEngine';
export { SceneAssembler } from './pipeline/scene/SceneAssembler';
export { SceneContentCache } from './pipeline/scene/SceneContentCache';
export {
  CHANNEL_MASK_R,
  CHANNEL_MASK_G,
  CHANNEL_MASK_B,
  CHANNEL_MASK_A,
  CHANNEL_MASK_RGB,
  DISPLAY_CHANNEL_SIGNAL_KEY,
} from './pipeline/scene/Scene';
export type { SceneChannelMask } from './pipeline/scene/Scene';
export { GpuDevice } from './gpu/device/GpuDevice';
export { sourceBitmapCache, highDepthTextureCache } from './sources';
export { markerToSvg } from './raster/paintMarker';
