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
 * AdjustPrePass.ts — Bake a layer's `adjustments` into a transient texture so a
 * following FilterPass observes the declared `adjustments → filters` order.
 *
 * ONLY used for layers that carry BOTH adjustments and filters. See
 * `shaders/adjustPre.ts` for the order-contract rationale and
 * `RenderGraph.resolveLayerSourceTexture` for the dispatch decision.
 *
 * OUTPUT CONTRACT — a drop-in replacement for the resident asset:
 *   • same content dimensions (`width`/`height`), so `resolveLayerGeometry` is
 *     unaffected;
 *   • bucket-aware `allocatedWidth/Height`, so `maxU/maxV` stay correct (a pooled
 *     texture is larger than its content — collapsing that ratio would sample unwritten padding);
 *   • STRAIGHT alpha, matching what the resident texture held.
 *
 * @module core/gpu/graph/composite/AdjustPrePass
 */

import type { LayerNode } from '../../scene/Scene';
import type { PipelineCache } from '@opengpex/editor/core/engine/gpu/resources/PipelineCache';
import type { BufferRing } from '@opengpex/editor/core/engine/gpu/resources/BufferRing';
import type { LayerTexture } from '@opengpex/editor/core/engine/gpu/resources/LayerTexture';
import { ADJUST_PRE_UNIFORM_BUFFER_SIZE, packAdjustPreUniform } from '@opengpex/editor/core/engine/gpu/shaders/adjustPre';
import { resolveAdjustBindGroup, type ResolveAdjustDeps } from '../support/adjustBindGroup';
import { resolveSourceGamutId } from '../support/sourceGamut';
import { resolveSourceRenderIntent } from '../support/sourceIntent';

export interface AdjustPrePassContext {
  readonly device: GPUDevice;
  readonly pipelineCache: PipelineCache;
  readonly bufferRing: BufferRing;
  readonly targetFormat: GPUTextureFormat;
  /** Resolve a resident curves/levels 1D LUT view by lutId. */
  readonly resolveLutView?: (lutId: string) => GPUTextureView | undefined;
  /** Resolve a resident 3D `.cube` LUT view by lutId. */
  readonly resolveLut3dView?: (lutId: string) => GPUTextureView | undefined;
}

export class AdjustPrePass {
  /**
   * Record the bake into `target`. The caller owns the render pass lifetime; this
   * only issues the draw so it can be batched into the surrounding encoder.
   */
  static draw(
    passEncoder: GPURenderPassEncoder,
    ctx: AdjustPrePassContext,
    params: {
      readonly layer: LayerNode;
      readonly source: LayerTexture;
      /**
       * Does `source` already hold linear light? The bake's OUTPUT is always
       * linear, so this only controls whether the sample is decoded first.
       */
      readonly sourceIsLinear?: boolean;
    },
  ): void {
    const { layer, source } = params;
    const { device, pipelineCache, bufferRing } = ctx;

    // Sample only the VALID region of a pooled source (see the maxU/maxV note).
    // `source` here is ALWAYS the raw resident asset (this pass is the FIRST sample
    // of the original pixels), so there is no pipeline override — the bake performs
    // the source→working gamut alignment AND owns the render-intent tone-map itself
    // and RenderGraph then tells the downstream
    // composite it is already working-gamut with its intent applied (constraint A).
    const gamutId = resolveSourceGamutId(layer);
    const intent = resolveSourceRenderIntent(layer);
    const uniform = packAdjustPreUniform(
      source.maxU,
      source.maxV,
      params.sourceIsLinear ?? false,
      gamutId,
      intent,
    );
    const slot = bufferRing.writeSlot(uniform);

    const bindGroup = device.createBindGroup({
      layout: pipelineCache.getAdjustPreBindGroupLayout(),
      label: `Adjust Pre BindGroup (${layer.id})`,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: bufferRing.getBuffer(),
            offset: 0,
            size: ADJUST_PRE_UNIFORM_BUFFER_SIZE,
          },
        },
        // 1:1 bake — nearest vs linear is irrelevant at an exact texel mapping, and
        // the layout demands a filtering sampler, so reuse the shared LUT sampler's
        // sibling: the plain linear sampler.
        { binding: 1, resource: pipelineCache.getLinearSampler() },
        { binding: 2, resource: source.view },
      ],
    });

    const deps: ResolveAdjustDeps = {
      device,
      pipelineCache,
      bufferRing,
      resolveLutView: ctx.resolveLutView,
      resolveLut3dView: ctx.resolveLut3dView,
    };
    const adjust = resolveAdjustBindGroup(deps, layer);

    passEncoder.setPipeline(pipelineCache.getAdjustPrePipeline(ctx.targetFormat));
    passEncoder.setVertexBuffer(0, pipelineCache.getQuadVertexBuffer());
    passEncoder.setBindGroup(0, bindGroup, [slot.offset]);
    passEncoder.setBindGroup(1, adjust.bindGroup, [adjust.offset]);
    passEncoder.draw(6);
  }
}
