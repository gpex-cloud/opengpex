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
 * WebGpuEngine.ts — The single public entry point of the v2 render engine.
 * Implements the declarative `IEngine` contract.
 *
 * @module core/engine/pipeline/WebGpuEngine
 */

import type { Capabilities } from '@opengpex/editor/core/engine/gpu/device/Capabilities';
import { UNKNOWN_CAPABILITIES } from '@opengpex/editor/core/engine/gpu/device/Capabilities';
import type { GpuInfo } from '@opengpex/editor/core/engine/gpu/GpuInfo';
import { GpuDevice, getSharedGpuDevice, type SurfaceConfig } from '@opengpex/editor/core/engine/gpu/device/GpuDevice';
import type { Scene } from '@opengpex/editor/core/engine/pipeline/scene/Scene';
import { TexturePool } from '@opengpex/editor/core/engine/gpu/resources/TexturePool';
import { ResidentTransientCache } from '@opengpex/editor/core/engine/gpu/resources/ResidentTransientCache';
import { strokeRenderer } from '@opengpex/editor/core/engine/pipeline/graph/build/vectorRenderers/StrokeRenderer';
import { ResidentAssetRegistry } from '@opengpex/editor/core/engine/gpu/resources/ResidentAssetRegistry';
import { derivePoolBudget } from '@opengpex/editor/core/engine/gpu/resources/poolBudget';
import { WorkingSet } from '@opengpex/editor/core/engine/gpu/resources/WorkingSet';
import { BufferRing } from '@opengpex/editor/core/engine/gpu/resources/BufferRing';
import { PipelineCache } from '@opengpex/editor/core/engine/gpu/resources/PipelineCache';
import { SceneCompiler } from '@opengpex/editor/core/engine/pipeline/graph/SceneCompiler';
import { RenderGraph, compositeDims, type ExportViewport } from '@opengpex/editor/core/engine/pipeline/graph/RenderGraph';
import { GainPresenter } from '@opengpex/editor/core/engine/pipeline/runtime/gainPresenter';
import { engineContentCache } from '@opengpex/editor/core/engine/gpu/resources/EngineContentCache';
import { releaseExportGlyphAtlas } from '@opengpex/editor/core/engine/pipeline/graph/build/vectorRenderers/TextRenderer';
import { readbackToPixels } from '@opengpex/editor/core/engine/gpu/readback';
import type { IEngine, ExportOptions, ExportResult, UploadSource, LutUpload } from '@opengpex/editor/core/engine/pipeline/IEngine';
import type { Lut3dUpload } from '@opengpex/editor/core/engine/pipeline/scene/lut3dPlan';
import { PERF_MON } from '@opengpex/editor/core/helpers/config';
import { RenderPerfMonitor } from './runtime/RenderPerfMonitor';
import { CompositeChannelCache } from './runtime/CompositeChannelCache';

export type { IEngine, ExportOptions, ExportResult, UploadSource, LutUpload } from '@opengpex/editor/core/engine/pipeline/IEngine';

/**
 * Idle-shrink threshold for the render-entry sweep: when the previous render
 * is more than this far in the past, stale pooled free textures are evicted
 * before the frame proceeds.
 */
const IDLE_RENDER_SHRINK_MS = 30_000;

export class WebGpuEngine implements IEngine {
  private readonly gpu = getSharedGpuDevice();

  private texturePool: TexturePool | null = null;
  private residentTransients: ResidentTransientCache | null = null;
  private pipelineCache: PipelineCache | null = null;
  private bufferRing: BufferRing | null = null;
  private initPromise: Promise<Capabilities> | null = null;
  private lastScene: Scene | null = null;
  private lastRenderAt = 0;
  private firstPaintWaiters: Array<() => void> = [];
  #visibilityListenerAttached = false;

