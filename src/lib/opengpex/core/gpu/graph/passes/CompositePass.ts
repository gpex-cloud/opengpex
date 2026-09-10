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
 * CompositePass.ts — Layer rendering pass with hardware transform & blend (spec §7.1, §8.1).
 *
 * Computes 2D affine -> NDC projection matrix for each layer quad,
 * uploads uniform parameters through BufferRing, binds textures,
 * and records draw calls on the active GPURenderPassEncoder.
 *
 * @module core/gpu/graph/passes/CompositePass
 */

import type { LayerNode, Mat3 } from '../../scene/Scene';
import type { PipelineCache } from '../../resources/PipelineCache';
import type { BufferRing } from '../../resources/BufferRing';
import type { LayerTexture } from '../../resources/LayerTexture';
import {
  LAYER_UNIFORM_BUFFER_SIZE,
  LAYER_FLAG_HAS_MASK,
  LAYER_FLAG_CLIP,
  LAYER_FLAG_HARD_MASK,
  channelMaskToUniformValue,
  type ChannelMaskMode,
} from '../../shaders/layer';
import { resolveLayerGeometry, effectiveScale } from './layerGeometry';

export interface CompositePassContext {
  readonly device: GPUDevice;
  readonly pipelineCache: PipelineCache;
  readonly bufferRing: BufferRing;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly targetFormat: GPUTextureFormat;
  readonly channelMask?: ChannelMaskMode;
}

export interface DrawLayerParams {
  readonly layer: LayerNode;
  readonly texture: LayerTexture;
  readonly maskTexture?: LayerTexture;
  readonly isBottomOpaque?: boolean;
}

/**
 * Reusable Float32Array / Uint32Array views for packing LayerUniforms (80 bytes).
 *
 * ⚠️ WP-5.6 concurrency note: these are MODULE-LEVEL mutable scratch buffers,
 * shared by every `CompositePass.drawLayer` call. This is safe today because the
 * render path is strictly single-threaded and synchronous — each call fully
 * packs + copies into the BufferRing (`writeSlot`) before the next call runs.
 * If a Worker-driven or async pipeline is ever introduced, convert these to
 * instance-level fields or allocate per-call to avoid cross-call corruption.
 */
const uniformData = new Float32Array(LAYER_UNIFORM_BUFFER_SIZE / 4);
const uniformUintView = new Uint32Array(uniformData.buffer);

/**
 * Compute the 3×3 matrix transforming unit quad (0..1, 0..1) -> NDC clip space,
 * and pack it into std140 uniform buffer column format (48 bytes = 12 floats + padding).
 *
 * Matrix derivation:
 *   local_to_world = transform * translate(localOffset) * scale(contentWidth, contentHeight)
 *   world_to_ndc   = scale(2 / frameW, -2 / frameH) * translate(-frameW / 2, -frameH / 2)
 */
export function packLayerUniforms(
  target: Float32Array,
  targetUint: Uint32Array,
  transform: Mat3,
  contentWidth: number,
  contentHeight: number,
  frameWidth: number,
  frameHeight: number,
  opacity: number,
  flags: number,
  channelMask: ChannelMaskMode = 'rgb',
  blendMode = 0,
  uvRect: readonly [number, number, number, number] = [0, 0, 1, 1],
  localOffset: readonly [number, number] = [0, 0],
): void {
  // sx, sy map world pixels to NDC [-1, 1] with Y pointing UP
  const sx = 2.0 / Math.max(1, frameWidth);
  const sy = -2.0 / Math.max(1, frameHeight);
  const ox = -1.0;
  const oy = 1.0;

  // Local-to-world scaled by content dimensions, offset by localOffset
  const aPrime = transform.a * contentWidth;
  const bPrime = transform.b * contentWidth;
  const cPrime = transform.c * contentHeight;
  const dPrime = transform.d * contentHeight;
  const tx = transform.a * localOffset[0] + transform.c * localOffset[1] + transform.tx;
  const ty = transform.b * localOffset[0] + transform.d * localOffset[1] + transform.ty;

  // Column 0: [sx * a', sy * b', 0, pad]
  target[0] = sx * aPrime;
  target[1] = sy * bPrime;
  target[2] = 0.0;
  target[3] = 0.0;

  // Column 1: [sx * c', sy * d', 0, pad]
  target[4] = sx * cPrime;
  target[5] = sy * dPrime;
  target[6] = 0.0;
  target[7] = 0.0;

  // Column 2: [sx * tx + ox, sy * ty + oy, 1.0, pad]
  target[8] = sx * tx + ox;
  target[9] = sy * ty + oy;
  target[10] = 1.0;
  target[11] = 0.0;

  // uv_rect: vec4<f32> (u0, v0, du, dv) -> 16 bytes at offset 48 (floats 12..15)
  target[12] = uvRect[0];
  target[13] = uvRect[1];
  target[14] = uvRect[2];
  target[15] = uvRect[3];

  // Float 16: opacity (offset 64)
  target[16] = opacity;
  // Uint 17: blend_mode (offset 68)
  targetUint[17] = blendMode;
  // Uint 18: flags (offset 72)
  targetUint[18] = flags;
  // Uint 19: channel_mask (offset 76)
  targetUint[19] = channelMaskToUniformValue(channelMask);
}

