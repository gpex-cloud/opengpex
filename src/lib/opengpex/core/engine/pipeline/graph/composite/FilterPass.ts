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
 * FilterPass.ts — Neighbourhood (compute) filters for a single layer
 * (separable-Gaussian blur pass).
 *
 * PASS ORCHESTRATION:
 *
 *   resident asset (or the AdjustPrePass bake)
 *          │
 *          ▼  compute pass "H"  — gaussian, axis = X, premultiply on load
 *      ping  (transient, pooled: TEXTURE_BINDING | STORAGE_BINDING | COPY_SRC)
 *          │
 *          ▼  compute pass "V"  — gaussian, axis = Y, un-premultiply on store
 *      pong  (transient, pooled — same bucket as ping, so the two alias/recycle)
 *          │
 *          ▼  returned as the layer's fgTexture for Composite/Blend
 *
 * Multiple filters chain by ping-ponging: the output of one filter becomes the
 * input of the next, and the freed buffer is reused for the following output.
 *
 * ⚠️ RESOURCE LIFETIME — why transients are NOT released here: the returned texture
 * is READ by the compositing pass later in the SAME command encoder, and the
 * intermediates are read by the following dispatch. Releasing them before
 * `queue.submit` would let the pool hand the same GPUTexture to another acquirer
 * mid-frame. So every transient is appended to the caller's `scratch` array, which
 * `RenderGraph.composite` returns and `WebGpuEngine` releases AFTER submit — the
 * mechanism already uses for the ping-pong composite buffers. No new
 * pooling machinery.
 *
 * ⚠️ POOL BUCKETING: `TexturePool` keys buckets on `${w}x${h}:${format}:${usage}`
 * and `release()` re-keys from the stored usage, so the STORAGE_BINDING transients
 * here occupy their own bucket and can never be handed out to a caller expecting a
 * RENDER_ATTACHMENT texture. The usage MUST therefore be passed explicitly — the
 * pool's default usage has no STORAGE_BINDING and the bind group would fail
 * validation.
 *
 * ⚠️ COLOUR SPACE: LINEAR LIGHT. The kernel decodes sRGB→linear on the FIRST
 * dispatch's load (unless told the source is already linear) and every filter's
 * OUTPUT is linear, so `FilterPass.run` threads a `sourceIsLinear` flag through the
 * chain and the composite pass that consumes the result is told the same. See
 * `shaders/gaussian.ts`.
 *
 * @module core/gpu/graph/composite/FilterPass
 */

import type { FilterDesc, LayerNode } from '../../scene/Scene';
import type { PipelineCache } from '@opengpex/editor/core/engine/gpu/resources/PipelineCache';
import type { BufferRing } from '@opengpex/editor/core/engine/gpu/resources/BufferRing';
import type { TexturePool } from '@opengpex/editor/core/engine/gpu/resources/TexturePool';
import { LayerTexture } from '@opengpex/editor/core/engine/gpu/resources/LayerTexture';
import { snapToPowerOfTwo } from '@opengpex/editor/core/engine/gpu/resources/TexturePool';
import { isOversizedTransient } from '@opengpex/editor/core/engine/gpu/resources/oversizedTransient';
import type { ResidentTransientDesc } from '@opengpex/editor/core/engine/gpu/resources/ResidentTransientCache';
import { GPUTextureUsage } from '@opengpex/editor/core/engine/gpu/constants';
import {
  packGaussianUniform,
  gaussianKernelRadius,
  GAUSS_UNIFORM_BUFFER_SIZE,
  GAUSS_WORKGROUP_SIZE,
  GAUSS_AXIS_HORIZONTAL,
  GAUSS_AXIS_VERTICAL,
  GAUSS_FLAG_PREMULTIPLY_ON_LOAD,
  GAUSS_FLAG_UNPREMULTIPLY_ON_STORE,
  GAUSS_FLAG_SRC_LINEAR,
  FEATHER_COMBINE_WORKGROUP,
} from '@opengpex/editor/core/engine/gpu/shaders/gaussian';

/** Usage every FilterPass transient needs: sampled, compute-written, copyable. */
export const FILTER_TRANSIENT_USAGE =
  GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC;

