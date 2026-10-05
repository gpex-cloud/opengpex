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
 * WHAT REPLACED WHAT:
 *   v1 imperative renderer                        → v2 declarative `IEngine`
 *   beginFrame + pushCommand* + flush + endFrame  → render(scene)
 *   drawLayerDirect (legacy back-door)            → (gone — one path only)
 *   DrawLayerOptions.isInteracting                → (gone — not a render concern)
 *   Legacy 2D + Vips (two engines)                → one RenderGraph, two sinks
 * Architecture overview:
 *   • Render pipeline: SceneCompiler + RenderGraph + CompositePass + ViewPass
 *   • Post-processing: AdjustPass + FilterPass
 *   • Vectors & Export: StrokePass + Readback staging
 *
 * @module core/engine/pipeline/WebGpuEngine
 */

import type { Capabilities } from '@opengpex/editor/core/engine/gpu/device/Capabilities';
import { UNKNOWN_CAPABILITIES } from '@opengpex/editor/core/engine/gpu/device/Capabilities';
import type { GpuInfo } from '@opengpex/editor/core/engine/gpu/GpuInfo';
import { GpuDevice, SWAPCHAIN_FORMAT, type SurfaceConfig } from '@opengpex/editor/core/engine/gpu/device/GpuDevice';
import type { Scene, LayerNode } from '@opengpex/editor/core/engine/pipeline/scene/Scene';
import { TexturePool, estimateTextureBytes } from '@opengpex/editor/core/engine/gpu/resources/TexturePool';
import { ResidentTransientCache } from '@opengpex/editor/core/engine/gpu/resources/ResidentTransientCache';
import { derivePoolBudget } from '@opengpex/editor/core/engine/gpu/resources/poolBudget';
import { LayerTexture } from '@opengpex/editor/core/engine/gpu/resources/LayerTexture';
import { BufferRing } from '@opengpex/editor/core/engine/gpu/resources/BufferRing';
import { PipelineCache } from '@opengpex/editor/core/engine/gpu/resources/PipelineCache';
import { GpuTimer } from '@opengpex/editor/core/engine/gpu/resources/GpuTimer';
import { SceneCompiler } from '@opengpex/editor/core/engine/pipeline/graph/SceneCompiler';
import { RenderGraph, compositeDims, type ExportViewport } from '@opengpex/editor/core/engine/pipeline/graph/RenderGraph';
import { computeCompositeSignature } from '@opengpex/editor/core/engine/pipeline/scene/compositeSignature';
import { clearVmaskCache } from '@opengpex/editor/core/engine/pipeline/graph/build/prepareVmaskSources';
import { GPUTextureUsage, GPUBufferUsage } from '@opengpex/editor/core/engine/gpu/constants';
import { halfToFloat } from '@opengpex/editor/core/engine/color/float16';
import type { IEngine, ExportOptions, ExportResult, UploadSource, LutUpload } from '@opengpex/editor/core/engine/pipeline/IEngine';
import type { Lut3dUpload } from '@opengpex/editor/core/engine/pipeline/scene/lut3dPlan';
import { PERF_MON } from '@opengpex/editor/core/helpers/config';

// Backward-compatible re-export of the engine contract (defined inline here pre-refactor).
export type { IEngine, ExportOptions, ExportResult, UploadSource, LutUpload } from '@opengpex/editor/core/engine/pipeline/IEngine';

// ────────────────────────────────────────────────────────────
// WebGpuEngine
// ────────────────────────────────────────────────────────────

/**
 * [PERF_MON] Fire `cb` once the GPU has finished all work submitted up to now.
 * `GPUQueue.onSubmittedWorkDone` exists at runtime but is absent from the pinned
 * `@webgpu/types`, so it is reached through a narrow cast and skipped if missing.
 */
function onQueueDone(queue: GPUQueue, cb: () => void): void {
  const done = (queue as unknown as { onSubmittedWorkDone?: () => Promise<void> })
    .onSubmittedWorkDone;
  if (typeof done !== 'function') return;
  done.call(queue).then(cb).catch(() => { /* device lost — ignore */ });
}

export class WebGpuEngine implements IEngine {
  private readonly gpu = new GpuDevice();

  private texturePool: TexturePool | null = null;
  /**
   * Engine-owned exact-size reuse for full-canvas /
   * oversized compositor transients (active vector stroke, ping-pong buffers)
   * that must bypass the POT pool. Created alongside `texturePool` (they share a
   * device lifetime), swept per frame, cleared on dimsChanged / device loss /
   * teardown. See {@link ResidentTransientCache}.
   */
  private residentTransients: ResidentTransientCache | null = null;
  private pipelineCache: PipelineCache | null = null;
  private bufferRing: BufferRing | null = null;
  private initPromise: Promise<Capabilities> | null = null;

  /**
   * Last Scene handed to `render()`.
   *
   * Kept for two reasons that both fall out of Scene being immutable pure data:
   *   1. device-loss recovery — re-init then replay;
   *   2. dirty-region diffing — compare against the incoming Scene.
   */
  private lastScene: Scene | null = null;

  /** Resident texture registry. */
  private readonly assets = new Map<string, LayerTexture>();

  /**
   * Resident 1D LUT registry, keyed by the deterministic `lutId`.
   * Curves/levels tables live here; dedup by lutId means an identical config is
   * uploaded once and shared across layers/frames. Lifecycle: created in
   * `uploadLut`, released in `releaseLut`, all dropped in `destroy`.
   */
  private readonly luts = new Map<string, { texture: GPUTexture; view: GPUTextureView }>();
  /** Resident 3D `.cube` LUTs — same dedup contract as `luts`. */
  private readonly luts3d = new Map<string, { texture: GPUTexture; view: GPUTextureView }>();

  /**
   * The document-space composited texture is
   * kept ALIVE across frames; on pan/zoom (view-only change) we skip
   * re-compositing and only replay the cheap view pass.
   */
  private compositeTexture: LayerTexture | null = null;
  /** Content signature of the cached composite (see compositeSignature.ts). */
  private compositeSignature: string | null = null;
  /** Dims the cached composite was built at — a change forces a rebuild (R5). */
  private compositeDocW = 0;
  private compositeDocH = 0;
  private compositeFormat: GPUTextureFormat | null = null;

