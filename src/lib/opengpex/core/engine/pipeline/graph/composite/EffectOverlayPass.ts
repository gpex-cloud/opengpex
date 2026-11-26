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
 * EffectOverlayPass.ts — The color-overlay effect's pipeline: ONE pointwise
 * compute dispatch (`shaders/effectOverlayCompose`) that blends the overlay
 * colour into the accumulated foreground's RGB by one of the 16 modes.
 *
 * ORDER CONTRACT: the caller runs overlay stages on the mask-baked content
 * BEFORE any stroke stage — the stroke compose flattens its ring into the
 * content colour, so a later overlay would dye the stroke. The pass keeps
 * the content ALPHA untouched (a surface effect never changes the
 * silhouette), which is what lets the stroke's EDT geometry stay
 * bit-identical with or without the overlay.
 *
 * GEOMETRY: the output is the EFFECT WINDOW — exactly the rect the caller
 * declares as `contentWindow`, matching the stroke compose output's
 * window-aligned contract. The overlay itself adds NO ROI expansion, but the
 * prepass's shared window carries the stroke/shadow AA slack, and the
 * declared window and the backing texture must agree texel-for-texel (a
 * content-sized output under a window-sized declaration stretches the
 * composite quad — the overlay-only "slightly enlarged content" incident).
 * The window→content read maps through a bit-exact i32 origin; the caller
 * passes the window rect INSIDE the current texture: the raw window rect for
 * the first stage (origin may be negative), the zero rect for stages that
 * consume an already window-aligned previous output.
 *
 * @module core/gpu/graph/composite/EffectOverlayPass
 */

import { LayerTexture } from '@opengpex/editor/core/engine/gpu/resources/LayerTexture';
import { acquireEffectOutputTransient, type FilterPassContext } from './FilterPass';
import {
  packEffectOverlayComposeUniform,
  EFFECT_OVERLAY_UNIFORM_BUFFER_SIZE,
  EFFECT_OVERLAY_WORKGROUP,
} from '@opengpex/editor/core/engine/gpu/shaders/effectOverlayCompose';
import type { LayerBlendMode } from '@opengpex/editor/core/types';

interface TexelRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export class EffectOverlayPass {
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
       * effect window for the first stage, or the full zero-origin rect when
       * the input is already a window-aligned previous output.
       */
      readonly windowTexel: TexelRect;
      /** Working-LINEAR straight-alpha overlay colour (only .rgb is consumed). */
      readonly overlayColor: readonly [number, number, number, number];
      /** One of the 16 `LayerBlendMode` values. */
      readonly blendMode: LayerBlendMode;
      /** Overlay strength 0..1. */
      readonly opacity: number;
    },
  ): LayerTexture {
    const width = Math.max(1, p.windowTexel.w);
    const height = Math.max(1, p.windowTexel.h);
    // Window-aligned output: dims == the declared contentWindow, so the
    // compositor's expandQuadToWindow geometry samples texel-for-texel.
    const out = acquireEffectOutputTransient(ctx, p.layerId, 'overlay', width, height);
    const uniform = packEffectOverlayComposeUniform(width, height, {
      currentIsLinear: p.currentIsLinear,
      gamutId: p.gamutId,
      currentWidth: p.current.width,
      currentHeight: p.current.height,
      // The current texture's top-left inside the window, in current texels:
      // the window rect's NEGATED origin (window origin at windowTexel.xy in
      // content space means content origin at -windowTexel.xy in window
      // space). Bit-exact i32 — negative origins are expected.
      currentOriginX: -p.windowTexel.x,
      currentOriginY: -p.windowTexel.y,
      overlayColor: p.overlayColor,
      blendMode: p.blendMode,
      opacity: p.opacity,
    });
    const slot = ctx.bufferRing.writeSlot(uniform);
    const bindGroup = ctx.device.createBindGroup({
      layout: ctx.pipelineCache.getEffectOverlayBindGroupLayout(ctx.workingFormat),
      label: `Effect Overlay BindGroup (${p.layerId})`,
      entries: [
        {
          binding: 0,
          resource: { buffer: ctx.bufferRing.getBuffer(), offset: 0, size: EFFECT_OVERLAY_UNIFORM_BUFFER_SIZE },
        },
        { binding: 1, resource: p.current.view },
        { binding: 2, resource: out.view },
      ],
    });
    const pass = encoder.beginComputePass({ label: `Effect Overlay Compose (${p.layerId})` });
    pass.setPipeline(ctx.pipelineCache.getEffectOverlayPipeline(ctx.workingFormat));
    pass.setBindGroup(0, bindGroup, [slot.offset]);
    pass.dispatchWorkgroups(
      Math.ceil(width / EFFECT_OVERLAY_WORKGROUP),
      Math.ceil(height / EFFECT_OVERLAY_WORKGROUP),
      1,
    );
    pass.end();
    // The compose output is working-LINEAR in the working gamut — later
    // stages (stroke / shadow chains) and the output declaration agree.
    return out;
  }
}
