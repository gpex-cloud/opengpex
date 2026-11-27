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
 * CompositeChannelCache.ts — Dual-channel (`full` / `roi`) composite target,
 * signature memo, and `below`-layer fast-path cache for `WebGpuEngine`.
 *
 * @module core/engine/pipeline/runtime/CompositeChannelCache
 */

import type { Capabilities } from '@opengpex/editor/core/engine/gpu/device/Capabilities';
import { LayerTexture } from '@opengpex/editor/core/engine/gpu/resources/LayerTexture';
import { TexturePool, estimateTextureBytes } from '@opengpex/editor/core/engine/gpu/resources/TexturePool';
import type { ResidentTransientCache } from '@opengpex/editor/core/engine/gpu/resources/ResidentTransientCache';
import type { PipelineCache } from '@opengpex/editor/core/engine/gpu/resources/PipelineCache';
import type { BufferRing } from '@opengpex/editor/core/engine/gpu/resources/BufferRing';
import type { ResidentAssetRegistry } from '@opengpex/editor/core/engine/gpu/resources/ResidentAssetRegistry';
import {
  derivePoolBudget,
  deriveEngineWorkingSetBudget,
  RESIDENT_COMPOSITE_TARGETS,
} from '@opengpex/editor/core/engine/gpu/resources/poolBudget';
import { GPUTextureUsage } from '@opengpex/editor/core/engine/gpu/constants';
import { SceneCompiler, type CompiledScene } from '@opengpex/editor/core/engine/pipeline/graph/SceneCompiler';
import {
  RenderGraph,
  compositeDims,
  type ExportViewport,
  type TexPlacement,
} from '@opengpex/editor/core/engine/pipeline/graph/RenderGraph';
import type { Scene, LayerNode } from '@opengpex/editor/core/engine/pipeline/scene/Scene';
import { computeCompositeSignature } from '@opengpex/editor/core/engine/pipeline/scene/compositeSignature';
import { effectiveScale } from '@opengpex/editor/core/engine/pipeline/graph/support/layerGeometry';
import { densityCompositeDims, uniformDensity } from '@opengpex/editor/core/engine/pipeline/runtime/densityComposite';
import {
  resolveCompositePlan,
  FALLBACK_MAX_TEXTURE_DIMENSION,
  COMPOSITE_BUDGET_DEFAULT_BYTES,
  workingFormatBpp,
} from '@opengpex/editor/core/engine/pipeline/runtime/compositeBudget';
import { resolveRoiFrame } from '@opengpex/editor/core/engine/pipeline/runtime/roiFrame';
import { PERF_MON } from '@opengpex/editor/core/helpers/config';
import type { RenderPerfMonitor } from './RenderPerfMonitor';

export interface ChannelFrameResult {
  activeTexture: LayerTexture | null;
  activeDensityScale: number;
  activePlacement: TexPlacement | undefined;
  docW: number;
  docH: number;
  sigMs: number;
  sigMiss: boolean;
  recomposited: boolean;
  recompositedRoi: boolean;
  compEncMs: number;
  mode: 'full' | 'roi';
  roiTargetW: number;
  roiTargetH: number;
  roiDensity: number;
}

export class CompositeChannelCache {
  private readonly channel = {
    below: {
      texture: null as LayerTexture | null,
      sig: null as string | null,
      w: 0,
      h: 0,
      format: null as GPUTextureFormat | null,
      densityScale: 1,
      roiKey: null as string | null,
      checkedFullSig: null as string | null,
    },
    roi: {
      texture: null as LayerTexture | null,
      signature: null as string | null,
      rectKey: null as string | null,
      rect: { x: 0, y: 0, w: 0, h: 0 },
      targetW: 0,
      targetH: 0,
      format: null as GPUTextureFormat | null,
      densityScale: 1,
      docW: 0,
      docH: 0,
    },
  };

  private compositeTexture: LayerTexture | null = null;
  private compositeSignature: string | null = null;
  private compositeTargetW = 0;
  private compositeTargetH = 0;
  private compositeFormat: GPUTextureFormat | null = null;

