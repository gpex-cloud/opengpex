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
 * adjustBindGroup.ts — Single resolver for the group-1 adjustment bind group
 * Shared by `CompositePass`, `BlendPass` and `AdjustPrePass`.
 *
 * Shared across consumers (the compositor, blend pass, and adjust bake) alongside
 * 3D LUT binding and the `suppress` switch that keeps a baked
 * adjustment from being applied twice.
 *
 * BEHAVIOUR
 * ---------
 * • Layers with a scalar/matrix arm (`basic` / `channelMix` / `colorBalance`) or a
 *   resident curves/levels/lut3d texture get a fresh bind group at a ring offset.
 * • Layers with NO adjustment at all bind the SHARED identity group (flags = 0), so
 *   `apply_adjustments` is a bit-exact no-op (identity no-op).
 * • `suppress: true` FORCES the identity group even when the layer HAS adjustments —
 *   used by the composite step of the adjust→filter path, where the adjustment is
 *   already baked into the filtered texture. Without this the grade would be applied
 *   twice (once in the bake, once inline).
 * • A referenced-but-not-yet-resident LUT (async upload race) leaves its sampling
 *   flag CLEARED and binds the identity placeholder, so the frame is
 *   correct-but-unadjusted rather than sampling garbage; the next frame (after the
 *   upload lands) re-composites with it.
 *
 * @module core/gpu/graph/support/adjustBindGroup
 */

import type { LayerNode } from '../../scene/Scene';
import type { PipelineCache } from '@opengpex/editor/core/engine/gpu/resources/PipelineCache';
import type { BufferRing } from '@opengpex/editor/core/engine/gpu/resources/BufferRing';
import {
  ADJUST_UNIFORM_BUFFER_SIZE,
  ADJUST_FLAG_LEVELS,
  ADJUST_FLAG_CURVES,
  ADJUST_FLAG_LUT3D,
} from '@opengpex/editor/core/engine/gpu/shaders/adjust';
import { packAdjustUniform } from '../../scene/adjustUniform';

/** Everything the resolver needs from the surrounding pass context. */
export interface ResolveAdjustDeps {
  readonly device: GPUDevice;
  readonly pipelineCache: PipelineCache;
  readonly bufferRing: BufferRing;
  /** Resolve a resident curves/levels 1D LUT view by lutId. */
  readonly resolveLutView?: (lutId: string) => GPUTextureView | undefined;
  /** Resolve a resident 3D `.cube` LUT view by lutId. */
  readonly resolveLut3dView?: (lutId: string) => GPUTextureView | undefined;
}

export interface ResolvedAdjustBindGroup {
  readonly bindGroup: GPUBindGroup;
  readonly offset: number;
}

/**
 * Resolve the group-1 adjustment bind group for `layer`.
 *
 * @param suppress force the identity (flags = 0) group — set by the composite step
 *   when the adjustment has ALREADY been baked upstream (adjust→filter order path).
 */
export function resolveAdjustBindGroup(
  deps: ResolveAdjustDeps,
  layer: LayerNode,
  suppress = false,
): ResolvedAdjustBindGroup {
  const { device, pipelineCache, bufferRing, resolveLutView, resolveLut3dView } = deps;

  if (suppress) {
    return { bindGroup: pipelineCache.getDefaultAdjustBindGroup(), offset: 0 };
  }

  const adjustments = layer.adjustments;
  const hasScalarOrMatrix =
    adjustments !== undefined &&
    adjustments.some(
      (a) => a.kind === 'basic' || a.kind === 'channelMix' || a.kind === 'colorBalance',
    );
  const levelsDesc = adjustments?.find((a) => a.kind === 'levels');
  const curvesDesc = adjustments?.find((a) => a.kind === 'curves');
  const lut3dDesc = adjustments?.find((a) => a.kind === 'lut3d');

  const levelsView =
    levelsDesc && resolveLutView ? resolveLutView((levelsDesc as { lutId: string }).lutId) : undefined;
  const curvesView =
    curvesDesc && resolveLutView ? resolveLutView((curvesDesc as { lutId: string }).lutId) : undefined;
  const lut3dView =
    lut3dDesc && resolveLut3dView
      ? resolveLut3dView((lut3dDesc as { lutId: string }).lutId)
      : undefined;

  // Nothing to apply → the shared identity (flags=0) bind group.
  if (!hasScalarOrMatrix && !levelsView && !curvesView && !lut3dView) {
    return { bindGroup: pipelineCache.getDefaultAdjustBindGroup(), offset: 0 };
  }

  const packed = packAdjustUniform(adjustments);
  // Set/clear the LUT sampling flags to match what is actually BOUND.
  const uints = new Uint32Array(packed.buffer);
  if (levelsView) uints[31] |= ADJUST_FLAG_LEVELS;
  if (curvesView) uints[31] |= ADJUST_FLAG_CURVES;
  if (lut3dView) uints[31] |= ADJUST_FLAG_LUT3D;

  const slot = bufferRing.writeSlot(packed);
  const identity = pipelineCache.getIdentityLutView();
  const identity3d = pipelineCache.getIdentityLut3dView();
  const bindGroup = device.createBindGroup({
    layout: pipelineCache.getAdjustBindGroupLayout(),
    label: `Adjust BindGroup (${layer.id})`,
    entries: [
      {
        binding: 0,
        resource: { buffer: bufferRing.getBuffer(), offset: 0, size: ADJUST_UNIFORM_BUFFER_SIZE },
      },
      { binding: 1, resource: pipelineCache.getLutSampler() },
      { binding: 2, resource: levelsView ?? identity },
      { binding: 3, resource: curvesView ?? identity },
      { binding: 4, resource: lut3dView ?? identity3d },
    ],
  });
  return { bindGroup, offset: slot.offset };
}
