/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the GNU General Public License.
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
 * EffectShadowPass.ts — The drop-shadow effect's pipeline (A8 P5): separable
 * Gaussian blur of the content silhouette (`FilterPass.gaussianBlur`, the
 * filter spine's own premultiply-correct kernel) followed by a pointwise
 * tint-and-offset compose (`shaders/effectShadowCompose`) that lands the
 * shadow BENEATH the accumulated foreground.
 *
 * WHY REUSE THE FILTER BLUR: translation-invariance makes blurring the
 * in-place silhouette and sampling it shifted equivalent to shifting first —
 * so the offset costs nothing in the blur passes and rides the compose
 * uniform instead. The blur output is STRAIGHT working-LINEAR light (the
 * H/V premultiply flags), and only its ALPHA is consumed by the tint.
 *
 * ORDER CONTRACT: the caller runs shadow stages AFTER stroke stages (the
 * stroke pass composes content-over-ring into `current`), so the shadow's
 * foreground-over-shadow compose yields the final z-order shadow beneath
 * stroke beneath content. Within the shadow category, later instances
 * compose beneath earlier ones (sequential over-composition, consistent with
 * the chain's "effects beneath content" reading).
 *
 * @module core/gpu/graph/composite/EffectShadowPass
 */

import { LayerTexture } from '@opengpex/editor/core/engine/gpu/resources/LayerTexture';
import { GAUSS_FLAG_SRC_ZERO_OOB } from '@opengpex/editor/core/engine/gpu/shaders/gaussian';
import { FilterPass, acquireEffectOutputTransient, type FilterPassContext } from './FilterPass';
import { EffectStrokePass } from './EffectStrokePass';
import {
  packEffectShadowComposeUniform,
  EFFECT_SHADOW_UNIFORM_BUFFER_SIZE,
  EFFECT_SHADOW_WORKGROUP,
} from '@opengpex/editor/core/engine/gpu/shaders/effectShadowCompose';
import {
  packEffectShadowSpreadUniform,
  EFFECT_SHADOW_SPREAD_UNIFORM_BUFFER_SIZE,
  EFFECT_SHADOW_SPREAD_WORKGROUP,
} from '@opengpex/editor/core/engine/gpu/shaders/effectShadowSpread';

interface TexelRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export class EffectShadowPass {
  static run(
    encoder: GPUCommandEncoder,
    ctx: FilterPassContext,
    p: {
      readonly layerId: string;
      /** The accumulated foreground (raw content, or the stroke pass output). */
      readonly current: LayerTexture;
      /** The silhouette source to blur (the ORIGINAL content, window-offset). */
      readonly silhouette: LayerTexture;
      /** The window rect in SILHOUETTE-texture texels (first stage only). */
      readonly windowTexel: TexelRect;
      readonly currentIsLinear: boolean;
      readonly gamutId: number;
      /** Current texture's top-left inside the window, in CURRENT texels. */
      readonly currentOriginTexel: TexelRect;
      readonly offsetX: number;
      readonly offsetY: number;
      readonly blurRadius: number;
      /** Silhouette dilation before the blur, in window texels (non-negative). */
      readonly spreadTexels: number;
      /** Distinguishes the spread EDT cache slot between shadow instances. */
      readonly instanceIndex: number;
      /** Alpha-only cache key for cross-frame EDT reuse (same contract as the stroke pass). */
      readonly edtAlphaKey?: string;
      readonly shadowColor: readonly [number, number, number, number];
      readonly opacity: number;
    },
  ): LayerTexture {
    const width = Math.max(1, p.windowTexel.w);
    const height = Math.max(1, p.windowTexel.h);

    // ── 1. Spread (optional): dilate / erode the silhouette BEFORE the blur —
    // the PS "Spread" job (bigger without softer). The EDT of the content
    // silhouette thresholds at ±spread (the stroke outside/inside closed
    // forms), so the spread costs seed+JFA+one pointwise pass and inherits
    // the EDT's exact round corners. spread 0 skips the whole stage
    // bit-exactly (the historical behaviour and the default).
    let silhouetteSource = p.silhouette;
    let silhouetteOrigin = p.windowTexel;
    const spread = Number.isFinite(p.spreadTexels) ? p.spreadTexels : 0;
    if (Math.abs(spread) > 0.001) {
      const edt = EffectStrokePass.computeEdt(encoder, ctx, {
        layerId: p.layerId,
        cacheId: `${p.layerId}:shadow-spread#${p.instanceIndex}`,
        content: p.silhouette,
        windowTexel: p.windowTexel,
        // The seed map depends only on the silhouette alpha — colour, opacity
        // and spread reuse the cached field (the stroke pass's contract).
        edtAlphaKey: p.edtAlphaKey,
      });
      const spreadTex = acquireEffectOutputTransient(ctx, p.layerId, 'shadow-spread', width, height);
      const spreadUniform = packEffectShadowSpreadUniform(width, height, {
        contentWidth: p.silhouette.width,
        contentHeight: p.silhouette.height,
        contentOriginX: -p.windowTexel.x,
        contentOriginY: -p.windowTexel.y,
        spreadTexels: spread,
      });
      const spreadSlot = ctx.bufferRing.writeSlot(spreadUniform);
      const spreadBg = ctx.device.createBindGroup({
        layout: ctx.pipelineCache.getEffectShadowSpreadBindGroupLayout(ctx.workingFormat),
        label: `Effect Shadow Spread BindGroup (${p.layerId})`,
        entries: [
          {
            binding: 0,
            resource: { buffer: ctx.bufferRing.getBuffer(), offset: 0, size: EFFECT_SHADOW_SPREAD_UNIFORM_BUFFER_SIZE },
          },
          { binding: 1, resource: edt.view },
          { binding: 2, resource: p.silhouette.view },
          { binding: 3, resource: spreadTex.view },
        ],
      });
      const spreadPass = encoder.beginComputePass({ label: `Effect Shadow Spread (${p.layerId})` });
      spreadPass.setPipeline(ctx.pipelineCache.getEffectShadowSpreadPipeline(ctx.workingFormat));
      spreadPass.setBindGroup(0, spreadBg, [spreadSlot.offset]);
      spreadPass.dispatchWorkgroups(
        Math.ceil(width / EFFECT_SHADOW_SPREAD_WORKGROUP),
        Math.ceil(height / EFFECT_SHADOW_SPREAD_WORKGROUP),
        1,
      );
      spreadPass.end();
      // The spread output is WINDOW-ALIGNED — the blur reads it with no offset.
      silhouetteSource = spreadTex;
      silhouetteOrigin = { x: 0, y: 0, w: width, h: height };
    }

    // ── 2. Blur the silhouette in place (H+V separable, premultiply-safe).
    // The FIRST stage's window sits at `windowTexel` inside the full content
    // texture; later stages consume window-aligned outputs whose origin IS
    // the window origin — but the silhouette source is ALWAYS the original
    // content, so the offset never shifts between instances.
    // SRC_ZERO_OOB unconditionally: taps past the silhouette bounds must read
    // truthful transparency, never the clamped edge texel (a shadow that
    // smears the content's edge texel outward is the classic blur edge bug).
    const blurred = FilterPass.gaussianBlur(
      encoder,
      ctx,
      { id: p.layerId },
      silhouetteSource,
      Math.max(0.001, p.blurRadius),
      true,
      { x: 0, y: 0, w: width, h: height },
      silhouetteOrigin,
      GAUSS_FLAG_SRC_ZERO_OOB,
    );

    // ── 3. Tint + offset + compose beneath the accumulated foreground.
    const out = acquireEffectOutputTransient(ctx, p.layerId, 'shadow', width, height);
    const uniform = packEffectShadowComposeUniform(width, height, {
      currentIsLinear: p.currentIsLinear,
      gamutId: p.gamutId,
      currentWidth: p.current.width,
      currentHeight: p.current.height,
      currentOriginX: p.currentOriginTexel.x,
      currentOriginY: p.currentOriginTexel.y,
      blurredWidth: blurred.width,
      blurredHeight: blurred.height,
      offsetX: p.offsetX,
      offsetY: p.offsetY,
      shadowColor: p.shadowColor,
      opacity: p.opacity,
    });
    const slot = ctx.bufferRing.writeSlot(uniform);
    const bindGroup = ctx.device.createBindGroup({
      layout: ctx.pipelineCache.getEffectShadowBindGroupLayout(ctx.workingFormat),
      label: `Effect Shadow BindGroup (${p.layerId})`,
      entries: [
        {
          binding: 0,
          resource: { buffer: ctx.bufferRing.getBuffer(), offset: 0, size: EFFECT_SHADOW_UNIFORM_BUFFER_SIZE },
        },
        { binding: 1, resource: blurred.view },
        { binding: 2, resource: p.current.view },
        { binding: 3, resource: out.view },
      ],
    });
    const pass = encoder.beginComputePass({ label: `Effect Shadow Compose (${p.layerId})` });
    pass.setPipeline(ctx.pipelineCache.getEffectShadowPipeline(ctx.workingFormat));
    pass.setBindGroup(0, bindGroup, [slot.offset]);
    pass.dispatchWorkgroups(
      Math.ceil(width / EFFECT_SHADOW_WORKGROUP),
      Math.ceil(height / EFFECT_SHADOW_WORKGROUP),
      1,
    );
    pass.end();
    return out;
  }

}