  /**
   * Per-asset epoch, bumped on every GENUINE re-transfer in `upload()` (not on
   * deduped no-ops). Feeds the composite signature so an in-place pixel edit
   * (same assetId, new bitmap) invalidates the cache (R2 miss-detection).
   */
  private readonly assetEpochs = new Map<string, number>();

  /**
   * Signature-string memo. `computeCompositeSignature` walks every layer
   * and `JSON.stringify`s masks/adjustments/filters — non-trivial CPU that ran
   * EVERY frame, even on a cam-only frame whose `scene.layers` is byte-identical
   * (and, with the CPU content cache, the very SAME array reference). We memoize
   * the computed signature on the inputs it is a PURE FUNCTION of: the
   * `scene.layers` reference + document dims + working format + a monotonic
   * asset-epoch version (bumped on any genuine re-transfer). A cam-only frame
   * hits this memo and skips the string rebuild entirely.
   *
   * SOUNDNESS: identical to the content cache — the memo key is a subset of the
   * signature's own inputs, so "same key ⟹ same signature". Only ever a wasted
   * recompute (false-dirty), never a stale signature (false-clean).
   */
  private sigMemoLayers: readonly LayerNode[] | null = null;
  private sigMemoDocW = 0;
  private sigMemoDocH = 0;
  private sigMemoFormat: GPUTextureFormat | null = null;
  private sigMemoEpochVersion = -1;
  private sigMemoValue: string | null = null;
  /**
   * Monotonic counter bumped whenever ANY asset epoch changes (in `upload()`).
   * A cam-only frame does not bump it, so the signature memo stays valid; an
   * in-place pixel edit bumps an epoch → bumps this → memo miss → recompute.
   */
  private assetEpochVersion = 0;

  /**
   * [PERF_MON] Per-stage timing accumulator for the render() hot path. Splits the
   * single "render" number CanvasStage already logs into compile / signature /
   * composite-encode / present-encode (CPU), plus composite/present GPU-done
   * latency (via `onSubmittedWorkDone`). Flushed to console ~1×/sec.
   *
   * WHY: during brush drags, a drag STILL recomposites the whole layer stack into a
   * FULL-CANVAS target every frame (composite target = `compositeDims` = frame
   * size, never the stroke bbox — P1 only shrank the stroke's own vector
   * transient). This panel quantifies exactly that: `recomposite=N/N` (fires
   * every frame), `target=W×H` (stays full canvas), and `gpu→composite` (the
   * dominant cost). Zero cost when PERF_MON is off — every write is gated.
   *
   * NOTE on GPU numbers: `onSubmittedWorkDone` is COARSE — it resolves when all
   * work submitted up to that call has finished, so the value includes any queue
   * backlog (which is exactly what a slow drag produces). It is a latency proxy,
   * not a per-pass GPU cost; use `timestamp-query` for per-pass breakdown.
   */
  private readonly _renderPerf = {
    n: 0,
    compileSum: 0, compileMax: 0,
    sigSum: 0, sigMax: 0, sigMiss: 0,
    recompN: 0, compEncSum: 0, compEncMax: 0,
    presEncSum: 0, presEncMax: 0,
    compGpuSum: 0, compGpuN: 0, compGpuMax: 0,
    presGpuSum: 0, presGpuN: 0, presGpuMax: 0,
    // [PERF_MON] TRUE per-pass GPU exec time (via `timestamp-query`), independent
    // of queue backlog — the ground truth `onSubmittedWorkDone` above cannot give.
    // `compSpan` = whole composite submit (vector + composite passes); `tsPass`
    // holds each labelled pass (vector / composite(pure)/blend / present).
    tsCompSpanSum: 0, tsCompSpanN: 0, tsCompSpanMax: 0,
    tsPass: {} as Record<string, { sum: number; n: number; max: number }>,
    docW: 0, docH: 0, layers: 0,
    lastFlush: 0,
  };

  /**
   * [PERF_MON] Ground-truth GPU pass timers (only allocated when PERF_MON is on
   * and the adapter grants `timestamp-query`). One per submit boundary: composite
   * and present each own a queryset + readback buffer. Nulled + destroyed on
   * device rebuild / teardown.
   */
  private _compTimer: GpuTimer | null = null;
  private _presTimer: GpuTimer | null = null;


  /**
   * One-shot callbacks awaiting the next successful swapchain submission.
   * Drained (and cleared) at the end of a `render()` that actually reached
   * `RenderGraph.execute` — never on an early-out path where no pixels landed.
   */
  private firstPaintWaiters: Array<() => void> = [];