export interface FilterPassContext {
  readonly device: GPUDevice;
  readonly pipelineCache: PipelineCache;
  readonly bufferRing: BufferRing;
  readonly texturePool: TexturePool;
  /** Storage format for the transients — the negotiated working format. */
  readonly workingFormat: 'rgba16float' | 'rgba32float';
  /** Transients are appended here; the caller releases them after submit. */
  readonly scratch: GPUTexture[];
  /**
   * Engine-owned resident-transient provider (render path only; undefined on
   * export). Oversized transients that bypass the POT pool reuse resident slots
   * through it instead of churning `createTexture` every frame — the SAME
   * bypass the full-canvas ping-pong buffers already take in RenderGraph.
   */
  readonly acquireResidentTransient?: (
    key: string,
    desc: ResidentTransientDesc,
  ) => GPUTexture;
}

/**
 * Does this layer need a FilterPass at all?
 *
 * `radius <= 0` is an identity blur, so a layer whose only filter is a zero-radius
 * gaussian takes the NO-filter path and stays bit-exact (identity no-op).
 */
export function hasEffectiveFilters(layer: LayerNode): boolean {
  const filters = layer.filters;
  if (!filters || filters.length === 0) return false;
  return filters.some((f) => isEffectiveFilter(f));
}

/** Is a single descriptor a real (non-identity) operation? */
function isEffectiveFilter(desc: FilterDesc): boolean {
  switch (desc.kind) {
    case 'gaussianBlur':
      return gaussianKernelRadius(desc.radius) > 0;
    case 'alphaFeather':
      // Same σ semantics as blur: radius ≤ 0 is an identity no-op.
      return gaussianKernelRadius(desc.radius) > 0;
    // convolve / pixelate have no state source yet (no UI writes them), so they
    // are inert. The dispatch below throws if one ever arrives, rather than
    // silently dropping it.
    default:
      return false;
  }
}

