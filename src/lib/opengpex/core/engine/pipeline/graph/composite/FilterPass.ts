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
 * FilterPass.ts — Neighbourhood (compute) filters for a single layer
 * (separable-Gaussian blur pass).
 *
 * PASS ORCHESTRATION:
 *
 *   resident asset (or the AdjustPrePass bake)
 *          │
 *          ▼  compute pass "H"  — gaussian, axis = X, premultiply on load
 *      ping  (transient, pooled: TEXTURE_BINDING | STORAGE_BINDING | COPY_SRC)
 *          │
 *          ▼  compute pass "V"  — gaussian, axis = Y, un-premultiply on store
 *      pong  (transient, pooled — same bucket as ping, so the two alias/recycle)
 *          │
 *          ▼  returned as the layer's fgTexture for Composite/Blend
 *
 * Multiple filters chain by ping-ponging: the output of one filter becomes the
 * input of the next, and the freed buffer is reused for the following output.
 *
 * ⚠️ RESOURCE LIFETIME — why transients are NOT released here: the returned texture
 * is READ by the compositing pass later in the SAME command encoder, and the
 * intermediates are read by the following dispatch. Releasing them before
 * `queue.submit` would let the pool hand the same GPUTexture to another acquirer
 * mid-frame. So every transient is appended to the caller's `scratch` array, which
 * `RenderGraph.composite` returns and `WebGpuEngine` releases AFTER submit — the
 * mechanism already uses for the ping-pong composite buffers. No new
 * pooling machinery.
 *
 * ⚠️ POOL BUCKETING: `TexturePool` keys buckets on `${w}x${h}:${format}:${usage}`
 * and `release()` re-keys from the stored usage, so the STORAGE_BINDING transients
 * here occupy their own bucket and can never be handed out to a caller expecting a
 * RENDER_ATTACHMENT texture. The usage MUST therefore be passed explicitly — the
 * pool's default usage has no STORAGE_BINDING and the bind group would fail
 * validation.
 *
 * ⚠️ COLOUR SPACE: LINEAR LIGHT. The kernel decodes sRGB→linear on the FIRST
 * dispatch's load (unless told the source is already linear) and every filter's
 * OUTPUT is linear, so `FilterPass.run` threads a `sourceIsLinear` flag through the
 * chain and the composite pass that consumes the result is told the same. See
 * `shaders/gaussian.ts`.
 *
 * @module core/gpu/graph/composite/FilterPass
 */

import type { FilterDesc, LayerNode } from '../../scene/Scene';
import type { PipelineCache } from '@opengpex/editor/core/engine/gpu/resources/PipelineCache';
import type { BufferRing } from '@opengpex/editor/core/engine/gpu/resources/BufferRing';
import type { TexturePool } from '@opengpex/editor/core/engine/gpu/resources/TexturePool';
import { LayerTexture } from '@opengpex/editor/core/engine/gpu/resources/LayerTexture';
import { snapToPowerOfTwo } from '@opengpex/editor/core/engine/gpu/resources/TexturePool';
import { GPUTextureUsage } from '@opengpex/editor/core/engine/gpu/constants';
import {
  packGaussianUniform,
  gaussianKernelRadius,
  GAUSS_UNIFORM_BUFFER_SIZE,
  GAUSS_WORKGROUP_SIZE,
  GAUSS_AXIS_HORIZONTAL,
  GAUSS_AXIS_VERTICAL,
  GAUSS_FLAG_PREMULTIPLY_ON_LOAD,
  GAUSS_FLAG_UNPREMULTIPLY_ON_STORE,
  GAUSS_FLAG_SRC_LINEAR,
} from '@opengpex/editor/core/engine/gpu/shaders/gaussian';

/** Usage every FilterPass transient needs: sampled, compute-written, copyable. */
export const FILTER_TRANSIENT_USAGE =
  GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC;

export interface FilterPassContext {
  readonly device: GPUDevice;
  readonly pipelineCache: PipelineCache;
  readonly bufferRing: BufferRing;
  readonly texturePool: TexturePool;
  /** Storage format for the transients — the negotiated working format. */
  readonly workingFormat: 'rgba16float' | 'rgba32float';
  /** Transients are appended here; the caller releases them after submit. */
  readonly scratch: GPUTexture[];
}