  private planMemo: {
    docW: number;
    docH: number;
    bpp: number;
    deviceMaxDim: number;
    budgetBytes: number;
    density: number;
  } | null = null;
  private planMemoMode: 'full' | 'roi' = 'full';

  private sigMemoLayers: readonly LayerNode[] | null = null;
  private sigMemoDocW = 0;
  private sigMemoDocH = 0;
  private sigMemoFormat: GPUTextureFormat | null = null;
  private sigMemoEpochVersion = -1;
  private sigMemoValue: string | null = null;

  constructor(
    private readonly registry: ResidentAssetRegistry,
    private readonly perf: RenderPerfMonitor,
  ) {}

  getCompositeTargetBytes(): number {
    return this.compositeTexture
      ? estimateTextureBytes(
          this.compositeTexture.allocatedWidth,
          this.compositeTexture.allocatedHeight,
          this.compositeTexture.format,
        )
      : 0;
  }

  getRoiTargetBytes(): number {
    return this.channel.roi.texture
      ? estimateTextureBytes(
          this.channel.roi.texture.allocatedWidth,
          this.channel.roi.texture.allocatedHeight,
          this.channel.roi.texture.format,
        )
      : 0;
  }

  getBelowCacheBytes(): number {
    return this.channel.below.texture
      ? estimateTextureBytes(
          this.channel.below.texture.allocatedWidth,
          this.channel.below.texture.allocatedHeight,
          this.channel.below.texture.format,
        )
      : 0;
  }

  releaseBelowCache(): void {
    this.channel.below.texture?.destroy();
    this.channel.below.texture = null;
    this.channel.below.sig = null;
    this.channel.below.checkedFullSig = null;
    this.channel.below.roiKey = null;
  }

  clearRoiChannel(): void {
    this.channel.roi.texture?.destroy();
    this.channel.roi.texture = null;
    this.channel.roi.signature = null;
    this.channel.roi.rectKey = null;
    this.channel.roi.rect.x = 0;
    this.channel.roi.rect.y = 0;
    this.channel.roi.rect.w = 0;
    this.channel.roi.rect.h = 0;
    this.channel.roi.targetW = 0;
    this.channel.roi.targetH = 0;
    this.channel.roi.format = null;
    this.channel.roi.densityScale = 1;
    this.channel.roi.docW = 0;
    this.channel.roi.docH = 0;
  }

  clear(): void {
    this.compositeTexture?.destroy();
    this.compositeTexture = null;
    this.compositeSignature = null;
    this.compositeFormat = null;
    this.compositeTargetW = 0;
    this.compositeTargetH = 0;

    this.releaseBelowCache();
    this.channel.below.format = null;
    this.channel.below.w = 0;
    this.channel.below.h = 0;
    this.channel.below.densityScale = 1;
    this.clearRoiChannel();

    this.sigMemoLayers = null;
    this.sigMemoValue = null;
  }

