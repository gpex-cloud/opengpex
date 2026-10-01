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
 * BlendPass.ts — Executes a non-separable ping-pong blend pass.
 *
 * Samples the accumulated background (bg_tex) and foreground layer (fg_tex),
 * computes W3C blend math in shader, and outputs directly into the destination texture.
 *
 * @module core/gpu/graph/composite/BlendPass
 */

import type { LayerNode } from '../../scene/Scene';
import type { LayerTexture } from '@opengpex/editor/core/engine/gpu/resources/LayerTexture';
import type { PipelineCache } from '@opengpex/editor/core/engine/gpu/resources/PipelineCache';
import type { BufferRing } from '@opengpex/editor/core/engine/gpu/resources/BufferRing';
import { BLEND_MODE_MAP, BLEND_UNIFORM_BUFFER_SIZE } from '@opengpex/editor/core/engine/gpu/shaders/blend';
import { packLayerUniforms } from './CompositePass';
import { resolveAdjustBindGroup as resolveAdjust } from '../support/adjustBindGroup';
import { resolveLayerGeometry, effectiveScale } from '../support/layerGeometry';
import { resolveVmaskUniform } from '../support/vmaskUniform';
import {
  LAYER_FLAG_HAS_MASK,
  LAYER_FLAG_CLIP,
  LAYER_FLAG_HARD_MASK,
  LAYER_FLAG_SOURCE_LINEAR,
  LAYER_FLAG_HAS_BMASK_INVERTED,
  LAYER_GAMUT_SHIFT,
  LAYER_RENDER_INTENT_SHIFT,
} from '@opengpex/editor/core/engine/gpu/shaders/layer';
import { isSourceLinear } from '../support/sourceDomain';
import { resolveSourceGamutId } from '../support/sourceGamut';
import { resolveSourceRenderIntent } from '../support/sourceIntent';
import type { ExportViewport } from '../RenderGraph';

export interface BlendPassContext {
  readonly device: GPUDevice;
  readonly pipelineCache: PipelineCache;
  readonly bufferRing: BufferRing;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly targetFormat: GPUTextureFormat;
  /** Resolve a resident curves/levels 1D LUT view by lutId. */
  readonly resolveLutView?: (lutId: string) => GPUTextureView | undefined;
  /** Resolve a resident 3D `.cube` LUT view by lutId. */
  readonly resolveLut3dView?: (lutId: string) => GPUTextureView | undefined;
  /** Optional export viewport & destination size. */
  readonly exportViewport?: ExportViewport;
}

export interface DrawBlendParams {
  readonly layer: LayerNode;
  readonly fgTexture: LayerTexture;
  readonly bgTexture: LayerTexture;
  readonly maskTexture?: LayerTexture;
  /** Polygon-baked vmask coverage texture (analytic/none → default white). */
  readonly vmaskTexture?: LayerTexture;
  /**
   * Force the identity group-1 adjust bind group because `fgTexture` ALREADY has the
   * layer's adjustments baked in (AdjustPrePass → FilterPass path).
   */
  readonly suppressAdjust?: boolean;
  /**
   * The `fgTexture` already holds LINEAR light because the pipeline produced it
   * (`AdjustPrePass` bake and/or `FilterPass` output), regardless of the original
   * asset's encoding. Overrides `layer.source.trc`; see `sourceDomain.ts`.
   *
   * ⚠️ Only the FOREGROUND is ever converted. `bgTexture` is the rgba16float
   * accumulator and is ALWAYS linear — `blend.wgsl` never decodes it.
   */
  readonly sourceIsLinear?: boolean;
  /**
   * The `fgTexture` already holds WORKING-gamut pixels (pipeline transient), so the
   * shader must NOT apply a source→working gamut matrix. Overrides
   * `layer.source.gamut`; see `sourceGamut.ts`.
   *
   * ⚠️ Only the FOREGROUND is ever converted. `bgTexture` is the rgba16float
   * accumulator and is ALWAYS in the working gamut — `blend.wgsl` never converts it.
   */
  readonly sourceIsWorkingGamut?: boolean;
  /**
   * The `fgTexture` already had its rendering-intent tone-map applied (the
   * `AdjustPrePass` bake owns it), so `blend.wgsl` must NOT re-apply it. Overrides
   * `layer.source.renderIntent`; see `sourceIntent.ts` (RAW Route B constraint A).
   *
   * ⚠️ Only the FOREGROUND is ever tone-mapped. `bgTexture` is the accumulator and
   * carries no intent — `blend.wgsl` never tone-maps it.
   */
  readonly sourceIntentApplied?: boolean;
}

/**
 * Reusable Float32Array / Uint32Array views for packing BlendUniforms (80 bytes).
 */
const blendUniformData = new Float32Array(BLEND_UNIFORM_BUFFER_SIZE / 4);
const blendUniformUintView = new Uint32Array(blendUniformData.buffer);