/** A convolution window in SOURCE-TEXTURE texels (physical asset space). */
export interface FilterWindow {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Derive the WINDOWED-CONVOLUTION rectangle for a filtered layer, or
 * `undefined` when the filter must run over the whole source (no crop →
 * un-windowed, the historical behaviour).
 *
 * WHY A WINDOW AT ALL: fragments share their source ASSET with the origin layer
 * (`SceneAssembler` keys resident textures by assetId), and `layer.crop` is the
 * only thing that narrows what is VISIBLE. Without a window, a 100×100 fragment
 * of a 6000×4000 photo pays the full 24-megapixel convolution. The window is the
 * crop expanded by the kernel reach (`ceil(3σ)`, the largest radius across all
 * effective filters) and clamped to the source bounds — so every texel INSIDE
 * the crop still receives its full kernel support from real source texels and
 * the windowed result is BIT-IDENTICAL to the full-asset convolution there.
 *
 * Units: `layer.crop` is logical px while the source texture is physical
 * (`dprScale` baked bitmaps), so the crop is scaled by `dpr` and the kernel
 * reach is divided back out, keeping the halo measured in real texels.
 */
export function resolveFilterWindow(
  layer: LayerNode,
  srcWidth: number,
  srcHeight: number,
): FilterWindow | undefined {
  if (!layer.crop) return undefined;
  const filters = (layer.filters ?? []).filter(isEffectiveFilter);
  if (filters.length === 0) return undefined;

  // Largest kernel reach across the chain, in LOGICAL px (σ is a logical-slider
  // value; the dispatch applies it to physical texels, so the halo in logical
  // units is reach / dpr).
  const dpr = layer.dprScale && layer.dprScale > 0 ? layer.dprScale : 1;
  let reachLogical = 0;
  for (const f of filters) {
    if (f.kind === 'gaussianBlur' || f.kind === 'alphaFeather') {
      reachLogical = Math.max(reachLogical, gaussianKernelRadius(f.radius) / dpr);
    }
  }

  // Expand + clamp, in source texels. Rounded OUTWARD so the window always
  // contains at least the full kernel support for every crop texel.
  const x0 = Math.max(0, Math.floor(layer.crop.x - reachLogical));
  const y0 = Math.max(0, Math.floor(layer.crop.y - reachLogical));
  const x1 = Math.min(srcWidth, Math.ceil(layer.crop.x + layer.crop.w + reachLogical));
  const y1 = Math.min(srcHeight, Math.ceil(layer.crop.y + layer.crop.h + reachLogical));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return undefined;
  return { x: x0, y: y0, w, h };
}

export class FilterPass {
  /**
   * Run every effective filter on `source`, returning the filtered texture.
   *
   * Records compute passes on `encoder` (each filter opens and closes its own
   * `beginComputePass` — compute and render passes cannot interleave inside one
   * pass encoder, but they can be recorded back-to-back on one command encoder).
   *
   * The returned `LayerTexture` mirrors `source`'s content AND allocated dimensions,
   * so `maxU/maxV` are preserved and `resolveLayerGeometry` downstream is unaffected.
   */
  static run(
    encoder: GPUCommandEncoder,
    ctx: FilterPassContext,
    params: {
      readonly layer: LayerNode;
      readonly source: LayerTexture;
      /**
       * Does `source` already hold LINEAR light? True when it came from
       * `AdjustPrePass`'s rgba16float bake or from a genuinely linear source asset;
       * false for the common sRGB-encoded `rgba8unorm` asset, which the FIRST
       * dispatch then decodes. Passed EXPLICITLY rather than inferred from the
       * texture format, because format does not imply domain (an rgba16float bake
       * is linear, but a hypothetical f16 encoded upload would not be).
       */
      readonly sourceIsLinear?: boolean;
      /**
       * WINDOWED convolution rect (source-texture texels — see
       * {@link resolveFilterWindow}). Undefined → convolve the whole source.
       * The returned texture's content is THIS rect, so the caller must carry
       * it into `PreparedSource.contentWindow` for the compositor's UV map.
       */
      readonly window?: FilterWindow;
    },
  ): LayerTexture {
    const { layer, source } = params;
    const filters = (layer.filters ?? []).filter(isEffectiveFilter);
    if (filters.length === 0) return source;

    const win = params.window;
    let current = source;
    // Only the FIRST filter can face an encoded source; every filter writes linear
    // output, so subsequent ones must not decode again.
    let currentIsLinear = params.sourceIsLinear ?? false;
    // Only the FIRST filter's input is the FULL source texture (window at
    // win.xy inside it); every subsequent filter chains on the previous
    // window-sized output, so its source origin is (0,0).
    let isFirst = true;
    for (const desc of filters) {
      const srcOrigin = win && isFirst ? { x: win.x, y: win.y } : undefined;
      isFirst = false;
      switch (desc.kind) {
        case 'gaussianBlur':
          current = FilterPass.gaussianBlur(encoder, ctx, layer, current, desc.radius, currentIsLinear, win, srcOrigin);
          currentIsLinear = true;
          break;
        case 'alphaFeather':
          current = FilterPass.alphaFeather(encoder, ctx, layer, current, desc.radius, currentIsLinear, win, srcOrigin);
          currentIsLinear = true;
          break;
        default:
          // Unreachable while isEffectiveFilter only admits gaussianBlur and
          // alphaFeather, but an explicit throw beats silently rendering an
          // un-filtered layer if a new FilterDesc arm is wired into the assembler
          // without a GPU implementation.
          throw new Error(
            `FilterPass: no GPU implementation for filter kind '${(desc as FilterDesc).kind}'`,
          );
      }
    }
    return current;
  }

