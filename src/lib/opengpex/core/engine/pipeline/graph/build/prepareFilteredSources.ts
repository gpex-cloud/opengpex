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
 * prepareFilteredSources.ts — Resolve filtered source textures for EVERY layer that
 * needs one, BEFORE any compositing render pass opens.
 *
 * ⚠️ WHY A PRE-PASS AND NOT INLINE: `FilterPass` records COMPUTE passes, and WebGPU
 * forbids beginning a compute pass while a render pass is still open. `RenderGraph`'s
 * composite branches hold one long-lived render pass across their whole layer loop, so
 * all filter work must be recorded first. This also means the filtered textures are
 * ready for BOTH the pure-separable and the ping-pong branch with one code path.
 *
 * Returns a per-layer map; layers absent from it composite straight from their
 * resident asset with the inline adjustment (bit-exact).
 *
 * @module core/gpu/graph/build/prepareFilteredSources
 */

import type { LayerNode } from '../../scene/Scene';
import type { CompiledScene } from '../SceneCompiler';
import { snapToPowerOfTwo } from '@opengpex/editor/core/engine/gpu/resources/TexturePool';
import { LayerTexture } from '@opengpex/editor/core/engine/gpu/resources/LayerTexture';
import { GPUTextureUsage } from '@opengpex/editor/core/engine/gpu/constants';
import { AdjustPrePass } from '../composite/AdjustPrePass';
import { hasEffectiveFilters } from '../composite/FilterPass';
import { isSourceLinear } from '../support/sourceDomain';
import { runFilterChain } from './runFilterChain';
import type { BuildContext, PreparedSource } from './types';

const CLEAR_COLOR: GPUColor = { r: 0, g: 0, b: 0, a: 0 };

/**
 * Resolve the texture a layer should be COMPOSITED from, running the
 * pre-composite filter chain when the layer declares filters.
 *
 * ORDER CONTRACT (`Scene.LayerNode`: adjustments apply BEFORE filters):
 *   • no filters  → return the resident asset unchanged; the compositing shader
 *     applies adjustments INLINE (bit-exact, zero cost).
 *   • has filters → ① bake adjustments into a transient (AdjustPrePass), so they
 *     land BEFORE the convolution, ② run FilterPass on that, ③ tell the caller to
 *     SUPPRESS the inline adjustment (`suppressAdjust`) so the grade is not applied
 *     a second time.
 *
 * Every transient goes into `ctx.scratch` and is released by the caller after submit
 * (transient lifetime — see FilterPass's module header).
 */
function resolveLayerSourceTexture(
  encoder: GPUCommandEncoder,
  ctx: BuildContext,
  layer: LayerNode,
  asset: LayerTexture,
): PreparedSource {
  const { workingFormat, scratch } = ctx;
  if (!hasEffectiveFilters(layer)) {
    // No pipeline-produced transient: the domain is whatever the ASSET declares.
    return { texture: asset, suppressAdjust: false, sourceIsLinear: false, sourceIsWorkingGamut: false, sourceIntentApplied: false };
  }

  const { device, pipelineCache, bufferRing, texturePool } = ctx;
  // Does the ORIGINAL asset already hold linear light? Threaded into the
  // bake/filter so neither decodes twice.
  const assetIsLinear = isSourceLinear(layer);

  // ① Bake adjustments first (skipped when the layer has none — then the bake
  // would be a pure copy, so we hand the asset straight to the filter).
  let filterInput = asset;
  // The bake ALWAYS outputs linear light (it decodes on sample), so once it
  // runs the filter must not decode again. Without a bake the filter faces the raw
  // asset and inherits its domain.
  let filterInputIsLinear = assetIsLinear;
  // ONLY the AdjustPre bake performs the source→working gamut
  // alignment (it is the first sample of the raw asset). Without a bake, the filter
  // input is still in the SOURCE gamut — the composite/blend does the conversion —
  // so this stays false. (A per-pixel linear matrix commutes with the convolution,
  // so deferring it past FilterPass to the compositor is mathematically exact.)
  let filterInputIsWorkingGamut = false;
  // RAW Route B ③: ONLY the AdjustPre bake applies the render-intent tone-map (it
  // is the raw asset's first sample). Without a bake the intent is still un-applied,
  // so the composite/blend must apply it — mirrors filterInputIsWorkingGamut. (The
  // tone-map is non-linear so it does NOT commute with the convolution; running it
  // in the bake, before FilterPass, matches how adjustments are baked pre-filter.)
  let filterInputIntentApplied = false;
  if (layer.adjustments && layer.adjustments.length > 0) {
    const rawBake = texturePool.acquire({
      width: asset.width,
      height: asset.height,
      format: workingFormat,
      // A render target that the compute pass then SAMPLES.
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      label: `AdjustPre Bake (${layer.id})`,
    });
    scratch.push(rawBake);
    const bake = new LayerTexture({
      texture: rawBake,
      width: asset.width,
      height: asset.height,
      allocatedWidth: snapToPowerOfTwo(asset.width),
      allocatedHeight: snapToPowerOfTwo(asset.height),
      format: workingFormat,
    });

    const bakePass = encoder.beginRenderPass({
      label: `Adjust Pre Pass (${layer.id})`,
      colorAttachments: [
        {
          view: bake.texture.createView(),
          clearValue: CLEAR_COLOR,
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    // Viewport is the CONTENT rect: the pooled texture may be larger, and the
    // filter only ever reads [0,width)×[0,height).
    bakePass.setViewport(0, 0, asset.width, asset.height, 0, 1);
    AdjustPrePass.draw(bakePass, {
      device,
      pipelineCache,
      bufferRing,
      targetFormat: workingFormat,
      resolveLutView: ctx.resolveLutView,
      resolveLut3dView: ctx.resolveLut3dView,
    }, { layer, source: asset, sourceIsLinear: assetIsLinear });
    bakePass.end();

    filterInput = bake;
    // The bake wrote linear light into an rgba16float target.
    filterInputIsLinear = true;
    // The bake also aligned the source gamut to the working space.
    filterInputIsWorkingGamut = true;
    // …and applied the render-intent tone-map (RAW Route B ③).
    filterInputIntentApplied = true;
  }

  // ② Convolve + describe the output domain (shared with the vector path).
  return runFilterChain(
    encoder,
    ctx,
    layer,
    filterInput,
    filterInputIsLinear,
    filterInputIsWorkingGamut,
    filterInputIntentApplied,
  );
}

export function prepareFilteredSources(
  encoder: GPUCommandEncoder,
  compiled: CompiledScene,
  ctx: BuildContext,
): Map<string, PreparedSource> {
  const out = new Map<string, PreparedSource>();
  for (const layer of compiled.scene.layers) {
    if (!hasEffectiveFilters(layer)) continue;
    if (layer.source.kind !== 'raster') continue;
    const asset = ctx.assets.get(layer.source.assetId);
    if (!asset) continue;
    out.set(layer.id, resolveLayerSourceTexture(encoder, ctx, layer, asset));
  }
  return out;
}
