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
 * RenderGraph.ts — Executes the compiled scene DAG (spec §6.3, §7.2; 缺陷 5 §5).
 *
 * COMPOSE-ONCE, VIEW-MANY (缺陷 5 §5):
 * The graph has two INDEPENDENTLY-CALLABLE halves so the engine can cache the
 * composite and replay only the cheap view pass on pan/zoom:
 *   • `composite(compiled, target, ctx)` — composite all layers into the given
 *     document-space texture (camera-INDEPENDENT). One submit.
 *   • `present(compositeTex, ctx)` — map that texture onto the swapchain applying
 *     the camera (`scene.view.transform`). One submit. Pan/zoom only runs this.
 *   • `execute(compiled, ctx)` — convenience orchestrator (acquire target →
 *     composite → present → release) for callers that do NOT cache (tests /
 *     export). The engine's render path calls the two halves directly (阶段 2).
 *
 * @module core/gpu/graph/RenderGraph
 */

import type { PipelineCache } from '../resources/PipelineCache';
import type { BufferRing } from '../resources/BufferRing';
import type { TexturePool } from '../resources/TexturePool';
import { snapToPowerOfTwo } from '../resources/TexturePool';
import { LayerTexture } from '../resources/LayerTexture';
import type { Scene } from '../scene/Scene';
import type { CompiledScene } from './SceneCompiler';
import { CompositePass, type CompositePassContext } from './passes/CompositePass';
import { BlendPass, type BlendPassContext } from './passes/BlendPass';
import { ViewPass, type ViewPassContext, composeViewMatrix } from './passes/ViewPass';
import { effectiveScale } from './passes/layerGeometry';

/** Context for the compositing half (camera-independent, document space). */
export interface CompositeContext {
  readonly device: GPUDevice;
  readonly pipelineCache: PipelineCache;
  readonly bufferRing: BufferRing;
  readonly texturePool: TexturePool;
  readonly assets: Map<string, LayerTexture>;
  readonly workingFormat?: GPUTextureFormat;
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
    // §6.2: pool snaps up to POT buckets; carry both sizes so maxU/maxV scale
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

export class RenderGraph {
  /**
   * Composite all layers into a fresh document-space texture (camera-
   * INDEPENDENT). Submits one command buffer. Returns the composite (caller
   * keeps as cache) + scratch textures to release now. 阶段 2: the engine calls
   * this ONLY when the content signature changes.
   */
  static composite(compiled: CompiledScene, ctx: CompositeContext): CompositeResult {
    const { device, pipelineCache, bufferRing, texturePool, assets } = ctx;
    const workingFormat: GPUTextureFormat = ctx.workingFormat ?? 'rgba16float';
    const scene = compiled.scene;
    const { frameWidth, frameHeight, allocatedWidth, allocatedHeight } = compositeDims(scene);

    const commandEncoder = device.createCommandEncoder({ label: 'RenderGraph Composite Encoder' });

    if (compiled.isPureDirect) {
      // ── Pure separable: composite all layers into ONE target. ──
      const rawTarget = texturePool.acquire({
        width: frameWidth,
        height: frameHeight,
        format: workingFormat,
        label: 'RenderGraph Composite Target (pure separable)',
      });
      const target = new LayerTexture({
        texture: rawTarget,
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
      });
      renderPass.setViewport(0, 0, frameWidth, frameHeight, 0, 1);

      const passCtx: CompositePassContext = {
        device,
        pipelineCache,
        bufferRing,
        frameWidth,
        frameHeight,
        targetFormat: workingFormat,
        channelMask: 'rgb', // unswizzled; the view pass applies channelMask
      };

      for (let s = 0; s < compiled.steps.length; s++) {
        const step = compiled.steps[s];
        if (step.kind !== 'separable') continue;
        for (let l = 0; l < step.layers.length; l++) {
          const layer = step.layers[l];
          if (layer.source.kind !== 'raster') continue;
          const asset = assets.get(layer.source.assetId);
          if (!asset) continue;
          const maskTex =
            layer.mask && layer.mask.kind === 'bitmap' ? assets.get(layer.mask.maskId) : undefined;
          CompositePass.drawLayer(renderPass, passCtx, {
            layer,
            texture: asset,
            maskTexture: maskTex,
            isBottomOpaque: false,
          });
        }
      }

      renderPass.end();
      device.queue.submit([commandEncoder.finish()]);
      return { result: target, scratch: [] };
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
    );
  }


