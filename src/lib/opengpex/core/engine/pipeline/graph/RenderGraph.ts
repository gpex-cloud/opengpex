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
 * RenderGraph.ts — Executes the compiled scene DAG.
 *
 * COMPOSE-ONCE, VIEW-MANY:
 * The graph has two INDEPENDENTLY-CALLABLE halves so the engine can cache the
 * composite and replay only the cheap view pass on pan/zoom:
 *   • `composite(compiled, target, ctx)` — composite all layers into the given
 *     document-space texture (camera-INDEPENDENT). One submit.
 *   • `present(compositeTex, ctx)` — map that texture onto the swapchain applying
 *     the camera (`scene.view.transform`). One submit. Pan/zoom only runs this.
 *   • `execute(compiled, ctx)` — convenience orchestrator (acquire target →
 *     composite → present → release) for callers that do NOT cache (tests /
 *     export). The engine's render path calls the two halves directly.
 *
 * @module core/gpu/graph/RenderGraph
 */

import type { PipelineCache } from '@opengpex/editor/core/engine/gpu/resources/PipelineCache';
import type { BufferRing } from '@opengpex/editor/core/engine/gpu/resources/BufferRing';
import type { TexturePool } from '@opengpex/editor/core/engine/gpu/resources/TexturePool';
import type { GpuTimer } from '@opengpex/editor/core/engine/gpu/resources/GpuTimer';
import { snapToPowerOfTwo } from '@opengpex/editor/core/engine/gpu/resources/TexturePool';
import { isOversizedTransient } from '@opengpex/editor/core/engine/gpu/resources/oversizedTransient';
import { LayerTexture } from '@opengpex/editor/core/engine/gpu/resources/LayerTexture';
import { GPUTextureUsage } from '@opengpex/editor/core/engine/gpu/constants';
import type { ResidentTransientDesc } from '@opengpex/editor/core/engine/gpu/resources/ResidentTransientCache';
import type { Scene, LayerNode } from '../scene/Scene';
import type { CompiledScene } from './SceneCompiler';
import { CompositePass, type CompositePassContext } from './composite/CompositePass';
import { BlendPass, type BlendPassContext } from './composite/BlendPass';
import { ViewPass, type ViewPassContext, composeViewMatrix } from './present/ViewPass';
import { vectorExportScale } from './support/vectorTransient';
import { effectiveScale } from './support/layerGeometry';
import { prepareFilteredSources } from './build/prepareFilteredSources';
import { prepareVectorSources } from './build/prepareVectorSources';
import { prepareVmaskSources } from './build/prepareVmaskSources';
import { prepareBmaskCombineSources } from './build/prepareBmaskCombine';
import type { BuildContext, PreparedSource } from './build/types';

/** Context for the compositing half (camera-independent, document space). */
export interface CompositeContext {
  readonly device: GPUDevice;
  readonly pipelineCache: PipelineCache;
  readonly bufferRing: BufferRing;
  readonly texturePool: TexturePool;
  readonly assets: Map<string, LayerTexture>;
  readonly workingFormat?: GPUTextureFormat;
  /** Resolve a resident curves/levels 1D LUT view by lutId. */
  readonly resolveLutView?: (lutId: string) => GPUTextureView | undefined;
  /** Resolve a resident 3D `.cube` LUT view by lutId. */
  readonly resolveLut3dView?: (lutId: string) => GPUTextureView | undefined;
  /**
   * Monotonically-increasing epoch per resident asset id, bumped on every
   * GENUINE re-transfer. Keys the bmask combine cache: a record re-upload
   * (e.g. a live fast-override stroke) must re-combine that layer's mask.
   */
  readonly getAssetEpoch?: (assetId: string) => number;
  /** Optional export viewport & destination size */
  readonly exportViewport?: ExportViewport;
  /**
   * The engine-owned, EXACT-size composite target, reused in
   * place across frames. When present, the composite renders INTO it instead of
   * acquiring a POT-bucketed pool target — this is what avoids per-frame
   * large buffer allocation/destruction churn. Its dims MUST equal the composite frame
   * dims (docW×docH). Export/tests do NOT pass it (they still pool a one-shot
   * target and, in export's case, may drive a different `exportViewport` size).
   */
  readonly target?: LayerTexture;
  /**
   * Engine-owned exact-size reuse for FULL-CANVAS /
   * oversized transients that must bypass the POT pool (`isOversizedTransient`).
   * When present (render path), the vector-stroke transient + ping-pong buffers
   * are `acquire`d from the engine's `ResidentTransientCache` — resident, reused
   * in place, swept when idle — instead of thrashing large blocks through the
   * pool every frame. Absent on export/tests, which fall back to a
   * one-shot exact-size texture destroyed after the frame (via `scratch`).
   */
  readonly acquireResidentTransient?: (key: string, desc: ResidentTransientDesc) => GPUTexture;
  /** [PERF_MON] When set, each composite render pass writes GPU begin/end timestamps. */
  readonly gpuTimer?: GpuTimer;
}

