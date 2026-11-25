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
 * prepareFilteredSources.ts — THE per-layer draw-source resolution: every
 * pixel-carrying layer (raster / solid) passes through this chain, and the
 * map it returns is the COMPLETE "what texture does this layer draw from"
 * authority for the frame (vector sources merge their own transients into the
 * same map from `prepareVectorSources`). The chain metaphor: material passes
 * through; a layer declaring filters gets filtered (bake + convolution), a
 * layer without them passes through untouched (resident asset / the solid
 * white binding formality) — no separate fallback pass exists.
 *
 * ⚠️ WHY A PRE-PASS AND NOT INLINE: `FilterPass` records COMPUTE passes, and WebGPU
 * forbids beginning a compute pass while a render pass is still open. `RenderGraph`'s
 * composite branches hold one long-lived render pass across their whole layer loop, so
 * all filter work must be recorded first. This also means the filtered textures are
 * ready for BOTH the pure-separable and the ping-pong branch with one code path.
 *
 * @module core/gpu/graph/build/prepareFilteredSources
 */

import type { LayerNode } from '../../scene/Scene';
import type { CompiledScene } from '../SceneCompiler';
import { snapToPowerOfTwo } from '@opengpex/editor/core/engine/gpu/resources/TexturePool';
import { LayerTexture } from '@opengpex/editor/core/engine/gpu/resources/LayerTexture';
import { GPUTextureUsage } from '@opengpex/editor/core/engine/gpu/constants';
import { AdjustPrePass } from '../composite/AdjustPrePass';
import { hasEffectiveFilters, resolveFilterWindow } from '../composite/FilterPass';
import { isSourceLinear } from '../support/sourceDomain';
import { runFilterChain } from './runFilterChain';
import type { AdjustCoverageBinding } from '../support/adjustBindGroup';
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
  adjustCoverageSources: Map<string, AdjustCoverageBinding>,
  /**
   * DECLARATIVE SOLID colour (working-LINEAR straight alpha) — present only
   * for `{kind:'solid'}` layers, which carry NO resident asset: the bound
   * texture is the shared 1×1 white formality and the AdjustPrePass bake
   * writes the uniform colour instead, producing the straight working-LINEAR
   * constant a following FilterPass consumes (same 1×1 shape the retired
   * solid-bytes path fed the convolution).
   */
  solidColor?: readonly [number, number, number, number],
): PreparedSource {
  const { workingFormat, scratch } = ctx;
  if (!hasEffectiveFilters(layer)) {
    // No pipeline-produced transient: the domain is whatever the ASSET declares.
    // (A solid layer never reaches the inline path with a colour-bearing asset —
    // the compositor reads the uniform; the texture arg is the white formality.)
    // The content rect follows the fragment model, which THIS stage owns as the
    // single source of truth: a logical fragment shares the source asset and its
    // visible content is the crop sub-rect (`crop · dpr` in asset texels —
    // `clipToLogicalLayer` keeps `visibleShape.rect` in the source frame), while
    // every layer owning its own asset (full rasters, physical trimmed products)
    // is content-aligned with the full texture. The effect prepass consumes this
    // declared rect verbatim and never re-derives crop semantics itself.
    const dpr = layer.dprScale && layer.dprScale > 0 ? layer.dprScale : 1;
    const contentRectInTexture = solidColor
      ? undefined
      : layer.crop
        ? { x: layer.crop.x * dpr, y: layer.crop.y * dpr, w: layer.crop.w * dpr, h: layer.crop.h * dpr }
        : { x: 0, y: 0, w: asset.width, h: asset.height };
    return { texture: asset, suppressAdjust: false, sourceIsLinear: false, sourceIsWorkingGamut: false, sourceIntentApplied: false, contentRectInTexture };
  }

  const { device, pipelineCache, bufferRing, texturePool } = ctx;
  // Does the ORIGINAL asset already hold linear light? Threaded into the
  // bake/filter so neither decodes twice. A solid declaration is ALWAYS linear.
  const assetIsLinear = solidColor !== undefined || isSourceLinear(layer);

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
  // ONLY the AdjustPre bake applies the render-intent tone-map (it
  // is the raw asset's first sample). Without a bake the intent is still un-applied,
  // so the composite/blend must apply it — mirrors filterInputIsWorkingGamut. (The
  // tone-map is non-linear so it does NOT commute with the convolution; running it
  // in the bake, before FilterPass, matches how adjustments are baked pre-filter.)
  let filterInputIntentApplied = false;
  if (layer.adjustStages && layer.adjustStages.length > 0) {
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
    // Coverage mapping: the coverage array is baked over the layer's CONTENT
    // rect (logical px), this pass samples the RAW asset (physical px) —
    // scale the content rect through dprScale into asset px. A cropped
    // fragment shares its source asset, so without this the coverage would
    // misalign by the crop origin. Undefined crop → no override (identity
    // mapping in the shader).
    const coverage = adjustCoverageSources.get(layer.id);
    let adjRect: { cropX: number; cropY: number; contentW: number; contentH: number } | undefined;
    if (coverage && layer.crop) {
      const dpr = layer.dprScale ?? 1;
      adjRect = {
        cropX: layer.crop.x * dpr,
        cropY: layer.crop.y * dpr,
        contentW: (layer.width ?? asset.width) * dpr,
        contentH: (layer.height ?? asset.height) * dpr,
      };
    }
    AdjustPrePass.draw(bakePass, {
      device,
      pipelineCache,
      bufferRing,
      targetFormat: workingFormat,
      resolveLutView: ctx.resolveLutView,
      resolveLut3dView: ctx.resolveLut3dView,
    }, { layer, source: asset, sourceIsLinear: assetIsLinear, adjustCoverage: coverage, adjRect, solidColor });
    bakePass.end();

    filterInput = bake;
    // The bake wrote linear light into an rgba16float target.
    filterInputIsLinear = true;
    // The bake also aligned the source gamut to the working space.
    filterInputIsWorkingGamut = true;
    // …and applied the render-intent tone-map.
    filterInputIntentApplied = true;
  }

  // ② Convolve + describe the output domain (shared with the vector path).
  // Window the convolution to crop ∪ kernel reach so a cropped fragment
  // never pays for its shared source asset's full extent.
  const window = resolveFilterWindow(layer, asset.width, asset.height) ?? undefined;
  return runFilterChain(
    encoder,
    ctx,
    layer,
    filterInput,
    filterInputIsLinear,
    filterInputIsWorkingGamut,
    filterInputIntentApplied,
    undefined,
    window,
  );
}

