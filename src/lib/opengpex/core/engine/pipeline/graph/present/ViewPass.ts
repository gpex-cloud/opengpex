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
 * ("Compose-Once, View-Many").
 *
 * Supersedes the old BlitPass. The engine composites all layers ONCE into a
 * document-space texture; this pass replays cheaply every frame, applying the
 * camera (`view_matrix`) + display channel-mask swizzle + `uv_scale` (POT
 * bucket content fraction). Pan/zoom only re-run THIS pass — no re-compositing.
 *
 * Note: `viewMatrix` maps the unit quad to full-screen NDC with Y flip,
 * pixel-identical to the 1:1 BlitPass, while camera integration folds
 * `scene.view.transform` into `viewMatrix`.
 *
 * @module core/gpu/graph/present/ViewPass
 */

import type { LayerTexture } from '@opengpex/editor/core/engine/gpu/resources/LayerTexture';
import type { PipelineCache } from '@opengpex/editor/core/engine/gpu/resources/PipelineCache';
import type { BufferRing } from '@opengpex/editor/core/engine/gpu/resources/BufferRing';
import { CHANNEL_MASK_RGB, type SceneChannelMask } from '../../scene/Scene';
import type { PresentGainMap } from '../support/gainPresenter';

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
 * blit.ts vertex stage did: `x*2-1, 1-y*2`. Used verbatim to keep
 * output pixel-identical to the 1:1 blit.
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
 * Compose the unit-quad → NDC view matrix.
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
 * `origin` (ROI channel) optionally folds a DOCUMENT-space
 * translation in front of the camera:
 *
 *   view_matrix = N ∘ (camera ∘ T(origin)) ∘ S(docW, docH)
 *
 * i.e. the texture's texel (0,0) sits at document coordinate `origin` and the
 * quad spans `origin .. origin+(docW,docH)` — a SUB-RECTANGLE of the document
 * (the roi composite). `origin` is in DOCUMENT PIXELS, not texels (the two
 * differ by the composite density), and is unrelated to the ants'
 * `gridOffset` phase. Omitting it (0,0) reproduces the full-document mapping
 * EXACTLY — the full channel never passes it.
 *
 * SELF-CONSISTENCY: with `camera = identity` and `docW===targetW`,
 * `docH===targetH` this reduces EXACTLY to {2,0,0,-2,-1,1} = IDENTITY_VIEW_MATRIX,
 * i.e. the 1:1 present (see unit test).
 */
export function composeViewMatrix(
  camera: ViewMatrix,
  docW: number,
  docH: number,
  targetW: number,
  targetH: number,
  origin?: { readonly x: number; readonly y: number },
): ViewMatrix {
  const tW = Math.max(1, targetW);
  const tH = Math.max(1, targetH);
  const ox = origin?.x ?? 0;
  const oy = origin?.y ?? 0;

  // M1 = camera ∘ translate(origin) ∘ scale(docW, docH): unit → physical.
  // The affine composition pre-multiplies the origin into the camera's
  // translation column: p ↦ camera(origin + scale·p).
  const m1a = camera.a * docW;
  const m1b = camera.b * docW;
  const m1c = camera.c * docH;
  const m1d = camera.d * docH;
  const m1tx = camera.a * ox + camera.c * oy + camera.tx;
  const m1ty = camera.b * ox + camera.d * oy + camera.ty;

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
  /**
   * HDR presentation variant — MUST agree with `targetFormat` (SDR pairs
   * `bgra8unorm` with the clamped fragment; HDR pairs `rgba16float` with the
   * unclamped-tail fragment — both encode in-shader, see `view.ts`).
   * Defaults to false (the SDR contract).
   */
  readonly hdr?: boolean;
  readonly channelMask?: SceneChannelMask;
  /** unit quad (document extent) → NDC. Identity full-screen by default. */
  readonly viewMatrix: ViewMatrix;
  /**
   * Screen physical pixels per composited texel — the
   * effectiveScale of the CAMERA (`scene.view.transform`), since 1 composited
   * texel == 1 canvas pixel and the camera maps canvas → physical. ≥1 (magnify,
   * i.e. zoomed in past 100%) → nearest for crisp pixels; <1 (minify) → linear.
   * This is the correct home for the magnification/minification sampler choice after compose/view
   * separation: `layer.transform` no longer carries the camera, so the compose
   * passes cannot see the zoom — the view pass must.
   */
  readonly sourceScale?: number;
  /**
   * The single-source gain map to apply in the HDR pipeline variant
   * (`view.ts`): texture + the ISO 21496-1 parameters + the document-normalized
   * uv rect this composite texture covers. Omitted (or `hdr` false) presents
   * the authoritative SDR base — the shader's `gain_enabled` stays 0 and the
   * 1×1 dummy rides binding 3.
   */
  readonly gainMap?: ViewGainMap;
}