  /**
   * Separable Gaussian: two compute dispatches (H then V) through one transient.
   *
   * ALPHA: premultiply on the FIRST pass's load and un-premultiply on the LAST
   * pass's store, so the convolution runs entirely in premultiplied space (no dark
   * halo at alpha edges) while the input AND output stay STRAIGHT — matching the
   * resident-texture convention every other pass assumes.
   *
   * COLOUR SPACE: pass H decodes sRGB→linear unless `sourceIsLinear`, so the
   * convolution is physically correct. Pass V ALWAYS sets
   * `GAUSS_FLAG_SRC_LINEAR` because its input is pass H's linear output — decoding
   * twice would darken the result. The returned texture holds LINEAR light.
   */
  private static gaussianBlur(
    encoder: GPUCommandEncoder,
    ctx: FilterPassContext,
    layer: LayerNode,
    source: LayerTexture,
    sigma: number,
    sourceIsLinear: boolean,
    win?: FilterWindow,
    srcOrigin?: { readonly x: number; readonly y: number },
  ): LayerTexture {
    const ping = FilterPass.acquireTransient(ctx, layer.id, 'h', win ? { width: win.w, height: win.h } : source);
    const pong = FilterPass.acquireTransient(ctx, layer.id, 'v', win ? { width: win.w, height: win.h } : source);


    // Pass H: source → ping (decode to linear if needed, then premultiply on load;
    // result stays linear + premultiplied). When windowed, the SOURCE is the full
    // texture with the window at srcOrigin — halo taps read real texels beyond
    // the window.
    FilterPass.dispatchGaussian(encoder, ctx, layer, {
      src: source,
      dst: ping,
      sigma,
      axis: GAUSS_AXIS_HORIZONTAL,
      flags:
        GAUSS_FLAG_PREMULTIPLY_ON_LOAD | (sourceIsLinear ? GAUSS_FLAG_SRC_LINEAR : 0),
      label: 'H',
      win,
      srcOrigin,
    });

    // Pass V: ping → pong (input is already LINEAR and premultiplied — never decode
    // twice; restore straight alpha on store). ping is window-sized, origin (0,0).
    FilterPass.dispatchGaussian(encoder, ctx, layer, {
      src: ping,
      dst: pong,
      sigma,
      axis: GAUSS_AXIS_VERTICAL,
      flags: GAUSS_FLAG_UNPREMULTIPLY_ON_STORE | GAUSS_FLAG_SRC_LINEAR,
      label: 'V',
      win,
    });


    return pong;
  }

  /**
   * Edge feather (non-destructive `alphaFeather` filter): soften the BITMAP ALPHA
   * edge without convolving interior colour.
   *
   * WHY NOT JUST `gaussianBlur`: the blur's premultiplied pipeline already
   * implements the normalized convolution — `a' = blurHV(a)`,
   * `bleed = blurHV(c·a) / blurHV(a)` — but its COLOUR is the convolved colour, so
   * textured interior detail is smoothed across the entire opaque region
   * (`c' = blur(c)` wherever the kernel window is fully opaque). Feathering must
   * leave interior pixels alone.
   *
   * THREE DISPATCHES, TWO TRANSIENTS:
   *   ① H blur: source → ping  (premultiply on load — identical to blur's H)
   *   ② V blur: ping → pong    (un-premultiply on store → straight LINEAR bleed
   *      with the feathered alpha; the store's own ε guard zeroes the RGB where
   *      the divisor is denormal, so the bleed can never NaN)
   *   ③ combine: (bleed=pong, orig=source) → ping — pointwise
   *      `c' = mix(bleed.rgb, orig.rgb, orig.a)`, `a' = bleed.a`.
   *      Interior texels (a=1) keep the ORIGINAL colour bit-for-bit; formerly
   *      transparent texels (a=0) take the bleed (extended colour, no halo from
   *      garbage straight-RGB); existing soft edges blend smoothly.
   *   The H intermediate `ping` is recycled as the combine's destination — it is
   *   the returned texture, so an alphaFeather allocates exactly as many
   *   transients as a plain blur.
   *
   * COLOUR SPACE: identical contract to blur — the returned texture holds LINEAR
   * light, `sourceIsLinear` suppresses the double decode (in the combine it gates
   * the decode of the ORIG binding).
   */
  private static alphaFeather(
    encoder: GPUCommandEncoder,
    ctx: FilterPassContext,
    layer: LayerNode,
    source: LayerTexture,
    sigma: number,
    sourceIsLinear: boolean,
    win?: FilterWindow,
    srcOrigin?: { readonly x: number; readonly y: number },
  ): LayerTexture {
    const ping = FilterPass.acquireTransient(ctx, layer.id, 'h', win ? { width: win.w, height: win.h } : source);
    const pong = FilterPass.acquireTransient(ctx, layer.id, 'v', win ? { width: win.w, height: win.h } : source);

    // ①② The blur pipeline verbatim — H premultiplies on load, V un-premultiplies
    // on store (→ normalized-convolution bleed + feathered alpha).
    FilterPass.dispatchGaussian(encoder, ctx, layer, {
      src: source,
      dst: ping,
      sigma,
      axis: GAUSS_AXIS_HORIZONTAL,
      flags:
        GAUSS_FLAG_PREMULTIPLY_ON_LOAD | (sourceIsLinear ? GAUSS_FLAG_SRC_LINEAR : 0),
      label: 'Feather H',
      win,
      srcOrigin,
    });
    FilterPass.dispatchGaussian(encoder, ctx, layer, {
      src: ping,
      dst: pong,
      sigma,
      axis: GAUSS_AXIS_VERTICAL,
      flags: GAUSS_FLAG_UNPREMULTIPLY_ON_STORE | GAUSS_FLAG_SRC_LINEAR,
      label: 'Feather V',
      win,
    });

    // ③ Combine: interior colour back from the original, alpha from the bleed.
    // The ORIG binding is the same full/window source pass ① read — its window
    // offset is the one this chain was given.
    FilterPass.dispatchFeatherCombine(encoder, ctx, layer, {
      bleed: pong,
      orig: source,
      dst: ping,
      sigma,
      sourceIsLinear,
      win,
      srcOrigin,
    });

    return ping;
  }

