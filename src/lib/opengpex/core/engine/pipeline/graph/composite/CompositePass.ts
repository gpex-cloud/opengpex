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
 * CompositePass.ts — Layer rendering pass with hardware transform & blend.
 *
 * Computes 2D affine -> NDC projection matrix for each layer quad,
 * uploads uniform parameters through BufferRing, binds textures,
 * and records draw calls on the active GPURenderPassEncoder.
 *
 * @module core/gpu/graph/composite/CompositePass
 */

import type { LayerNode, Mat3 } from '../../scene/Scene';
import type { PipelineCache } from '@opengpex/editor/core/engine/gpu/resources/PipelineCache';
import type { BufferRing } from '@opengpex/editor/core/engine/gpu/resources/BufferRing';
import type { LayerTexture } from '@opengpex/editor/core/engine/gpu/resources/LayerTexture';
import {
  LAYER_UNIFORM_BUFFER_SIZE,
  LAYER_FLAG_HAS_MASK,
  LAYER_FLAG_CLIP,
  LAYER_FLAG_SOURCE_LINEAR,
  LAYER_GAMUT_SHIFT,
  LAYER_RENDER_INTENT_SHIFT,
} from '@opengpex/editor/core/engine/gpu/shaders/layer';
import { resolveAdjustBindGroup as resolveAdjust } from '../support/adjustBindGroup';
import { resolveLayerGeometry, effectiveScale } from '../support/layerGeometry';
import { resolveVmaskUniform } from '../support/vmaskUniform';
import { isSourceLinear } from '../support/sourceDomain';
import { resolveSourceGamutId } from '../support/sourceGamut';
import { resolveSourceRenderIntent } from '../support/sourceIntent';
import type { ExportViewport } from '../RenderGraph';

