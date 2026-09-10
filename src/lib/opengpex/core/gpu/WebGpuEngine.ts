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
 * WebGpuEngine.ts — The single public entry point of the v2 render engine
 * (v2 spec §5.1). Implements the declarative `IEngine` contract.
 *
 * WHAT REPLACED WHAT (§5.2):
 *   v1 imperative renderer                        → v2 declarative `IEngine`
 *   beginFrame + pushCommand* + flush + endFrame  → render(scene)
 *   drawLayerDirect (legacy back-door)            → (gone — one path only)
 *   DrawLayerOptions.isInteracting                → (gone — not a render concern)
 *   Legacy 2D + Vips (two engines)                → one RenderGraph, two sinks
 *
 * ⚠️ STUB STATUS (checklist A4②): `init()` is real — it negotiates the device
 * and emits the `WebGPU Initializing` smoke signal. `render()` / `export()` /
 * `upload()` / `release()` are intentionally EMPTY, awaiting:
 *   • Phase 1–2 → SceneCompiler + RenderGraph + CompositePass  (render)
 *   • Phase 3   → AdjustPass + FilterPass
 *   • Phase 4   → StrokePass + Readback                        (export)
 * The stub keeps the whole project compiling and the UI runnable while each
 * pipeline stage is lit up incrementally (§13.3).
 *
 * @module core/gpu/WebGpuEngine
 */

import type { Capabilities } from './device/Capabilities';
import { GpuDevice, type SurfaceConfig } from './device/GpuDevice';
import type { Scene, LayerNode } from './scene/Scene';
import { TexturePool } from './resources/TexturePool';
import { LayerTexture } from './resources/LayerTexture';
import { BufferRing } from './resources/BufferRing';
import { PipelineCache } from './resources/PipelineCache';
import { SceneCompiler } from './graph/SceneCompiler';
import { RenderGraph, compositeDims } from './graph/RenderGraph';
import { computeCompositeSignature } from './scene/compositeSignature';
import { clearVectorMaskCache } from './scene/SceneAssembler';
import { GPUTextureUsage } from './constants';

// ────────────────────────────────────────────────────────────
// Export contract (§11 — implemented in Phase 4)
// ────────────────────────────────────────────────────────────

/**
 * Export request options.
 *
 * The v2 promise: export shares the SAME compiled RenderGraph as the on-screen
 * frame, so 16-bit output is no longer a separate vips composite path — only
 * the final sink differs (§1.2, §3.2). vips is retained for codec duties only.
 */
export interface ExportOptions {
  /** Output bit depth. 16/32 require a float working format. */
  readonly bitDepth: 8 | 16 | 32;
  /** Optional crop in world pixels; defaults to the artboard. */
  readonly region?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  /** Scale factor applied to the output resolution. */
  readonly scale?: number;
}

/** Raw readback result, ready to hand to a codec. */
export interface ExportResult {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: 8 | 16 | 32;
  /** Interleaved RGBA pixels at the requested depth. */
  readonly pixels: Uint8ClampedArray | Uint16Array | Float32Array;
}

// ────────────────────────────────────────────────────────────
// IEngine
// ────────────────────────────────────────────────────────────

/**
 * The declarative render engine contract (§5.1).
 *
 * Design notes:
 *   • No implicit ordering — every method is independently callable.
 *   • `render` is synchronous and fire-and-forget; batching / dirty-region
 *     culling are internal concerns, not caller obligations.
 *   • Asset lifecycle is explicit (`upload` / `release`) so textures stay
 *     resident in VRAM instead of being copied across threads each frame (§2.4).
 */
export interface IEngine {
  /** Initialize device/context/pools. Idempotent. Returns negotiated capabilities. */
  init(canvas: HTMLCanvasElement, surface?: SurfaceConfig): Promise<Capabilities>;