  /**
   * Residency metadata for the dedup contract, keyed by `assetId`.
   * `source` is the last uploaded bitmap reference; `version` is the optional
   * content stamp. Either matching one skips re-transfer.
   */
  private readonly assetMeta = new Map<
    string,
    { source: ImageBitmap | VideoFrame | OffscreenCanvas | Float32Array | Uint16Array; version?: number }
  >();

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
          // Resident transient cache shares the pool's device lifetime.
          this.residentTransients?.clear();
          this.residentTransients = new ResidentTransientCache(device);
        }
        if (!this.pipelineCache || this.pipelineCache.device !== device) {
          this.pipelineCache?.destroy();
          this.pipelineCache = new PipelineCache(device);
        }
        if (!this.bufferRing || this.bufferRing.device !== device) {
          this.bufferRing?.destroy();
          this.bufferRing = new BufferRing(device);
        }

        // On device loss, replay the last Scene once the device is back.
        this.gpu.setLostHandler(() => {
          this.initPromise = null;
          for (const asset of this.assets.values()) {
            asset.destroy();
          }
          this.assets.clear();
          this.assetMeta.clear();

          const scene = this.lastScene;
          const currentCanvas = this.gpu.getCanvas() ?? canvas;
          void this.gpu.init(currentCanvas, surface).then(() => {
            const reloadedDevice = this.gpu.getDevice();
            if (reloadedDevice) {
              this.texturePool?.destroy();
              this.texturePool = this.#makeTexturePool(reloadedDevice, this.gpu.getCapabilities());
              // The resident transients belonged to the lost device.
              this.residentTransients?.clear();
              this.residentTransients = new ResidentTransientCache(reloadedDevice);
              this.pipelineCache?.destroy();
              this.pipelineCache = new PipelineCache(reloadedDevice);
              this.bufferRing?.destroy();
              this.bufferRing = new BufferRing(reloadedDevice);
            }
            // The composite target belonged to the lost device and is
            // engine-owned (not freed by the pool teardown above). Destroy it and
            // clear the cache stamps so the replay below rebuilds it fresh.
            this.compositeTexture?.destroy();
            this.compositeTexture = null;
            this.compositeSignature = null;
            this.compositeFormat = null;
            this.compositeDocW = 0;
            this.compositeDocH = 0;
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

  /**
   * Synchronously attach a new or remounted canvas to the existing device.
   * Useful when React remounts Viewport with a new HTMLCanvasElement.
   */
  attachCanvas(canvas: HTMLCanvasElement, surface?: SurfaceConfig): boolean {
    return this.gpu.attachCanvas(canvas, surface);
  }

  /**
   * Register a one-shot post-first-paint callback. See `IEngine.onFirstPaint`.
   * Fired at the end of the next `render()` that actually submits a frame.
   */
  onFirstPaint(cb: () => void): () => void {
    this.firstPaintWaiters.push(cb);
    return () => {
      this.firstPaintWaiters = this.firstPaintWaiters.filter((w) => w !== cb);
    };
  }

  /**
   * Declarative frame submission.
   *
   * Draws scene layers bottom-to-top onto the swapchain render pass.
   */
  render(scene: Scene): void {
    this.lastScene = scene;
    if (!this.gpu.isReady() || !this.pipelineCache || !this.bufferRing || !this.texturePool) {
      return;
    }

    const context = this.gpu.getContext();
    const device = this.gpu.getDevice();
    const caps = this.gpu.getCapabilities();
    if (!context || !device || !caps) return;

    // Safety checks: ensure device matches all cached resources
    if (
      this.pipelineCache.device !== device ||
      this.texturePool.device !== device ||
      this.bufferRing.device !== device
    ) {
      this.pipelineCache.destroy();
      this.pipelineCache = new PipelineCache(device);
      this.texturePool.destroy();
      this.texturePool = this.#makeTexturePool(device, caps);
      // Resident transients belonged to the mismatched device.
      this.residentTransients?.clear();
      this.residentTransients = new ResidentTransientCache(device);
      this.bufferRing.destroy();
      this.bufferRing = new BufferRing(device);

      for (const asset of this.assets.values()) {
        asset.destroy();
      }
      this.assets.clear();
      this.assetMeta.clear();
      // LUT textures belonged to the destroyed device — drop them so the next
      // frame re-uploads via the SceneAssembler LUT plan (dedup by lutId).
      for (const entry of this.luts.values()) {
        entry.texture.destroy();
      }
      this.luts.clear();
      for (const entry of this.luts3d.values()) {
        entry.texture.destroy();
      }
      this.luts3d.clear();
      // Device rebuild invalidates the composite cache —
      // the target is engine-owned (not pooled), so DESTROY it explicitly;
      // the recreated TexturePool no longer frees it for us. Force a fresh composite.
      this.compositeTexture?.destroy();
      this.compositeTexture = null;
      this.compositeSignature = null;
      this.compositeFormat = null;
      this.compositeDocW = 0;
      this.compositeDocH = 0;
      this.assetEpochs.clear();
      // Device rebuild invalidates the signature memo too.
      this.sigMemoLayers = null;
      this.sigMemoValue = null;
      this.assetEpochVersion++;
      // [PERF_MON] GPU timers held resources on the destroyed device.
      this._compTimer?.destroy();
      this._compTimer = null;
      this._presTimer?.destroy();
      this._presTimer = null;
    }

    // Safety checks: canvas must be connected to DOM and have non-zero dimensions
    const canvas = context.canvas as HTMLCanvasElement;
    if (!canvas || canvas.width === 0 || canvas.height === 0) return;
    if (typeof canvas.isConnected === 'boolean' && !canvas.isConnected) return;

    let currentTexture: GPUTexture;
    try {
      currentTexture = context.getCurrentTexture();
    } catch {
      return;
    }
    const currentView = currentTexture.createView();

    // Reset BufferRing cursor for the frame
    this.bufferRing.reset();

    // 1. Compile scene into intelligent batches
    const _pCompileT0 = PERF_MON ? performance.now() : 0;
    const compiled = SceneCompiler.compile(scene);
    const _pCompileMs = PERF_MON ? performance.now() - _pCompileT0 : 0;

    const workingFormat: GPUTextureFormat = caps.workingFormat ?? 'rgba16float';

    // Re-composite the document texture ONLY when the content signature changes
    // (layers / attributes / order / edited pixels). Pan/zoom changes only
    // `scene.view`, which is NOT in the signature, so those frames skip
    // compositing entirely and replay just the cheap view pass.
    const { frameWidth: docW, frameHeight: docH } = compositeDims(scene);

    // Reuse the memoized signature when the inputs it derives from are
    // unchanged (same `scene.layers` reference on a cam-only frame + same dims /
    // format / asset-epoch version). Skips the per-frame layer walk + JSON work.
    // Defence-in-depth for heavy scenes — see the CanvasStage/SceneContentCache
    // note: with DevTools closed assemble takes negligible time, so this memo is
    // a situational win to avoid unnecessary JSON serialization work.
    let signature: string;
    const _pSigT0 = PERF_MON ? performance.now() : 0;
    let _pSigMiss = false;
    if (
      this.sigMemoValue !== null &&
      this.sigMemoLayers === scene.layers &&
      this.sigMemoDocW === docW &&
      this.sigMemoDocH === docH &&
      this.sigMemoFormat === workingFormat &&
      this.sigMemoEpochVersion === this.assetEpochVersion
    ) {
      signature = this.sigMemoValue;
    } else {
      _pSigMiss = true;
      signature = computeCompositeSignature(scene, {
        getAssetEpoch: (assetId) => this.assetEpochs.get(assetId) ?? 0,
        workingFormat,
      });
      this.sigMemoLayers = scene.layers;
      this.sigMemoDocW = docW;
      this.sigMemoDocH = docH;
      this.sigMemoFormat = workingFormat;
      this.sigMemoEpochVersion = this.assetEpochVersion;
      this.sigMemoValue = signature;
    }
    const _pSigMs = PERF_MON ? performance.now() - _pSigT0 : 0;

    // R5 — composite texture lifecycle: rebuild when the cached one is missing,
    // its dims changed, or the working format changed.
    const dimsChanged =
      this.compositeDocW !== docW ||
      this.compositeDocH !== docH ||
      this.compositeFormat !== workingFormat;

    const needsRecomposite =
      this.compositeTexture === null || dimsChanged || this.compositeSignature !== signature;

    const _pCompEncT0 = PERF_MON ? performance.now() : 0;
    let _pCompEncMs = 0;
    if (needsRecomposite) {
      // The composite target is ENGINE-OWNED — an exact-size
      // (NON-POT, NON-pool) texture reused IN PLACE across frames. A signature-
      // only change (any edit) re-renders into the SAME texture; only a dims/
      // format change destroys it and rebuilds at the new size. This removes the
      // per-frame `createTexture(512MiB)+destroy` churn the POT pool inflicted on
      // large canvases: loadOp:'clear' still clears it every frame, but
      // the allocation no longer thrashes.
      if (this.compositeTexture && dimsChanged) {
        this.compositeTexture.destroy();
        this.compositeTexture = null;
      }
      if (dimsChanged) {
        // The previous document's full-canvas transients are dead
        // weight at the new size. Drop the resident vector/ping-pong buffers and
        // purge ALL idle pool blocks (`evictUnused(0)`) in one shot, so a large-to-small canvas
        // switch frees VRAM instead of stranding oversized ghosts in the pool cache.
        this.residentTransients?.clear();
        this.texturePool.evictUnused(0);
      }
      if (!this.compositeTexture) {
        this.compositeTexture = this.#createCompositeTarget(device, docW, docH, workingFormat);
      }

      // [PERF_MON] Arm the composite GPU timer (skips if a prior readback is still
      // pending → natural sampling). `startSubmit` gates whether passes instrument.
      let _compArmed = false;
      if (PERF_MON) {
        if (!this._compTimer) this._compTimer = new GpuTimer(device, 'composite');
        _compArmed = this._compTimer.startSubmit();
      }

      // Open the resident-transient frame so this composite's `acquire`s
      // mark their slots live; `endFrame()` after submit sweeps any slot that
      // went untouched (a committed stroke's transient, idle ping-pong buffers).
      this.residentTransients?.beginFrame();

      const { scratch } = RenderGraph.composite(compiled, {
        device,
        pipelineCache: this.pipelineCache,
        bufferRing: this.bufferRing,
        texturePool: this.texturePool,
        assets: this.assets,
        workingFormat,
        resolveLutView: (lutId) => this.getLutView(lutId),
        resolveLut3dView: (lutId) => this.getLut3dView(lutId),
        target: this.compositeTexture,
        acquireResidentTransient: this.residentTransients
          ? (key, desc) => this.residentTransients!.acquire(key, desc)
          : undefined,
        gpuTimer: _compArmed ? this._compTimer! : undefined,
      });

      // The composite landed in the engine-owned `target`; only the pooled
      // scratch (ping-pong spare + filter transients) returns to the pool.
      // Resident buffers are excluded by RenderGraph (the cache owns them).
      for (const tex of scratch) this.texturePool.release(tex);

      // Sweep resident slots not touched this frame (lazy de-alloc).
      this.residentTransients?.endFrame();

      this.compositeSignature = signature;
      this.compositeDocW = docW;
      this.compositeDocH = docH;
      this.compositeFormat = workingFormat;

      if (PERF_MON) {
        _pCompEncMs = performance.now() - _pCompEncT0;
        // GPU-done latency for composite: measured from the start of encode until
        // the queue signals this (and all prior) work complete. See _renderPerf.
        const g0 = _pCompEncT0;
        onQueueDone(device.queue, () => {
          const ms = performance.now() - g0;
          const w = this._renderPerf;
          w.compGpuSum += ms; w.compGpuN++;
          if (ms > w.compGpuMax) w.compGpuMax = ms;
        });
        // True per-pass GPU exec time (backlog-independent). Reads after submit.
        if (_compArmed) {
          this._compTimer!.read((r) => {
            const w = this._renderPerf;
            w.tsCompSpanSum += r.spanMs; w.tsCompSpanN++;
            if (r.spanMs > w.tsCompSpanMax) w.tsCompSpanMax = r.spanMs;
            for (const p of r.passes) this.#accumTsPass(p.label, p.ms);
          });
        }
      }
    }

    // 3. Present the (possibly cached) composite to the swapchain applying the
    // camera. This runs EVERY frame — it is the only work on pan/zoom.
    const _pPresEncT0 = PERF_MON ? performance.now() : 0;
    let _presArmed = false;
    if (PERF_MON) {
      if (!this._presTimer) this._presTimer = new GpuTimer(device, 'present');
      _presArmed = this._presTimer.startSubmit();
    }
    RenderGraph.present(this.compositeTexture!, {
      device,
      pipelineCache: this.pipelineCache,
      bufferRing: this.bufferRing,
      currentView,
      // Surface format constraint: MUST match the format `GpuDevice.configureSurface` pinned, not the
      // probe result — the view pipeline is compiled against the actual swapchain
      // texture. Using `caps.preferredFormat` here would mismatch on any platform
      // whose preferred format differs, failing pipeline validation.
      targetFormat: SWAPCHAIN_FORMAT,
      scene,
      gpuTimer: _presArmed ? this._presTimer! : undefined,
    });

    if (PERF_MON) {
      const presEncMs = performance.now() - _pPresEncT0;
      const g0 = _pPresEncT0;
      onQueueDone(device.queue, () => {
        const ms = performance.now() - g0;
        const w = this._renderPerf;
        w.presGpuSum += ms; w.presGpuN++;
        if (ms > w.presGpuMax) w.presGpuMax = ms;
      });
      // True per-pass GPU exec time for the present view pass (backlog-independent).
      if (_presArmed) {
        this._presTimer!.read((r) => {
          for (const p of r.passes) this.#accumTsPass(p.label, p.ms);
        });
      }
      this.#accumRenderPerf({
        compileMs: _pCompileMs,
        sigMs: _pSigMs,
        sigMiss: _pSigMiss,
        recomposite: needsRecomposite,
        compEncMs: _pCompEncMs,
        presEncMs,
        docW,
        docH,
        layers: scene.layers.length,
      });
    }

    // 3. Real pixels are now committed to the swapchain — release any one-shot
    // first-paint waiters (visibility gate, see onFirstPaint). Drained after a
    // genuine submit only; every early-return above skips this by design so the
    // gate never opens on a frame that produced nothing.
    if (this.firstPaintWaiters.length > 0) {
      const waiters = this.firstPaintWaiters;
      this.firstPaintWaiters = [];
      for (const cb of waiters) {
        try { cb(); } catch (err) { console.warn('[WebGpuEngine] onFirstPaint callback threw', err); }
      }
    }
  }

  /**
   * Same Scene, offscreen sink + readback (sharing the same render pipeline).
   *
   * Readback flow:
   *   composite → `copyTextureToBuffer` (256-aligned) → `mapAsync(READ)` →
   *   de-pad rows → decode `rgba16float` texels → quantize to the requested
   *   depth → `ExportResult`.
   *
   * DELIBERATELY DEFERRED (do NOT add here):
   *   • Large-image tiling when the row-padded buffer exceeds `maxBufferSize`
   *     (TODO: split into horizontal bands, copy+map each, stitch).
   *   • TERMINAL TRC / colour-space ENCODE. The composite buffer is LINEAR light.
   *     This method returns LINEAR values in the requested container; the single
   *     sRGB/target-TRC encode belongs to the codec step, which MUST reuse the same
   *     `linear_to_srgb` conversion as `view.wgsl` (no second encode point).
   *     f16 depth returns the raw linear half decoded to float; u8/u16 quantize
   *     the linear value as-is.
   *
   * Reuses `RenderGraph.composite` (its pooled target already carries
   * `COPY_SRC`), so export shares the exact compile+composite path as `render()`.
   */
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

    // 1. Composite into a FRESH target texture matching export resolution.
    // One submit inside composite().
    this.bufferRing.reset();
    const compiled = SceneCompiler.compile(scene);
    const { result: composite, scratch } = RenderGraph.composite(compiled, {
      device,
      pipelineCache: this.pipelineCache,
      bufferRing: this.bufferRing,
      texturePool: this.texturePool,
      assets: this.assets,
      workingFormat,
      resolveLutView: (lutId) => this.getLutView(lutId),
      resolveLut3dView: (lutId) => this.getLut3dView(lutId),
      exportViewport,
    });

    // Tracked out here so the `finally` can free it on ANY exit path: a lost
    // device rejects `mapAsync`, and `#decodeReadback` throws on OOM. Either one
    // used to leak the whole staging buffer (tens to hundreds of MB) per attempt.
    let staging: GPUBuffer | undefined;
    let mappedNow = false;
    try {
      // 2. Read the TARGET rect (targetW×targetH) back. rgba16float = 8 bytes/texel;
      // rgba32float = 16. copyTextureToBuffer requires bytesPerRow % 256 === 0.
      const bytesPerTexel = workingFormat === 'rgba32float' ? 16 : 8;
      const bytesPerRow = Math.ceil((targetW * bytesPerTexel) / 256) * 256;
      const bufferSize = bytesPerRow * targetH;

      if (device.limits?.maxBufferSize && bufferSize > device.limits.maxBufferSize) {
        throw new Error(
          `[WebGpuEngine] Export readback buffer size (${bufferSize} bytes) exceeds device maxBufferSize (${device.limits.maxBufferSize} bytes).`,
        );
      }

      staging = device.createBuffer({
        label: 'Export Readback Staging',
        size: bufferSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });

      const encoder = device.createCommandEncoder({ label: 'Export Readback Encoder' });
      encoder.copyTextureToBuffer(
        { texture: composite.texture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
        { buffer: staging, offset: 0, bytesPerRow, rowsPerImage: targetH },
        { width: targetW, height: targetH, depthOrArrayLayers: 1 },
      );
      device.queue.submit([encoder.finish()]);

      // `bufferSize` is a multiple of 256, so it satisfies mapAsync's alignment.
      await staging.mapAsync(GPUMapMode.READ, 0, bufferSize);
      mappedNow = true;
      const mapped = staging.getMappedRange(0, bufferSize);

      // 3. De-pad rows + decode → quantize to the requested container.
      const pixels = this.#decodeReadback(mapped, {
        width: targetW,
        height: targetH,
        bytesPerRow,
        workingFormat,
        bitDepth: opts.bitDepth,
      });

      return { width: targetW, height: targetH, bitDepth: opts.bitDepth, pixels };
    } finally {
      // `unmap()` is only legal on a mapped buffer, hence the flag; `destroy()`
      // is safe either way and implicitly unmaps.
      if (staging) {
        if (mappedNow) staging.unmap();
        staging.destroy();
      }
      // Export composite target + scratch are one-shot: return them all.
      this.texturePool.release(composite.texture);
      for (const tex of scratch) this.texturePool.release(tex);
    }
  }

  /**
   * Construct a `TexturePool` with a device-adaptive `maxFreeBytes`:
   * low-VRAM / integrated adapters keep the idle-transient cache tight
   * so it does not stack atop the already-resident engine-owned composite target.
   * `caps` may be null pre-negotiation → the discrete default (safe over-provision).
   */
  #makeTexturePool(device: GPUDevice, caps: Capabilities | null): TexturePool {
    return new TexturePool(device, { maxFreeBytes: derivePoolBudget(caps ?? UNKNOWN_CAPABILITIES) });
  }

  /**
   * Allocate the engine-owned composite target at its EXACT document size
   * (no POT snap → no waste) and OUTSIDE the TexturePool (a single-size,
   * single-instance resident texture gains nothing from bucketing).
   * Usage mirrors the pool's default set so any sampler/readback path that used
   * to see a pooled target behaves identically. Lifetime: reused in place until
   * a dims/format change or teardown destroys it.
   */

  #createCompositeTarget(
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
    // Exact size ⇒ allocated == content ⇒ maxU=maxV=1.0 (present samples the
    // whole texture; no POT sub-rect fraction).
    return new LayerTexture({ texture, width, height, format });
  }

  /**
   * [PERF_MON] Fold one instrumented pass's TRUE GPU exec time into the rolling
   * window, keyed by label (vector / composite(pure)/blend / present).
   */
  #accumTsPass(label: string, ms: number): void {
    const map = this._renderPerf.tsPass;
    const e = map[label] ?? (map[label] = { sum: 0, n: 0, max: 0 });
    e.sum += ms; e.n++; if (ms > e.max) e.max = ms;
  }

  /**
   * [PERF_MON] Fold one frame's render-stage timings into the rolling window and
   * flush a one-line summary ~1×/sec. Called only when PERF_MON is on.
   */
  #accumRenderPerf(s: {
    compileMs: number;
    sigMs: number;
    sigMiss: boolean;
    recomposite: boolean;
    compEncMs: number;
    presEncMs: number;
    docW: number;
    docH: number;
    layers: number;
  }): void {
    const w = this._renderPerf;
    const now = performance.now();
    if (w.lastFlush === 0) w.lastFlush = now;

    w.n++;
    w.compileSum += s.compileMs; if (s.compileMs > w.compileMax) w.compileMax = s.compileMs;
    w.sigSum += s.sigMs; if (s.sigMs > w.sigMax) w.sigMax = s.sigMs; if (s.sigMiss) w.sigMiss++;
    if (s.recomposite) {
      w.recompN++;
      w.compEncSum += s.compEncMs;
      if (s.compEncMs > w.compEncMax) w.compEncMax = s.compEncMs;
    }
    w.presEncSum += s.presEncMs; if (s.presEncMs > w.presEncMax) w.presEncMax = s.presEncMs;
    w.docW = s.docW; w.docH = s.docH; w.layers = s.layers;

    if (now - w.lastFlush >= 1000 && w.n > 0) {
      const f = (x: number) => x.toFixed(2);
      const avg = (sum: number, n: number) => (n > 0 ? f(sum / n) : '-');
      console.warn(
        `[Engine.render] window(${w.n}f) target=${w.docW}×${w.docH} layers=${w.layers} recomposite=${w.recompN}/${w.n} | ` +
          `compile avg=${avg(w.compileSum, w.n)} max=${f(w.compileMax)} | ` +
          `sig avg=${avg(w.sigSum, w.n)} max=${f(w.sigMax)} miss=${w.sigMiss} | ` +
          `compEnc avg=${avg(w.compEncSum, w.recompN)} max=${f(w.compEncMax)} | ` +
          `presEnc avg=${avg(w.presEncSum, w.n)} max=${f(w.presEncMax)} | ` +
          `gpu→composite avg=${avg(w.compGpuSum, w.compGpuN)} max=${f(w.compGpuMax)} | ` +
          `gpu→present avg=${avg(w.presGpuSum, w.presGpuN)} max=${f(w.presGpuMax)} (ms, GPU=latency incl. queue backlog)`,
      );
      // Separate line: TRUE per-pass GPU exec time (timestamp-query), which is
      // NOT backlog-inflated — compare against the gpu→* latencies above to tell
      // "genuinely expensive pass" from "cheap pass, deep queue".
      const passKeys = Object.keys(w.tsPass);
      if (w.tsCompSpanN > 0 || passKeys.length > 0) {
        const passStr = passKeys
          .map((k) => `${k} avg=${avg(w.tsPass[k].sum, w.tsPass[k].n)} max=${f(w.tsPass[k].max)}`)
          .join(' | ');
        console.warn(
          `[Engine.render.gpuTS] compSpan avg=${avg(w.tsCompSpanSum, w.tsCompSpanN)} max=${f(w.tsCompSpanMax)}` +
            (passStr ? ` | ${passStr}` : '') +
            ' (ms, true GPU exec, backlog-independent)',
        );
      }
      w.n = 0;
      w.compileSum = 0; w.compileMax = 0;
      w.sigSum = 0; w.sigMax = 0; w.sigMiss = 0;
      w.recompN = 0; w.compEncSum = 0; w.compEncMax = 0;
      w.presEncSum = 0; w.presEncMax = 0;
      w.compGpuSum = 0; w.compGpuN = 0; w.compGpuMax = 0;
      w.presGpuSum = 0; w.presGpuN = 0; w.presGpuMax = 0;
      w.tsCompSpanSum = 0; w.tsCompSpanN = 0; w.tsCompSpanMax = 0;
      w.tsPass = {};
      w.lastFlush = now;
    }
  }

  // ── Readback staging ───────────────────────────────────────────────────────
  // One fresh `MAP_READ` buffer per `export()`, destroyed in that method's
  // `finally` as soon as the readback is decoded. No pooling: every readback path
  // — file export, bake, and the colour sampler's press-time snapshot + commit
  // micro-capture — is a one-shot at human cadence, so there is no repeated churn
  // to amortise.

  /**
   * De-pad the row-aligned staging buffer and decode each texel to the requested
   * output container. LINEAR values are preserved (final color encoding happens
   * at the export codec step). Colour and alpha are treated identically — a straight
   * numeric requantization.
   */
  #decodeReadback(
    mapped: ArrayBuffer,
    p: {
      width: number;
      height: number;
      bytesPerRow: number;
      workingFormat: GPUTextureFormat;
      bitDepth: 8 | 16 | 32;
    },
  ): Uint8ClampedArray | Uint16Array | Float32Array {
    const { width, height, bytesPerRow, workingFormat } = p;
    const rowFloats = width * 4;
    const isF32 = workingFormat === 'rgba32float';

    // Read one un-padded row of RGBA floats from the padded staging buffer.
    //
    // The f32 lane returns a VIEW, not a copy: `mapped` is already f32, so the
    // only work is skipping the 256-byte row padding, and `bytesPerRow` is a
    // multiple of 256 — hence always 4-byte aligned, which `Float32Array` over an
    // ArrayBuffer requires. The view is valid until `unmap()`, which happens after
    // every caller below has consumed it, so this never escapes.
    //
    // It used to `.slice()` here. That was not needed by ANY lane — the 8/16-bit
    // lanes only read `rowF[i]`, and the 32-bit lane immediately `out.set()`s the
    // row, so the slice made it copy the same data twice and allocate one throwaway
    // Float32Array per row. Invisible in `export()` (a one-shot user action), but
    // the colour sampler put this on an interactive path: 92ms of main-thread copy
    // per 4096×4096 capture, half of it pure waste.
    const readRowFloats = (row: number): Float32Array => {
      if (isF32) {
        return new Float32Array(mapped, row * bytesPerRow, rowFloats);
      }
      const halves = new Uint16Array(mapped, row * bytesPerRow, rowFloats);
      const out = new Float32Array(rowFloats);
      for (let i = 0; i < rowFloats; i++) out[i] = halfToFloat(halves[i]);
      return out;
    };

    if (p.bitDepth === 32) {
      const need = width * height * 4;
      const out = new Float32Array(need);
      for (let y = 0; y < height; y++) out.set(readRowFloats(y), y * rowFloats);
      return out;
    }
    if (p.bitDepth === 16) {
      const out = new Uint16Array(width * height * 4);
      for (let y = 0; y < height; y++) {
        const rowF = readRowFloats(y);
        const base = y * rowFloats;
        for (let i = 0; i < rowFloats; i++) {
          out[base + i] = Math.max(0, Math.min(65535, Math.round(rowF[i] * 65535)));
        }
      }
      return out;
    }
    // 8-bit — Uint8ClampedArray auto-clamps to [0,255].
    const out = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      const rowF = readRowFloats(y);
      const base = y * rowFloats;
      for (let i = 0; i < rowFloats; i++) out[base + i] = Math.round(rowF[i] * 255);
    }
    return out;
  }

  /**
   * True once this asset is resident in VRAM. SceneAssembler queries
   * this before uploading to achieve zero-transfer pan/zoom.
   */
  has(assetId: string): boolean {
    return this.assets.has(assetId);
  }

  /**
   * Upload an ingested source into a resident GPUTexture.
   *
   * Dispatches by source bit depth:
   *   • `bitmap` → zero-copy `copyExternalImageToTexture` → `rgba8unorm`.
   *   • `raw`    → `writeTexture` of decoded naked pixels → `rgba16float` /
   *     `rgba32float` (16/32-bit sources; the composite buffer stays f16).
   *
   * Resident-dedup: if `assetId` is already resident and unchanged, returns
   * immediately without release/create/DMA. "Unchanged" = matching `version`
   * stamp (when provided) or identical `src.data` reference (when not). Only a
   * genuine pixel edit (new source / bumped version) triggers re-transfer.
   */
  uploadSource(assetId: string, src: UploadSource, version?: number): void {
    if (!this.gpu.isReady()) {
      return;
    }

    // Dedup: skip re-transfer when the resident asset is unchanged.
    const existing = this.assets.get(assetId);
    const meta = this.assetMeta.get(assetId);
    if (existing && meta) {
      const unchanged =
        version !== undefined ? meta.version === version : meta.source === src.data;
      if (unchanged) {
        return;
      }
    }

    const device = this.gpu.getDevice()!;

    // Content changed (or first upload): drop the stale resident texture.
    this.release(assetId);

    let layerTex: LayerTexture;

    if (src.kind === 'bitmap') {
      const bitmap = src.data;
      const width = 'displayWidth' in bitmap ? bitmap.displayWidth : bitmap.width;
      const height = 'displayHeight' in bitmap ? bitmap.displayHeight : bitmap.height;

      const texture = device.createTexture({
        size: [width, height, 1],
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
        label: `LayerAsset (${assetId})`,
      });

      // Identity upload: the bitmap preserves its intrinsic source gamut (e.g. Display-P3
      // via embedded ICC). Tag the copy destination with that SAME gamut so
      // `copyExternalImageToTexture` performs NO gamut conversion (identity);
      // the shader's gamut-align step later maps gamut_id→working (P3).
      //   • color rasters carry gamut = frame.colorSpace ∈ {srgb, display-p3};
      //   • untagged sources (masks, canvas-baked transients) are sRGB-intrinsic
      //     ⇒ default 'srgb' (identical to the pre-fix WebGPU default → zero
      //     regression; the gray coverage axis is gamut-invariant regardless).
      // A P3 raster with a missing/srgb tag would be silently narrowed — the
      // oversaturation bug this fix removes.
      const destColorSpace: GPUPredefinedColorSpace =
        src.gamut === 'display-p3' ? 'display-p3' : 'srgb';

      device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture, colorSpace: destColorSpace },
        [width, height],
      );

      layerTex = new LayerTexture({ texture, width, height, format: 'rgba8unorm' });
    } else {
      // Precision invariant: 16/32-bit sources land as naked pixels via
      // writeTexture. This branch is the resident dispatch skeleton —
      // a 4-channel float/half-float upload.
      const { w, h, format } = src.desc;
      const bytesPerPixel = format === 'rgba32float' ? 16 : 8;

      const texture = device.createTexture({
        size: [w, h, 1],
        format,
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
        label: `LayerAsset (${assetId})`,
      });

      device.queue.writeTexture(
        { texture },
        src.data,
        { bytesPerRow: w * bytesPerPixel, rowsPerImage: h },
        [w, h, 1],
      );

      layerTex = new LayerTexture({ texture, width: w, height: h, format });
    }

    this.assets.set(assetId, layerTex);
    this.assetMeta.set(assetId, { source: src.data, version });

    // A genuine re-transfer bumps the asset epoch so the composite signature
    // changes and the cache re-composites. Deduped no-op uploads return early
    // above and never reach here.
    this.assetEpochs.set(assetId, (this.assetEpochs.get(assetId) ?? 0) + 1);
    // Invalidate the signature memo: an epoch change means the next
    // signature must be recomputed (in-place pixel edit → new pixels).
    this.assetEpochVersion++;
  }

  release(assetId: string): void {
    const layerTex = this.assets.get(assetId);
    if (layerTex) {
      layerTex.destroy();
      this.assets.delete(assetId);
    }
    this.assetMeta.delete(assetId);
  }

  hasLut(lutId: string): boolean {
    return this.luts.has(lutId);
  }

  /**
   * Upload/dedup a resident 1D LUT (curves/levels residency). The
   * `lutId` is a deterministic content hash, so an already-resident id means the
   * pixels are identical → no-op (no re-transfer). Only a genuine curve/level
   * edit produces a new id and thus a new upload. rgba16float 1D texture so the
   * shared clamp/linear sampler interpolates entries at full working precision.
   */
  uploadLut(lut: LutUpload): void {
    if (!this.gpu.isReady()) return;
    // Dedup: identical content id ⇒ identical pixels ⇒ nothing to do.
    if (this.luts.has(lut.lutId)) return;

    const device = this.gpu.getDevice()!;
    const texture = device.createTexture({
      size: [lut.width, 1, 1],
      dimension: '1d',
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: `LUT (${lut.lutId})`,
    });
    device.queue.writeTexture(
      { texture },
      lut.data,
      { bytesPerRow: lut.width * 8, rowsPerImage: 1 },
      [lut.width, 1, 1],
    );
    this.luts.set(lut.lutId, { texture, view: texture.createView({ dimension: '1d' }) });
  }

  releaseLut(lutId: string): void {
    const entry = this.luts.get(lutId);
    if (entry) {
      entry.texture.destroy();
      this.luts.delete(lutId);
    }
  }

  /**
   * Resident LUT view for `lutId`, or `undefined` if not yet uploaded. Used by
   * the compositing passes to bind the curve/levels 1D LUT at group 1.
   */
  getLutView(lutId: string): GPUTextureView | undefined {
    return this.luts.get(lutId)?.view;
  }

  hasLut3d(lutId: string): boolean {
    return this.luts3d.has(lutId);
  }

  /**
   * Upload/dedup a resident 3D `.cube` LUT. Mirrors {@link uploadLut}:
   * the `lutId` is a content hash of the SAMPLES, so an already-resident id means
   * identical pixels → no-op.
   *
   * `lut.format` was chosen by `lut3dPlan.selectLut3dFormat` under the negotiated
   * capabilities, so it is always a FILTERABLE float format and can be bound
   * alongside the shared filtering sampler for hardware trilinear interpolation.
   */
  uploadLut3d(lut: Lut3dUpload): void {
    if (!this.gpu.isReady()) return;
    if (this.luts3d.has(lut.lutId)) return;

    const device = this.gpu.getDevice()!;
    const texture = device.createTexture({
      size: [lut.size, lut.size, lut.size],
      dimension: '3d',
      format: lut.format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: `LUT3D (${lut.lutId})`,
    });
    device.queue.writeTexture(
      { texture },
      lut.data,
      // `.cube` is red-fastest and writeTexture walks x→y→z, so the parsed sample
      // order uploads verbatim (see cubeLut's LAYOUT CONTRACT).
      { bytesPerRow: lut.bytesPerRow, rowsPerImage: lut.size },
      [lut.size, lut.size, lut.size],
    );
    this.luts3d.set(lut.lutId, { texture, view: texture.createView({ dimension: '3d' }) });
  }

  releaseLut3d(lutId: string): void {
    const entry = this.luts3d.get(lutId);
    if (entry) {
      entry.texture.destroy();
      this.luts3d.delete(lutId);
    }
  }

  /**
   * Resident 3D LUT view for `lutId`, or `undefined` if not yet uploaded. Bound at
   * group-1 binding 4; when absent the pass binds the 1×1×1 identity placeholder and
   * clears the sampling flag (correct-but-ungraded, never garbage).
   */
  getLut3dView(lutId: string): GPUTextureView | undefined {
    return this.luts3d.get(lutId)?.view;
  }

  destroy(): void {
    for (const asset of this.assets.values()) {
      asset.destroy();
    }
    this.assets.clear();
    this.assetMeta.clear();
    this.assetEpochs.clear();
    for (const entry of this.luts.values()) {
      entry.texture.destroy();
    }
    this.luts.clear();
    for (const entry of this.luts3d.values()) {
      entry.texture.destroy();
    }
    this.luts3d.clear();
    // The composite target is engine-owned (exact-size, not pooled), so
    // DESTROY it explicitly — texturePool.destroy() does not free it for us.
    this.compositeTexture?.destroy();
    this.compositeTexture = null;
    // The resident transient cache is engine-owned (exact-size, not
    // pooled) — destroy every live slot explicitly, like the composite target.
    this.residentTransients?.clear();
    this.residentTransients = null;
    this.compositeSignature = null;
    this.compositeFormat = null;
    this.compositeDocW = 0;
    this.compositeDocH = 0;
    // Drop the signature memo on teardown.
    this.sigMemoLayers = null;
    this.sigMemoValue = null;
    // Release owned vmask coverage textures + private compute rings.
    clearVmaskCache();
    this.lastScene = null;
    this.initPromise = null;
    // [PERF_MON] Free GPU timer resources.
    this._compTimer?.destroy();
    this._compTimer = null;
    this._presTimer?.destroy();
    this._presTimer = null;

    this.texturePool?.destroy();
    this.pipelineCache?.destroy();
    this.bufferRing?.destroy();

    this.texturePool = null;
    this.pipelineCache = null;
    this.bufferRing = null;

    this.gpu.destroy();
  }

  // ─── Diagnostics ───

  getCapabilities(): Capabilities | null {
    return this.gpu.getCapabilities();
  }

  /**
   * Synchronous GPU diagnostics snapshot. Assembles from resident,
   * synchronous sources only: negotiated `Capabilities`, `TexturePool.getStats()`,
   * and the engine-owned composite target's byte footprint (which lives OUTSIDE
   * the pool, so it must be accounted separately).
   *
   * ⚠️ CONTRACT: `limits` are ALLOCATION CEILINGS and `memory` is the
   * ENGINE's own book-keeping — NEITHER is a real hardware-VRAM figure. See
   * {@link GpuInfo} for the full caveat. Do not surface these as "VRAM usage".
   */
  getGpuInfo(): GpuInfo {
    const caps = this.gpu.getCapabilities();
    const ready = this.isReady() && caps !== null;
    const source = ready ? caps! : UNKNOWN_CAPABILITIES;

    const stats = this.texturePool?.getStats();
    const ct = this.compositeTexture;
    const compositeTargetBytes = ct
      ? estimateTextureBytes(ct.allocatedWidth, ct.allocatedHeight, ct.format)
      : 0;

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
        compositeTargetBytes,
      },
    };
  }

  getTexturePool(): TexturePool | null {
    return this.texturePool;
  }

  isReady(): boolean {
    return this.gpu.isReady();
  }
}

// ────────────────────────────────────────────────────────────
// Singleton accessor (merged from the former engine/renderer.ts)
//
// Provides:
//   - getGpuEngine(): lazy-created IEngine singleton
//   - getEngine(): alias to getGpuEngine() for backwards compatibility
//   - Cache singletons (sourceBitmapCache re-export)
// ────────────────────────────────────────────────────────────

// ── Lazy WebGPU Engine Singleton ──
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

// ── Cache Singletons (render loop subscribe + lifecycle) ──
export { sourceBitmapCache } from '@opengpex/editor/core/engine/sources/SourceBitmapCache';


