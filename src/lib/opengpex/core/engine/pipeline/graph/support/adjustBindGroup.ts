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
 * adjustBindGroup.ts — Single resolver for the group-1 GRADE-CHAIN bind group.
 * Shared by `CompositePass`, `BlendPass` and `AdjustPrePass`.
 *
 * BEHAVIOUR
 * ---------
 * • A layer whose chain packs to at least one ACTIVE stage (any operator bit
 *   set once residency is accounted for) gets a fresh bind group at a ring
 *   offset: the packed `AdjustChain` uniform, the layer's LUT atlas (or the
 *   identity atlas), its coverage array (or the 1-layer white default) and the
 *   3D LUT slot.
 * • A layer with NO active stage binds the SHARED identity group
 *   (`stage_count = 0`), so `apply_adjust_chain` is a bit-exact no-op.
 * • `suppress: true` FORCES the identity group even when the layer HAS a chain —
 *   used by the composite step of the adjust→filter path, where the chain is
 *   already baked into the filtered texture. Without this the grade would be
 *   applied twice (once in the bake, once inline).
 * • A referenced-but-not-yet-resident atlas / 3D LUT (async upload race) leaves
 *   the corresponding sampling flags CLEARED and binds the identity placeholder,
 *   so the frame is correct-but-unadjusted rather than sampling garbage; the
 *   next frame (after the upload lands) re-composites with it.
 *
 * @module core/gpu/graph/support/adjustBindGroup
 */

import type { LayerNode } from '../../scene/Scene';
import type { PipelineCache } from '@opengpex/editor/core/engine/gpu/resources/PipelineCache';
import type { BufferRing } from '@opengpex/editor/core/engine/gpu/resources/BufferRing';
import { ADJUST_UNIFORM_BUFFER_SIZE } from '@opengpex/editor/core/engine/gpu/shaders/adjust';
import { packAdjustChain } from '../../scene/adjustUniform';

/** Everything the resolver needs from the surrounding pass context. */
export interface ResolveAdjustDeps {
  readonly device: GPUDevice;
  readonly pipelineCache: PipelineCache;
  readonly bufferRing: BufferRing;
  /** Resolve a resident per-layer LUT atlas (`texture_2d`) view by its atlas id. */
  readonly resolveLutView?: (lutId: string) => GPUTextureView | undefined;
  /** Resolve a resident 3D `.cube` LUT view by lutId. */
  readonly resolveLut3dView?: (lutId: string) => GPUTextureView | undefined;
}

/** The layer's baked coverage array + the union window it was baked over. */
export interface AdjustCoverageBinding {
  readonly view: GPUTextureView;
  /** (x0, y0, w, h) in content-unit fractions of the layer's content rect. */
  readonly window: readonly [number, number, number, number];
}

export interface ResolvedAdjustBindGroup {
  readonly bindGroup: GPUBindGroup;
  readonly offset: number;
}

/**
 * Resolve the group-1 grade-chain bind group for `layer`.
 *
 * @param suppress force the identity (stage_count = 0) group — set by the
 *   composite step when the chain has ALREADY been baked upstream.
 * @param coverage the layer's baked coverage array, when any stage is confined.
 */
export function resolveAdjustBindGroup(
  deps: ResolveAdjustDeps,
  layer: LayerNode,
  suppress = false,
  coverage?: AdjustCoverageBinding,
): ResolvedAdjustBindGroup {
  const { device, pipelineCache, bufferRing, resolveLutView, resolveLut3dView } = deps;

  if (suppress) {
    return { bindGroup: pipelineCache.getDefaultAdjustBindGroup(), offset: 0 };
  }

  const stages = layer.adjustStages;
  if (!stages || stages.length === 0) {
    return { bindGroup: pipelineCache.getDefaultAdjustBindGroup(), offset: 0 };
  }

  const atlasView =
    layer.adjustLutAtlasId && resolveLutView ? resolveLutView(layer.adjustLutAtlasId) : undefined;

  // The single 3D LUT slot: the FIRST stage referencing a resident lut3d wins
  // (no producer emits one today; the slot is kept for the film-look feature).
  let lut3dView: GPUTextureView | undefined;
  for (const st of stages) {
    const d = st.adjustments.find((a) => a.kind === 'lut3d') as { lutId: string } | undefined;
    if (d && resolveLut3dView) {
      lut3dView = resolveLut3dView(d.lutId);
      if (lut3dView) break;
    }
  }

  const { packed, activeStages } = packAdjustChain(stages, {
    atlasResident: atlasView !== undefined,
    lut3dResident: lut3dView ? () => true : undefined,
    coverageWindow: coverage?.window,
  });

  // Nothing to apply (every stage waits on a resident texture) → identity group.
  if (activeStages === 0) {
    return { bindGroup: pipelineCache.getDefaultAdjustBindGroup(), offset: 0 };
  }

  const slot = bufferRing.writeSlot(packed);
  const bindGroup = device.createBindGroup({
    layout: pipelineCache.getAdjustBindGroupLayout(),
    label: `Adjust BindGroup (${layer.id})`,
    entries: [
      {
        binding: 0,
        resource: { buffer: bufferRing.getBuffer(), offset: 0, size: ADJUST_UNIFORM_BUFFER_SIZE },
      },
      { binding: 1, resource: pipelineCache.getLutSampler() },
      { binding: 2, resource: atlasView ?? pipelineCache.getIdentityLutView() },
      { binding: 3, resource: coverage?.view ?? pipelineCache.getAdjustCoverageArrayView() },
      { binding: 4, resource: lut3dView ?? pipelineCache.getIdentityLut3dView() },
    ],
  });
  return { bindGroup, offset: slot.offset };
}