  /** Synchronously attach a new or remounted canvas to the existing device surface. */
  attachCanvas(canvas: HTMLCanvasElement, surface?: SurfaceConfig): boolean;

  /** Declaratively render one frame to the swapchain. */
  render(scene: Scene): void;

  /**
   * Register a ONE-SHOT callback fired after the NEXT successful frame is
   * actually submitted to the swapchain (i.e. real pixels exist).
   *
   * WHY (see Viewport visibility gate): the stage container fades in on
   * `isReady`. Gating that on "bitmap decoded" (`imagesLoaded`) is wrong — a
   * decoded bitmap is NOT the same milestone as "the GPU has drawn this frame".
   * The checkerboard (synchronous SVG) would fade in the instant a bitmap
   * lands, while the WebGPU canvas still waits for the next ticker tick to
   * `render()`, so the board flashes ahead of the image. This callback lets the
   * gate wait for the true first paint instead. Returns an unsubscribe fn.
   */
  onFirstPaint(cb: () => void): () => void;

  /** Render the same Scene to an offscreen target and read it back (export). */
  export(scene: Scene, opts: ExportOptions): Promise<ExportResult>;

  /**
   * Is this asset already resident in VRAM? SceneAssembler MUST query this
   * before uploading, so pan/zoom frames skip re-transfer entirely (§6.3).
   */
  has(assetId: string): boolean;

  /**
   * Upload/update a resident GPUTexture from a decoded bitmap.
   *
   * Dedup contract (§6.3): if `assetId` is already resident and unchanged, this
   * is a no-op — no release/create/DMA. "Unchanged" means either the optional
   * `version` stamp matches the resident one, or (when no version is given) the
   * `bitmap` reference is identical to the resident source. Only a genuine pixel
   * change (draw/erase/filter → new bitmap or bumped version) re-transfers.
   */
  upload(assetId: string, bitmap: ImageBitmap | VideoFrame, version?: number): void;

  /** Release a resident texture. */
  release(assetId: string): void;

  /** True once a device has been negotiated and is ready. */
  isReady(): boolean;

  destroy(): void;
}

// ────────────────────────────────────────────────────────────
// WebGpuEngine
// ────────────────────────────────────────────────────────────

export class WebGpuEngine implements IEngine {
  private readonly gpu = new GpuDevice();

  private texturePool: TexturePool | null = null;
  private pipelineCache: PipelineCache | null = null;
  private bufferRing: BufferRing | null = null;
  private initPromise: Promise<Capabilities> | null = null;

  /**
   * Last Scene handed to `render()`.
   *
   * Kept for two reasons that both fall out of Scene being immutable pure data:
   *   1. device-loss recovery — re-init then replay (§16.1);
   *   2. dirty-region diffing — compare against the incoming Scene (§3.2).
   */
  private lastScene: Scene | null = null;

  /** Resident texture registry (§6.3). */
  private readonly assets = new Map<string, LayerTexture>();

  /**
   * 缺陷 5 §5 阶段 2 — composite cache. The document-space composited texture is
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
   * [P1 §4] Signature-string memo. `computeCompositeSignature` walks every layer
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
   * One-shot callbacks awaiting the next successful swapchain submission.
   * Drained (and cleared) at the end of a `render()` that actually reached
   * `RenderGraph.execute` — never on an early-out path where no pixels landed.
   */
  private firstPaintWaiters: Array<() => void> = [];

  /**
   * Residency metadata for the §6.3 dedup contract, keyed by `assetId`.
   * `source` is the last uploaded bitmap reference; `version` is the optional
   * content stamp. Either matching one skips re-transfer.
   */
  private readonly assetMeta = new Map<
    string,
    { source: ImageBitmap | VideoFrame; version?: number }
  >();