/**
 * Everything the HDR fragment needs to reconstruct the HDR rendition from the
 * composited SDR base. Built by the engine per present (never cached across
 * frames): the decoded map texture view, the affine decode parameters
 * (`engine/color/gainMap.ts` owns the math), and the uv placement that maps
 * the composite's document extent onto the map (full channel = [0,0]-[1,1];
 * the ROI channel folds its document origin in).
 */
export interface ViewGainMap extends PresentGainMap {
  readonly uvOriginX: number;
  readonly uvOriginY: number;
  readonly uvScaleX: number;
  readonly uvScaleY: number;
}

/**
 * Reusable scratch for ViewUniforms (96 bytes): mat3x3 (48) + uv_scale vec2 (8)
 * + channel_mask u32 (4) + pad (4) + gain params (16) + gain uv placement (16).
 * Column-major, each mat column padded to 16.
 */
const viewUniformData = new ArrayBuffer(96);
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
    // POT-bucketed composited texture, not the whole allocation.
    viewUniformF32[12] = sourceTexture.maxU;
    viewUniformF32[13] = sourceTexture.maxV;
    // channel_mask (u32 slot 14), pad (u32 slot 15). The mask is a 4-bit
    // visibility field consumed directly by view.wgsl's Photoshop rule.
    viewUniformU32[14] = ctx.channelMask ?? CHANNEL_MASK_RGB;
    viewUniformU32[15] = 0;

    // Gain-map params (floats 16..19 = bytes 64..79) + document uv placement
    // (floats 20..23 = bytes 80..95). `gain_enabled` (u32 slot 19) is set ONLY
    // for the HDR variant with an eligible, decoded map — every other present
    // keeps 0 and the shader multiplies nothing.
    const gain = ctx.hdr ? ctx.gainMap : undefined;
    if (gain) {
      viewUniformF32[16] = gain.gainMin;
      viewUniformF32[17] = gain.gainMax;
      viewUniformF32[18] = gain.gamma;
      viewUniformU32[19] = 1;
      viewUniformF32[20] = gain.uvOriginX;
      viewUniformF32[21] = gain.uvOriginY;
      viewUniformF32[22] = gain.uvScaleX;
      viewUniformF32[23] = gain.uvScaleY;
    } else {
      viewUniformF32[16] = 0;
      viewUniformF32[17] = 0;
      viewUniformF32[18] = 1;
      viewUniformU32[19] = 0;
      viewUniformF32[20] = 0;
      viewUniformF32[21] = 0;
      viewUniformF32[22] = 1;
      viewUniformF32[23] = 1;
    }

    const slot = ctx.bufferRing.writeSlot(viewUniformF32);

    const bindGroup = ctx.device.createBindGroup({
      label: 'View BindGroup',
      layout: ctx.pipelineCache.getViewBindGroupLayout(),
      entries: [
        {
          binding: 0,
          resource: { buffer: ctx.bufferRing.getBuffer(), offset: 0, size: 96 },
        },
        {
          binding: 1,
          // Nearest when zoomed in (crisp pixels), linear
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
        {
          binding: 3,
          resource: gain ? gain.textureView : ctx.pipelineCache.getGainDummyView(),
        },
      ],
    });

    passEncoder.setPipeline(ctx.pipelineCache.getViewPipeline(ctx.targetFormat, ctx.hdr ?? false));
    passEncoder.setVertexBuffer(0, ctx.pipelineCache.getQuadVertexBuffer());
    passEncoder.setBindGroup(0, bindGroup, [slot.offset]);
    passEncoder.draw(6);
  }
}