/**
 * Viewport mapping specification for offscreen render / export.
 * Maps an optional sub-region of world space [srcX, srcY, srcW, srcH] to a target destination framebuffer (targetWidth × targetHeight).
 */
export interface ExportViewport {
  /** Target physical output width (Framebuffer width in pixels) */
  readonly targetWidth: number;
  /** Target physical output height (Framebuffer height in pixels) */
  readonly targetHeight: number;
  /** Optional source region [srcX, srcY, srcW, srcH] in scene world space. Defaults to full frame [0, 0, frameWidth, frameHeight]. */
  readonly sourceRect?: readonly [number, number, number, number];
}

/** Context for the view/present half (camera-dependent, swapchain). */
export interface PresentContext {
  readonly device: GPUDevice;
  readonly pipelineCache: PipelineCache;
  readonly bufferRing: BufferRing;
  readonly currentView: GPUTextureView;
  readonly targetFormat: GPUTextureFormat;
  /** The Scene whose `view` + `frame` + `display` drive the present. */
  readonly scene: Scene;
  /** [PERF_MON] When set, the view pass writes GPU begin/end timestamps. */
  readonly gpuTimer?: GpuTimer;
}

/** Combined context for the non-caching `execute` orchestrator. */
export interface RenderGraphContext {
  readonly device: GPUDevice;
  readonly pipelineCache: PipelineCache;
  readonly bufferRing: BufferRing;
  readonly texturePool: TexturePool;
  readonly assets: Map<string, LayerTexture>;
  readonly currentView: GPUTextureView;
  readonly targetFormat: GPUTextureFormat;
  readonly workingFormat?: GPUTextureFormat;
  /** Resolve a resident curves/levels 1D LUT view by lutId. */
  readonly resolveLutView?: (lutId: string) => GPUTextureView | undefined;
  /** Resolve a resident 3D `.cube` LUT view by lutId. */
  readonly resolveLut3dView?: (lutId: string) => GPUTextureView | undefined;
  /** Per-asset epoch (bmask combine cache keying) — see {@link CompositeContext}. */
  readonly getAssetEpoch?: (assetId: string) => number;
  /** Optional export viewport & destination size */
  readonly exportView?: {
    readonly targetWidth: number;
    readonly targetHeight: number;
    readonly srcX: number;
    readonly srcY: number;
    readonly srcW: number;
    readonly srcH: number;
  };
}

const CLEAR_COLOR: GPUColor = { r: 0, g: 0, b: 0, a: 0 };

/** Document composite dimensions derived from a Scene's frame. */
export function compositeDims(scene: Scene): {
  frameWidth: number;
  frameHeight: number;
  allocatedWidth: number;
  allocatedHeight: number;
} {
  const frameWidth = Math.max(1, scene.frame.width);
  const frameHeight = Math.max(1, scene.frame.height);
  return {
    frameWidth,
    frameHeight,
    // Pool snaps up to POT buckets; carry both sizes so maxU/maxV scale
    // the view-pass UV to the content rect (not the whole allocation).
    allocatedWidth: snapToPowerOfTwo(frameWidth),
    allocatedHeight: snapToPowerOfTwo(frameHeight),
  };
}

