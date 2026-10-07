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
 * runFilterChain.ts — Convolve a build-phase source through its layer's effective
 * filters and describe the output domain for the compositor.
 *
 * Shared by the raster path (`prepareFilteredSources`, after its optional AdjustPre
 * bake) and the vector path (`prepareVectorSources`, over the strategy's transient),
 * so the two can never drift.
 *
 * The FilterPass output is ALWAYS linear light. `sourceIsWorkingGamut` /
 * `sourceIntentApplied` mirror whether an upstream bake already performed those
 * (a filter-only raster reaches here still in its source gamut / intent-unapplied,
 * so the compositor must finish the job). `suppressAdjust` defaults to "did this
 * layer's adjustments feed a bake"; the vector path overrides it to false because a
 * vector source bakes no grade and the compositor applies `layer.adjustments` inline.
 *
 * @module core/gpu/graph/build/runFilterChain
 */

import type { LayerNode } from '../../scene/Scene';
import type { LayerTexture } from '@opengpex/editor/core/engine/gpu/resources/LayerTexture';
import { FilterPass } from '../composite/FilterPass';
import type { BuildContext, PreparedSource } from './types';

export function runFilterChain(
  encoder: GPUCommandEncoder,
  ctx: BuildContext,
  layer: LayerNode,
  filterInput: LayerTexture,
  inputIsLinear: boolean,
  inputIsWorkingGamut: boolean,
  inputIntentApplied: boolean,
  suppressAdjust?: boolean,
): PreparedSource {
  const { device, pipelineCache, bufferRing, texturePool, workingFormat, scratch } = ctx;
  const filtered = FilterPass.run(
    encoder,
    { device, pipelineCache, bufferRing, texturePool, workingFormat, scratch },
    { layer, source: filterInput, sourceIsLinear: inputIsLinear },
  );

  // The grade is already in the pixels — do not let the composite re-apply it.
  return {
    texture: filtered,
    suppressAdjust: suppressAdjust ?? (layer.adjustments !== undefined && layer.adjustments.length > 0),
    vectorTransient: layer.source?.kind === 'vector',
    sourceIsLinear: true,
    // ⚠️ NOT unconditionally true: gamut alignment only happened if a bake ran.
    sourceIsWorkingGamut: inputIsWorkingGamut,
    // ⚠️ Same discipline: intent was applied only if a bake ran.
    sourceIntentApplied: inputIntentApplied,
  };
}
