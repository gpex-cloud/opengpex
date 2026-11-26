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
 * prepareEffectSources.ts — Layer-effect prepass (A8): turn every layer that
 * carries effect stages into ONE composed "effects beneath content" transient,
 * so the composite passes consume it as an ordinary straight-alpha source with
 * ZERO effect awareness.
 *
 * WHY A THIRD PREPASS (the filter/vector spines' sibling): the stroke needs
 * compute dispatches (dilation sweeps + pointwise compose), and WebGPU forbids
 * compute inside an open render pass — identical rationale to
 * prepareFilteredSources. It runs LAST in the build phase, AFTER
 * prepareFilteredSources / prepareVectorSources, because it consumes their
 * output: effects decorate the outermost content (adjustments and filters have
 * already landed in the pixels by the time the ring is derived — the §5.4
 * ordering contract).
 *
 * CONTENT MATERIALIZATION (per source kind):
 *   • raster  — the prepared source IS the content (raw asset, adjust bake, or
 *     filtered transient). An UNFILTERED layer with adjustStages arrives still
 *     un-baked (the composite applies the grade inline); because a stroke ring
 *     must NOT be graded, this prepass bakes the grade first (the same
 *     AdjustPrePass route prepareFilteredSources uses), so the output can
 *     declare `suppressAdjust: true`.
 *   • solid   — no pixels exist. Materialize the fill rect into the window via
 *     the AdjustPrePass solid route (uniform colour, identity normalize) with a
 *     scissor limited to the fill rect — the stroke must ring the FILL RECT,
 *     not the whole window.
 *   • vector  — the strategy transient IS the content (already working-LINEAR).
 *
 * COORDINATE CONTRACT: all effect maths runs in the content texture's TEXEL
 * space. The ring's anchor rect is the source-prep stage's declared
 * `contentRectInTexture` (texture texels) — never re-derived from `layer.crop`
 * semantics here. The output `contentWindow` converts back WITH an explicit
 * `basis`:
 *   raster   — asset texels (`basis: 'asset'`); the compositor divides by
 *              `layer.dprScale`.
 *   vector   — transient texels; converted to logical px for the window
 *              (`basis: 'content-local'` — vector dpr is 1 and the transient
 *              is density × logical).
 *   solid    — logical px (`basis: 'content-local'`, density 1).
 * SceneAssembler guarantees effect nodes carry an explicit full-extent crop,
 * which is what lets the composite's `expandQuadToWindow` geometry branch run
 * for every source kind (see the node assembly site).
 *
 * RENDER-INTENT: the compose output inherits `sourceIntentApplied` from its
 * input — a RAW source's filmic knee therefore applies to the whole composed
 * foreground (stroke included) at the compositor, a documented RAW-only corner
 * of the P2 scope.
 *
 * @module core/gpu/graph/build/prepareEffectSources
 */

import type { CompiledScene } from '../SceneCompiler';
import { snapToPowerOfTwo } from '@opengpex/editor/core/engine/gpu/resources/TexturePool';
import { LayerTexture } from '@opengpex/editor/core/engine/gpu/resources/LayerTexture';
import { GPUTextureUsage } from '@opengpex/editor/core/engine/gpu/constants';
import { AdjustPrePass } from '../composite/AdjustPrePass';
import { EffectStrokePass, sweepEdtCache } from '../composite/EffectStrokePass';
import { EffectShadowPass } from '../composite/EffectShadowPass';
import { resolveSourceGamutId } from '../support/sourceGamut';
import { expandWindowForStroke, expandWindowForPads, effectWindowPadsPx, effectReachPx, strokeContentBase } from './support/effectRoi';
import {
  EFFECT_MASK_BAKE_UNIFORM_BUFFER_SIZE,
  EFFECT_MASK_BAKE_WORKGROUP,
  packEffectMaskBakeUniform,
} from '@opengpex/editor/core/engine/gpu/shaders/effectMaskBake';
import type { AdjustCoverageBinding } from '../support/adjustBindGroup';
import type { VmaskBake } from './prepareVmaskSources';
import type { BuildContext, PreparedSource } from './types';

const CLEAR_COLOR: GPUColor = { r: 0, g: 0, b: 0, a: 0 };


interface TexelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The stroke / shadow stages carried by a layer's translated effect chain. */
function strokeStages(layer: CompiledScene['scene']['layers'][number]) {
  return (layer.effects ?? []).filter((s) => s.kind === 'stroke');
}

function shadowStages(layer: CompiledScene['scene']['layers'][number]) {
  return (layer.effects ?? []).filter((s) => s.kind === 'shadow');
}

export function prepareEffectSources(
  encoder: GPUCommandEncoder,
  compiled: CompiledScene,
  ctx: BuildContext,
  sources: Map<string, PreparedSource>,
  /** Reserved for the coverage-aware effect scoping (the shape/feather seam);
   *  unused while effects are whole-layer. Kept in the signature so the
   *  RenderGraph call site does not churn when scoping lands. */
  _adjustCoverageSources: Map<string, AdjustCoverageBinding>,
  vmaskSources?: ReadonlyMap<string, VmaskBake>,
  bmaskSources?: ReadonlyMap<string, LayerTexture>,
): void {
  const { workingFormat, scratch } = ctx;
  const activeEdtKeys = new Set<string>();
  for (const layer of compiled.scene.layers) {
    const stages = strokeStages(layer);
    const shadows = shadowStages(layer);
    if (stages.length === 0 && shadows.length === 0) continue;
    const prepared = sources.get(layer.id);
    if (!prepared) continue; // asset not resident yet — the layer skips this frame anyway

    const solidColor = layer.source.kind === 'solid' ? layer.source.color : undefined;
    const asset = prepared.texture;

    // ── 1. Content materialization ──────────────────────────────────────
    // Everything downstream reads one `content` texture + a texel-space base
    // rect (the visible content this stroke rings) + a density (texels per
    // logical px, which scales the stroke radius into texels).
    let content: LayerTexture;
    let base: TexelRect;
    let density: number;
    let contentIsLinear: boolean;
    let gamutId: number;
    /** Offset of the content texture's origin in the OUTPUT-window space (asset/window coords). */
    let contentToWindow: { x: number; y: number };

    if (solidColor) {
      // DECLARATIVE SOLID: materialize the fill rect into a fresh window-sized
      // texture (the 1x1 white formality has no ring-able pixels). Density 1 —
      // the window reports in logical px and the fill has no texels to lose.
      // The window is pre-expanded HERE (this is the one arm that owns its own
      // allocation), so the stroke chain below skips the expansion.
      const logical: TexelRect = layer.crop
        ? { x: layer.crop.x, y: layer.crop.y, w: layer.crop.w, h: layer.crop.h }
        : { x: 0, y: 0, w: layer.width ?? 1, h: layer.height ?? 1 };
      density = 1;
      contentToWindow = { x: 0, y: 0 };
      const reach = effectReachPx(stages);
      const windowRect = expandWindowForStroke(logical, reach);
      base = { x: logical.x - windowRect.x, y: logical.y - windowRect.y, w: logical.w, h: logical.h };
      const raw = ctx.texturePool.acquire({
        width: windowRect.w,
        height: windowRect.h,
        format: workingFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        label: `Stroke Solid Content (${layer.id})`,
      });
      scratch.push(raw);
      content = new LayerTexture({
        texture: raw,
        width: windowRect.w,
        height: windowRect.h,
        allocatedWidth: snapToPowerOfTwo(windowRect.w),
        allocatedHeight: snapToPowerOfTwo(windowRect.h),
        format: workingFormat,
      });
      // The AdjustPrePass solid route writes the uniform colour with identity
      // normalize flags (working-LINEAR in, working-LINEAR out) and applies the
      // layer's adjust stages when present — the solid's one bake does both.
      const bakePass = encoder.beginRenderPass({
        label: `Stroke Solid Content Pass (${layer.id})`,
        colorAttachments: [{ view: content.texture.createView(), clearValue: CLEAR_COLOR, loadOp: 'clear', storeOp: 'store' }],
      });
      bakePass.setViewport(0, 0, windowRect.w, windowRect.h, 0, 1);
      // Scissor the quad write to the FILL RECT: the stroke rings the fill's
      // own extent, so everything outside it must stay transparent (a full
      // window fill would have no outside to ring).
      bakePass.setScissorRect(
        Math.max(0, Math.round(base.x)),
        Math.max(0, Math.round(base.y)),
        Math.max(1, Math.round(base.w)),
        Math.max(1, Math.round(base.h)),
      );
      AdjustPrePass.draw(bakePass, {
        device: ctx.device,
        pipelineCache: ctx.pipelineCache,
        bufferRing: ctx.bufferRing,
        targetFormat: workingFormat,
        resolveLutView: ctx.resolveLutView,
        resolveLut3dView: ctx.resolveLut3dView,
      }, { layer, source: asset, solidColor });
      bakePass.end();
      contentIsLinear = true;
      gamutId = 0;
    } else {
      // RASTER / VECTOR: the prepared texture is the content.
      content = asset;
      const dpr = layer.dprScale && layer.dprScale > 0 ? layer.dprScale : 1;
      // SINGLE SOURCE OF TRUTH: the ring anchors on the content rect the
      // source-prep stage declared (`contentRectInTexture`, texture texels).
      // This module does NOT re-derive it from `layer.crop` semantics — that
      // derivation is exactly what mis-registered a physical fragment's stroke
      // when real layer data violated the fragment model (a content-aligned
      // trimmed asset carrying an unrebased crop origin pointed the ring at a
      // region with no content, shifting ring AND quad by ≈ `crop.xy · d − pad`).
      base = strokeContentBase(prepared.contentRectInTexture, asset.width, asset.height);
      if (prepared.contentWindow) {
        // FILTERED raster: the texture holds exactly the filter window (window
        // origin at texture (0,0)). Density 1 — filter chains run at
        // asset-texel scale; the stroke radius scales by dpr at the compositor.
        density = 1;
        contentToWindow = { x: prepared.contentWindow.x, y: prepared.contentWindow.y };
      } else if (layer.source.kind === 'vector') {
        // VECTOR: the transient covers the layer's full logical extent at the
        // composite density; texels per logical px derives from the texture
        // itself (the resolveLayerDprScale vector contract — same formula
        // prepareVectorSources used to declare the content rect).
        const logicalW = Math.max(1, layer.width ?? asset.width);
        density = asset.width / logicalW;
        contentToWindow = { x: 0, y: 0 };
      } else {
        // RAW raster (full image or a cropped fragment): density is the
        // asset's own texels-per-logical factor.
        density = dpr;
        contentToWindow = { x: 0, y: 0 };
      }

      // An un-baked grade (unfiltered layer with adjustStages, or a vector
      // layer with adjustStages): bake it FIRST so the ring derives from the
      // graded content and the output can declare suppressAdjust — otherwise
      // the compositor's inline grade would hit the stroke pixels too.
      if (!prepared.suppressAdjust && layer.adjustStages && layer.adjustStages.length > 0) {
        const raw = ctx.texturePool.acquire({
          width: asset.width,
          height: asset.height,
          format: workingFormat,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
          label: `Stroke Adjust Bake (${layer.id})`,
        });
        scratch.push(raw);
        const bake = new LayerTexture({
          texture: raw,
          width: asset.width,
          height: asset.height,
          allocatedWidth: snapToPowerOfTwo(asset.width),
          allocatedHeight: snapToPowerOfTwo(asset.height),
          format: workingFormat,
        });
        const bakePass = encoder.beginRenderPass({
          label: `Stroke Adjust Bake Pass (${layer.id})`,
          colorAttachments: [{ view: bake.texture.createView(), clearValue: CLEAR_COLOR, loadOp: 'clear', storeOp: 'store' }],
        });
        bakePass.setViewport(0, 0, asset.width, asset.height, 0, 1);
        AdjustPrePass.draw(bakePass, {
          device: ctx.device,
          pipelineCache: ctx.pipelineCache,
          bufferRing: ctx.bufferRing,
          targetFormat: workingFormat,
          resolveLutView: ctx.resolveLutView,
          resolveLut3dView: ctx.resolveLut3dView,
        }, { layer, source: asset, sourceIsLinear: prepared.sourceIsLinear });
        bakePass.end();
        content = bake;
        contentIsLinear = true;
        // The bake aligned the gamut too.
        gamutId = 0;
      } else {
        contentIsLinear = prepared.sourceIsLinear;
        gamutId = resolveSourceGamutId(layer);
      }
    }

    // ── 1b. Mask bake (G3 stage 1) ─────────────────────────────────────
    // Bake combined bmask + polygon-baked vmask into the content alpha BEFORE
    // dilation so the stroke ring follows the true silhouette (holes, cutouts,
    // feathered edges) and the output declares `maskFree: true`.
    const bmaskTex = bmaskSources?.get(layer.id);
    const vmaskBake = vmaskSources?.get(layer.id);
    // A cropped logical fragment sharing a larger source asset (G2): the blur
    // taps of a shadow legitimately reach outside the visible crop, where the
    // shared asset's neighbor pixels are OPAQUE and would smear into the
    // shadow. The mask-bake pass doubles as a visibility crop (both mask flags
    // off = guarded copy of the base rect), so the shadow blur reads a
    // base-sized silhouette whose out-of-bounds is truthful transparency.
    const baseIsSubRect = !solidColor
      && (base.x > 0 || base.y > 0 || base.x + base.w < content.width || base.y + base.h < content.height);
    const needsVisibilityCrop = shadows.length > 0 && baseIsSubRect;
    if (bmaskTex || vmaskBake || needsVisibilityCrop) {
      const bx0 = solidColor ? 0 : Math.floor(base.x);
      const by0 = solidColor ? 0 : Math.floor(base.y);
      const dstW = solidColor ? content.width : Math.max(1, Math.ceil(base.x + base.w) - bx0);
      const dstH = solidColor ? content.height : Math.max(1, Math.ceil(base.y + base.h) - by0);
      const raw = ctx.texturePool.acquire({
        width: dstW,
        height: dstH,
        format: workingFormat,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
        label: `Effect Mask Bake (${layer.id})`,
      });
      scratch.push(raw);
      const baked = new LayerTexture({
        texture: raw,
        width: dstW,
        height: dstH,
        allocatedWidth: snapToPowerOfTwo(dstW),
        allocatedHeight: snapToPowerOfTwo(dstH),
        format: workingFormat,
      });
      const uniform = packEffectMaskBakeUniform(dstW, dstH, {
        hasBmask: !!bmaskTex,
        hasVmask: !!vmaskBake,
        contentWidth: content.width,
        contentHeight: content.height,
        contentOffsetX: bx0,
        contentOffsetY: by0,
        baseOriginInDstX: base.x - bx0,
        baseOriginInDstY: base.y - by0,
        baseWidth: base.w,
        baseHeight: base.h,
        contentLogicalWidth: base.w / density,
        contentLogicalHeight: base.h / density,
        vmaskWindow: vmaskBake?.window,
      });
      const slot = ctx.bufferRing.writeSlot(uniform);
      const bindGroup = ctx.device.createBindGroup({
        layout: ctx.pipelineCache.getEffectMaskBakeBindGroupLayout(workingFormat),
        label: `Effect Mask Bake BindGroup (${layer.id})`,
        entries: [
          {
            binding: 0,
            resource: { buffer: ctx.bufferRing.getBuffer(), offset: 0, size: EFFECT_MASK_BAKE_UNIFORM_BUFFER_SIZE },
          },
          { binding: 1, resource: content.view },
          { binding: 2, resource: bmaskTex ? bmaskTex.view : ctx.pipelineCache.getDefaultMaskView() },
          { binding: 3, resource: vmaskBake ? vmaskBake.texture.view : ctx.pipelineCache.getDefaultMaskView() },
          { binding: 4, resource: ctx.pipelineCache.getLinearSampler() },
          { binding: 5, resource: baked.view },
        ],
      });
      const pass = encoder.beginComputePass({ label: `Effect Mask Bake (${layer.id})` });
      pass.setPipeline(ctx.pipelineCache.getEffectMaskBakePipeline(workingFormat));
      pass.setBindGroup(0, bindGroup, [slot.offset]);
      pass.dispatchWorkgroups(
        Math.ceil(dstW / EFFECT_MASK_BAKE_WORKGROUP),
        Math.ceil(dstH / EFFECT_MASK_BAKE_WORKGROUP),
        1,
      );
      pass.end();
      content = baked;
      if (!solidColor) {
        base = { x: base.x - bx0, y: base.y - by0, w: base.w, h: base.h };
        contentToWindow = { x: contentToWindow.x + bx0, y: contentToWindow.y + by0 };
      }
    }

    // ── 2. Stroke chain ─────────────────────────────────────────────────
    // The window expands ONCE for the LARGEST radius (every instance's
    // dilation stays inside one allocation), around the content-texture rect
    // the stroke rings. Coordinates:
    //   windowTexel — CONTENT-texture texel space (the EffectStrokePass's
    //     first dispatch samples the content with this window offset, so a
    //     cropped shared asset only dilates around its visible crop).
    //   contentWindow (below) — the same window in the OUTPUT reporting
    //     space: asset texels for raster (the compositor recovers logical px
    //     through layer.dprScale, the same contract filter windows run
    //     under); logical px for vector (window/density) and solid (the
    //     materialized texture is already the expanded window).
    const pads = effectWindowPadsPx([...stages, ...shadows]);
    const windowTexel: TexelRect = solidColor
      ? { x: 0, y: 0, w: content.width, h: content.height }
      : expandWindowForPads(
          base,
          {
            left: pads.left * density,
            top: pads.top * density,
            right: pads.right * density,
            bottom: pads.bottom * density,
          },
        );

    // The shadow silhouette derives from the ORIGINAL content (never from the
    // stroke output — a stroke ring must not fatten the shadow), so capture
    // the post-mask-bake texture + geometry before the stroke chain reassigns
    // `current`. The visibility crop above already shrank this texture to the
    // base rect when the layer is a cropped shared-asset fragment.
    const silhouette = content;

    let current = content;
    let currentIsLinear = contentIsLinear;
    let currentGamutId = gamutId;
    const baseAlphaKey = `${content.width}x${content.height}|b:${bmaskTex ? 1 : 0}|v:${vmaskBake ? 1 : 0}|a:${layer.adjustStages?.length ?? 0}|f:${prepared.contentWindow ? 1 : 0}`;
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      if (stage.kind !== 'stroke') continue;
      const cacheId = `${layer.id}#${i}`;
      activeEdtKeys.add(cacheId);
      // Only the FIRST instance faces the original content (window offset
      // inside it); later instances consume the previous window-aligned
      // output, whose origin IS the window origin.
      const windowInContent: TexelRect = i === 0
        ? windowTexel
        : { x: 0, y: 0, w: windowTexel.w, h: windowTexel.h };
      current = EffectStrokePass.run(encoder, ctx, {
        layerId: layer.id,
        instanceIndex: i,
        content: current,
        windowTexel: windowInContent,
        contentIsLinear: currentIsLinear,
        gamutId: currentGamutId,
        strokeColor: stage.color,
        widthTexels: stage.widthPx * density,
        position: stage.position,
        contentVisibleTexel: i === 0 ? base : undefined,
        edtAlphaKey: i === 0 ? baseAlphaKey : undefined,
      });
      // Subsequent instances compose over the previous output: already
      // working-LINEAR in the working gamut.
      currentIsLinear = true;
      currentGamutId = 0;
    }

    // The shadow spread's EDT lives in its own cache slot per instance —
    // register it in the sweep guard or the sweep destroys the entry every
    // frame (the cache would never survive past one frame).
    shadows.forEach((_, i) => activeEdtKeys.add(`${layer.id}:shadow-spread#${i}`));

    // ── 2b. Shadow chain ────────────────────────────────────────────────
    // Runs AFTER the strokes: each shadow composites BENEATH the accumulated
    // foreground, giving the fixed cross-category z-order shadow beneath
    // stroke beneath content. The blur taps read the SILHOUETTE captured
    // above; SRC_ZERO_OOB makes taps beyond a cropped silhouette truthful
    // transparency (a full-content silhouette's own bounds already are).
    // The blur ALWAYS samples the captured silhouette at the window offset
    // (the silhouette never becomes window-aligned — strokes do, shadows do
    // not). Only the FOREGROUND side of the compose switches coordinates: the
    // raw content's top-left sits at -windowTexel inside the window, while a
    // stroke-composed foreground is already window-aligned.
    let currentAligned = stages.length > 0;
    for (let i = 0; i < shadows.length; i++) {
      const stage = shadows[i];
      if (stage.kind !== 'shadow') continue;
      const currentOrigin: TexelRect = currentAligned
        ? { x: 0, y: 0, w: current.width, h: current.height }
        : { x: -windowTexel.x, y: -windowTexel.y, w: current.width, h: current.height };
      current = EffectShadowPass.run(encoder, ctx, {
        layerId: layer.id,
        current,
        silhouette,
        windowTexel,
        currentIsLinear,
        gamutId: currentGamutId,
        currentOriginTexel: currentOrigin,
        offsetX: stage.offsetX * density,
        offsetY: stage.offsetY * density,
        blurRadius: stage.blurRadius * density,
        spreadTexels: (stage.spreadPx ?? 0) * density,
        instanceIndex: i,
        edtAlphaKey: baseAlphaKey,
        shadowColor: stage.color,
        opacity: stage.opacity,
      });
      // The compose output is working-LINEAR in the working gamut,
      // window-aligned — later stages and the output declaration agree.
      currentIsLinear = true;
      currentGamutId = 0;
      currentAligned = true;
    }

    // ── 3. Output declaration ───────────────────────────────────────────
    // Vector/solid windows report in LOGICAL px (their compositor-side dpr is
    // 1); raster windows report in ASSET texels (the compositor recovers
    // logical px through layer.dprScale — the same contract the filter
    // windows already run under).
    const isLogicalReport = solidColor || layer.source.kind === 'vector';
    const div = isLogicalReport ? density : 1;
    const contentWindow = {
      x: (contentToWindow.x + windowTexel.x) / div,
      y: (contentToWindow.y + windowTexel.y) / div,
      w: windowTexel.w / div,
      h: windowTexel.h / div,
      // Explicit basis: raster windows are in ASSET texels (the compositor
      // recovers logical px through layer.dprScale); vector/solid windows are
      // already in the layer's LOCAL LOGICAL px — the compositor must not
      // divide by anything (vector dpr is 1 by construction, and a stale
      // layer.dprScale on the node must not squeeze the quad).
      basis: (isLogicalReport ? 'content-local' : 'asset') as 'content-local' | 'asset',
    };

    sources.set(layer.id, {
      texture: current,
      // The grade (if any) is baked into the composed pixels; the composite
      // must not re-apply it — and must not grade the stroke either.
      suppressAdjust: true,
      vectorTransient: false,
      sourceIsLinear: true,
      sourceIsWorkingGamut: true,
      sourceIntentApplied: prepared.sourceIntentApplied,
      contentWindow,
      expandQuadToWindow: true,
      maskFree: true,
    });
  }
  sweepEdtCache(activeEdtKeys);
}