  renderFrame(ctx: {
    device: GPUDevice;
    caps: Capabilities;
    scene: Scene;
    compiled: CompiledScene;
    workingFormat: GPUTextureFormat;
    pipelineCache: PipelineCache;
    bufferRing: BufferRing;
    texturePool: TexturePool;
    residentTransients: ResidentTransientCache | null;
  }): ChannelFrameResult {
    const {
      device,
      caps,
      scene,
      compiled,
      workingFormat,
      pipelineCache,
      bufferRing,
      texturePool,
      residentTransients,
    } = ctx;

    const { frameWidth: docW, frameHeight: docH } = compositeDims(scene);
    const workingBpp = workingFormatBpp(workingFormat as 'rgba16float' | 'rgba32float');
    const deviceMaxDim =
      device.limits?.maxTextureDimension2D ??
      caps.limits.maxTextureDimension2D ??
      FALLBACK_MAX_TEXTURE_DIMENSION;
    const compositeDensity = Math.max(1, scene.view.density ?? 1);
    const budgetBytes = deriveEngineWorkingSetBudget(derivePoolBudget(caps));
    const densityBudgetBytes = COMPOSITE_BUDGET_DEFAULT_BYTES;
    const screenScale = effectiveScale(scene.view.transform);

    const epochVersion = this.registry.getEpochVersion();
    let signature: string;
    const sigT0 = PERF_MON ? performance.now() : 0;
    let sigMiss = false;
    if (
      this.sigMemoValue !== null &&
      this.sigMemoLayers === scene.layers &&
      this.sigMemoDocW === docW &&
      this.sigMemoDocH === docH &&
      this.sigMemoFormat === workingFormat &&
      this.sigMemoEpochVersion === epochVersion
    ) {
      signature = this.sigMemoValue;
    } else {
      sigMiss = true;
      signature = computeCompositeSignature(scene, {
        getAssetEpoch: (assetId) => this.registry.getAssetEpoch(assetId),
        workingFormat,
      });
      this.sigMemoLayers = scene.layers;
      this.sigMemoDocW = docW;
      this.sigMemoDocH = docH;
      this.sigMemoFormat = workingFormat;
      this.sigMemoEpochVersion = epochVersion;
      this.sigMemoValue = signature;
    }
    const sigMs = PERF_MON ? performance.now() - sigT0 : 0;

    const liveHintTopmost =
      scene.layers.length >= 2 && scene.layers[scene.layers.length - 1]?.useIncreComp === true;
    if (
      this.channel.below.texture !== null &&
      !liveHintTopmost &&
      this.channel.below.checkedFullSig !== signature
    ) {
      const belowSig = computeCompositeSignature(
        { ...scene, layers: scene.layers.slice(0, -1) },
        { getAssetEpoch: (assetId) => this.registry.getAssetEpoch(assetId), workingFormat },
      );
      if (belowSig !== this.channel.below.sig) {
        this.releaseBelowCache();
      } else {
        this.channel.below.checkedFullSig = signature;
      }
    }

    const memo = this.planMemo;
    if (
      !memo ||
      memo.docW !== docW ||
      memo.docH !== docH ||
      memo.bpp !== workingBpp ||
      memo.deviceMaxDim !== deviceMaxDim ||
      memo.budgetBytes !== budgetBytes ||
      memo.density !== compositeDensity
    ) {
      this.planMemo = {
        docW,
        docH,
        bpp: workingBpp,
        deviceMaxDim,
        budgetBytes,
        density: compositeDensity,
      };
      this.planMemoMode = resolveCompositePlan({
        docW,
        docH,
        bpp: workingBpp,
        deviceMaxDim,
        budgetBytes,
        compositeDensity,
        residentTargets: RESIDENT_COMPOSITE_TARGETS,
      }).mode;
    }
    const planMode = this.planMemoMode;

    let activeTexture: LayerTexture | null = null;
    let activeDensityScale = 1;
    let activePlacement: TexPlacement | undefined;
    let recomposited = false;
    let recompositedRoi = false;
    let compEncMs = 0;

    if (planMode === 'full') {
      const density = uniformDensity(compositeDensity);
      const [compW, compH] = densityCompositeDims(docW, docH, [density.scaleX, density.scaleY]);
      const densityScale = Math.min(density.scaleX, density.scaleY);

      const dimsChanged =
        this.compositeTargetW !== compW ||
        this.compositeTargetH !== compH ||
        this.compositeFormat !== workingFormat;

      const needsRecomposite =
        this.compositeTexture === null || dimsChanged || this.compositeSignature !== signature;

      const roiFallbackUsable =
        this.channel.roi.texture !== null &&
        this.channel.roi.docW === docW &&
        this.channel.roi.docH === docH &&
        this.channel.roi.signature === signature;
      const presentRoiDuringFullRebuild = needsRecomposite && roiFallbackUsable;
      if (!needsRecomposite && this.channel.roi.texture) {
        this.clearRoiChannel();
      }

      const compEncT0 = PERF_MON ? performance.now() : 0;
      if (needsRecomposite) {
        recomposited = true;
        if (this.compositeTexture && dimsChanged) {
          this.compositeTexture.destroy();
          this.compositeTexture = null;
        }
        if (dimsChanged) {
          residentTransients?.clear();
          texturePool.evictUnused(0);
          this.releaseBelowCache();
        }
        if (!this.compositeTexture) {
          this.compositeTexture = this.createCompositeTarget(device, compW, compH, workingFormat);
        }

        const encFast = this.encodeWithBelowCache({
          device,
          scene,
          workingFormat,
          pipelineCache,
          bufferRing,
          texturePool,
          residentTransients,
          density: [density.scaleX, density.scaleY],
          densityScale,
          rebuildKey: null,
          fullSignature: signature,
          target: this.compositeTexture,
          targetW: compW,
          targetH: compH,
          perfStart: compEncT0,
        });
        if (encFast !== null) {
          compEncMs = encFast;
        } else {
          compEncMs = this.compositeInto(compiled, {
            device,
            workingFormat,
            pipelineCache,
            bufferRing,
            texturePool,
            residentTransients,
            target: this.compositeTexture,
            interactiveScale: [density.scaleX, density.scaleY],
            perfStart: compEncT0,
          });
        }
        this.compositeSignature = signature;
        this.compositeTargetW = compW;
        this.compositeTargetH = compH;
        this.compositeFormat = workingFormat;
      }

      if (presentRoiDuringFullRebuild) {
        activeTexture = this.channel.roi.texture;
        activeDensityScale = this.channel.roi.densityScale;
        activePlacement = {
          origin: { x: this.channel.roi.rect.x, y: this.channel.roi.rect.y },
          docW: this.channel.roi.rect.w,
          docH: this.channel.roi.rect.h,
        };
      } else {
        activeTexture = this.compositeTexture;
        activeDensityScale = densityScale;
      }
    } else {
      if (this.compositeTexture) {
        this.compositeTexture.destroy();
        this.compositeTexture = null;
        this.releaseBelowCache();
        this.compositeSignature = null;
        this.compositeFormat = null;
        this.compositeTargetW = 0;
        this.compositeTargetH = 0;
      }

      const roi = resolveRoiFrame({
        scene,
        docW,
        docH,
        screenScale,
        compositeDensity,
        workingFormat: workingFormat as 'rgba16float' | 'rgba32float',
        deviceMaxDim,
        budgetBytes: densityBudgetBytes,
        signature,
        current: {
          resident: this.channel.roi.texture !== null,
          rectKey: this.channel.roi.rectKey,
          signature: this.channel.roi.signature,
          targetW: this.channel.roi.targetW,
          targetH: this.channel.roi.targetH,
          format: this.channel.roi.format,
          rectX: this.channel.roi.rect.x,
          rectY: this.channel.roi.rect.y,
          rectW: this.channel.roi.rect.w,
          rectH: this.channel.roi.rect.h,
        },
      });

      if (roi.rect && roi.density) {
        const intersect = roi.rect;
        const roiDensity = roi.density;

        const compEncT0 = PERF_MON ? performance.now() : 0;
        if (roi.needsComposite) {
          recomposited = true;
          recompositedRoi = true;
          if (this.channel.roi.texture && roi.dimsChanged) {
            this.channel.roi.texture.destroy();
            this.channel.roi.texture = null;
          }
          if (!this.channel.roi.texture) {
            this.channel.roi.texture = this.createCompositeTarget(
              device,
              roi.targetW,
              roi.targetH,
              workingFormat,
            );
          }

          const roiViewport: ExportViewport = {
            targetWidth: roi.targetW,
            targetHeight: roi.targetH,
            sourceRect: [intersect.x, intersect.y, intersect.w, intersect.h],
          };
          const encFast = this.encodeWithBelowCache({
            device,
            scene,
            workingFormat,
            pipelineCache,
            bufferRing,
            texturePool,
            residentTransients,
            density: [roiDensity.scaleX, roiDensity.scaleY],
            densityScale: Math.min(roiDensity.scaleX, roiDensity.scaleY),
            rebuildKey: roi.rebuildKey,
            fullSignature: signature,
            target: this.channel.roi.texture,
            targetW: roi.targetW,
            targetH: roi.targetH,
            exportViewport: roiViewport,
            perfStart: compEncT0,
          });
          if (encFast !== null) {
            compEncMs = encFast;
          } else {
            compEncMs = this.compositeInto(compiled, {
              device,
              workingFormat,
              pipelineCache,
              bufferRing,
              texturePool,
              residentTransients,
              target: this.channel.roi.texture,
              interactiveScale: [roiDensity.scaleX, roiDensity.scaleY],
              exportViewport: roiViewport,
              perfStart: compEncT0,
            });
          }

          this.channel.roi.signature = signature;
          this.channel.roi.rectKey = roi.rebuildKey;
          this.channel.roi.rect.x = intersect.x;
          this.channel.roi.rect.y = intersect.y;
          this.channel.roi.rect.w = intersect.w;
          this.channel.roi.rect.h = intersect.h;
          this.channel.roi.targetW = roi.targetW;
          this.channel.roi.targetH = roi.targetH;
          this.channel.roi.format = workingFormat;
          this.channel.roi.densityScale = Math.min(roiDensity.scaleX, roiDensity.scaleY);
          this.channel.roi.docW = docW;
          this.channel.roi.docH = docH;
        }
      }

      if (this.channel.roi.texture) {
        activeTexture = this.channel.roi.texture;
        activeDensityScale = this.channel.roi.densityScale;
        activePlacement = {
          origin: { x: this.channel.roi.rect.x, y: this.channel.roi.rect.y },
          docW: this.channel.roi.rect.w,
          docH: this.channel.roi.rect.h,
        };
      }
    }

    return {
      activeTexture,
      activeDensityScale,
      activePlacement,
      docW,
      docH,
      sigMs,
      sigMiss,
      recomposited,
      recompositedRoi,
      compEncMs,
      mode: planMode,
      roiTargetW: this.channel.roi.texture ? this.channel.roi.targetW : 0,
      roiTargetH: this.channel.roi.texture ? this.channel.roi.targetH : 0,
      roiDensity: this.channel.roi.texture ? this.channel.roi.densityScale : 0,
    };
  }

