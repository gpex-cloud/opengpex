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
 * EffectGradientPass.ts — The gradient-overlay effect's pipeline: ONE
 * pointwise compute dispatch (`shaders/effectGradientCompose`) that samples
 * the two-stop ramp per content texel and blends it into the accumulated
 * foreground's RGB by one of the 16 modes.
 *
 * ORDER CONTRACT: the caller runs gradient stages in the SURFACE BAND —
 * after the color-overlay chain, BEFORE the stroke chain — on the mask-baked
 * content. The stroke compose flattens its ring into the content colour, so
 * a later gradient would dye the stroke. The pass keeps the content ALPHA
 * untouched (a surface effect never changes the silhouette).
 *
 * GEOMETRY: the output is WINDOW-ALIGNED at the caller's effect window (the
 * batch-1 contract — the declared contentWindow and the backing texture
 * must agree texel-for-texel), with the window→content read through a
 * bit-exact i32 origin. The ramp's UV basis is the VISIBLE content rect
 * (contentRectInTexture contract), passed in CURRENT-texture texels — the
 * caller re-bases it when the input is already a window-aligned previous
 * surface output.
 *
 * @module core/gpu/graph/composite/EffectGradientPass
 */

import { LayerTexture } from '@opengpex/editor/core/engine/gpu/resources/LayerTexture';
import { acquireEffectOutputTransient, type FilterPassContext } from './FilterPass';
import {
  packEffectGradientComposeUniform,
  EFFECT_GRADIENT_UNIFORM_BUFFER_SIZE,
  EFFECT_GRADIENT_WORKGROUP,
} from '@opengpex/editor/core/engine/gpu/shaders/effectGradientCompose';
import type { LayerBlendMode, GradientOverlayStyle } from '@opengpex/editor/core/types';

interface TexelRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export class EffectGradientPass {
  static run(
    encoder: GPUCommandEncoder,
    ctx: FilterPassContext,
    p: {
      readonly layerId: string;
      /** The mask-baked content this overlay re-colours (and its geometry). */
      readonly current: LayerTexture;
      readonly currentIsLinear: boolean;
      readonly gamutId: number;
      /**
       * The window rect in CURRENT-texture texels: the prepass's shared
       * effect window for the first surface stage, or the full zero-origin
       * rect when the input is already a window-aligned previous output.
       */
      readonly windowTexel: TexelRect;
      /**
       * The visible content rect in CURRENT-texture texels (the ramp's UV
       * basis — contentRectInTexture, re-based for window-aligned inputs).
       */
      readonly contentVisible: TexelRect;
      /** Working-LINEAR straight-alpha ramp START colour. */
      readonly startColor: readonly [number, number, number, number];
      /** Working-LINEAR straight-alpha ramp END colour. */
      readonly endColor: readonly [number, number, number, number];
      /** One of the 16 `LayerBlendMode` values. */
      readonly blendMode: LayerBlendMode;
      readonly style: GradientOverlayStyle;
      /** Ramp axis angle in RADIANS, display orientation. */
      readonly angleRad: number;
      /** Ramp extent percent (100 = visible rect fit). */
      readonly scale: number;
      /** Overlay strength 0..1. */
      readonly opacity: number;
    },
  ): LayerTexture {
    const width = Math.max(1, p.windowTexel.w);
    const height = Math.max(1, p.windowTexel.h);
    // Window-aligned output: dims == the declared contentWindow, so the
    // compositor's expandQuadToWindow geometry samples texel-for-texel.
    const out = acquireEffectOutputTransient(ctx, p.layerId, 'gradient', width, height);
    const uniform = packEffectGradientComposeUniform(width, height, {
      currentIsLinear: p.currentIsLinear,
      gamutId: p.gamutId,
      currentWidth: p.current.width,
      currentHeight: p.current.height,
      // The current texture's top-left inside the window, in current texels
      // (the window rect's NEGATED origin). Bit-exact i32 — negative
      // origins are expected.
      currentOriginX: -p.windowTexel.x,
      currentOriginY: -p.windowTexel.y,
      contentVisible: p.contentVisible,
      blendMode: p.blendMode,
      style: p.style,
      angleRad: p.angleRad,
      scale: p.scale,
      opacity: p.opacity,
      startColor: p.startColor,
      endColor: p.endColor,
    });
    const slot = ctx.bufferRing.writeSlot(uniform);
    const bindGroup = ctx.device.createBindGroup({
      layout: ctx.pipelineCache.getEffectGradientBindGroupLayout(ctx.workingFormat),
      label: `Effect Gradient BindGroup (${p.layerId})`,
      entries: [
        {
          binding: 0,
          resource: { buffer: ctx.bufferRing.getBuffer(), offset: 0, size: EFFECT_GRADIENT_UNIFORM_BUFFER_SIZE },
        },
        { binding: 1, resource: p.current.view },
        { binding: 2, resource: out.view },
      ],
    });
    const pass = encoder.beginComputePass({ label: `Effect Gradient Compose (${p.layerId})` });
    pass.setPipeline(ctx.pipelineCache.getEffectGradientPipeline(ctx.workingFormat));
    pass.setBindGroup(0, bindGroup, [slot.offset]);
    pass.dispatchWorkgroups(
      Math.ceil(width / EFFECT_GRADIENT_WORKGROUP),
      Math.ceil(height / EFFECT_GRADIENT_WORKGROUP),
      1,
    );
    pass.end();
    // The compose output is working-LINEAR in the working gamut,
    // window-aligned — later stages and the output declaration agree.
    return out;
  }
}
