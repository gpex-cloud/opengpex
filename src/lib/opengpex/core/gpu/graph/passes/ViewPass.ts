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
 * ViewPass.ts — Maps the composited document texture onto the swapchain
 * (缺陷 5 §5, "Compose-Once, View-Many").
 *
 * Supersedes the old BlitPass. The engine composites all layers ONCE into a
 * document-space texture; this pass replays cheaply every frame, applying the
 * camera (`view_matrix`) + display channel-mask swizzle + `uv_scale` (POT
 * bucket content fraction). Pan/zoom only re-run THIS pass — no re-compositing.
 *
 * 阶段 1a note: `viewMatrix` is the identity full-screen mapping (unit quad →
 * full-screen NDC with Y flip), so the output is pixel-identical to the old 1:1
 * BlitPass. 阶段 1b folds `scene.view.transform` (the camera) into `viewMatrix`.
 *
 * @module core/gpu/graph/passes/ViewPass
 */

import type { LayerTexture } from '../../resources/LayerTexture';
import type { PipelineCache } from '../../resources/PipelineCache';
import type { BufferRing } from '../../resources/BufferRing';
import { channelMaskToUniformValue, type ChannelMaskMode } from '../../shaders/layer';

/**
 * A 2D affine as the 6 meaningful components of a 3×3 (last row [0,0,1]),
 * matching `Mat3` in Scene.ts. Used for `viewMatrix` mapping the unit quad
 * (0..1, document extent) → NDC clip space.
 */
export interface ViewMatrix {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly tx: number;
  readonly ty: number;
}

/**
 * Identity full-screen view matrix: unit quad (0..1) → full-screen NDC (-1..1)
 * with Y flipped (uv.y=0 is top). Equals the hard-coded mapping the old
 * blit.ts vertex stage did: `x*2-1, 1-y*2`. Used verbatim in 阶段 1a to keep
 * output pixel-identical to the previous 1:1 blit.
 */
export const IDENTITY_VIEW_MATRIX: ViewMatrix = {
  a: 2,
  b: 0,
  c: 0,
  d: -2,
  tx: -1,
  ty: 1,
};

/**
 * Compose the unit-quad → NDC view matrix for 阶段 1b (缺陷 5 §5).
 *
 * The composited texture holds the DOCUMENT (canvas space, `docW × docH`); the
 * unit quad (0..1) spans that document extent. To present it we chain:
 *
 *   view_matrix = N(physical→NDC) ∘ M_camera(canvas→physical) ∘ S(unit→canvas)
 *
 *   • S: unit (0..1) → canvas (0..docW, 0..docH)                = scale(docW, docH)
 *   • camera: canvas → swapchain physical pixels                = `scene.view.transform`
 *   • N: physical (0..targetW, 0..targetH) → NDC (-1..1), Y flip = the swapchain map
 *
 * SELF-CONSISTENCY: with `camera = identity` and `docW===targetW`,
 * `docH===targetH` this reduces EXACTLY to {2,0,0,-2,-1,1} = IDENTITY_VIEW_MATRIX,
 * i.e. the 阶段 1a 1:1 present — so 1b is continuous with 1a (see unit test).
 */
export function composeViewMatrix(
  camera: ViewMatrix,
  docW: number,
  docH: number,
  targetW: number,
  targetH: number,
): ViewMatrix {
  const tW = Math.max(1, targetW);
  const tH = Math.max(1, targetH);

  // M1 = camera ∘ scale(docW, docH): unit → physical.
  const m1a = camera.a * docW;
  const m1b = camera.b * docW;
  const m1c = camera.c * docH;
  const m1d = camera.d * docH;
  const m1tx = camera.tx;
  const m1ty = camera.ty;

  // N: physical → NDC. Na = 2/tW, Nd = -2/tH, Ntx = -1, Nty = 1.
  const na = 2 / tW;
  const nd = -2 / tH;

  return {
    a: na * m1a,
    b: nd * m1b,
    c: na * m1c,
    d: nd * m1d,
    tx: na * m1tx - 1,
    ty: nd * m1ty + 1,
  };
}

