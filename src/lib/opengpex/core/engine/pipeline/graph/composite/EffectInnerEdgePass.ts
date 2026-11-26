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
 * EffectInnerEdgePass.ts — ONE shared pipeline for the inner-edge family
 * (Inner Glow / Inner Shadow), parameterized per effect:
 *
 *   1. INVERT  — padded inverted silhouette (truthful 1.0 border; the OOB
 *      fix — see shaders/effectInnerCompose) at
 *      window + (blurReach + spread + slack) headroom per side.
 *   2. SPREAD  — optional EDT dilation of the inverted region (the existing
 *      effectShadowSpread pipeline run on the inverted texture; fg seeds =
 *      inverted alpha ≥ ½, so the band dilates INWARD), each effect getting
 *      its OWN EDT cache slot (`<layerId>:inner-glow#<i>` /
 *      `<layerId>:inner-shadow#<i>`). The dilate grid's headroom is the
 *      invert temp's padding itself — ≥ spread by construction, the
 *      max-spread glow lesson applied at this pass's own temps rather than
 *      the (pad-0) output window.
 *   3. BLUR    — `FilterPass.gaussianBlur` over the padded rect (offset 0);
 *      no zero-OOB flag — the truthful 1.0 padding IS the boundary value.
 *   4. COMPOSE — pointwise blend of the band onto the final foreground,
 *      clipped by the silhouette alpha; output window-aligned at the same
 *      window extent (inner effects never grow the window).
 *
 * EXECUTION POSITION: after the stroke and shadow chains, on the final
 * foreground (the compose is the last writer — the band never feeds another
 * family's EDT).
 *
 * @module core/gpu/graph/composite/EffectInnerEdgePass
 */

import { LayerTexture } from '@opengpex/editor/core/engine/gpu/resources/LayerTexture';
import { acquireEffectOutputTransient, FilterPass, type FilterPassContext } from './FilterPass';
import { EffectStrokePass } from './EffectStrokePass';
import {
  packEffectInnerInvertUniform,
  packEffectInnerComposeUniform,
  EFFECT_INNER_INVERT_UNIFORM_BUFFER_SIZE,
  EFFECT_INNER_UNIFORM_BUFFER_SIZE,
  EFFECT_INNER_WORKGROUP,
} from '@opengpex/editor/core/engine/gpu/shaders/effectInnerCompose';
import {
  packEffectShadowSpreadUniform,
  EFFECT_SHADOW_SPREAD_UNIFORM_BUFFER_SIZE,
  EFFECT_SHADOW_SPREAD_WORKGROUP,
} from '@opengpex/editor/core/engine/gpu/shaders/effectShadowSpread';
import { STROKE_ROI_AA_SLACK_PX, shadowBlurReachPx } from '../build/support/effectRoi';
import type { LayerBlendMode } from '@opengpex/editor/core/types';

interface TexelRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export class EffectInnerEdgePass {
  static run(
    encoder: GPUCommandEncoder,
    ctx: FilterPassContext,
    p: {
      readonly layerId: string;
      /** The effect kind — owns the EDT cache slot suffix and transient labels. */
      readonly effectKey: 'inner-glow' | 'inner-shadow';
      /** Distinguishes the EDT cache slot between instances. */
      readonly instanceIndex: number;
      /** Alpha-only cache key for cross-frame EDT reuse (the silhouette contract). */
      readonly edtAlphaKey: string;
      /** The final foreground the band composites ON. */
      readonly current: LayerTexture;
      /** Current texture's top-left inside the window, in CURRENT texels (bit-exact i32). */
      readonly currentOriginTexel: TexelRect;
      /** The ORIGINAL mask-baked silhouette (never the stroked foreground). */
      readonly silhouette: LayerTexture;
      /** Silhouette texture's top-left inside the window, in SIL texels (bit-exact i32). */
      readonly silOriginTexel: TexelRect;
      /** The window rect in SIL texels — anchors the padded temp. */
      readonly windowTexel: TexelRect;
      /** The visible content rect in SIL texels (the band build's guard). */
      readonly visibleRect: TexelRect;
      readonly currentIsLinear: boolean;
      readonly gamutId: number;
      /** Working-LINEAR straight-alpha effect colour. */
      readonly effectColor: readonly [number, number, number, number];
      /** One of the 16 `LayerBlendMode` values. */
      readonly blendMode: LayerBlendMode;
      /** Effect strength 0..1. */
      readonly opacity: number;
      /** Gaussian sigma in window texels. */
      readonly blurRadius: number;
      /** Inverted-region dilation before the blur, in window texels (non-negative). */
      readonly spreadTexels: number;
      /** Inner-shadow band shift in window texels (0 for the glow; the ring lands on the offset's side). */
      readonly offsetX: number;
      readonly offsetY: number;
    },
  ): LayerTexture {
    const width = Math.max(1, p.windowTexel.w);
    const height = Math.max(1, p.windowTexel.h);
    // The band temp's outward headroom: blur taps + spread dilation + AA
    // slack, all truthful-1.0 beyond the visible rect (the OOB fix).
    const spread = Number.isFinite(p.spreadTexels) ? p.spreadTexels : 0;
    // INNER SIGMA MAPPING (20261126, user-calibrated): the reference
    // product's inner shadow reads SOFTER than the outer path at the same
    // numeric blur size, so the inner edge blurs at sigma = 2 x blurRadius.
    // Every downstream consumer of the reach (invert padding, blur rect)
    // derives from this effective sigma — change it in ONE place.
    const sigma = p.blurRadius * 2;
    const blurReach = shadowBlurReachPx(sigma);
    const pad = blurReach + Math.max(0, spread) + STROKE_ROI_AA_SLACK_PX;
    const paddedW = Math.max(1, width + 2 * pad);
    const paddedH = Math.max(1, height + 2 * pad);

    // ── 1. Invert: padded inverted silhouette, truthful 1.0 border. ──────
    const invPad = acquireEffectOutputTransient(ctx, p.layerId, `${p.effectKey}-inv`, paddedW, paddedH);
    const invertUniform = packEffectInnerInvertUniform(paddedW, paddedH, {
      padTexels: pad,
      silWidth: p.silhouette.width,
      silHeight: p.silhouette.height,
      silOriginX: p.silOriginTexel.x,
      silOriginY: p.silOriginTexel.y,
      // The visible window rect guards the band build; padding is 1.0.
      // The visible rect in WINDOW coords: window w = sil s - silOrigin.
      innerRect: {
        x: p.visibleRect.x + p.silOriginTexel.x,
        y: p.visibleRect.y + p.silOriginTexel.y,
        w: p.visibleRect.w,
        h: p.visibleRect.h,
      },
    });
    const invertSlot = ctx.bufferRing.writeSlot(invertUniform);
    const invertBg = ctx.device.createBindGroup({
      layout: ctx.pipelineCache.getEffectInnerInvertBindGroupLayout(ctx.workingFormat),
      label: `Effect Inner Invert BindGroup (${p.layerId} ${p.effectKey})`,
      entries: [
        {
          binding: 0,
          resource: { buffer: ctx.bufferRing.getBuffer(), offset: 0, size: EFFECT_INNER_INVERT_UNIFORM_BUFFER_SIZE },
        },
        { binding: 1, resource: p.silhouette.view },
        { binding: 2, resource: invPad.view },
      ],
    });
    const invertPass = encoder.beginComputePass({ label: `Effect Inner Invert (${p.layerId} ${p.effectKey})` });
    invertPass.setPipeline(ctx.pipelineCache.getEffectInnerInvertPipeline(ctx.workingFormat));
    invertPass.setBindGroup(0, invertBg, [invertSlot.offset]);
    invertPass.dispatchWorkgroups(
      Math.ceil(paddedW / EFFECT_INNER_WORKGROUP),
      Math.ceil(paddedH / EFFECT_INNER_WORKGROUP),
      1,
    );
    invertPass.end();

    // ── 2. Spread: dilate the INVERTED region inward via the EDT band. ───
    // The EDT grid IS the padded temp (≥ spread headroom by construction).
    let bandSource = invPad;
    if (spread > 0.001) {
      const edt = EffectStrokePass.computeEdt(encoder, ctx, {
        layerId: p.layerId,
        cacheId: `${p.layerId}:${p.effectKey}#${p.instanceIndex}`,
        content: invPad,
        windowTexel: { x: 0, y: 0, w: paddedW, h: paddedH },
        // The seed map depends only on the inverted alpha.
        edtAlphaKey: `${p.edtAlphaKey}|inv`,
      });
      const spreadPad = acquireEffectOutputTransient(ctx, p.layerId, `${p.effectKey}-spread`, paddedW, paddedH);
      const spreadUniform = packEffectShadowSpreadUniform(paddedW, paddedH, {
        contentWidth: invPad.width,
        contentHeight: invPad.height,
        // Identity mapping: the EDT grid IS the padded grid.
        contentOriginX: 0,
        contentOriginY: 0,
        spreadTexels: spread,
        // The full padded rect is the visible guard — the padding's truthful
        // 1.0 border participates as seeds, exactly as built.
        contentVisible: { x: 0, y: 0, w: paddedW, h: paddedH },
      });
      const spreadSlot = ctx.bufferRing.writeSlot(spreadUniform);
      const spreadBg = ctx.device.createBindGroup({
        layout: ctx.pipelineCache.getEffectShadowSpreadBindGroupLayout(ctx.workingFormat),
        label: `Effect Inner Spread BindGroup (${p.layerId} ${p.effectKey})`,
        entries: [
          {
            binding: 0,
            resource: { buffer: ctx.bufferRing.getBuffer(), offset: 0, size: EFFECT_SHADOW_SPREAD_UNIFORM_BUFFER_SIZE },
          },
          { binding: 1, resource: edt.view },
          { binding: 2, resource: invPad.view },
          { binding: 3, resource: spreadPad.view },
        ],
      });
      const spreadPass = encoder.beginComputePass({ label: `Effect Inner Spread (${p.layerId} ${p.effectKey})` });
      spreadPass.setPipeline(ctx.pipelineCache.getEffectShadowSpreadPipeline(ctx.workingFormat));
      spreadPass.setBindGroup(0, spreadBg, [spreadSlot.offset]);
      spreadPass.dispatchWorkgroups(
        Math.ceil(paddedW / EFFECT_SHADOW_SPREAD_WORKGROUP),
        Math.ceil(paddedH / EFFECT_SHADOW_SPREAD_WORKGROUP),
        1,
      );
      spreadPass.end();
      bandSource = spreadPad;
    }

    // ── 3. Blur the padded band (offset 0, NO zero-OOB flag: the truthful
    // 1.0 padding IS the boundary value — the whole OOB fix).
    const blurred = FilterPass.gaussianBlur(
      encoder,
      ctx,
      { id: `${p.layerId}:${p.effectKey}` },
      bandSource,
      Math.max(0.001, sigma),
      true,
      { x: 0, y: 0, w: paddedW, h: paddedH },
      { x: 0, y: 0 },
      0,
    );

    // ── 4. Compose the band onto the final foreground (window-aligned). ──
    const out = acquireEffectOutputTransient(ctx, p.layerId, `${p.effectKey}-compose`, width, height);
    const composeUniform = packEffectInnerComposeUniform(width, height, {
      currentIsLinear: p.currentIsLinear,
      gamutId: p.gamutId,
      currentWidth: p.current.width,
      currentHeight: p.current.height,
      currentOriginX: p.currentOriginTexel.x,
      currentOriginY: p.currentOriginTexel.y,
      silWidth: p.silhouette.width,
      silHeight: p.silhouette.height,
      silOriginX: p.silOriginTexel.x,
      silOriginY: p.silOriginTexel.y,
      bandWidth: blurred.width,
      bandHeight: blurred.height,
      offsetX: p.offsetX,
      offsetY: p.offsetY,
      padTexels: pad,
      blendMode: p.blendMode,
      opacity: p.opacity,
      effectColor: p.effectColor,
    });
    const composeSlot = ctx.bufferRing.writeSlot(composeUniform);
    const composeBg = ctx.device.createBindGroup({
      layout: ctx.pipelineCache.getEffectInnerComposeBindGroupLayout(ctx.workingFormat),
      label: `Effect Inner Compose BindGroup (${p.layerId} ${p.effectKey})`,
      entries: [
        {
          binding: 0,
          resource: { buffer: ctx.bufferRing.getBuffer(), offset: 0, size: EFFECT_INNER_UNIFORM_BUFFER_SIZE },
        },
        { binding: 1, resource: p.current.view },
        { binding: 2, resource: p.silhouette.view },
        { binding: 3, resource: blurred.view },
        { binding: 4, resource: out.view },
      ],
    });
    const composePass = encoder.beginComputePass({ label: `Effect Inner Compose (${p.layerId} ${p.effectKey})` });
    composePass.setPipeline(ctx.pipelineCache.getEffectInnerComposePipeline(ctx.workingFormat));
    composePass.setBindGroup(0, composeBg, [composeSlot.offset]);
    composePass.dispatchWorkgroups(
      Math.ceil(width / EFFECT_INNER_WORKGROUP),
      Math.ceil(height / EFFECT_INNER_WORKGROUP),
      1,
    );
    composePass.end();
    // The compose output is working-LINEAR in the working gamut,
    // window-aligned at the SAME window extent.
    return out;
  }
}