export class BlendPass {
  /**
   * Draw a layer using the 16-mode ping-pong blend shader.
   */
  static drawLayer(
    passEncoder: GPURenderPassEncoder,
    ctx: BlendPassContext,
    params: DrawBlendParams,
  ): void {
    const { layer, fgTexture, bgTexture, maskTexture, vmaskTexture } = params;

    let flags = 0;
    if (maskTexture) flags |= LAYER_FLAG_HAS_MASK;
    if (layer.clip) flags |= LAYER_FLAG_CLIP;
    if (layer.bmask?.hard) flags |= LAYER_FLAG_HARD_MASK;
    // Same shared decision as CompositePass, so
    // an inverted bmask cannot render correctly under one blend mode and wrongly
    // under another.
    if (layer.bmask?.inverted) flags |= LAYER_FLAG_HAS_BMASK_INVERTED;
    // Same shared decision as CompositePass, so a layer cannot change
    // appearance merely by switching between a class-A and class-B blend mode.
    if (isSourceLinear(layer, params.sourceIsLinear)) flags |= LAYER_FLAG_SOURCE_LINEAR;
    // Same shared gamut decision as CompositePass — only the
    // foreground is converted; the bg accumulator is already the working gamut.
    const gamutId = resolveSourceGamutId(layer, params.sourceIsWorkingGamut);
    flags |= (gamutId << LAYER_GAMUT_SHIFT);
    // Same shared intent decision as CompositePass, so a layer
    // cannot change appearance by switching between a class-A and class-B blend
    // mode. A bake-tone-mapped transient passes sourceIntentApplied → 0.
    const renderIntent = resolveSourceRenderIntent(layer, params.sourceIntentApplied);
    flags |= (renderIntent << LAYER_RENDER_INTENT_SHIFT);

    const blendModeIndex = BLEND_MODE_MAP[layer.blendMode] ?? 0;

    const { contentWidth, contentHeight, localOffset, uvRect } = resolveLayerGeometry(
      layer,
      fgTexture.width,
      fgTexture.height,
      layer.dprScale ?? 1,
    );

    // ⚠️ POT-BUCKET UV FIX: same rationale as CompositePass — scale content-relative
    // UVs into physical-texture space for POT-bucketed pool textures.
    const physicalUvRect: readonly [number, number, number, number] = [
      uvRect[0] * fgTexture.maxU,
      uvRect[1] * fgTexture.maxV,
      uvRect[2] * fgTexture.maxU,
      uvRect[3] * fgTexture.maxV,
    ];

    // Resolve vmask uniform triple (shared with CompositePass). Packed at
    // slots 19..27; the transform overwrite below only touches slots 0..11, so the
    // vmask fields survive untouched.
    const vmaskU = resolveVmaskUniform(layer.vmask, contentWidth, contentHeight, !!vmaskTexture);

    // Pack uv_rect / opacity / blend_mode / flags at their fixed offsets
    // (12..18) plus vmask (19..27); slot 0..11 is OVERWRITTEN below with the
    // inverse placement matrix — packLayerUniforms would put the local→NDC matrix
    // there, but the full-frame blend quad needs the opposite mapping.
    packLayerUniforms(
      blendUniformData,
      blendUniformUintView,
      layer.transform,
      contentWidth,
      contentHeight,
      ctx.frameWidth,
      ctx.frameHeight,
      layer.opacity,
      flags,
      blendModeIndex,
      physicalUvRect,
      localOffset,
      undefined,
      vmaskU.flags,
      vmaskU.rect,
      vmaskU.feather,
    );

    // ── Overwrite slots 0..11 with fg_frame_to_local = inverse of the forward
    // placement (foreground-local unit quad -> frame-pixel coordinate) ──
    //
    // Forward affine M (matches packLayerUniforms' linear part, minus the NDC
    // scale): frame_px = M · [ux, uy, 1] where
    //   aPrime = a·cw   cPrime = c·ch   txp = a·ox + c·oy + tx
    //   bPrime = b·cw   dPrime = d·ch   typ = b·ox + d·oy + ty
    // The blend shader multiplies fg_frame_to_local · [frame_px, 1] to recover
    // (ux, uy); pixels landing outside 0..1 are treated as no-coverage so the
    // background passes through untouched (no copyTextureToTexture needed).
    const t = layer.transform;
    const ox = localOffset[0];
    const oy = localOffset[1];
    const aPrime = t.a * contentWidth;
    const bPrime = t.b * contentWidth;
    const cPrime = t.c * contentHeight;
    const dPrime = t.d * contentHeight;
    const txp = t.a * ox + t.c * oy + t.tx;
    const typ = t.b * ox + t.d * oy + t.ty;

    const ev = ctx.exportViewport;
    const srcX = ev?.sourceRect ? ev.sourceRect[0] : 0;
    const srcY = ev?.sourceRect ? ev.sourceRect[1] : 0;
    const srcW = ev?.sourceRect ? ev.sourceRect[2] : ctx.frameWidth;
    const srcH = ev?.sourceRect ? ev.sourceRect[3] : ctx.frameHeight;
    const targetW = ev?.targetWidth ?? ctx.frameWidth;
    const targetH = ev?.targetHeight ?? ctx.frameHeight;
    const sxScale = srcW / Math.max(1, targetW);
    const syScale = srcH / Math.max(1, targetH);

    const det = aPrime * dPrime - cPrime * bPrime;
    if (Math.abs(det) > 1e-12) {
      const inv = 1 / det;
      const ia = dPrime * inv;
      const ib = -bPrime * inv;
      const ic = -cPrime * inv;
      const id = aPrime * inv;
      const itx = -(ia * txp + ic * typ);
      const ity = -(ib * txp + id * typ);

      // Composite transform Total_Inv = M^(-1) · S:
      // Maps framebuffer position (target_px) -> world_px -> layer unit quad (0..1)
      blendUniformData[0] = ia * sxScale;
      blendUniformData[1] = ib * sxScale;
      blendUniformData[2] = 0;
      blendUniformData[3] = 0;
      blendUniformData[4] = ic * syScale;
      blendUniformData[5] = id * syScale;
      blendUniformData[6] = 0;
      blendUniformData[7] = 0;
      blendUniformData[8] = ia * srcX + ic * srcY + itx;
      blendUniformData[9] = ib * srcX + id * srcY + ity;
      blendUniformData[10] = 1;
      blendUniformData[11] = 0;
    } else {
      // Degenerate (zero-area) placement: map every frame pixel far outside the
      // unit rect so coverage is 0 everywhere and the background is preserved.
      blendUniformData[0] = 0;
      blendUniformData[1] = 0;
      blendUniformData[2] = 0;
      blendUniformData[3] = 0;
      blendUniformData[4] = 0;
      blendUniformData[5] = 0;
      blendUniformData[6] = 0;
      blendUniformData[7] = 0;
      blendUniformData[8] = -1;
      blendUniformData[9] = -1;
      blendUniformData[10] = 1;
      blendUniformData[11] = 0;
    }

    // Write to BufferRing with dynamic offset
    const slot = ctx.bufferRing.writeSlot(blendUniformData);

    // Build BindGroup for the blend shader
    const bindGroup = ctx.device.createBindGroup({
      label: `Blend BindGroup (${layer.id} / ${layer.blendMode})`,
      layout: ctx.pipelineCache.getBlendBindGroupLayout(),
      entries: [
        {
          binding: 0,
          resource: {
            buffer: ctx.bufferRing.getBuffer(),
            offset: 0,
            size: BLEND_UNIFORM_BUFFER_SIZE,
          },
        },
        {
          binding: 1,
          // Sampler for fg_tex — nearest when the layer magnifies its
          // source within the document, linear when it minifies (bg_tex uses
          // textureLoad, no sampler). Note: this is the SOURCE→DOCUMENT scale;
          // the camera zoom is handled at the view pass, not here.
          resource: ctx.pipelineCache.getSamplerForScale(effectiveScale(layer.transform)),
        },
        {
          binding: 2,
          resource: fgTexture.texture.createView(),
        },
        {
          binding: 3,
          resource: bgTexture.texture.createView(),
        },
        {
          binding: 4,
          resource: maskTexture
            ? maskTexture.texture.createView()
            : ctx.pipelineCache.getDefaultMaskView(),
        },
        {
          // Vmask slot (binding 5). Polygon → baked coverage texture;
          // analytic/none → 1×1 default white (unread unless HAS_VMASK_TEX bit set).
          binding: 5,
          resource: vmaskTexture
            ? vmaskTexture.texture.createView()
            : ctx.pipelineCache.getDefaultMaskView(),
        },
      ],
    });

    // Set pipeline, vertex buffer, dynamic bind group and draw
    passEncoder.setPipeline(ctx.pipelineCache.getBlendPipeline(ctx.targetFormat));
    passEncoder.setVertexBuffer(0, ctx.pipelineCache.getQuadVertexBuffer());
    passEncoder.setBindGroup(0, bindGroup, [slot.offset]);

    // Group 1: per-layer colour adjustments, applied to the un-premultiplied
    // foreground before blend. Identity layers bind the shared flags=0 group;
    // `suppressAdjust` also forces it when the grade was already baked upstream.
    const adjust = resolveAdjust(
      {
        device: ctx.device,
        pipelineCache: ctx.pipelineCache,
        bufferRing: ctx.bufferRing,
        resolveLutView: ctx.resolveLutView,
        resolveLut3dView: ctx.resolveLut3dView,
      },
      layer,
      params.suppressAdjust,
    );
    passEncoder.setBindGroup(1, adjust.bindGroup, [adjust.offset]);

    passEncoder.draw(6, 1, 0, 0);
  }
}