  /** Cheap synchronous probe used by the shell to decide v2-vs-v1 routing (§12). */
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
          this.texturePool = new TexturePool(device);
        }
        if (!this.pipelineCache || this.pipelineCache.device !== device) {
          this.pipelineCache?.destroy();
          this.pipelineCache = new PipelineCache(device);
        }
        if (!this.bufferRing || this.bufferRing.device !== device) {
          this.bufferRing?.destroy();
          this.bufferRing = new BufferRing(device);
        }

        // §16.1 — on device loss, replay the last Scene once the device is back.
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
              this.texturePool = new TexturePool(reloadedDevice);
              this.pipelineCache?.destroy();
              this.pipelineCache = new PipelineCache(reloadedDevice);
              this.bufferRing?.destroy();
              this.bufferRing = new BufferRing(reloadedDevice);
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
   * Draws scene layers bottom-to-top onto the swapchain render pass (§5.1, §7.1).
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
      this.texturePool = new TexturePool(device);
      this.bufferRing.destroy();
      this.bufferRing = new BufferRing(device);

      for (const asset of this.assets.values()) {
        asset.destroy();
      }
      this.assets.clear();
      this.assetMeta.clear();
      // 缺陷 5 §5 阶段 2 (R5): device rebuild invalidates the composite cache —
      // its texture belonged to the destroyed pool. Force a fresh composite.
      this.compositeTexture = null;
      this.compositeSignature = null;
      this.compositeFormat = null;
      this.compositeDocW = 0;
      this.compositeDocH = 0;
      this.assetEpochs.clear();
      // [P1 §4] Device rebuild invalidates the signature memo too.
      this.sigMemoLayers = null;
      this.sigMemoValue = null;
      this.assetEpochVersion++;
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

    // 1. Compile scene into intelligent batches (spec §7.2)
    const compiled = SceneCompiler.compile(scene);

    const workingFormat: GPUTextureFormat = caps.workingFormat ?? 'rgba16float';

    // 2. 缺陷 5 §5 阶段 2 — COMPOSE-ONCE, VIEW-MANY.
    // Re-composite the document texture ONLY when the content signature changes
    // (layers / attributes / order / edited pixels). Pan/zoom changes only
    // `scene.view`, which is NOT in the signature, so those frames skip
    // compositing entirely and replay just the cheap view pass.
    const { frameWidth: docW, frameHeight: docH } = compositeDims(scene);

    // [P1 §4] Reuse the memoized signature when the inputs it derives from are
    // unchanged (same `scene.layers` reference on a cam-only frame + same dims /
    // format / asset-epoch version). Skips the per-frame layer walk + JSON work.
    // Defence-in-depth for heavy scenes — see the CanvasStage/SceneContentCache
    // note: the P1 "pan/zoom 120→100" was a DevTools artifact (assemble≈0.01ms
    // with F12 closed), so this memo is a situational win, not a defect fix.
    let signature: string;
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

    // R5 — composite texture lifecycle: rebuild when the cached one is missing,
    // its dims changed, or the working format changed.
    const dimsChanged =
      this.compositeDocW !== docW ||
      this.compositeDocH !== docH ||
      this.compositeFormat !== workingFormat;

    const needsRecomposite =
      this.compositeTexture === null || dimsChanged || this.compositeSignature !== signature;

    if (needsRecomposite) {
      // Drop the stale cache (its pooled texture returns to the pool).
      if (this.compositeTexture) {
        this.texturePool.release(this.compositeTexture.texture);
        this.compositeTexture = null;
      }

      const { result, scratch } = RenderGraph.composite(compiled, {
        device,
        pipelineCache: this.pipelineCache,
        bufferRing: this.bufferRing,
        texturePool: this.texturePool,
        assets: this.assets,
        workingFormat,
      });

      // Keep the composite as the cache; return only the transient scratch.
      this.compositeTexture = result;
      for (const tex of scratch) this.texturePool.release(tex);

      this.compositeSignature = signature;
      this.compositeDocW = docW;
      this.compositeDocH = docH;
      this.compositeFormat = workingFormat;
    }

    // 3. Present the (possibly cached) composite to the swapchain applying the
    // camera. This runs EVERY frame — it is the only work on pan/zoom.
    RenderGraph.present(this.compositeTexture!, {
      device,
      pipelineCache: this.pipelineCache,
      bufferRing: this.bufferRing,
      currentView,
      targetFormat: caps.preferredFormat,
      scene,
    });

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
   * Same Scene, offscreen sink + readback.
   *
   * STUB — Phase 4 will implement `copyTextureToBuffer` → `mapAsync(READ)` →
   * f16/u16/u8 encoding (§11). Rejects for now so callers fail loudly rather
   * than silently receiving a blank buffer.
   */
  async export(_scene: Scene, _opts: ExportOptions): Promise<ExportResult> {
    throw new Error(
      '[WebGpuEngine] export() is not implemented yet — Readback lands in Phase 4 (spec §11).',
    );
  }

  /**
   * True once this asset is resident in VRAM (§6.3). SceneAssembler queries
   * this before uploading to achieve zero-transfer pan/zoom.
   */
  has(assetId: string): boolean {
    return this.assets.has(assetId);
  }

  /**
   * Zero-copy upload from ImageBitmap into a resident GPUTexture (§6.3, §6.4).
   *
   * Resident-dedup: if `assetId` is already resident and unchanged, returns
   * immediately without release/create/DMA. "Unchanged" = matching `version`
   * stamp (when provided) or identical `bitmap` reference (when not). Only a
   * genuine pixel edit (new bitmap / bumped version) triggers re-transfer.
   */
  upload(assetId: string, bitmap: ImageBitmap | VideoFrame, version?: number): void {
    if (!this.gpu.isReady()) {
      return;
    }

    // §6.3 dedup: skip re-transfer when the resident asset is unchanged.
    const existing = this.assets.get(assetId);
    const meta = this.assetMeta.get(assetId);
    if (existing && meta) {
      const unchanged =
        version !== undefined ? meta.version === version : meta.source === bitmap;
      if (unchanged) {
        return;
      }
    }

    const device = this.gpu.getDevice()!;

    // Content changed (or first upload): drop the stale resident texture.
    this.release(assetId);

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

    device.queue.copyExternalImageToTexture(
      { source: bitmap },
      { texture },
      [width, height],
    );

    const layerTex = new LayerTexture({
      texture,
      width,
      height,
      format: 'rgba8unorm',
    });

    this.assets.set(assetId, layerTex);
    this.assetMeta.set(assetId, { source: bitmap, version });

    // 缺陷 5 §5 阶段 2: a genuine re-transfer bumps the asset epoch so the
    // composite signature changes and the cache re-composites (R2). Deduped
    // no-op uploads return early above and never reach here.
    this.assetEpochs.set(assetId, (this.assetEpochs.get(assetId) ?? 0) + 1);
    // [P1 §4] Invalidate the signature memo: an epoch change means the next
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

  destroy(): void {
    for (const asset of this.assets.values()) {
      asset.destroy();
    }
    this.assets.clear();
    this.assetMeta.clear();
    this.assetEpochs.clear();
    // 缺陷 5 §5 阶段 2: drop the composite cache. Its texture is a pooled resource;
    // texturePool.destroy() below frees the backing GPU memory, so just drop refs.
    this.compositeTexture = null;
    this.compositeSignature = null;
    this.compositeFormat = null;
    this.compositeDocW = 0;
    this.compositeDocH = 0;
    // [P1 §4] Drop the signature memo on teardown.
    this.sigMemoLayers = null;
    this.sigMemoValue = null;
    // WP-3.1: release pre-rasterized vector-mask bitmaps (Review §4.3).
    clearVectorMaskCache();
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

  getTexturePool(): TexturePool | null {
    return this.texturePool;
  }

  isReady(): boolean {
    return this.gpu.isReady();
  }
}