export interface CompositePassContext {
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

export interface DrawLayerParams {
  readonly layer: LayerNode;
  readonly texture: LayerTexture;
  /**
   * The layer's COMBINED bmask coverage — the texture the bmask combine pass
   * baked from ALL enabled records (each record's hard bit + erase/restore
   * family folded into its red channel). Absent when the layer has no bmask or
   * no record resolved; then the default white view binds and the layer renders
   * unmasked. The retired per-record hard/invert flag bits carry no meaning
   * here — the combined texture IS the final mask.
   */
  readonly maskTexture?: LayerTexture;
  /**
   * The polygon-baked vmask coverage texture for this layer, produced by
   * the fill-pass this frame. Present only for `layer.vmask.kind === 'polygon'`;
   * analytic vmasks solve per-fragment and bind the default white view.
   */
  readonly vmaskTexture?: LayerTexture;
  readonly isBottomOpaque?: boolean;
  /**
   * Force the identity group-1 adjust bind group because `texture` ALREADY has the
   * layer's adjustments baked in (AdjustPrePass → FilterPass path). Prevents
   * applying the grade twice.
   */
  readonly suppressAdjust?: boolean;
  /**
   * The `texture` already holds LINEAR light because the pipeline produced it
   * (`AdjustPrePass` bake and/or `FilterPass` output), regardless of the original
   * asset's encoding. Overrides `layer.source.trc`; see `sourceDomain.ts`.
   */
  readonly sourceIsLinear?: boolean;
  /**
   * The `texture` already holds WORKING-gamut pixels because the pipeline produced
   * it (`AdjustPrePass` bake and/or `FilterPass` output), so the shader must NOT
   * apply a source→working gamut matrix (it would double-convert). Overrides
   * `layer.source.gamut`; see `sourceGamut.ts`.
   */
  readonly sourceIsWorkingGamut?: boolean;
  /**
   * The `texture` already had its rendering-intent tone-map applied because the
   * pipeline produced it (the `AdjustPrePass` bake owns the tone-map), so the shader
   * must NOT re-apply it (it would double-tone-map, crushing contrast). Overrides
   * `layer.source.renderIntent`; see `sourceIntent.ts` (RAW Route B constraint A).
   */
  readonly sourceIntentApplied?: boolean;
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
  blendMode = 0,
  uvRect: readonly [number, number, number, number] = [0, 0, 1, 1],
  localOffset: readonly [number, number] = [0, 0],
  exportViewport?: ExportViewport,
  vmaskFlags = 0,
  vmaskRect: readonly [number, number, number, number] = [0, 0, 0, 0],
  vmaskFeather: readonly [number, number, number, number] = [0, 0, 0, 0],
): void {
  const srcX = exportViewport?.sourceRect ? exportViewport.sourceRect[0] : 0;
  const srcY = exportViewport?.sourceRect ? exportViewport.sourceRect[1] : 0;
  const srcW = exportViewport?.sourceRect ? exportViewport.sourceRect[2] : frameWidth;
  const srcH = exportViewport?.sourceRect ? exportViewport.sourceRect[3] : frameHeight;

  // sx, sy map world pixels to NDC [-1, 1] with Y pointing UP
  const sx = 2.0 / Math.max(1, srcW);
  const sy = -2.0 / Math.max(1, srcH);
  const ox = -1.0 - (2.0 * srcX) / Math.max(1, srcW);
  const oy = 1.0 + (2.0 * srcY) / Math.max(1, srcH);

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
  // Uint 19: vmask_flags (offset 76). A layer with no
  // vmask packs 0 here so the shader's vmask branch is skipped byte-for-byte.
  targetUint[19] = vmaskFlags;

  // vmask_rect: vec4<f32> (cx, cy, halfW, halfH) in layer-local px, offset 80
  // (floats 20..23) — analytic sub-path only; polygon leaves it zero.
  target[20] = vmaskRect[0];
  target[21] = vmaskRect[1];
  target[22] = vmaskRect[2];
  target[23] = vmaskRect[3];

  // vmask_feather: vec4<f32> (featherPx, maskPxW, maskPxH, _reserved), offset 96
  // (floats 24..27). maskPxW/H convert normalized mask_uv → layer-local px in the
  // analytic branch; featherPx is the smoothstep transition width.
  target[24] = vmaskFeather[0];
  target[25] = vmaskFeather[1];
  target[26] = vmaskFeather[2];
  target[27] = vmaskFeather[3];
}

/**
 * Re-exported for backward compatibility. The implementation moved to
 * `adjustBindGroup.ts` when it gained an additional consumer (`AdjustPrePass`)
 * plus 3D-LUT binding and the `suppress` switch — see that module for the
 * behaviour contract.
 */
export { resolveAdjustBindGroup, type ResolveAdjustDeps } from '../support/adjustBindGroup';

export class CompositePass {
  /**
   * Draw a single layer quad onto the active render pass.
   */
  static drawLayer(
    passEncoder: GPURenderPassEncoder,
    ctx: CompositePassContext,
    params: DrawLayerParams,
  ): void {
    const { layer, texture, maskTexture, vmaskTexture, isBottomOpaque } = params;

    let flags = 0;
    if (maskTexture) flags |= LAYER_FLAG_HAS_MASK;
    if (layer.clip) flags |= LAYER_FLAG_CLIP;
    // The retired bmask hard/invert/stack flag bits (3/10/11..17) are gone:
    // the combine pass bakes every record's semantics into the combined mask
    // texture, which the shader plain-multiplies.
    // Tell the shader to SKIP the sRGB→linear decode when this layer's pixels
    // are already linear light — either a genuinely linear source asset, or a
    // filtered/baked transient that the filter chain already converted.
    if (isSourceLinear(layer, params.sourceIsLinear)) flags |= LAYER_FLAG_SOURCE_LINEAR;
    // Pack the source gamut id (0..4) into bits 5..7. 0 = direct
    // (already working gamut, or a pipeline transient the bake already converted).
    const gamutId = resolveSourceGamutId(layer, params.sourceIsWorkingGamut);
    flags |= (gamutId << LAYER_GAMUT_SHIFT);
    // Pack the render intent (0..2) into bits 8..9. A pipeline
    // transient whose bake already tone-mapped passes sourceIntentApplied → 0
    // (constraint A: never double-tone-map).
    const renderIntent = resolveSourceRenderIntent(layer, params.sourceIntentApplied);
    flags |= (renderIntent << LAYER_RENDER_INTENT_SHIFT);

    const { contentWidth, contentHeight, localOffset, uvRect } = resolveLayerGeometry(
      layer,
      texture.width,
      texture.height,
      layer.dprScale ?? 1,
    );

    // ⚠️ POT-BUCKET UV FIX: `resolveLayerGeometry` computes UVs in CONTENT-relative
    // space (i.e. normalised over `texture.width × texture.height`). When the physical
    // GPUTexture is larger than the content (POT-bucketed pool textures from FilterPass
    // or AdjustPrePass), `textureSample` normalises over the ALLOCATED size, so we must
    // scale the UVs by `maxU/maxV` (= content / allocated). For exact-size textures
    // (WebGpuEngine-uploaded assets, maxU=maxV=1) this is a no-op.
    const physicalUvRect: readonly [number, number, number, number] = [
      uvRect[0] * texture.maxU,
      uvRect[1] * texture.maxV,
      uvRect[2] * texture.maxU,
      uvRect[3] * texture.maxV,
    ];

    // Resolve the vmask uniform triple (analytic → SDF params; polygon →
    // just the HAS_TEX bit, invert/hard already baked into vmaskTexture).
    const vmaskU = resolveVmaskUniform(layer.vmask, contentWidth, contentHeight, !!vmaskTexture);

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
      0,
      physicalUvRect,
      localOffset,
      ctx.exportViewport,
      vmaskU.flags,
      vmaskU.rect,
      vmaskU.feather,
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
          // Nearest when the layer magnifies its source WITHIN the
          // document (source texel ≥ 1 document texel), linear when it minifies.
          // Note: layer.transform is camera-INDEPENDENT (document space), so this
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
        {
          // Vmask slot. Polygon → the baked coverage texture; analytic /
          // none → the 1×1 default white view (slot must be valid; unread when
          // vmask_flags has no HAS_VMASK_TEX bit).
          binding: 4,
          resource: vmaskTexture ? vmaskTexture.view : ctx.pipelineCache.getDefaultMaskView(),
        },
      ],
      label: `Layer BindGroup (${layer.id})`,
    });

    // 5. Issue draw commands
    passEncoder.setPipeline(pipeline);
    passEncoder.setVertexBuffer(0, ctx.pipelineCache.getQuadVertexBuffer());
    passEncoder.setBindGroup(0, bindGroup, [slot.offset]);

    // 6. Group 1: per-layer colour adjustments. Identity layers bind the
    // shared flags=0 group so `apply_adjustments` is a no-op (identity no-op).
    // `suppressAdjust` forces that identity group for a layer whose grade was
    // already BAKED by AdjustPrePass ahead of a FilterPass — without it the grade
    // would be applied twice (adjust→filter order path).
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

    passEncoder.draw(6);
  }
}