/** Result of a compositing pass. */
export interface CompositeResult {
  /**
   * The composited document texture. Checked out from the pool and OWNED BY THE
   * CALLER across frames (the composite cache) — release its `.texture` back to
   * the pool when re-compositing or tearing down.
   */
  readonly result: LayerTexture;
  /** Transient scratch textures to release immediately after this call. */
  readonly scratch: GPUTexture[];
}

/**
 * The base texture a composite/blend guard should draw for `layer`, or `undefined`
 * to skip it. Unifies the source kinds behind the guards:
 *   • a PREPARED transient (filtered raster, or a vector source) always wins;
 *   • else a raster layer draws its resident asset;
 *   • else (a vector source whose prepass was skipped) → skip.
 */
function resolveGuardTexture(
  layer: LayerNode,
  assets: Map<string, LayerTexture>,
  prepared: Map<string, PreparedSource>,
): LayerTexture | undefined {
  const prep = prepared.get(layer.id);
  if (prep) return prep.texture;
  if (layer.source.kind === 'raster') return assets.get(layer.source.assetId);
  return undefined;
}

export class RenderGraph {
  /**
   * Composite all layers into a fresh document-space texture (camera-
   * INDEPENDENT). Submits one command buffer. Returns the composite (caller
   * keeps as cache) + scratch textures to release now. The engine calls
   * this ONLY when the content signature changes.
   */
  static composite(compiled: CompiledScene, ctx: CompositeContext): CompositeResult {
    const { device, pipelineCache, bufferRing, texturePool, assets } = ctx;
    const workingFormat: GPUTextureFormat = ctx.workingFormat ?? 'rgba16float';
    const scene = compiled.scene;

    const ev = ctx.exportViewport;
    const baseDims = compositeDims(scene);
    const frameWidth = ev ? Math.max(1, Math.round(ev.targetWidth)) : baseDims.frameWidth;
    const frameHeight = ev ? Math.max(1, Math.round(ev.targetHeight)) : baseDims.frameHeight;
    const allocatedWidth = snapToPowerOfTwo(frameWidth);
    const allocatedHeight = snapToPowerOfTwo(frameHeight);

    const commandEncoder = device.createCommandEncoder({ label: 'RenderGraph Composite Encoder' });

    // Record ALL filter compute work up-front — a compute pass cannot
    // begin while a render pass is open. `filterScratch` transients are released by
    // the caller after submit, alongside the ping-pong scratch.
    const filterScratch: GPUTexture[] = [];
    const buildCtx: BuildContext = {
      ...ctx,
      workingFormat: workingFormat as 'rgba16float' | 'rgba32float',
      scratch: filterScratch,
    };
    const filtered = prepareFilteredSources(commandEncoder, compiled, buildCtx);

    // Vector spine: render every vector layer to its own transient up-front
    // and merge into the SAME map, so the four composite guards below treat them as
    // ordinary straight-alpha raster sources. Also recorded before any composite
    // render pass opens (its per-source render passes cannot nest inside one).
    // Supersample the transient to the export density so 2×/4× exports stay
    // razor-sharp (`vectorExportScale` is [1,1] on the interactive path).
    const vectorScale = vectorExportScale(ev, baseDims.frameWidth, baseDims.frameHeight);
    prepareVectorSources(commandEncoder, compiled, buildCtx, filtered, vectorScale);

    // Bake every POLYGON vmask into an owned coverage texture, keyed by
    // layer id. Recorded here (before any composite render pass opens) because the
    // fill is a compute pass. Analytic vmasks are NOT in this map — they solve
    // per-fragment. The map threads into every drawLayer as `vmaskTexture`.
    const vmaskSources = new Map<string, LayerTexture>();
    prepareVmaskSources(commandEncoder, compiled, buildCtx, vmaskSources, vectorScale);

    // Combine every layer's enabled bmask records into ONE owned coverage
    // texture, keyed by layer id (the retired stack slots' replacement). Also
    // a compute phase, recorded before any composite render pass opens. Layers
    // with a single soft erase record bind their record texture directly
    // (identity fast path — zero dispatch).
    const bmaskSources = new Map<string, LayerTexture>();
    prepareBmaskCombineSources(commandEncoder, compiled, buildCtx, bmaskSources);

    if (compiled.isPureDirect) {
      // ── Pure separable: composite all layers into ONE target. ──
      // Reuse the engine-owned exact-size target when provided; otherwise
      // (export/tests) acquire a one-shot POT pool target as before.
      const target =
        ctx.target ??
        new LayerTexture({
          texture: texturePool.acquire({
            width: frameWidth,
            height: frameHeight,
            format: workingFormat,
            label: 'RenderGraph Composite Target (pure separable)',
          }),
          width: frameWidth,
          height: frameHeight,
          allocatedWidth,
          allocatedHeight,
          format: workingFormat,
        });

      const renderPass = commandEncoder.beginRenderPass({
        label: 'Composite Pass (pure separable)',
        colorAttachments: [
          { view: target.texture.createView(), clearValue: CLEAR_COLOR, loadOp: 'clear', storeOp: 'store' },
        ],
        timestampWrites: ctx.gpuTimer?.pass('composite(pure)'),
      });
      renderPass.setViewport(0, 0, frameWidth, frameHeight, 0, 1);

      const passCtx: CompositePassContext = {
        device,
        pipelineCache,
        bufferRing,
        frameWidth,
        frameHeight,
        targetFormat: workingFormat,
        resolveLutView: ctx.resolveLutView,
        resolveLut3dView: ctx.resolveLut3dView,
        exportViewport: ev,
      };

      for (let s = 0; s < compiled.steps.length; s++) {
        const step = compiled.steps[s];
        if (step.kind !== 'separable') continue;
        for (let l = 0; l < step.layers.length; l++) {
          const layer = step.layers[l];
          // Prefer a prepared transient (filtered raster OR a vector source);
          // else a raster layer draws its resident asset; else skip (stroke).
          const src = filtered.get(layer.id);
          const texture = resolveGuardTexture(layer, assets, filtered);
          if (!texture) continue;
          // The COMBINED bmask coverage (bmask combine pass). Absent → unmasked.
          const maskTex = bmaskSources.get(layer.id);
          CompositePass.drawLayer(renderPass, passCtx, {
            layer,
            texture,
            maskTexture: maskTex,
            vmaskTexture: vmaskSources.get(layer.id),
            isBottomOpaque: false,
            suppressAdjust: src?.suppressAdjust,
            sourceIsLinear: src?.sourceIsLinear,
            sourceIsWorkingGamut: src?.sourceIsWorkingGamut,
            sourceIntentApplied: src?.sourceIntentApplied,
          });
        }
      }

      renderPass.end();
      ctx.gpuTimer?.resolve(commandEncoder);
      device.queue.submit([commandEncoder.finish()]);
      return { result: target, scratch: filterScratch };
    }

    return RenderGraph.compositePingPong(
      compiled,
      ctx,
      commandEncoder,
      workingFormat,
      frameWidth,
      frameHeight,
      allocatedWidth,
      allocatedHeight,
      filtered,
      vmaskSources,
      bmaskSources,
      filterScratch,
      ev,
    );
  }