  /**
   * Ping-pong compositing for scenes with non-separable blend modes. The result
   * ends in one of the two acquired buffers; that buffer is returned as the
   * cache `result` and the OTHER is returned as scratch to release. No final
   * copy (§7.5 forbids full-canvas copyTextureToTexture).
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
  ): CompositeResult {
    const { device, pipelineCache, bufferRing, texturePool, assets } = ctx;

    const rawA = texturePool.acquire({
      width: frameWidth,
      height: frameHeight,
      format: workingFormat,
      label: 'RenderGraph Ping Target A',
    });
    const rawB = texturePool.acquire({
      width: frameWidth,
      height: frameHeight,
      format: workingFormat,
      label: 'RenderGraph Pong Target B',
    });

    const mkTex = (texture: GPUTexture) =>
      new LayerTexture({ texture, width: frameWidth, height: frameHeight, allocatedWidth, allocatedHeight, format: workingFormat });

    let currentAccumulator = mkTex(rawA);
    let currentScratch = mkTex(rawB);
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
        });
        renderPass.setViewport(0, 0, frameWidth, frameHeight, 0, 1);

        const passCtx: CompositePassContext = {
          device, pipelineCache, bufferRing, frameWidth, frameHeight,
          targetFormat: workingFormat, channelMask: 'rgb',
        };

        for (let l = 0; l < step.layers.length; l++) {
          const layer = step.layers[l];
          if (layer.source.kind !== 'raster') continue;
          const asset = assets.get(layer.source.assetId);
          if (!asset) continue;
          const maskTex =
            layer.mask && layer.mask.kind === 'bitmap' ? assets.get(layer.mask.maskId) : undefined;
          CompositePass.drawLayer(renderPass, passCtx, { layer, texture: asset, maskTexture: maskTex, isBottomOpaque: false });
        }

        renderPass.end();
        isFirstStep = false;
      } else if (step.kind === 'non-separable') {
        const layer = step.layer;
        if (layer.source.kind !== 'raster') continue;
        const asset = assets.get(layer.source.assetId);
        if (!asset) continue;
        const maskTex =
          layer.mask && layer.mask.kind === 'bitmap' ? assets.get(layer.mask.maskId) : undefined;

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

        // §7.5 ping-pong: BlendPass reads the accumulator via bound bg_tex and
        // draws a full-frame quad into the scratch with loadOp:'clear' (every
        // pixel rewritten → no copyTextureToTexture, forbidden by §7.5).
        const blendPass = commandEncoder.beginRenderPass({
          label: `NonSeparable Blend Pass (${layer.id} / ${layer.blendMode})`,
          colorAttachments: [
            { view: currentScratch.texture.createView(), clearValue: CLEAR_COLOR, loadOp: 'clear', storeOp: 'store' },
          ],
        });
        blendPass.setViewport(0, 0, frameWidth, frameHeight, 0, 1);

        const blendCtx: BlendPassContext = {
          device, pipelineCache, bufferRing, frameWidth, frameHeight,
          targetFormat: workingFormat, channelMask: 'rgb',
        };

        BlendPass.drawLayer(blendPass, blendCtx, {
          layer, fgTexture: asset, bgTexture: currentAccumulator, maskTexture: maskTex,
        });
        blendPass.end();

        const tmp = currentAccumulator;
        currentAccumulator = currentScratch;
        currentScratch = tmp;
      }
    }

    device.queue.submit([commandEncoder.finish()]);
    // Keep the accumulator as the composite cache; release the other buffer.
    return { result: currentAccumulator, scratch: [currentScratch.texture] };
  }

  /**
   * Present a composited document texture onto the swapchain, applying the
   * camera (缺陷 5 §5). Submits one command buffer. 阶段 2: the engine runs THIS
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
      // 缺陷 3 / §3 阶段 3a: screen physical px per composited texel = the camera's
      // effective scale (canvas→physical). Drives nearest(magnify)/linear(minify).
      sourceScale: effectiveScale(scene.view.transform),
    };

    ViewPass.draw(viewPass, viewCtx, compositeTex);
    viewPass.end();
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