export interface ViewPassContext {
  readonly device: GPUDevice;
  readonly pipelineCache: PipelineCache;
  readonly bufferRing: BufferRing;
  readonly targetFormat: GPUTextureFormat;
  readonly channelMask?: ChannelMaskMode;
  /** unit quad (document extent) → NDC. Identity full-screen in 阶段 1a. */
  readonly viewMatrix: ViewMatrix;
  /**
   * 缺陷 3 / §3 阶段 3a: screen physical pixels per composited texel — the
   * effectiveScale of the CAMERA (`scene.view.transform`), since 1 composited
   * texel == 1 canvas pixel and the camera maps canvas → physical. ≥1 (magnify,
   * i.e. zoomed in past 100%) → nearest for crisp pixels; <1 (minify) → linear.
   * This is the correct home for the 缺陷 3 sampler choice after compose/view
   * separation: `layer.transform` no longer carries the camera, so the compose
   * passes cannot see the zoom — the view pass must.
   */
  readonly sourceScale?: number;
}

/**
 * Reusable scratch for ViewUniforms (64 bytes): mat3x3 (48) + uv_scale vec2 (8)
 * + channel_mask u32 (4) + pad (4). Column-major, each mat column padded to 16.
 */
const viewUniformData = new ArrayBuffer(64);
const viewUniformF32 = new Float32Array(viewUniformData);
const viewUniformU32 = new Uint32Array(viewUniformData);

export class ViewPass {
  /**
   * Draw the composited source texture onto the active render pass, applying
   * the view matrix, uv_scale and channel-mask swizzle.
   */
  static draw(
    passEncoder: GPURenderPassEncoder,
    ctx: ViewPassContext,
    sourceTexture: LayerTexture,
  ): void {
    const m = ctx.viewMatrix;

    // Pack column-major mat3x3<f32>, each column a vec3 padded to 16 bytes:
    //   col0 = (a, b, 0), col1 = (c, d, 0), col2 = (tx, ty, 1)
    viewUniformF32[0] = m.a;
    viewUniformF32[1] = m.b;
    viewUniformF32[2] = 0;
    viewUniformF32[3] = 0;
    viewUniformF32[4] = m.c;
    viewUniformF32[5] = m.d;
    viewUniformF32[6] = 0;
    viewUniformF32[7] = 0;
    viewUniformF32[8] = m.tx;
    viewUniformF32[9] = m.ty;
    viewUniformF32[10] = 1;
    viewUniformF32[11] = 0;

    // uv_scale (floats 12..13): sample only the content sub-rect of the
    // POT-bucketed composited texture (§6.2), not the whole allocation.
    viewUniformF32[12] = sourceTexture.maxU;
    viewUniformF32[13] = sourceTexture.maxV;
    // channel_mask (u32 slot 14), pad (u32 slot 15)
    viewUniformU32[14] = channelMaskToUniformValue(ctx.channelMask ?? 'rgb');
    viewUniformU32[15] = 0;

    const slot = ctx.bufferRing.writeSlot(viewUniformF32);

    const bindGroup = ctx.device.createBindGroup({
      label: 'View BindGroup',
      layout: ctx.pipelineCache.getViewBindGroupLayout(),
      entries: [
        {
          binding: 0,
          resource: { buffer: ctx.bufferRing.getBuffer(), offset: 0, size: 64 },
        },
        {
          binding: 1,
          // 缺陷 3 / §3 阶段 3a: nearest when zoomed in (crisp pixels), linear
          // when zoomed out (minify → avoid moiré/shimmer). Falls back to linear
          // when sourceScale is unknown (test/legacy callers).
          resource:
            ctx.sourceScale !== undefined
              ? ctx.pipelineCache.getSamplerForScale(ctx.sourceScale)
              : ctx.pipelineCache.getLinearSampler(),
        },
        {
          binding: 2,
          resource: sourceTexture.view,
        },
      ],
    });

    passEncoder.setPipeline(ctx.pipelineCache.getViewPipeline(ctx.targetFormat));
    passEncoder.setVertexBuffer(0, ctx.pipelineCache.getQuadVertexBuffer());
    passEncoder.setBindGroup(0, bindGroup, [slot.offset]);
    passEncoder.draw(6);
  }
}