  /**
   * Ping-pong compositing for scenes with non-separable blend modes. The result
   * ends in one of the two acquired buffers; that buffer is returned as the
   * cache `result` and the OTHER is returned as scratch to release. No final
   * copy (avoiding full-canvas copyTextureToTexture).
   */
  private static compositePingPong(
    compiled: CompiledScene,
    ctx: CompositeContext,
    commandEncoder: GPUCommandEncoder,
    workingFormat: GPUTextureFormat,
    frameWidth: number,
    frameHeight: number,
    allocatedWidth: number,
    allocatedHeight: number,
    filtered: Map<string, PreparedSource>,
    vmaskSources: Map<string, LayerTexture>,
    bmaskSources: Map<string, LayerTexture>,
    filterScratch: GPUTexture[],
    exportViewport?: ExportViewport,
  ): CompositeResult {
    const { device, pipelineCache, bufferRing, texturePool, assets } = ctx;

    const mkTex = (texture: GPUTexture) =>
      new LayerTexture({ texture, width: frameWidth, height: frameHeight, allocatedWidth, allocatedHeight, format: workingFormat });

    // A full-canvas ping-pong buffer is oversized for the POT pool
    // (`isOversizedTransient`) — bypassing the pool prevents allocation churn.
    // Render path (resident provider present): acquire it engine-owned & reused in
    // place, EXACT-size. Export path (no provider): create it exact-size and let it
    // flow out through result/scratch to be destroyed after the frame. Below the
    // threshold it stays pooled (unchanged small-canvas behaviour).
    const oversized = isOversizedTransient(frameWidth, frameHeight);
    const resident = oversized ? ctx.acquireResidentTransient : undefined;
    const BUF_USAGE =
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
    const mkBuf = (key: string, label: string): LayerTexture => {
      if (!oversized) {
        return mkTex(texturePool.acquire({ width: frameWidth, height: frameHeight, format: workingFormat, label }));
      }
      const texture = resident
        ? resident(key, { width: frameWidth, height: frameHeight, format: workingFormat, usage: BUF_USAGE, label })
        : device.createTexture({ size: [frameWidth, frameHeight, 1], format: workingFormat, usage: BUF_USAGE, label });
      // Exact-size ⇒ allocated == content ⇒ maxU=maxV=1.
      return new LayerTexture({ texture, width: frameWidth, height: frameHeight, allocatedWidth: frameWidth, allocatedHeight: frameHeight, format: workingFormat });
    };
    // The engine-owned resident buffer must NOT be released back to the pool at
    // the end (the cache keeps it across frames); a pooled or one-shot one must.
    const scratchIsResident = oversized && !!resident;

    // When the engine hands us its exact-size target, make it ONE
    // of the two ping-pong buffers so the final accumulator lands IN it with no
    // full-canvas copyTextureToTexture. The accumulator starts on buffer A and
    // swaps once per non-separable step, so it ends on A iff the swap count is
    // even — assign `target` to whichever slot ends up final. The OTHER buffer is
    // engine-owned resident when oversized, else a pooled scratch.
    let currentAccumulator: LayerTexture;
    let currentScratch: LayerTexture;
    if (ctx.target) {
      const nonSepCount = compiled.steps.reduce(
        (n, s) => n + (s.kind === 'non-separable' ? 1 : 0),
        0,
      );
      const finalIsA = nonSepCount % 2 === 0;
      const other = mkBuf('pingpong:scratch', 'RenderGraph Ping Scratch');
      if (finalIsA) {
        currentAccumulator = ctx.target;
        currentScratch = other;
      } else {
        currentAccumulator = other;
        currentScratch = ctx.target;
      }
    } else {
      currentAccumulator = mkBuf('pingpong:A', 'RenderGraph Ping Target A');
      currentScratch = mkBuf('pingpong:B', 'RenderGraph Pong Target B');
    }

    let isFirstStep = true;

    for (let s = 0; s < compiled.steps.length; s++) {
      const step = compiled.steps[s];

      if (step.kind === 'separable') {
        const renderPass = commandEncoder.beginRenderPass({
          label: `Separable Batch Pass #${s}`,
          colorAttachments: [
            {
              view: currentAccumulator.texture.createView(),
              clearValue: CLEAR_COLOR,
              loadOp: isFirstStep ? 'clear' : 'load',
              storeOp: 'store',
            },
          ],
          timestampWrites: ctx.gpuTimer?.pass(`sep#${s}`),
        });
        renderPass.setViewport(0, 0, frameWidth, frameHeight, 0, 1);

        const passCtx: CompositePassContext = {
          device, pipelineCache, bufferRing, frameWidth, frameHeight,
          targetFormat: workingFormat,
          resolveLutView: ctx.resolveLutView,
          resolveLut3dView: ctx.resolveLut3dView,
          exportViewport,
        };

        for (let l = 0; l < step.layers.length; l++) {
          const layer = step.layers[l];
          // Prepared transient (filtered raster OR vector source) wins; else
          // a raster layer draws its resident asset; else skip.
          const src = filtered.get(layer.id);
          const texture = resolveGuardTexture(layer, assets, filtered);
          if (!texture) continue;
          // The COMBINED bmask coverage (bmask combine pass). Absent → unmasked.
          const maskTex = bmaskSources.get(layer.id);
          CompositePass.drawLayer(renderPass, passCtx, {
            layer,
            texture,
            maskTexture: maskTex,
            vmaskTexture: vmaskSources.get(layer.id),
            isBottomOpaque: false,
            suppressAdjust: src?.suppressAdjust,
            sourceIsLinear: src?.sourceIsLinear,
            sourceIsWorkingGamut: src?.sourceIsWorkingGamut,
            sourceIntentApplied: src?.sourceIntentApplied,
          });
        }

        renderPass.end();
        isFirstStep = false;
      } else if (step.kind === 'non-separable') {
        const layer = step.layer;
        // Prepared transient (filtered raster OR vector source) wins; else a raster
        // layer blends its resident asset; else skip (stroke).
        const src = filtered.get(layer.id);
        const fgTexture = resolveGuardTexture(layer, assets, filtered);
        if (!fgTexture) continue;
        // The COMBINED bmask coverage (bmask combine pass). Absent → unmasked.
        const maskTex = bmaskSources.get(layer.id);

        if (isFirstStep) {
          const initPass = commandEncoder.beginRenderPass({
            label: 'Initial Background Clear Pass',
            colorAttachments: [
              { view: currentAccumulator.texture.createView(), clearValue: CLEAR_COLOR, loadOp: 'clear', storeOp: 'store' },
            ],
          });
          initPass.end();
          isFirstStep = false;
        }

        // Ping-pong: BlendPass reads the accumulator via bound bg_tex and
        // draws a full-frame quad into the scratch with loadOp:'clear' (every
        // pixel rewritten → no copyTextureToTexture needed).
        const blendPass = commandEncoder.beginRenderPass({
          label: `NonSeparable Blend Pass (${layer.id} / ${layer.blendMode})`,
          colorAttachments: [
            { view: currentScratch.texture.createView(), clearValue: CLEAR_COLOR, loadOp: 'clear', storeOp: 'store' },
          ],
          timestampWrites: ctx.gpuTimer?.pass(`blend(${layer.blendMode})`),
        });
        blendPass.setViewport(0, 0, frameWidth, frameHeight, 0, 1);

        const blendCtx: BlendPassContext = {
          device, pipelineCache, bufferRing, frameWidth, frameHeight,
          targetFormat: workingFormat,
          resolveLutView: ctx.resolveLutView,
          resolveLut3dView: ctx.resolveLut3dView,
          exportViewport,
        };

        // Foreground = the prepared transient (filtered raster / vector source) or
        // the resident asset, resolved once above.
        BlendPass.drawLayer(blendPass, blendCtx, {
          layer,
          fgTexture,
          bgTexture: currentAccumulator,
          maskTexture: maskTex,
          vmaskTexture: vmaskSources.get(layer.id),
          suppressAdjust: src?.suppressAdjust,
          sourceIsLinear: src?.sourceIsLinear,
          sourceIsWorkingGamut: src?.sourceIsWorkingGamut,
          sourceIntentApplied: src?.sourceIntentApplied,
        });
        blendPass.end();

        const tmp = currentAccumulator;
        currentAccumulator = currentScratch;
        currentScratch = tmp;
      }
    }

    ctx.gpuTimer?.resolve(commandEncoder);
    device.queue.submit([commandEncoder.finish()]);
    // The final accumulator is the composite result — the engine-owned `target`
    // when one was passed (parity above guarantees it), else a pooled/one-shot
    // buffer the caller keeps as cache. `currentScratch` is the OTHER full-canvas
    // buffer; return it for release UNLESS it is the engine-owned resident buffer
    // (the cache keeps it across frames, releasing it would destroy it).
    // Filter transients always go back to the pool (submit has consumed them).
    const releasable = scratchIsResident
      ? [...filterScratch]
      : [currentScratch.texture, ...filterScratch];
    return { result: currentAccumulator, scratch: releasable };
  }