  private compositeInto(
    compiled: CompiledScene,
    opts: {
      device: GPUDevice;
      workingFormat: GPUTextureFormat;
      pipelineCache: PipelineCache;
      bufferRing: BufferRing;
      texturePool: TexturePool;
      residentTransients: ResidentTransientCache | null;
      target: LayerTexture;
      interactiveScale: readonly [number, number];
      exportViewport?: ExportViewport;
      initialLoad?: boolean;
      armTimer?: boolean;
      perfStart: number;
    },
  ): number {
    const {
      device,
      workingFormat,
      pipelineCache,
      bufferRing,
      texturePool,
      residentTransients,
      target,
      interactiveScale,
      exportViewport,
      initialLoad,
      armTimer = true,
    } = opts;

    const timer = this.perf.armComposite(device, armTimer);
    residentTransients?.beginFrame();

    const { scratch } = RenderGraph.composite(compiled, {
      device,
      pipelineCache,
      bufferRing,
      texturePool,
      assets: this.registry.getAssetsMap(),
      workingFormat,
      resolveLutView: (lutId) => this.registry.getLutView(lutId),
      resolveLut3dView: (lutId) => this.registry.getLut3dView(lutId),
      getAssetEpoch: (assetId) => this.registry.getAssetEpoch(assetId),
      target,
      interactiveScale,
      exportViewport,
      acquireResidentTransient: residentTransients
        ? (key, desc) => residentTransients.acquire(key, desc)
        : undefined,
      initialLoad,
      gpuTimer: timer,
    });

    for (const tex of scratch) texturePool.release(tex);
    residentTransients?.endFrame();

    return this.perf.recordComposite(device, opts.perfStart, timer);
  }