export class CompositePass {
  /**
   * Draw a single layer quad onto the active render pass.
   */
  static drawLayer(
    passEncoder: GPURenderPassEncoder,
    ctx: CompositePassContext,
    params: DrawLayerParams,
  ): void {
    const { layer, texture, maskTexture, isBottomOpaque } = params;

    let flags = 0;
    if (maskTexture) flags |= LAYER_FLAG_HAS_MASK;
    if (layer.clip) flags |= LAYER_FLAG_CLIP;
    if (layer.mask?.hard) flags |= LAYER_FLAG_HARD_MASK;

    const { contentWidth, contentHeight, localOffset, uvRect } = resolveLayerGeometry(
      layer,
      texture.width,
      texture.height,
      layer.dprScale ?? 1,
    );

    // 1. Pack uniforms
    packLayerUniforms(
      uniformData,
      uniformUintView,
      layer.transform,
      contentWidth,
      contentHeight,
      ctx.frameWidth,
      ctx.frameHeight,
      layer.opacity,
      flags,
      ctx.channelMask ?? 'rgb',
      0,
      uvRect,
      localOffset,
    );

    // 2. Write to BufferRing with dynamic offset
    const slot = ctx.bufferRing.writeSlot(uniformData);

    // 3. Acquire pipeline for the requested blend mode
    const pipeline = ctx.pipelineCache.getLayerPipeline(
      layer.blendMode,
      ctx.targetFormat,
      isBottomOpaque,
    );

    // 4. Create bind group
    const bindGroup = ctx.device.createBindGroup({
      layout: ctx.pipelineCache.getLayerBindGroupLayout(),
      entries: [
        {
          binding: 0,
          resource: {
            buffer: ctx.bufferRing.getBuffer(),
            offset: 0,
            size: LAYER_UNIFORM_BUFFER_SIZE,
          },
        },
        {
          binding: 1,
          // 缺陷 3 / §3: nearest when the layer magnifies its source WITHIN the
          // document (source texel ≥ 1 document texel), linear when it minifies.
          // 阶段 1b: layer.transform is camera-INDEPENDENT (document space), so this
          // is the SOURCE→DOCUMENT scale only; the CAMERA zoom is handled at the
          // view pass (ViewPass.sourceScale), not here.
          resource: ctx.pipelineCache.getSamplerForScale(effectiveScale(layer.transform)),
        },
        {
          binding: 2,
          resource: texture.view,
        },
        {
          binding: 3,
          resource: maskTexture ? maskTexture.view : ctx.pipelineCache.getDefaultMaskView(),
        },
      ],
      label: `Layer BindGroup (${layer.id})`,
    });

    // 5. Issue draw commands
    passEncoder.setPipeline(pipeline);
    passEncoder.setVertexBuffer(0, ctx.pipelineCache.getQuadVertexBuffer());
    passEncoder.setBindGroup(0, bindGroup, [slot.offset]);
    passEncoder.draw(6);
  }
}