  /**
   * Present a composited document texture onto the swapchain, applying the
   * camera. Submits one command buffer. The engine runs THIS
   * every frame; on pan/zoom it is the ONLY work (composite is cached).
   */
  static present(compositeTex: LayerTexture, ctx: PresentContext): void {
    const { device, pipelineCache, bufferRing, currentView, targetFormat, scene } = ctx;
    const { frameWidth, frameHeight } = compositeDims(scene);

    const commandEncoder = device.createCommandEncoder({ label: 'RenderGraph Present Encoder' });

    const viewPass = commandEncoder.beginRenderPass({
      label: 'View Pass (composited document -> swapchain)',
      colorAttachments: [
        { view: currentView, clearValue: CLEAR_COLOR, loadOp: 'clear', storeOp: 'store' },
      ],
      timestampWrites: ctx.gpuTimer?.pass('present'),
    });

    const viewMatrix = composeViewMatrix(
      scene.view.transform,
      frameWidth,
      frameHeight,
      scene.view.target.width,
      scene.view.target.height,
    );

    const viewCtx: ViewPassContext = {
      device,
      pipelineCache,
      bufferRing,
      targetFormat,
      channelMask: scene.display.channelMask,
      viewMatrix,
      // Screen physical px per composited texel = the camera's
      // effective scale (canvas→physical). Drives nearest(magnify)/linear(minify).
      sourceScale: effectiveScale(scene.view.transform),
    };

    ViewPass.draw(viewPass, viewCtx, compositeTex);
    viewPass.end();
    ctx.gpuTimer?.resolve(commandEncoder);
    device.queue.submit([commandEncoder.finish()]);
  }

  /**
   * Convenience orchestrator for callers that do NOT cache the composite
   * (tests / export): composite → present → release EVERYTHING (both the
   * scratch and the composite target). The engine's render path calls
   * `composite` + `present` directly and keeps the composite across frames.
   */
  static execute(compiled: CompiledScene, ctx: RenderGraphContext): void {
    const { result, scratch } = RenderGraph.composite(compiled, {
      device: ctx.device,
      pipelineCache: ctx.pipelineCache,
      bufferRing: ctx.bufferRing,
      texturePool: ctx.texturePool,
      assets: ctx.assets,
      workingFormat: ctx.workingFormat,
      resolveLutView: ctx.resolveLutView,
      resolveLut3dView: ctx.resolveLut3dView,
      getAssetEpoch: ctx.getAssetEpoch,
    });

    RenderGraph.present(result, {
      device: ctx.device,
      pipelineCache: ctx.pipelineCache,
      bufferRing: ctx.bufferRing,
      currentView: ctx.currentView,
      targetFormat: ctx.targetFormat,
      scene: compiled.scene,
    });

    // Non-caching path: return the composite target AND scratch to the pool.
    ctx.texturePool.release(result.texture);
    for (const tex of scratch) ctx.texturePool.release(tex);
  }
}