  private createCompositeTarget(
    device: GPUDevice,
    width: number,
    height: number,
    format: GPUTextureFormat,
  ): LayerTexture {
    const texture = device.createTexture({
      size: [width, height, 1],
      format,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
      label: 'Engine Composite Target (resident, exact-size)',
    });
    return new LayerTexture({ texture, width, height, format });
  }

  private copyFullTexture(
    device: GPUDevice,
    src: GPUTexture,
    dst: GPUTexture,
    width: number,
    height: number,
  ): void {
    const encoder = device.createCommandEncoder({ label: 'Below Cache Seed Copy' });
    encoder.copyTextureToTexture({ texture: src }, { texture: dst }, [width, height, 1]);
    device.queue.submit([encoder.finish()]);
  }

  private encodeWithBelowCache(opts: {
    device: GPUDevice;
    scene: Scene;
    workingFormat: GPUTextureFormat;
    pipelineCache: PipelineCache;
    bufferRing: BufferRing;
    texturePool: TexturePool;
    residentTransients: ResidentTransientCache | null;
    density: readonly [number, number];
    densityScale: number;
    rebuildKey: string | null;
    fullSignature: string;
    target: LayerTexture;
    targetW: number;
    targetH: number;
    exportViewport?: ExportViewport;
    perfStart: number;
  }): number | null {
    const {
      device,
      scene,
      workingFormat,
      pipelineCache,
      bufferRing,
      texturePool,
      residentTransients,
      density,
      densityScale,
      rebuildKey,
      fullSignature,
      target,
      targetW,
      targetH,
      exportViewport,
      perfStart,
    } = opts;

    const last = scene.layers.length > 0 ? scene.layers[scene.layers.length - 1] : undefined;
    if (!last?.useIncreComp || scene.layers.length < 2) return null;

    const belowScene: Scene = { ...scene, layers: scene.layers.slice(0, -1) };
    const activeScene: Scene = { ...scene, layers: [scene.layers[scene.layers.length - 1]] };
    const belowSig = computeCompositeSignature(belowScene, {
      getAssetEpoch: (assetId) => this.registry.getAssetEpoch(assetId),
      workingFormat,
    });
    const cacheDimsMatch =
      this.channel.below.texture !== null &&
      this.channel.below.w === targetW &&
      this.channel.below.h === targetH &&
      this.channel.below.format === workingFormat &&
      this.channel.below.densityScale === densityScale &&
      this.channel.below.roiKey === rebuildKey;
    const cacheValid = cacheDimsMatch && this.channel.below.sig === belowSig;

    if (PERF_MON) {
      console.info(
        `[BelowCache] ${cacheValid ? 'fast' : 'rebuild'} layers=${scene.layers.length} belowSigHit=${cacheValid}`,
      );
    }

    if (!cacheValid) {
      if (!cacheDimsMatch) {
        this.channel.below.texture?.destroy();
        this.channel.below.texture = this.createCompositeTarget(device, targetW, targetH, workingFormat);
        this.channel.below.w = targetW;
        this.channel.below.h = targetH;
        this.channel.below.format = workingFormat;
        this.channel.below.densityScale = densityScale;
        this.channel.below.roiKey = rebuildKey;
      }
      const belowCompiled = SceneCompiler.compile(belowScene);
      const encBelow = this.compositeInto(belowCompiled, {
        device,
        workingFormat,
        pipelineCache,
        bufferRing,
        texturePool,
        residentTransients,
        target: this.channel.below.texture!,
        interactiveScale: density,
        exportViewport,
        perfStart,
        armTimer: false,
      });
      this.copyFullTexture(device, this.channel.below.texture!.texture, target.texture, targetW, targetH);
      const activeCompiled = SceneCompiler.compile(activeScene);
      const encActive = this.compositeInto(activeCompiled, {
        device,
        workingFormat,
        pipelineCache,
        bufferRing,
        texturePool,
        residentTransients,
        target,
        interactiveScale: density,
        exportViewport,
        initialLoad: true,
        perfStart,
        armTimer: false,
      });
      this.channel.below.sig = belowSig;
      this.channel.below.checkedFullSig = fullSignature;
      return encBelow + encActive;
    }

    this.copyFullTexture(device, this.channel.below.texture!.texture, target.texture, targetW, targetH);
    const activeCompiled = SceneCompiler.compile(activeScene);
    return this.compositeInto(activeCompiled, {
      device,
      workingFormat,
      pipelineCache,
      bufferRing,
      texturePool,
      residentTransients,
      target,
      interactiveScale: density,
      exportViewport,
      initialLoad: true,
      perfStart,
      armTimer: false,
    });
  }
}