  /** Record the pointwise alphaFeather COMBINE pass (2D-tiled, 8×8 workgroups). */
  private static dispatchFeatherCombine(
    encoder: GPUCommandEncoder,
    ctx: FilterPassContext,
    layer: LayerNode,
    p: {
      bleed: LayerTexture;
      orig: LayerTexture;
      dst: LayerTexture;
      sigma: number;
      sourceIsLinear: boolean;
      win?: FilterWindow;
      srcOrigin?: { readonly x: number; readonly y: number };
    },
  ): void {
    const { device, pipelineCache, bufferRing } = ctx;
    const width = p.bleed.width;
    const height = p.bleed.height;

    // Reuses the Gaussian uniform layout (dims + flags + the windowed source
    // offset are read; weights are packed but ignored by cs_feather_combine).
    // `orig` may be the FULL source with the window at srcOrigin inside it.
    const uniform = packGaussianUniform(
      p.sigma,
      width,
      height,
      GAUSS_AXIS_HORIZONTAL,
      p.sourceIsLinear ? GAUSS_FLAG_SRC_LINEAR : 0,
      p.srcOrigin
        ? {
            width: p.orig.width,
            height: p.orig.height,
            originX: p.srcOrigin.x,
            originY: p.srcOrigin.y,
          }
        : undefined,
    );
    const slot = bufferRing.writeSlot(uniform);

    const bindGroup = device.createBindGroup({
      layout: pipelineCache.getFeatherCombineBindGroupLayout(ctx.workingFormat),
      label: `Feather Combine BindGroup (${layer.id})`,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: bufferRing.getBuffer(),
            offset: 0,
            size: GAUSS_UNIFORM_BUFFER_SIZE,
          },
        },
        { binding: 1, resource: p.bleed.view },
        { binding: 2, resource: p.orig.view },
        { binding: 3, resource: p.dst.view },
      ],
    });

    const pass = encoder.beginComputePass({ label: `Feather Combine (${layer.id})` });
    pass.setPipeline(pipelineCache.getFeatherCombinePipeline(ctx.workingFormat));
    pass.setBindGroup(0, bindGroup, [slot.offset]);
    pass.dispatchWorkgroups(
      Math.ceil(width / FEATHER_COMBINE_WORKGROUP),
      Math.ceil(height / FEATHER_COMBINE_WORKGROUP),
      1,
    );
    pass.end();
  }

  /**
   * Acquire a transient matching `like`'s content size, registering it in `scratch`
   * for post-submit release. The pooled texture may be LARGER (power-of-two bucket),
   * so the wrapper carries both the content and allocated dimensions.
   *
   * OVERSIZED BYPASS: a transient whose POT-snapped extent exceeds the pool ladder
   * ceiling (4096) must not enter the pool — a single rgba16float block at that size
   * is ≥128 MiB, so a blur's ping+pong release pair trips `evictOldest` EVERY frame
   * and the next frame re-runs `createTexture` (the exact churn the pool exists to
   * prevent; see oversizedTransient.ts). Mirrors RenderGraph's ping-pong routing:
   *   • render path (resident provider present) → engine-owned exact-size slot,
     *   reused in place across frames; NOT pushed to `scratch` (releasing it would
     *   destroy the resident slot).
   *   • export path (no provider) → one-shot EXACT-size texture, pushed to
   *     `scratch` (post-submit `release` destroys the untracked texture; exact
   *     size also avoids the POT ladder's up-to-4× area waste).
   */
  private static acquireTransient(
    ctx: FilterPassContext,
    layerId: string,
    slot: string,
    content: { readonly width: number; readonly height: number },
  ): LayerTexture {
    if (isOversizedTransient(content.width, content.height)) {
      const desc: ResidentTransientDesc = {
        width: content.width,
        height: content.height,
        format: ctx.workingFormat,
        usage: FILTER_TRANSIENT_USAGE,
        label: `FilterPass Oversized Transient (${layerId} ${slot})`,
      };
      const texture = ctx.acquireResidentTransient
        ? ctx.acquireResidentTransient(`filter:${layerId}:${slot}`, desc)
        : ctx.device.createTexture({ size: [content.width, content.height, 1], format: ctx.workingFormat, usage: FILTER_TRANSIENT_USAGE, label: desc.label });
      if (!ctx.acquireResidentTransient) ctx.scratch.push(texture);
      // Exact-size ⇒ allocated == content.
      return new LayerTexture({
        texture,
        width: content.width,
        height: content.height,
        allocatedWidth: content.width,
        allocatedHeight: content.height,
        format: ctx.workingFormat,
      });
    }
    const texture = ctx.texturePool.acquire({
      width: content.width,
      height: content.height,
      format: ctx.workingFormat,
      // MUST be explicit: the pool default lacks STORAGE_BINDING (and would land in
      // the render-attachment bucket) — see the module header.
      usage: FILTER_TRANSIENT_USAGE,
      label: 'FilterPass Transient',
    });
    ctx.scratch.push(texture);
    return new LayerTexture({
      texture,
      width: content.width,
      height: content.height,
      allocatedWidth: snapToPowerOfTwo(content.width),
      allocatedHeight: snapToPowerOfTwo(content.height),
      format: ctx.workingFormat,
    });
  }

  /** Record ONE 1D Gaussian pass. */
  private static dispatchGaussian(
    encoder: GPUCommandEncoder,
    ctx: FilterPassContext,
    layer: LayerNode,
    p: {
      src: LayerTexture;
      dst: LayerTexture;
      sigma: number;
      axis: number;
      flags: number;
      label: string;
      /** WINDOWED convolution: output rect (src texel space). Undefined → full. */
      win?: FilterWindow;
      /** The source is the FULL texture with the window at this offset inside it. */
      srcOrigin?: { readonly x: number; readonly y: number };
    },
  ): void {
    const { device, pipelineCache, bufferRing } = ctx;
    // Output (window) dims; `dims` un-windowed == src dims (historical behaviour).
    const width = p.win?.w ?? p.src.width;
    const height = p.win?.h ?? p.src.height;

    // Windowed: the source may be the FULL texture with the window at srcOrigin.
    const uniform = packGaussianUniform(
      p.sigma,
      width,
      height,
      p.axis,
      p.flags,
      p.win
        ? {
            width: p.src.width,
            height: p.src.height,
            originX: p.srcOrigin?.x ?? 0,
            originY: p.srcOrigin?.y ?? 0,
          }
        : undefined,
    );
    const slot = bufferRing.writeSlot(uniform);

    const bindGroup = device.createBindGroup({
      layout: pipelineCache.getFilterBindGroupLayout(ctx.workingFormat),
      label: `Gaussian ${p.label} BindGroup (${layer.id})`,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: bufferRing.getBuffer(),
            offset: 0,
            size: GAUSS_UNIFORM_BUFFER_SIZE,
          },
        },
        { binding: 1, resource: p.src.view },
        { binding: 2, resource: p.dst.view },
      ],
    });

    const pass = encoder.beginComputePass({ label: `Gaussian ${p.label} (${layer.id})` });
    pass.setPipeline(pipelineCache.getGaussianPipeline(ctx.workingFormat));
    pass.setBindGroup(0, bindGroup, [slot.offset]);
    // One workgroup covers GAUSS_WORKGROUP_SIZE pixels along the FILTERED axis; the
    // y dimension enumerates the lines perpendicular to it (workgroup tiling).
    const axisLen = p.axis === GAUSS_AXIS_HORIZONTAL ? width : height;
    const lineCount = p.axis === GAUSS_AXIS_HORIZONTAL ? height : width;
    pass.dispatchWorkgroups(Math.ceil(axisLen / GAUSS_WORKGROUP_SIZE), lineCount, 1);
    pass.end();
  }
}
