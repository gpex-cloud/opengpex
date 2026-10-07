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
 * prepareVectorSources.ts — Vector spine prepass (architecture B): render EVERY
 * vector layer to its own transient BEFORE any composite render pass opens,
 * so the four composite guards consume it as an ordinary straight-alpha raster
 * source.
 *
 * WHY A PREPASS (mirrors `prepareFilteredSources`): each vector source needs its own
 * render pass, and WebGPU forbids beginning one while a composite render pass is
 * open. Recording all of them up-front lets the pure-separable / ping-pong /
 * non-separable branches all read the finished transients through one map.
 *
 * STRATEGY DISPATCH: the geometry→coverage step is delegated to the `VectorRenderer`
 * named by `source.renderer` (`sdf` today, `stroke` reserved), resolved through the
 * exhaustive `resolveVectorRenderer` selector. Everything ELSE here —
 * transient sizing, the filter chain, the domain flags — is shape-agnostic spine
 * and identical for every strategy.
 *
 * SIZING (architecture B contract #3): the transient is sized at the COMPOSITE
 * density — `ceil(bounding × exportScale)` — where `exportScale` is the export
 * viewport's physical-px-per-world-px (1 on the interactive path). An SDF source is
 * resolution-independent, so `fwidth` then yields analytic AA at the OUTPUT density
 * and a 2×/4× export downsamples a supersampled edge instead of stretching a logical
 * bitmap. `contentWidth/Height` stay logical (the downstream `drawLayer` samples the
 * larger texture down), so the geometry is untouched — only the texel count grows.
 *
 * FILTER CHAIN: when the layer carries effective filters, the transient is fed
 * through the SAME `FilterPass` chain a raster layer uses (shared `runFilterChain`),
 * producing a filtered transient that the compositor samples. The input is flagged
 * linear + working-gamut + intent-applied (the strategy already resolved all three),
 * so no `AdjustPrePass` bake runs and `suppressAdjust` stays false — the compositor
 * still applies `layer.adjustments` inline. A FILTERED source is NOT supersampled
 * (scale `[1,1]`): the gaussian radius is a logical-pixel quantity, so filtering at
 * logical density and upscaling on export matches how a filtered raster layer
 * behaves.
 *
 * OUTPUT ENTRY: `{ sourceIsLinear/sourceIsWorkingGamut/sourceIntentApplied: true }`
 * so the downstream `drawLayer` packs flags that SKIP sRGB-decode / gamut-convert /
 * tone-map — the colours were already resolved to working-gamut linear light by the
 * scene-assembly mapper (`markerToVectorSource`).
 *
 * @module core/gpu/graph/build/prepareVectorSources
 */

import type { CompiledScene } from '../SceneCompiler';
import { snapToPowerOfTwo } from '@opengpex/editor/core/engine/gpu/resources/TexturePool';
import { isOversizedTransient } from '@opengpex/editor/core/engine/gpu/resources/oversizedTransient';
import { LayerTexture } from '@opengpex/editor/core/engine/gpu/resources/LayerTexture';
import { GPUTextureUsage } from '@opengpex/editor/core/engine/gpu/constants';
import { hasEffectiveFilters } from '../composite/FilterPass';
import type { VectorRenderContext } from './vectorRenderers/VectorRenderer';
import { resolveVectorRenderer } from './vectorRenderers/resolveVectorRenderer';
import { vectorTransientSize } from '../support/vectorTransient';
import { runFilterChain } from './runFilterChain';
import type { BuildContext, PreparedSource } from './types';

const CLEAR_COLOR: GPUColor = { r: 0, g: 0, b: 0, a: 0 };

export function prepareVectorSources(
  encoder: GPUCommandEncoder,
  compiled: CompiledScene,
  ctx: BuildContext,
  out: Map<string, PreparedSource>,
  exportScale: readonly [number, number],
): void {
  const { device, pipelineCache, bufferRing, texturePool, workingFormat, scratch } = ctx;
  // One opaque token per composite invocation — strategies use it as a frame
  // boundary (the text atlas applies deferred flushes once per frame).
  const frameToken: object = {};
  const vectorCtx: VectorRenderContext = {
    device,
    pipelineCache,
    bufferRing,
    targetFormat: workingFormat,
    // [PERF_MON] Let a compute-based strategy timestamp its own prepass into the
    // composite timer (undefined when timing is off — the strategy omits it).
    timestamp: ctx.gpuTimer ? (label) => ctx.gpuTimer?.pass(label) : undefined,
  };
  for (const layer of compiled.scene.layers) {
    if (layer.source.kind !== 'vector') continue;
    const source = layer.source;

    // A filtered source convolves at COMPOSITE density (blur radius is a logical-pixel
    // quantity); a plain one supersamples to the export density. See the header.
    const filtered = hasEffectiveFilters(layer);
    const scale: readonly [number, number] = filtered ? [1, 1] : exportScale;
    const [reqW, reqH] = vectorTransientSize(layer.width ?? 1, layer.height ?? 1, scale);

    // A full-canvas / oversized transient must NOT enter the POT
    // pool — pushing a >4096 block through it destroys the block AND poisons the
    // small buckets every frame. Route it to the engine's resident cache
    // (render path: reused in place, dims-keyed) when the provider is present,
    // else a one-shot exact-size texture destroyed after the frame (export/tests).
    // A below-threshold transient stays pooled (the common small-layer case).
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    const oversized = isOversizedTransient(reqW, reqH);

    let raw: GPUTexture;
    let allocatedWidth: number;
    let allocatedHeight: number;
    if (oversized) {
      // Exact-size ⇒ allocated == content ⇒ maxU=maxV=1 (no POT sub-rect).
      allocatedWidth = reqW;
      allocatedHeight = reqH;
      if (ctx.acquireResidentTransient) {
        raw = ctx.acquireResidentTransient(`vector:${layer.id}`, {
          width: reqW,
          height: reqH,
          format: workingFormat,
          usage,
          label: `Vector Transient (${layer.id}, resident)`,
        });
      } else {
        raw = device.createTexture({
          size: [reqW, reqH, 1],
          format: workingFormat,
          usage,
          label: `Vector Transient (${layer.id}, one-shot)`,
        });
        scratch.push(raw);
      }
    } else {
      raw = texturePool.acquire({
        width: reqW,
        height: reqH,
        format: workingFormat,
        usage,
        label: `Vector Transient (${layer.id})`,
      });
      scratch.push(raw);
      allocatedWidth = snapToPowerOfTwo(reqW);
      allocatedHeight = snapToPowerOfTwo(reqH);
    }

    const transient = new LayerTexture({
      texture: raw,
      width: reqW,
      height: reqH,
      allocatedWidth,
      allocatedHeight,
      format: workingFormat,
    });

    // Static strategy dispatch (no runtime registry): the exhaustive selector picks
    // the engine built-in that turns this source's geometry into coverage. Resolved
    // BEFORE the render pass opens so a compute-based strategy can encode its prepass —
    // WebGPU forbids beginning a compute pass while a render pass is active.
    const renderer = resolveVectorRenderer(source.renderer);
    renderer.encodePrepass?.(encoder, vectorCtx, { params: source, frameToken });

    const vectorPass = encoder.beginRenderPass({
      label: `Vector Pass (${layer.id})`,
      colorAttachments: [
        { view: transient.texture.createView(), clearValue: CLEAR_COLOR, loadOp: 'clear', storeOp: 'store' },
      ],
      timestampWrites: ctx.gpuTimer?.pass(`vector(${source.renderer})`),
    });
    // Viewport = the VALID content rect; the pooled texture may be POT-larger, and
    // downstream sampling is bounded to [0, maxU]×[0, maxV].
    vectorPass.setViewport(0, 0, reqW, reqH, 0, 1);
    // Density = the transient's physical texels per logical px. Resolution-
    // DEPENDENT strategies (text: glyph atlas rasterization band) read it;
    // analytic ones (sdf/stroke) ignore it and stay sharp at any texel count.
    renderer.render(vectorPass, vectorCtx, {
      params: source,
      density: Math.max(scale[0], scale[1]),
      frameToken,
    });
    vectorPass.end();

    // The strategy resolved colour AND domain: straight-alpha working-gamut linear light.
    const vectorSource: PreparedSource = {
      texture: transient,
      suppressAdjust: false,
      vectorTransient: true,
      sourceIsLinear: true,
      sourceIsWorkingGamut: true,
      sourceIntentApplied: true,
    };

    if (!filtered) {
      out.set(layer.id, vectorSource);
      continue;
    }

    // Cascade the filters over the vector transient. The bake is deliberately skipped:
    // the pixels are already linear/working-gamut/intent-applied, so running it would
    // re-decode the grade. `runFilterChain` keeps `suppressAdjust` false — the
    // compositor applies `layer.adjustments` inline like any raster.
    out.set(
      layer.id,
      runFilterChain(
        encoder,
        ctx,
        layer,
        transient,
        /* inputIsLinear */ true,
        /* inputIsWorkingGamut */ true,
        /* inputIntentApplied */ true,
        /* suppressAdjust */ false,
      ),
    );
  }
}