export function prepareFilteredSources(
  encoder: GPUCommandEncoder,
  compiled: CompiledScene,
  ctx: BuildContext,
  adjustCoverageSources: Map<string, AdjustCoverageBinding> = new Map(),
): Map<string, PreparedSource> {
  const out = new Map<string, PreparedSource>();
  for (const layer of compiled.scene.layers) {
    // The chain serves the two pixel-handle arms; vector sources materialize
    // in their own prepass (prepareVectorSources) and merge into the same map.
    const solidColor = layer.source.kind === 'solid' ? layer.source.color : undefined;
    if (layer.source.kind !== 'raster' && !solidColor) continue;
    const asset = solidColor
      ? ctx.pipelineCache.getSolidPixelTexture()
      : layer.source.kind === 'raster'
        ? ctx.assets.get(layer.source.assetId)
        : undefined;
    if (!asset) continue; // raster asset not resident yet — layer skips this frame
    const prepared = resolveLayerSourceTexture(encoder, ctx, layer, asset, adjustCoverageSources, solidColor);
    // An UNFILTERED solid passes through the chain untouched — its colour
    // rides the uniform tail vec4, so the compositor must take the uniform
    // path (the texture is just the binding formality). Stamped here, at the
    // point where "materialized vs uniform" is decided, instead of being
    // re-derived at every draw site.
    if (solidColor && !prepared.suppressAdjust) {
      prepared.solidUniform = true;
    }
    out.set(layer.id, prepared);
  }
  return out;
}
