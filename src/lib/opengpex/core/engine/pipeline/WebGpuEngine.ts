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
import { GpuDevice, type SurfaceConfig } from '@opengpex/editor/core/engine/gpu/device/GpuDevice';
import type { Scene, LayerNode } from '@opengpex/editor/core/engine/pipeline/scene/Scene';
import { TexturePool, estimateTextureBytes } from '@opengpex/editor/core/engine/gpu/resources/TexturePool';
import { ResidentTransientCache } from '@opengpex/editor/core/engine/gpu/resources/ResidentTransientCache';
import { derivePoolBudget } from '@opengpex/editor/core/engine/gpu/resources/poolBudget';
import { LayerTexture } from '@opengpex/editor/core/engine/gpu/resources/LayerTexture';
import { BufferRing } from '@opengpex/editor/core/engine/gpu/resources/BufferRing';
import { PipelineCache } from '@opengpex/editor/core/engine/gpu/resources/PipelineCache';
import { GpuTimer } from '@opengpex/editor/core/engine/gpu/resources/GpuTimer';
import { SceneCompiler, type CompiledScene } from '@opengpex/editor/core/engine/pipeline/graph/SceneCompiler';
import {
  RenderGraph,
  compositeDims,
  type ExportViewport,
  type TexPlacement,
} from '@opengpex/editor/core/engine/pipeline/graph/RenderGraph';
import { effectiveScale } from '@opengpex/editor/core/engine/pipeline/graph/support/layerGeometry';
import { GainPresenter } from '@opengpex/editor/core/engine/pipeline/graph/support/gainPresenter';
import {
  resolveInteractiveDensity,
  densityCompositeDims,
  INTERACTIVE_COMPOSITE_CEIL_PX,
} from '@opengpex/editor/core/engine/pipeline/graph/support/densityComposite';
import {
  resolveCompositePlan,
  budgetDerivedCeilPx,
  COMPOSITE_BUDGET_DEFAULT_BYTES,
  workingFormatBpp,
} from '@opengpex/editor/core/engine/pipeline/graph/support/compositeBudget';
import { resolveRoiFrame } from '@opengpex/editor/core/engine/pipeline/graph/support/roiFrame';
import { computeCompositeSignature } from '@opengpex/editor/core/engine/pipeline/scene/compositeSignature';
import { clearVmaskCache } from '@opengpex/editor/core/engine/pipeline/graph/build/prepareVmaskSources';
import { releaseExportGlyphAtlas } from '@opengpex/editor/core/engine/pipeline/graph/build/vectorRenderers/TextRenderer';
import { clearBmaskCombineCache } from '@opengpex/editor/core/engine/pipeline/graph/build/prepareBmaskCombine';
import { GPUTextureUsage } from '@opengpex/editor/core/engine/gpu/constants';
import { readbackToPixels } from '@opengpex/editor/core/engine/gpu/readback';
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
   * Present-time gain-map decision collaborator (`graph/support/gainPresenter`):
   * texture residency, the gradual-reveal ease and its rAF self-pump. Resolved per
   * present with the scene's eligible asset id; undefined → gain_enabled 0
   * (the SDR base verbatim). The closures keep the dependency one-way (the
   * presenter never imports the engine).
   */
  readonly gainPresenter = new GainPresenter({
    getDevice: () => this.gpu.getDevice(),
    isHdrActive: () => this.gpu.isHdrPresentation(),
    replayFrame: () => {
      if (this.lastScene) this.render(this.lastScene);
    },
  });

  /**
   * The document-space composited texture is
   * kept ALIVE across frames; on pan/zoom (view-only change) we skip
   * re-compositing and only replay the cheap view pass.
   */
  private compositeTexture: LayerTexture | null = null;
  /** Content signature of the cached composite (see compositeSignature.ts). */
  private compositeSignature: string | null = null;
  /** Dims the cached composite was built at — a change forces a rebuild. */
  private compositeTargetW = 0;
  private compositeTargetH = 0;
  private compositeFormat: GPUTextureFormat | null = null;
  /**
   * The ACHIEVED interactive density scale (`min(scaleX, scaleY)` of
   * {@link InteractiveDensity}) the cached composite was rendered at — the
   * per-frame dirty signal for density-band crossings: a band change scales
   * the composite dims → `dimsChanged` below → exactly one re-composite per
   * crossing, while pan/zoom inside a band leaves the dims (and everything
   * else) untouched → zero re-composites. Also feeds the present sampler.
   */
  private compositeDensityScale = 1;

  /**
   * One-entry memo for the per-frame channel decision. The
   * plan is a PURE function of (doc dims, bpp, negotiated limit) — this key is
   * complete (two frames with equal inputs belong to equal plans; the byte
   * budget is a compile-time constant, not a runtime input), so a hit skips
   * the trivial recompute and, more importantly, gives the render loop a
   * stable handle on the CURRENT channel. A frame-load or frame-resize needs
   * no explicit hook: they change the inputs → the memo misses → the next
   * frame re-decides.
   */
  private planMemo: {
    docW: number; docH: number; bpp: number; deviceMaxDim: number;
  } | null = null;
  private planMemoMode: 'full' | 'roi' = 'full';

  /**
   * Documents whose density-1 footprint exceeds the composite budget or the
   * device texture limit composite ONLY their visible region into this smaller
   * resident target, re-rendered when the quantized visible rect moves (block
   * lattice = the hysteresis), the band crosses, or content edits.
   */
  private roiTexture: LayerTexture | null = null;
  /** Content signature the cached roi was rendered at. */
  private roiSignature: string | null = null;
  /** Quantized visible-rect rebuild key (`getVisibleRect` key + band) of the cache. */
  private roiRectKey: string | null = null;
  /** Document-space rect (frame-local px) the cached roi texture covers. */
  private roiRectX = 0;
  private roiRectY = 0;
  private roiRectW = 0;
  private roiRectH = 0;
  /** Texel dims of the cached roi texture (rect × density). */
  private roiTargetW = 0;
  private roiTargetH = 0;
  private roiFormat: GPUTextureFormat | null = null;
  /** The ACHIEVED roi density (≥ 1 except where physics forces below — see resolveRoiDensity). */
  private roiDensityScale = 1;
  /**
   * Document dims the cached roi was built for (transition guard: a roi
   * from a DIFFERENT document — a resize channel flip — must never be
   * presented as a fallback during the full-channel rebuild).
   */
  private roiDocW = 0;
  private roiDocH = 0;

  /**
   * Per-asset epoch, bumped on every GENUINE re-transfer in `upload()` (not on
   * deduped no-ops). Feeds the composite signature so an in-place pixel edit
   * (same assetId, new bitmap) invalidates the cache.
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
   * size, never the stroke bbox — only the stroke's own vector
   * transient was ever shrunk). This panel quantifies exactly that: `recomposite=N/N` (fires
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
    recompN: 0, roiRecompN: 0, compEncSum: 0, compEncMax: 0,
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
    mode: 'full' as 'full' | 'roi',
    roiTargetW: 0, roiTargetH: 0, roiDensity: 0,
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

  /**
   * Reusable scratch canvas for `channel: 'r'` mask uploads. The source mask
   * keeps its coverage in the ALPHA channel on the CPU (alpha compositing is
   * how eraser strokes accumulate); `copyExternalImageToTexture` into
   * `r8unorm` takes the source's RED channel, so the upload first composites
   * the mask over opaque black — white paint over black yields `R = 255·α`,
   * `A = 1`, byte-exact in premultiplied 8-bit. Lazily created and resized;
   * kept across uploads so a live stroke only pays one drawImage per frame.
   */
  private alphaRedScratch: OffscreenCanvas | HTMLCanvasElement | null = null;

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

    // Safety checks: ensure device matches all cached resources — a mismatch
    // (e.g. a swapped device outside the lost-handler flow) re-adopts every
    // device-owned resource in one sweep.
    if (
      this.pipelineCache.device !== device ||
      this.texturePool.device !== device ||
      this.bufferRing.device !== device
    ) {
      this.#adoptDevice(device, caps);
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

    // Density-banded interactive composite: quantize the camera's screen
    // scale (cam.k × dpr, pixel-snapped) onto the glyph-atlas density bands.
    // Recomputing each frame is a few compares; only the QUANTIZED value
    // matters downstream — inside a band pan/zoom leaves the composite dims
    // unchanged (cache hit), crossing a band changes them → exactly one
    // re-composite per crossing.
    //
    // Dual channel: the byte budget (128 MiB policy constant,
    // compositeBudget.ts) + the negotiated device limit decide — zoom-
    // INDEPENDENTLY — whether the document holds a full-document 1:1 composite
    // ('full': existing architecture) or must composite only its visible
    // region ('roi'). The area-based budget is deliberately stricter than the
    // old per-edge 4096 clamp on non-square documents.
    const workingBpp = workingFormatBpp(workingFormat as 'rgba16float' | 'rgba32float');
    const deviceMaxDim =
      device.limits?.maxTextureDimension2D ?? caps.limits.maxTextureDimension2D ?? INTERACTIVE_COMPOSITE_CEIL_PX;
    const budgetBytes = COMPOSITE_BUDGET_DEFAULT_BYTES;
    const screenScale = effectiveScale(scene.view.transform);

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

    // Re-decide the channel every frame, memoized on the
    // plan's complete pure-input key (see planMemo). Frame load/resize needs
    // no explicit hook — they change the inputs.
    const memo = this.planMemo;
    if (
      !memo ||
      memo.docW !== docW || memo.docH !== docH ||
      memo.bpp !== workingBpp || memo.deviceMaxDim !== deviceMaxDim
    ) {
      this.planMemo = {
        docW, docH, bpp: workingBpp, deviceMaxDim,
      };
      this.planMemoMode = resolveCompositePlan({
        docW, docH, bpp: workingBpp, deviceMaxDim, budgetBytes,
      }).mode;
    }
    const planMode = this.planMemoMode;

    // Per-frame presentation state resolved by the channel branch below.
    let activeTexture: LayerTexture | null = null;
    let activeDensityScale = 1;
    let activePlacement: TexPlacement | undefined;
    let recomposited = false;
    let recompositedRoi = false;
    let _pCompEncMs = 0;

    if (planMode === 'full') {
      // ── FULL channel (existing architecture) ──
      // Mode='full' guarantees density ≥ 1: the budget term ≥ 1 by the channel
      // decision and the device term ≥ 1 by the physics veto — the mosaic
      // failure mode is structurally impossible here.
      const density = resolveInteractiveDensity(
        screenScale,
        docW,
        docH,
        // Budget-derived edge ceiling prefolded with the negotiated device limit:
        // adds the area-budget clamp term to min(band, ceil/maxDocDim) without
        // changing resolveInteractiveDensity's contract.
        Math.min(deviceMaxDim, budgetDerivedCeilPx(docW, docH, workingBpp, budgetBytes)),
      );
      const [compW, compH] = densityCompositeDims(docW, docH, [density.scaleX, density.scaleY]);
      const densityScale = Math.min(density.scaleX, density.scaleY);

      // Composite texture lifecycle: rebuild when the cached one is missing,
      // its dims changed (document resize OR a density-band crossing — the
      // band-scaled dims move), or the working format changed.
      const dimsChanged =
        this.compositeTargetW !== compW ||
        this.compositeTargetH !== compH ||
        this.compositeFormat !== workingFormat;

      const needsRecomposite =
        this.compositeTexture === null || dimsChanged || this.compositeSignature !== signature;

      // roi→full transition: the full target was DROPPED when the
      // roi channel took over, so a channel flip rebuilds it. While that rebuild
      // encodes (same tick, below), a CONTENT-FRESH roi for the SAME document
      // keeps presenting — no white frame, no blocking; the fresh full lands the
      // next rendered frame (pixels identical meanwhile). A roi from a DIFFERENT
      // document (resize flip) or a STALE roi (edits since) must not show — the
      // normal path presents the just-encoded full instead.
      const roiFallbackUsable =
        this.roiTexture !== null &&
        this.roiDocW === docW && this.roiDocH === docH &&
        this.roiSignature === signature;
      const presentRoiDuringFullRebuild = needsRecomposite && roiFallbackUsable;
      // Once the full channel is fresh again, the roi fallback is redundant
      // VRAM — drop it (idempotent; a later channel flip rebuilds it cheaply).
      if (!needsRecomposite && this.roiTexture) {
        this.#clearRoiChannel();
      }

      const _pCompEncT0 = PERF_MON ? performance.now() : 0;
      if (needsRecomposite) {
        recomposited = true;
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
          this.compositeTexture = this.#createCompositeTarget(device, compW, compH, workingFormat);
        }

        _pCompEncMs = this.#compositeInto(compiled, {
          device,
          workingFormat,
          target: this.compositeTexture!,
          // Render the composite at the current density band's achieved
          // scale.
          interactiveScale: [density.scaleX, density.scaleY],
          perfStart: _pCompEncT0,
        });

        this.compositeSignature = signature;
        this.compositeTargetW = compW;
        this.compositeTargetH = compH;
        this.compositeFormat = workingFormat;
        this.compositeDensityScale = densityScale;
      }

      if (presentRoiDuringFullRebuild) {
        activeTexture = this.roiTexture;
        activeDensityScale = this.roiDensityScale;
        activePlacement = {
          origin: { x: this.roiRectX, y: this.roiRectY },
          docW: this.roiRectW,
          docH: this.roiRectH,
        };
      } else {
        activeTexture = this.compositeTexture;
        activeDensityScale = densityScale;
      }
    } else {
      // ── ROI channel ──
      // Only the visible region composites, at band-clamped density ≥ 1 (the
      // correctness root: every magnified texel is a real document pixel, so the
      // pixel grid aligns at ANY zoom). Rebuild triggers: the quantized
      // visible-rect key (the block lattice IS the hysteresis — no second
      // design), a band crossing, a content edit, or target dims/format change.
      // Within the rect, pan/zoom still replays only the cheap present.
      //
      // The full channel's resident target would go stale under roi-mode
      // edits and double-book the budget — drop it when roi takes over. The way
      // back rebuilds it in-frame while this roi (if fresh) keeps presenting.
      if (this.compositeTexture) {
        this.compositeTexture.destroy();
        this.compositeTexture = null;
        this.compositeSignature = null;
        this.compositeFormat = null;
        this.compositeTargetW = 0;
        this.compositeTargetH = 0;
        this.compositeDensityScale = 1;
      }
      // The whole roi decision — rect, density, dims, rebuild key, rebuild
      // need — is one pure function of this frame's inputs plus the resident
      // stamps (see roiFrame.ts); the engine consumes the decision and owns
      // only the texture lifecycle.
      const roi = resolveRoiFrame({
        scene,
        docW,
        docH,
        screenScale,
        workingFormat: workingFormat as 'rgba16float' | 'rgba32float',
        deviceMaxDim,
        budgetBytes,
        signature,
        current: {
          resident: this.roiTexture !== null,
          rectKey: this.roiRectKey,
          signature: this.roiSignature,
          targetW: this.roiTargetW,
          targetH: this.roiTargetH,
          format: this.roiFormat,
        },
      });

      if (roi.rect && roi.density) {
        const intersect = roi.rect;
        const roiDensity = roi.density;

        const _pCompEncT0 = PERF_MON ? performance.now() : 0;
        if (roi.needsComposite) {
          recomposited = true;
          recompositedRoi = true;
          // Same engine-owned exact-size lifecycle as the full channel: in-place
          // re-render on key/signature moves (constant-size pans re-render into
          // the SAME texture), destroy + recreate only when the texel dims or
          // format move. NOTE: unlike the full channel, a dims change does NOT
          // clear the resident transients / evict the pool — the roi's
          // ping-pong/vector transients resize WITH the roi and the resident
          // cache sweeps their old slots lazily.
          if (this.roiTexture && roi.dimsChanged) {
            this.roiTexture.destroy();
            this.roiTexture = null;
          }
          if (!this.roiTexture) {
            this.roiTexture = this.#createCompositeTarget(device, roi.targetW, roi.targetH, workingFormat);
          }

          _pCompEncMs = this.#compositeInto(compiled, {
            device,
            workingFormat,
            target: this.roiTexture,
            interactiveScale: [roiDensity.scaleX, roiDensity.scaleY],
            exportViewport: {
              targetWidth: roi.targetW,
              targetHeight: roi.targetH,
              sourceRect: [intersect.x, intersect.y, intersect.w, intersect.h],
            } satisfies ExportViewport,
            perfStart: _pCompEncT0,
          });

          this.roiSignature = signature;
          this.roiRectKey = roi.rebuildKey;
          this.roiRectX = intersect.x;
          this.roiRectY = intersect.y;
          this.roiRectW = intersect.w;
          this.roiRectH = intersect.h;
          this.roiTargetW = roi.targetW;
          this.roiTargetH = roi.targetH;
          this.roiFormat = workingFormat;
          this.roiDensityScale = Math.min(roiDensity.scaleX, roiDensity.scaleY);
          this.roiDocW = docW;
          this.roiDocH = docH;
        }
      }

      // Present from the roi cache whenever it exists — INCLUDING when the
      // viewport is fully off-document (`intersect` null, no rebuild): mapping
      // the stale rect's quad off-screen is what CLEARS the swapchain (present
      // pass loadOp:'clear'); skipping the present would leave the previous
      // frame's pixels on screen.
      if (this.roiTexture) {
        activeTexture = this.roiTexture;
        activeDensityScale = this.roiDensityScale;
        // origin + covered dims ALWAYS travel together:
        // present must not re-derive the extent from compositeDims(scene).
        activePlacement = {
          origin: { x: this.roiRectX, y: this.roiRectY },
          docW: this.roiRectW,
          docH: this.roiRectH,
        };
      }
    }

    // 3. Present the (possibly cached) composite to the swapchain applying the
    // camera. This runs EVERY frame — it is the only work on pan/zoom (inside
    // the roi rect: the block-quantized rect is stable across small pans).
    // Skipped only when the roi channel has no texture yet (first frame with
    // the viewport fully off-document — the swapchain's initial transparent
    // black lets the stage's checkerboard show through).
    if (activeTexture) {
      const _pPresEncT0 = PERF_MON ? performance.now() : 0;
      let _presArmed = false;
      if (PERF_MON) {
        if (!this._presTimer) this._presTimer = new GpuTimer(device, 'present');
        _presArmed = this._presTimer.startSubmit();
      }
      RenderGraph.present(activeTexture, {
        device,
        pipelineCache: this.pipelineCache,
        bufferRing: this.bufferRing,
        currentView,
        // Surface format constraint: MUST match the format `GpuDevice.configureSurface`
        // pinned for the CURRENT surface mode, not the probe result — the view pipeline
        // is compiled against the actual swapchain texture. Using `caps.preferredFormat`
        // here would mismatch on any platform whose preferred format differs, failing
        // pipeline validation. The HDR flag rides the same authority so the shader
        // variant (unclamped-tail vs SDR-clamped) always pairs with the format.
        targetFormat: this.gpu.getSwapchainFormat(),
        hdr: this.gpu.isHdrPresentation(),
        scene,
        // The composite holds densityScale texels per document px, so the
        // magnify/minify sampler compares the camera scale against THAT density.
        densityScale: activeDensityScale,
        // ROI: the texture covers a document SUB-RECT — present folds its origin
        // in front of the camera. Undefined on the full
        // channel → the whole-document mapping, byte-identical to pre-ROI.
        texPlacement: activePlacement,
        // Single-source gain-map presentation: eligibility rides the scene
        // (assembled once), the decoded payload the source cache, the GPU
        // texture uploaded once here on first use. Undefined → gain_enabled 0
        // (SDR base verbatim): HDR off, not eligible, or the map still decoding
        // — that last case flips bright on a later frame via the cache notify.
        gainMap: this.gainPresenter.resolve(scene.display.gainMapAssetId),
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
          recomposite: recomposited,
          recompositeRoi: recompositedRoi,
          compEncMs: _pCompEncMs,
          presEncMs,
          docW,
          docH,
          layers: scene.layers.length,
        });
      }
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
   * Orchestration only: composite → `readbackToPixels` (staging + mapAsync +
   * decode, in `gpu/readback.ts`) → one-shot release of the pooled target,
   * scratch, and the export-band glyph atlas.
   *
   * DELIBERATELY DEFERRED (do NOT add here):
   *   • Large-image tiling when the row-padded buffer exceeds `maxBufferSize`
   *     (TODO: split into horizontal bands, copy+map each, stitch).
   *   • TERMINAL TRC / colour-space ENCODE — the readback returns LINEAR
   *     light in the requested container; the single sRGB/target-TRC encode
   *     belongs to the codec step (see readback.ts).
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
      getAssetEpoch: (assetId) => this.assetEpochs.get(assetId) ?? 0,
      exportViewport,
    });

    // 2. Read the composited target back. The staging buffer's lifecycle
    // (including the lost-device / OOM exit paths) lives inside
    // `readbackToPixels`.
    let pixels: Uint8ClampedArray | Uint16Array | Float32Array;
    try {
      pixels = await readbackToPixels(device, composite.texture, {
        width: targetW,
        height: targetH,
        workingFormat: workingFormat as 'rgba16float' | 'rgba32float',
        bitDepth: opts.bitDepth,
      });
    } finally {
      // Export composite target + scratch are one-shot: return them all.
      this.texturePool.release(composite.texture);
      for (const tex of scratch) this.texturePool.release(tex);
      // The export-band glyph atlas is ONE-SHOT: the composite
      // above rasterized text at the export density band; release it on EVERY
      // exit path so interactive VRAM is never taxed by export-scale glyphs.
      // Same scale the vector spine was fed (target px per source px,
      // region-aware). Kept inside export() so every caller of the engine
      // black-box gets the release — dispatch layers must not reach into the
      // renderer internals for it.
      releaseExportGlyphAtlas(Math.max(targetW / Math.max(1, srcW), targetH / Math.max(1, srcH)));
    }

    return { width: targetW, height: targetH, bitDepth: opts.bitDepth, pixels };
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
   * Destroy the ROI channel's resident state (device loss / device rebuild /
   * teardown — the same moments the full-channel composite target is cleared).
   */
  #clearRoiChannel(): void {
    this.roiTexture?.destroy();
    this.roiTexture = null;
    this.roiSignature = null;
    this.roiRectKey = null;
    this.roiRectX = 0;
    this.roiRectY = 0;
    this.roiRectW = 0;
    this.roiRectH = 0;
    this.roiTargetW = 0;
    this.roiTargetH = 0;
    this.roiFormat = null;
    this.roiDensityScale = 1;
    this.roiDocW = 0;
    this.roiDocH = 0;
  }

  /**
   * Drop every cache whose contents reference a GPU device: resident assets,
   * LUTs, the engine-owned composite/roi targets, the dedup/epoch/signature
   * memos, and the [PERF_MON] timers. The single home for this sweep — device
   * loss recovery, the render-path device-mismatch guard, and teardown all
   * used to hand-maintain near-identical copies that had already drifted (the
   * lost path skipped the asset-epoch / signature-memo reset the mismatch
   * path performed).
   */
  #releaseCaches(): void {
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
    // Gain-map textures belonged to the destroyed device — the CPU payload in
    // gainMapSourceCache survives, so the next eligible present re-uploads
    // (and re-runs the reveal ease, a graceful re-brighten after recovery).
    this.gainPresenter.release();
    // Engine-owned targets are OUTSIDE the pool (nothing else frees them):
    // destroy explicitly and clear the stamps so the next frame rebuilds
    // them fresh.
    this.compositeTexture?.destroy();
    this.compositeTexture = null;
    this.compositeSignature = null;
    this.compositeFormat = null;
    this.compositeTargetW = 0;
    this.compositeTargetH = 0;
    this.compositeDensityScale = 1;
    this.#clearRoiChannel();
    // Epochs restart (an upload against the new device is a genuine first
    // transfer) and the signature memo drops (the next frame recomputes).
    this.assetEpochs.clear();
    this.sigMemoLayers = null;
    this.sigMemoValue = null;
    this.assetEpochVersion++;
    // [PERF_MON] GPU timers held resources on the destroyed device.
    this._compTimer?.destroy();
    this._compTimer = null;
    this._presTimer?.destroy();
    this._presTimer = null;
  }

  /**
   * Bind every device-owned resource to a (re)negotiated device: sweep all
   * caches ({@link #releaseCaches}) then rebuild the pool, resident
   * transients, pipeline cache, and buffer ring against the new device.
   * Device-loss recovery and the render-path device-mismatch guard both
   * funnel here so their semantics cannot drift apart again.
   */
  #adoptDevice(device: GPUDevice, caps: Capabilities | null): void {
    this.#releaseCaches();
    this.texturePool?.destroy();
    this.texturePool = this.#makeTexturePool(device, caps);
    // The resident transients belonged to the old device.
    this.residentTransients?.clear();
    this.residentTransients = new ResidentTransientCache(device);
    this.pipelineCache?.destroy();
    this.pipelineCache = new PipelineCache(device);
    this.bufferRing?.destroy();
    this.bufferRing = new BufferRing(device);
  }

  /**
   * Encode one composite submit into an engine-owned target — the shared body
   * of the full and roi channel branches (the only `RenderGraph.composite`
   * call site on the render path). Arms the [PERF_MON] composite timer, opens
   * the resident-transient frame, submits, releases the pooled scratch back to
   * the pool, sweeps idle resident slots, and folds the timings into the
   * rolling window. Returns the CPU encode time in ms (0 when PERF_MON is
   * off) for the caller's frame accounting. The caller owns the channel
   * lifecycle around this call (target (re)creation + cache-stamp backfill).
   */
  #compositeInto(
    compiled: CompiledScene,
    opts: {
      device: GPUDevice;
      workingFormat: GPUTextureFormat;
      /** Engine-owned exact-size target (render() guarantees it is created). */
      target: LayerTexture;
      interactiveScale: readonly [number, number];
      /** ROI channel only: the sub-rect seam (sourceRect shifts world→NDC). */
      exportViewport?: ExportViewport;
      /** The `PERF_MON`-gated timestamp taken before the target lifecycle. */
      perfStart: number;
    },
  ): number {
    const { device, workingFormat, target, interactiveScale, exportViewport } = opts;
    // render() validated these against the live device before dispatching.
    const pipelineCache = this.pipelineCache!;
    const bufferRing = this.bufferRing!;
    const texturePool = this.texturePool!;

    // [PERF_MON] Arm the composite GPU timer (skips if a prior readback is
    // still pending → natural sampling). `startSubmit` gates whether passes
    // instrument.
    let armed = false;
    if (PERF_MON) {
      if (!this._compTimer) this._compTimer = new GpuTimer(device, 'composite');
      armed = this._compTimer.startSubmit();
    }

    // Open the resident-transient frame so this composite's `acquire`s mark
    // their slots live; `endFrame()` after submit sweeps any slot that went
    // untouched (a committed stroke's transient, idle ping-pong buffers).
    this.residentTransients?.beginFrame();

    const { scratch } = RenderGraph.composite(compiled, {
      device,
      pipelineCache,
      bufferRing,
      texturePool,
      assets: this.assets,
      workingFormat,
      resolveLutView: (lutId) => this.getLutView(lutId),
      resolveLut3dView: (lutId) => this.getLut3dView(lutId),
      // Keys the bmask combine cache: a re-uploaded mask record (live
      // fast-override stroke) must re-combine that layer's mask.
      getAssetEpoch: (assetId) => this.assetEpochs.get(assetId) ?? 0,
      target,
      // Render the composite (and the vector/text transients through the same
      // supersampling seam) at the achieved density scale; on the roi channel
      // the exportViewport seam shifts the world→NDC basis (the exact
      // machinery the export path exercises).
      interactiveScale,
      exportViewport,
      acquireResidentTransient: this.residentTransients
        ? (key, desc) => this.residentTransients!.acquire(key, desc)
        : undefined,
      gpuTimer: armed ? this._compTimer! : undefined,
    });

    // The composite landed in the engine-owned `target`; only the pooled
    // scratch (ping-pong spare + filter transients) returns to the pool.
    // Resident buffers are excluded by RenderGraph (the cache owns them).
    for (const tex of scratch) texturePool.release(tex);

    // Sweep resident slots not touched this frame (lazy de-alloc).
    this.residentTransients?.endFrame();

    if (PERF_MON) {
      const encMs = performance.now() - opts.perfStart;
      // GPU-done latency for composite: measured from the start of encode
      // until the queue signals this (and all prior) work complete. See
      // _renderPerf.
      const g0 = opts.perfStart;
      onQueueDone(device.queue, () => {
        const ms = performance.now() - g0;
        const w = this._renderPerf;
        w.compGpuSum += ms; w.compGpuN++;
        if (ms > w.compGpuMax) w.compGpuMax = ms;
      });
      // True per-pass GPU exec time (backlog-independent). Reads after submit.
      if (armed) {
        this._compTimer!.read((r) => {
          const w = this._renderPerf;
          w.tsCompSpanSum += r.spanMs; w.tsCompSpanN++;
          if (r.spanMs > w.tsCompSpanMax) w.tsCompSpanMax = r.spanMs;
          for (const p of r.passes) this.#accumTsPass(p.label, p.ms);
        });
      }
      return encMs;
    }
    return 0;
  }

  /**
   * Allocate the engine-owned composite target at its EXACT density-scaled
   * document extent (no POT snap → no waste; band dims come from
   * `densityCompositeDims`, shared with RenderGraph so the graph's frame dims
   * always match) and OUTSIDE the TexturePool (a single-size,
   * single-instance resident texture gains nothing from bucketing).
   * Usage mirrors the pool's default set so any sampler/readback path that used
   * to see a pooled target behaves identically. Lifetime: reused in place until
   * a dims/format change (incl. a density-band crossing) or teardown destroys it.
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
    recompositeRoi: boolean;
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
    w.mode = this.planMemoMode;
    if (this.roiTexture) {
      w.roiTargetW = this.roiTargetW;
      w.roiTargetH = this.roiTargetH;
      w.roiDensity = this.roiDensityScale;
    }
    w.compileSum += s.compileMs; if (s.compileMs > w.compileMax) w.compileMax = s.compileMs;
    w.sigSum += s.sigMs; if (s.sigMs > w.sigMax) w.sigMax = s.sigMs; if (s.sigMiss) w.sigMiss++;
    if (s.recomposite) {
      w.recompN++;
      if (s.recompositeRoi) w.roiRecompN++;
      w.compEncSum += s.compEncMs;
      if (s.compEncMs > w.compEncMax) w.compEncMax = s.compEncMs;
    }
    w.presEncSum += s.presEncMs; if (s.presEncMs > w.presEncMax) w.presEncMax = s.presEncMs;
    w.docW = s.docW; w.docH = s.docH; w.layers = s.layers;

    if (now - w.lastFlush >= 1000 && w.n > 0) {
      const f = (x: number) => x.toFixed(2);
      const avg = (sum: number, n: number) => (n > 0 ? f(sum / n) : '-');
      const roiStr = w.mode === 'roi'
        ? ` roi=${w.roiTargetW}×${w.roiTargetH}@${f(w.roiDensity)}`
        : '';
      console.warn(
        `[Engine.render] window(${w.n}f) target=${w.docW}×${w.docH} layers=${w.layers} mode=${w.mode}${roiStr} ` +
        `recomposite=${w.recompN}/${w.n} (roi=${w.roiRecompN}) | ` +
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
      w.recompN = 0; w.roiRecompN = 0; w.compEncSum = 0; w.compEncMax = 0;
      w.presEncSum = 0; w.presEncMax = 0;
      w.compGpuSum = 0; w.compGpuN = 0; w.compGpuMax = 0;
      w.presGpuSum = 0; w.presGpuN = 0; w.presGpuMax = 0;
      w.tsCompSpanSum = 0; w.tsCompSpanN = 0; w.tsCompSpanMax = 0;
      w.tsPass = {};
      w.lastFlush = now;
    }
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
   *   • `bitmap` + `channel: 'r'` → alpha→red scratch composite → `r8unorm`
   *     (bitmap masks; 1 byte/pixel = 4× VRAM saving per record).
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

      // Bitmap masks upload as single-channel `r8unorm` (1 byte/pixel — a 4×
      // VRAM saving per record). Their CPU-side coverage lives in the ALPHA
      // channel (alpha compositing is how eraser strokes accumulate), and
      // `copyExternalImageToTexture` into `r8unorm` takes the source's RED
      // channel — so the mask is remapped α→R on a scratch canvas first. The
      // SAMPLING side reads `.r` for every bmask texture (bmaskCombine.ts).
      const isMask = src.channel === 'r';
      const copySource: ImageBitmap | VideoFrame | OffscreenCanvas | HTMLCanvasElement = isMask
        ? this.maskAlphaToRed(bitmap, width, height)
        : bitmap;
      const format: GPUTextureFormat = isMask ? 'r8unorm' : 'rgba8unorm';

      const texture = device.createTexture({
        size: [width, height, 1],
        format,
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
        label: `LayerAsset (${assetId})`,
      });

      // Identity upload: the bitmap preserves its intrinsic source gamut (e.g. Display-P3
      // via embedded ICC). Tag the copy destination with that SAME gamut so
      // `copyExternalImageToTexture` performs NO gamut conversion (identity);
      // the shader's gamut-align step later maps gamut_id→working (ProPhoto,
      // `WORKING_GAMUT`).
      //   • color rasters carry gamut = frame.colorSpace ∈ {srgb, display-p3};
      //   • untagged sources (masks, canvas-baked transients) are sRGB-intrinsic
      //     ⇒ default 'srgb' (identical to the pre-fix WebGPU default → zero
      //     regression; the gray coverage axis is gamut-invariant regardless).
      // A P3 raster with a missing/srgb tag would be silently narrowed — the
      // oversaturation bug this fix removes.
      const destColorSpace: GPUPredefinedColorSpace =
        src.gamut === 'display-p3' ? 'display-p3' : 'srgb';

      device.queue.copyExternalImageToTexture(
        { source: copySource },
        { texture, colorSpace: destColorSpace },
        [width, height],
      );

      layerTex = new LayerTexture({ texture, width, height, format });
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

  /**
   * Composite a bitmap mask over opaque black on the shared scratch canvas so
   * its ALPHA coverage becomes the RED channel (`R = 255·α`, `A = 1`). The
   * composite is byte-exact for the white-on-transparent masks
   * `MaskStrokeSession` stamps: source-over onto opaque black in premultiplied
   * 8-bit is `out = srcPremul + black·(1−α) = α` (baked records decode from
   * the same white-on-transparent canvases, so the contract covers them too).
   * The scratch is lazily created and kept across uploads — a live stroke only
   * pays one drawImage per frame, and the black backfill fully overwrites the
   * previous content every call.
   */
  private maskAlphaToRed(
    bitmap: ImageBitmap | VideoFrame | OffscreenCanvas,
    width: number,
    height: number,
  ): OffscreenCanvas | HTMLCanvasElement {
    if (!this.alphaRedScratch) {
      this.alphaRedScratch = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(width, height)
        : document.createElement('canvas');
    }
    const scratch = this.alphaRedScratch;
    if (scratch.width !== width) scratch.width = width;
    if (scratch.height !== height) scratch.height = height;
    const ctx = scratch.getContext('2d') as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx) {
      // Unreachable in every WebGPU-capable browser (2D context support is
      // universal there); a null context means the α→R remap cannot run.
      throw new Error('2D context unavailable for mask alpha→red upload conversion');
    }
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap as CanvasImageSource, 0, 0, width, height);
    return scratch;
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
    this.#releaseCaches();
    // The resident transient cache is engine-owned (exact-size, not
    // pooled) — destroy every live slot explicitly, like the composite target.
    this.residentTransients?.clear();
    this.residentTransients = null;
    // Release owned vmask coverage textures + private compute rings.
    clearVmaskCache();
    // Release owned combined bmask textures + private uniform ring.
    clearBmaskCombineCache();
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


