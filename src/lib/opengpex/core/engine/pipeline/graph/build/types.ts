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
 * types.ts — Shared build-phase types.
 *
 * `PreparedSource` and `BuildContext` used to live inline in `RenderGraph.ts`.
 * Moved up so the build-phase functions extracted into sibling `build/` modules
 * can share them without importing from the orchestrator itself.
 *
 * @module core/gpu/graph/build/types
 */

import type { LayerTexture } from '@opengpex/editor/core/engine/gpu/resources/LayerTexture';
import type { CompositeContext } from '../RenderGraph';

/**
 * A per-layer source the compositor draws INSTEAD of the resident asset: a filtered
 * raster transient, or (architecture B) a vector source's offscreen transient. The
 * boolean fields tell `drawLayer` which normalisation steps the pixels have already
 * had, so its flag packing does not double-apply them.
 */
export type PreparedSource = {
  texture: LayerTexture;
  suppressAdjust: boolean;
  vectorTransient?: boolean;
  sourceIsLinear: boolean;
  sourceIsWorkingGamut: boolean;
  sourceIntentApplied: boolean;
};

/**
 * Bundles the build phase's repeatedly-destructured parameter group
 * (`device`/`pipelineCache`/`bufferRing`/`texturePool` + `workingFormat` + `scratch`)
 * into one context object, so `runFilterChain`/`prepareFilteredSources`/
 * `prepareVectorSources` take a single `ctx` instead of three separate params.
 * Extends `CompositeContext` to inherit `resolveLutView`/`resolveLut3dView`/`assets`/
 * `exportViewport` for free, rather than duplicating those fields.
 */
export interface BuildContext extends CompositeContext {
  readonly workingFormat: 'rgba16float' | 'rgba32float';
  readonly scratch: GPUTexture[];
}