/**
 * Does this layer need a FilterPass at all?
 *
 * `radius <= 0` is an identity blur, so a layer whose only filter is a zero-radius
 * gaussian takes the NO-filter path and stays bit-exact (identity no-op).
 */
export function hasEffectiveFilters(layer: LayerNode): boolean {
  const filters = layer.filters;
  if (!filters || filters.length === 0) return false;
  return filters.some((f) => isEffectiveFilter(f));
}

/** Is a single descriptor a real (non-identity) operation? */
function isEffectiveFilter(desc: FilterDesc): boolean {
  switch (desc.kind) {
    case 'gaussianBlur':
      return gaussianKernelRadius(desc.radius) > 0;
    // convolve / pixelate have no state source yet (no UI writes them), so they
    // are inert. The dispatch below throws if one ever arrives, rather than
    // silently dropping it.
    default:
      return false;
  }
}

export class FilterPass {
  /**
   * Run every effective filter on `source`, returning the filtered texture.
   *
   * Records compute passes on `encoder` (each filter opens and closes its own
   * `beginComputePass` — compute and render passes cannot interleave inside one
   * pass encoder, but they can be recorded back-to-back on one command encoder).
   *
   * The returned `LayerTexture` mirrors `source`'s content AND allocated dimensions,
   * so `maxU/maxV` are preserved and `resolveLayerGeometry` downstream is unaffected.
   */
  static run(
    encoder: GPUCommandEncoder,
    ctx: FilterPassContext,
    params: {
      readonly layer: LayerNode;
      readonly source: LayerTexture;
      /**
       * Does `source` already hold LINEAR light? True when it came from
       * `AdjustPrePass`'s rgba16float bake or from a genuinely linear source asset;
       * false for the common sRGB-encoded `rgba8unorm` asset, which the FIRST
       * dispatch then decodes. Passed EXPLICITLY rather than inferred from the
       * texture format, because format does not imply domain (an rgba16float bake
       * is linear, but a hypothetical f16 encoded upload would not be).
       */
      readonly sourceIsLinear?: boolean;
    },
  ): LayerTexture {
    const { layer, source } = params;
    const filters = (layer.filters ?? []).filter(isEffectiveFilter);
    if (filters.length === 0) return source;

    let current = source;
    // Only the FIRST filter can face an encoded source; every filter writes linear
    // output, so subsequent ones must not decode again.
    let currentIsLinear = params.sourceIsLinear ?? false;
    for (const desc of filters) {
      switch (desc.kind) {
        case 'gaussianBlur':
          current = FilterPass.gaussianBlur(encoder, ctx, layer, current, desc.radius, currentIsLinear);
          currentIsLinear = true;
          break;
        default:
          // Unreachable while isEffectiveFilter only admits gaussianBlur, but an
          // explicit throw beats silently rendering an un-filtered layer if a new
          // FilterDesc arm is wired into the assembler without a GPU implementation.
          throw new Error(
            `FilterPass: no GPU implementation for filter kind '${(desc as FilterDesc).kind}'`,
          );
      }
    }
    return current;
  }

