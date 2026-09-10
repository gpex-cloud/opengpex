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
 * BlendPass.ts — Executes a non-separable ping-pong blend pass (spec §7.2, §8.3).
 *
 * Samples the accumulated background (bg_tex) and foreground layer (fg_tex),
 * computes W3C blend math in shader, and outputs directly into the destination texture.
 *
 * @module core/gpu/graph/passes/BlendPass
 */

import type { LayerNode } from '../../scene/Scene';
import type { LayerTexture } from '../../resources/LayerTexture';
import type { PipelineCache } from '../../resources/PipelineCache';
import type { BufferRing } from '../../resources/BufferRing';
import { BLEND_MODE_MAP } from '../../shaders/blend';
import { packLayerUniforms } from './CompositePass';
import { resolveLayerGeometry, effectiveScale } from './layerGeometry';
import {
  LAYER_FLAG_HAS_MASK,
  LAYER_FLAG_CLIP,
  LAYER_FLAG_HARD_MASK,
  type ChannelMaskMode,
} from '../../shaders/layer';

export interface BlendPassContext {
  readonly device: GPUDevice;
  readonly pipelineCache: PipelineCache;
  readonly bufferRing: BufferRing;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly targetFormat: GPUTextureFormat;
  readonly channelMask?: ChannelMaskMode;
}

export interface DrawBlendParams {
  readonly layer: LayerNode;
  readonly fgTexture: LayerTexture;
  readonly bgTexture: LayerTexture;
  readonly maskTexture?: LayerTexture;
}

/**
 * Reusable Float32Array / Uint32Array views for packing BlendUniforms (80 bytes).
 */
const blendUniformData = new Float32Array(20);
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
    const { layer, fgTexture, bgTexture, maskTexture } = params;

    let flags = 0;
    if (maskTexture) flags |= LAYER_FLAG_HAS_MASK;
    if (layer.clip) flags |= LAYER_FLAG_CLIP;
    if (layer.mask?.hard) flags |= LAYER_FLAG_HARD_MASK;

    const blendModeIndex = BLEND_MODE_MAP[layer.blendMode] ?? 0;

    const { contentWidth, contentHeight, localOffset, uvRect } = resolveLayerGeometry(
      layer,
      fgTexture.width,
      fgTexture.height,
      layer.dprScale ?? 1,
    );

    // Pack uv_rect / opacity / blend_mode / flags / channel_mask at their fixed
    // offsets (12..19). The transform slot (0..11) is OVERWRITTEN below with the
    // inverse placement matrix — packLayerUniforms would put the local→NDC matrix
    // there, but §7.5's full-frame blend quad needs the opposite mapping.
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
      ctx.channelMask ?? 'rgb',
      blendModeIndex,
      uvRect,
      localOffset,
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

    const det = aPrime * dPrime - cPrime * bPrime;
    if (Math.abs(det) > 1e-12) {
      const inv = 1 / det;
      const ia = dPrime * inv;
      const ib = -bPrime * inv;
      const ic = -cPrime * inv;
      const id = aPrime * inv;
      const itx = -(ia * txp + ic * typ);
      const ity = -(ib * txp + id * typ);

      // Column-major std140 mat3x3 (cols 0..2, each padded to 16 bytes):
      // col0 = (ia, ib, 0), col1 = (ic, id, 0), col2 = (itx, ity, 1)
      blendUniformData[0] = ia;
      blendUniformData[1] = ib;
      blendUniformData[2] = 0;
      blendUniformData[3] = 0;
      blendUniformData[4] = ic;
      blendUniformData[5] = id;
      blendUniformData[6] = 0;
      blendUniformData[7] = 0;
      blendUniformData[8] = itx;
      blendUniformData[9] = ity;
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
            size: 80,
          },
        },
        {
          binding: 1,
          // 缺陷 3 / §3: sampler for fg_tex — nearest when the layer magnifies its
          // source within the document, linear when it minifies (bg_tex uses
          // textureLoad, no sampler). 阶段 1b: this is the SOURCE→DOCUMENT scale;
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
      ],
    });

    // Set pipeline, vertex buffer, dynamic bind group and draw
    passEncoder.setPipeline(ctx.pipelineCache.getBlendPipeline(ctx.targetFormat));
    passEncoder.setVertexBuffer(0, ctx.pipelineCache.getQuadVertexBuffer());
    passEncoder.setBindGroup(0, bindGroup, [slot.offset]);
    passEncoder.draw(6, 1, 0, 0);
  }
}