  private readonly perf = new RenderPerfMonitor();
  private readonly registry = new ResidentAssetRegistry({
    isReady: () => this.gpu.isReady(),
    getDevice: () => this.gpu.getDevice(),
  });
  private readonly channelCache = new CompositeChannelCache(this.registry, this.perf);

  readonly gainPresenter = new GainPresenter({
    getDevice: () => this.gpu.getDevice(),
    isHdrActive: () => this.gpu.isHdrPresentation(),
    replayFrame: () => {
      if (this.lastScene) this.render(this.lastScene);
    },
  });

  private readonly workingSet = new WorkingSet({
    compositeTargetBytes: () => this.channelCache.getCompositeTargetBytes(),
    roiTargetBytes: () => this.channelCache.getRoiTargetBytes(),
    belowCacheBytes: () => this.channelCache.getBelowCacheBytes(),
    residentTransientBytes: () => this.residentTransients?.totalBytes() ?? 0,
    poolBytes: () => this.texturePool?.getStats().totalBytes ?? 0,
  });

  readonly #onVisibilityChange = (): void => {
    if (typeof document === 'undefined' || !document.hidden) return;
    this.channelCache.releaseBelowCache();
    this.texturePool?.evictUnused(0);
    this.residentTransients?.reclaimIdle(0);
  };

  /** Cheap synchronous probe used by the shell to decide v2-vs-v1 routing. */
  static isSupported(): boolean {
    return GpuDevice.isSupported();
  }

  async init(canvas: HTMLCanvasElement, surface?: SurfaceConfig): Promise<Capabilities> {
    if (this.gpu.isReady() && this.pipelineCache && this.texturePool && this.bufferRing) {
      this.attachCanvas(canvas, surface);
      return this.gpu.getCapabilities()!;
    }
    if (this.initPromise) {
      const caps = await this.initPromise;
      this.attachCanvas(canvas, surface);
      return caps;
    }

    this.initPromise = (async () => {
      try {
        const caps = await this.gpu.init(canvas, surface);
        const device = this.gpu.getDevice()!;

        if (!this.texturePool || this.texturePool.device !== device) {
          this.texturePool?.destroy();
          this.texturePool = this.#makeTexturePool(device, caps);
          this.residentTransients?.clear();
          this.residentTransients = new ResidentTransientCache(device);
        }
        if (!this.pipelineCache || this.pipelineCache.device !== device) {
          this.pipelineCache?.destroy();
          this.pipelineCache = new PipelineCache(device);
          this.#warmUpCommonPipelines();
        }
        if (!this.bufferRing || this.bufferRing.device !== device) {
          this.bufferRing?.destroy();
          this.bufferRing = new BufferRing(device);
        }

        if (!this.#visibilityListenerAttached && typeof document !== 'undefined') {
          document.addEventListener('visibilitychange', this.#onVisibilityChange);
          this.#visibilityListenerAttached = true;
        }

        this.gpu.setLostHandler(() => {
          this.initPromise = null;
          const scene = this.lastScene;
          const currentCanvas = this.gpu.getCanvas() ?? canvas;
          void this.gpu.init(currentCanvas, surface).then(() => {
            const reloadedDevice = this.gpu.getDevice();
            if (reloadedDevice) {
              this.#adoptDevice(reloadedDevice, this.gpu.getCapabilities());
            }
            if (scene) this.render(scene);
          });
        });

        return caps;
      } catch (err) {
        this.initPromise = null;
        throw err;
      }
    })();

    return await this.initPromise;
  }

  attachCanvas(canvas: HTMLCanvasElement, surface?: SurfaceConfig): boolean {
    return this.gpu.attachCanvas(canvas, surface);
  }

  onFirstPaint(cb: () => void): () => void {
    this.firstPaintWaiters.push(cb);
    return () => {
      this.firstPaintWaiters = this.firstPaintWaiters.filter((w) => w !== cb);
    };
  }

  render(scene: Scene): void {
    this.lastScene = scene;
    if (!this.gpu.isReady() || !this.pipelineCache || !this.bufferRing || !this.texturePool) {
      return;
    }

    const context = this.gpu.getContext();
    const device = this.gpu.getDevice();
    const caps = this.gpu.getCapabilities();
    if (!context || !device || !caps) return;

    if (
      this.pipelineCache.device !== device ||
      this.texturePool.device !== device ||
      this.bufferRing.device !== device
    ) {
      this.#adoptDevice(device, caps);
    }

    const canvas = context.canvas as HTMLCanvasElement;
    if (!canvas || canvas.width === 0 || canvas.height === 0) return;
    if (typeof canvas.isConnected === 'boolean' && !canvas.isConnected) return;

    const nowMs = performance.now();
    if (this.lastRenderAt !== 0 && nowMs - this.lastRenderAt > IDLE_RENDER_SHRINK_MS) {
      this.texturePool.evictUnused(10_000);
    }
    this.lastRenderAt = nowMs;

    let currentTexture: GPUTexture;
    try {
      currentTexture = context.getCurrentTexture();
    } catch {
      return;
    }
    const currentView = currentTexture.createView();

    this.bufferRing.reset();

    const compileT0 = PERF_MON ? performance.now() : 0;
    const compiled = SceneCompiler.compile(scene);
    const compileMs = PERF_MON ? performance.now() - compileT0 : 0;

    const workingFormat: GPUTextureFormat = caps.workingFormat ?? 'rgba16float';
    const frame = this.channelCache.renderFrame({
      device,
      caps,
      scene,
      compiled,
      workingFormat,
      pipelineCache: this.pipelineCache,
      bufferRing: this.bufferRing,
      texturePool: this.texturePool,
      residentTransients: this.residentTransients,
    });

    if (frame.activeTexture) {
      const presEncT0 = PERF_MON ? performance.now() : 0;
      const presTimer = this.perf.armPresent(device);

      RenderGraph.present(frame.activeTexture, {
        device,
        pipelineCache: this.pipelineCache,
        bufferRing: this.bufferRing,
        currentView,
        targetFormat: this.gpu.getSwapchainFormat(),
        hdr: this.gpu.isHdrPresentation(),
        scene,
        densityScale: frame.activeDensityScale,
        texPlacement: frame.activePlacement,
        gainMap: this.gainPresenter.resolve(scene.display.gainMapAssetId),
        gpuTimer: presTimer,
      });

      const presEncMs = this.perf.recordPresent(device, presEncT0, presTimer);
      this.perf.flushFrame({
        compileMs,
        sigMs: frame.sigMs,
        sigMiss: frame.sigMiss,
        recomposite: frame.recomposited,
        recompositeRoi: frame.recompositedRoi,
        compEncMs: frame.compEncMs,
        presEncMs,
        docW: frame.docW,
        docH: frame.docH,
        layers: scene.layers.length,
        mode: frame.mode,
        roiTargetW: frame.roiTargetW,
        roiTargetH: frame.roiTargetH,
        roiDensity: frame.roiDensity,
        workingSet: this.workingSet,
      });
    }

    if (this.firstPaintWaiters.length > 0) {
      const waiters = this.firstPaintWaiters;
      this.firstPaintWaiters = [];
      for (const cb of waiters) {
        try {
          cb();
        } catch (err) {
          console.warn('[WebGpuEngine] onFirstPaint callback threw', err);
        }
      }
    }
  }

  async export(scene: Scene, opts: ExportOptions): Promise<ExportResult> {
    if (!this.gpu.isReady() || !this.pipelineCache || !this.bufferRing || !this.texturePool) {
      throw new Error('[WebGpuEngine] export() called before init().');
    }
    const device = this.gpu.getDevice();
    const caps = this.gpu.getCapabilities();
    if (!device || !caps) {
      throw new Error('[WebGpuEngine] export() has no device.');
    }

    const { frameWidth: docW, frameHeight: docH } = compositeDims(scene);
    const workingFormat: GPUTextureFormat = caps.workingFormat ?? 'rgba16float';

    const srcX = opts.region?.x ?? 0;
    const srcY = opts.region?.y ?? 0;
    const srcW = opts.region?.w ?? docW;
    const srcH = opts.region?.h ?? docH;

    const scale = opts.scale ?? 1;
    const targetW = opts.targetWidth ?? Math.max(1, Math.round(srcW * scale));
    const targetH = opts.targetHeight ?? Math.max(1, Math.round(srcH * scale));

    const exportViewport: ExportViewport = {
      targetWidth: targetW,
      targetHeight: targetH,
      sourceRect: [srcX, srcY, srcW, srcH],
    };

    this.bufferRing.reset();
    const compiled = SceneCompiler.compile(scene);
    const { result: composite, scratch } = RenderGraph.composite(compiled, {
      device,
      pipelineCache: this.pipelineCache,
      bufferRing: this.bufferRing,
      texturePool: this.texturePool,
      assets: this.registry.getAssetsMap(),
      workingFormat,
      resolveLutView: (lutId) => this.getLutView(lutId),
      resolveLut3dView: (lutId) => this.getLut3dView(lutId),
      getAssetEpoch: (assetId) => this.registry.getAssetEpoch(assetId),
      exportViewport,
    });

    let pixels: Uint8ClampedArray | Uint16Array | Float32Array;
    try {
      pixels = await readbackToPixels(device, composite.texture, {
        width: targetW,
        height: targetH,
        workingFormat: workingFormat as 'rgba16float' | 'rgba32float',
        bitDepth: opts.bitDepth,
      });
    } finally {
      this.texturePool.release(composite.texture);
      for (const tex of scratch) this.texturePool.release(tex);
      releaseExportGlyphAtlas(Math.max(targetW / Math.max(1, srcW), targetH / Math.max(1, srcH)));
    }

    return { width: targetW, height: targetH, bitDepth: opts.bitDepth, pixels };
  }

  has(assetId: string): boolean {
    return this.registry.has(assetId);
  }

  uploadSource(assetId: string, src: UploadSource, version?: number): void {
    this.registry.uploadSource(assetId, src, version);
  }

  release(assetId: string): void {
    this.registry.release(assetId);
  }

  hasLut(lutId: string): boolean {
    return this.registry.hasLut(lutId);
  }

  uploadLut(lut: LutUpload): void {
    this.registry.uploadLut(lut);
  }

  releaseLut(lutId: string): void {
    this.registry.releaseLut(lutId);
  }

  getLutView(lutId: string): GPUTextureView | undefined {
    return this.registry.getLutView(lutId);
  }

  hasLut3d(lutId: string): boolean {
    return this.registry.hasLut3d(lutId);
  }

  uploadLut3d(lut: Lut3dUpload): void {
    this.registry.uploadLut3d(lut);
  }

  releaseLut3d(lutId: string): void {
    this.registry.releaseLut3d(lutId);
  }

  getLut3dView(lutId: string): GPUTextureView | undefined {
    return this.registry.getLut3dView(lutId);
  }

  destroy(): void {
    if (this.#visibilityListenerAttached && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.#onVisibilityChange);
      this.#visibilityListenerAttached = false;
    }
    this.#releaseCaches();
    this.residentTransients?.clear();
    this.residentTransients = null;
    this.lastScene = null;
    this.initPromise = null;

    this.texturePool?.destroy();
    this.pipelineCache?.destroy();
    this.bufferRing?.destroy();

    this.texturePool = null;
    this.pipelineCache = null;
    this.bufferRing = null;

    this.gpu.destroy();
  }

  getCapabilities(): Capabilities | null {
    return this.gpu.getCapabilities();
  }

  getGpuInfo(): GpuInfo {
    const caps = this.gpu.getCapabilities();
    const ready = this.isReady() && caps !== null;
    const source = ready ? caps! : UNKNOWN_CAPABILITIES;

    const stats = this.texturePool?.getStats();
    const ws = this.workingSet.snapshot();

    return {
      ready,
      adapterInfo: { ...source.adapterInfo },
      limits: {
        maxTextureDimension2D: source.limits.maxTextureDimension2D,
        maxBufferSize: source.limits.maxBufferSize,
      },
      workingFormat: source.workingFormat,
      needsTiling: source.needsTiling,
      memory: {
        inUseBytes: stats?.inUseBytes ?? 0,
        freeBytes: stats?.freeBytes ?? 0,
        peakBytes: stats?.peakBytes ?? 0,
        compositeTargetBytes: ws.compositeTargetBytes,
        roiTargetBytes: ws.roiTargetBytes,
        belowCacheBytes: ws.belowCacheBytes,
        residentTransientBytes: ws.residentTransientBytes,
        workingSetBytes: ws.totalBytes,
      },
    };
  }

  getTexturePool(): TexturePool | null {
    return this.texturePool;
  }

  isReady(): boolean {
    return this.gpu.isReady();
  }

  #makeTexturePool(device: GPUDevice, caps: Capabilities | null): TexturePool {
    return new TexturePool(device, { maxFreeBytes: derivePoolBudget(caps ?? UNKNOWN_CAPABILITIES) });
  }

  #releaseCaches(): void {
    this.registry.clear();
    this.gainPresenter.release();
    this.channelCache.clear();
    this.perf.destroy();
    engineContentCache.clear();
    strokeRenderer.clearLiveCache();
  }

  #adoptDevice(device: GPUDevice, caps: Capabilities | null): void {
    this.#releaseCaches();
    this.texturePool?.destroy();
    this.texturePool = this.#makeTexturePool(device, caps);
    this.residentTransients?.clear();
    this.residentTransients = new ResidentTransientCache(device);
    this.pipelineCache?.destroy();
    this.pipelineCache = new PipelineCache(device);
    this.#warmUpCommonPipelines();
    this.bufferRing?.destroy();
    this.bufferRing = new BufferRing(device);
  }

  /**
   * Pre-compile frequently shared GPU pipelines in a microtask after device
   * creation so the first interactive gesture does not pay shader compilation.
   */
  #warmUpCommonPipelines(): void {
    const cache = this.pipelineCache;
    if (!cache) return;
    const format: GPUTextureFormat = this.gpu.getCapabilities()?.workingFormat ?? 'rgba16float';
    queueMicrotask(() => {
      if (this.pipelineCache !== cache || !this.gpu.isReady()) return;
      // Warm-up is best-effort: a device that cannot create pipelines (test
      // doubles, feature-limited adapters) must not let the compile error
      // escape as an unhandled async exception — the first real stroke still
      // compiles the pipelines synchronously on its own path.
      try {
        cache.getStrokeExtrudePipeline();
        cache.getStrokePipeline(format);
      } catch {
        /* ignore — compilation happens on demand at first use */
      }
    });
  }
}

declare global {
  var __opengpex_v2_webgpu_engine__: IEngine | undefined;
}

let _gpuEngine: IEngine | null = null;

export function getGpuEngine(): IEngine {
  if (typeof globalThis !== 'undefined') {
    if (!globalThis.__opengpex_v2_webgpu_engine__) {
      globalThis.__opengpex_v2_webgpu_engine__ = new WebGpuEngine();
    }
    return globalThis.__opengpex_v2_webgpu_engine__;
  }
  if (!_gpuEngine) {
    _gpuEngine = new WebGpuEngine();
  }
  return _gpuEngine;
}

export const getEngine = getGpuEngine;

export { imageBitmapCache } from '@opengpex/editor/core/engine/sources/ImageBitmapCache';