  /**
   * Separable Gaussian: two compute dispatches (H then V) through one transient.
   *
   * ALPHA: premultiply on the FIRST pass's load and un-premultiply on the LAST
   * pass's store, so the convolution runs entirely in premultiplied space (no dark
   * halo at alpha edges) while the input AND output stay STRAIGHT — matching the
   * resident-texture convention every other pass assumes.
   *
   * COLOUR SPACE: pass H decodes sRGB→linear unless `sourceIsLinear`, so the
   * convolution is physically correct. Pass V ALWAYS sets
   * `GAUSS_FLAG_SRC_LINEAR` because its input is pass H's linear output — decoding
   * twice would darken the result. The returned texture holds LINEAR light.
   */
  private static gaussianBlur(
    encoder: GPUCommandEncoder,
    ctx: FilterPassContext,
    layer: LayerNode,
    source: LayerTexture,
    sigma: number,
    sourceIsLinear: boolean,
  ): LayerTexture {
    const ping = FilterPass.acquireTransient(ctx, source);
    const pong = FilterPass.acquireTransient(ctx, source);


    // Pass H: source → ping (decode to linear if needed, then premultiply on load;
    // result stays linear + premultiplied).
    FilterPass.dispatchGaussian(encoder, ctx, layer, {
      src: source,
      dst: ping,
      sigma,
      axis: GAUSS_AXIS_HORIZONTAL,
      flags:
        GAUSS_FLAG_PREMULTIPLY_ON_LOAD | (sourceIsLinear ? GAUSS_FLAG_SRC_LINEAR : 0),
      label: 'H',
    });

    // Pass V: ping → pong (input is already LINEAR and premultiplied — never decode
    // twice; restore straight alpha on store).
    FilterPass.dispatchGaussian(encoder, ctx, layer, {
      src: ping,
      dst: pong,
      sigma,
      axis: GAUSS_AXIS_VERTICAL,
      flags: GAUSS_FLAG_UNPREMULTIPLY_ON_STORE | GAUSS_FLAG_SRC_LINEAR,
      label: 'V',
    });


    return pong;
  }

  /**
   * Acquire a transient matching `like`'s content size, registering it in `scratch`
   * for post-submit release. The pooled texture may be LARGER (power-of-two bucket),
   * so the wrapper carries both the content and allocated dimensions.
   */
  private static acquireTransient(ctx: FilterPassContext, like: LayerTexture): LayerTexture {
    const texture = ctx.texturePool.acquire({
      width: like.width,
      height: like.height,
      format: ctx.workingFormat,
      // MUST be explicit: the pool default lacks STORAGE_BINDING (and would land in
      // the render-attachment bucket) — see the module header.
      usage: FILTER_TRANSIENT_USAGE,
      label: 'FilterPass Transient',
    });
    ctx.scratch.push(texture);
    return new LayerTexture({
      texture,
      width: like.width,
      height: like.height,
      allocatedWidth: snapToPowerOfTwo(like.width),
      allocatedHeight: snapToPowerOfTwo(like.height),
      format: ctx.workingFormat,
    });
  }

  /** Record ONE 1D Gaussian pass. */
  private static dispatchGaussian(
    encoder: GPUCommandEncoder,
    ctx: FilterPassContext,
    layer: LayerNode,
    p: {
      src: LayerTexture;
      dst: LayerTexture;
      sigma: number;
      axis: number;
      flags: number;
      label: string;
    },
  ): void {
    const { device, pipelineCache, bufferRing } = ctx;
    const width = p.src.width;
    const height = p.src.height;

    const uniform = packGaussianUniform(p.sigma, width, height, p.axis, p.flags);
    const slot = bufferRing.writeSlot(uniform);

    const bindGroup = device.createBindGroup({
      layout: pipelineCache.getFilterBindGroupLayout(ctx.workingFormat),
      label: `Gaussian ${p.label} BindGroup (${layer.id})`,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: bufferRing.getBuffer(),
            offset: 0,
            size: GAUSS_UNIFORM_BUFFER_SIZE,
          },
        },
        { binding: 1, resource: p.src.view },
        { binding: 2, resource: p.dst.view },
      ],
    });

    const pass = encoder.beginComputePass({ label: `Gaussian ${p.label} (${layer.id})` });
    pass.setPipeline(pipelineCache.getGaussianPipeline(ctx.workingFormat));
    pass.setBindGroup(0, bindGroup, [slot.offset]);
    // One workgroup covers GAUSS_WORKGROUP_SIZE pixels along the FILTERED axis; the
    // y dimension enumerates the lines perpendicular to it (workgroup tiling).
    const axisLen = p.axis === GAUSS_AXIS_HORIZONTAL ? width : height;
    const lineCount = p.axis === GAUSS_AXIS_HORIZONTAL ? height : width;
    pass.dispatchWorkgroups(Math.ceil(axisLen / GAUSS_WORKGROUP_SIZE), lineCount, 1);
    pass.end();
  }
}
