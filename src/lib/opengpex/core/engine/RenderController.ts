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
 * RenderController — the framework-free owner of the editor's render
 * presentation loop (engine debt ⑨).
 *
 * WHY THIS EXISTS: `CanvasStage` (a React component) used to flatten FOUR
 * engine responsibilities inline — dirty-flag management, cache
 * subscriptions, the HDR presentation dim orchestration, and swapchain
 * buffer sizing — so the render loop's correctness contract lived inside a
 * component whose re-render cycle could recreate closures around it. This
 * class owns that orchestration framework-free; the React stage only binds
 * the canvas element and forwards intents (mark dirty, request HDR, frame
 * input), keeping the loop's state in one place with one lifecycle
 * (`dispose`).
 *
 * OWNERSHIP MAP:
 *   - Dirty state       — `markDirty()` is the ONLY external write; the tick
 *                         clears it after a rendered frame.
 *   - Cache subscribe   — the three render-source caches (8-bit bitmap /
 *                         high-depth channel / gain map) notify → dirty, so a
 *                         late decode upgrades the very next frame.
 *   - HDR presentation  — `setHdrRequested` sequences the OFF transition: the
 *                         gain first eases back to the SDR base on the
 *                         still-HDR surface (the dim mirrors the reveal),
 *                         THEN the surface reconfigures — switching the
 *                         surface first would clip the highlights in one
 *                         frame. A frame change or a re-enable mid-dim
 *                         applies immediately. The class owns the SURFACE
 *                         end-to-end: it remembers the canvas handed to
 *                         `attachCanvas`/`initCanvas` and reconfigures the
 *                         swapchain directly at the settled moment — no
 *                         round-trip through React state (an earlier design
 *                         bounced the settled mode through a stage callback
 *                         + re-render only to land back in this same engine;
 *                         removed 2026-11-15).
 *   - Buffer sizing     — `syncCanvasBuffer` keeps the CSS size and the
 *                         physical (dpr-scaled) swapchain size in lockstep and
 *                         reports a resize (a resize clears the canvas — the
 *                         tick must repaint).
 *   - The tick          — `renderTick` is the per-frame body: assemble
 *                         (memoized compose-once/view-many) → flush uploads →
 *                         view fold → gain-map warm → engine render.
 *
 * The class deliberately does NOT own: the canvas element (React ref),
 * document/session state (injected per tick), or the ticker itself
 * (`useFastSync` stays the scheduler; the controller is its callback body).
 *
 * @module core/engine/RenderController
 */

import type { Frame, CameraState, Dimensions, TransformLayer, GeometryService, AssetService, BitmapMaskOverrideMap } from '@opengpex/editor/core/types';
import { CHANNEL_MASK_RGB } from '@opengpex/editor/core/engine';
import type { SceneChannelMask } from '@opengpex/editor/core/engine/pipeline/scene/Scene';
import { PERF_MON } from '@opengpex/editor/core/helpers/config';
import {
  imageBitmapCache,
  getGpuEngine,
  highDepthCache,
  gainMapCache,
  SceneAssembler,
  SceneContentCache,
} from '@opengpex/editor/core/engine';
import { WORKING_GAMUT } from '@opengpex/editor/core/engine/color/gamut';
import type { FileService } from '@opengpex/editor/core/files';

/** The fast-sync volatile the ticker hands to each tick (buffered drafts,
 * gesture transients, interaction flags). Structural — avoids importing the
 * volatile store into the engine. */
export interface RenderTickVolatile {
  readonly activeState: { readonly interacting: boolean };
  readonly buffered: {
    readonly layers: Record<string, { mask?: BitmapMaskOverrideMap; useIncreComp?: boolean } | undefined>;
  };
  readonly transient: Record<string, unknown>;
}

/** Per-tick session inputs — everything the engine must not reach into on
 * its own, forwarded by the stage from React-owned state. */
export interface RenderTickInput {
  readonly canvas: HTMLCanvasElement;
  readonly frame: Frame;
  readonly camera: CameraState;
  readonly viewportDim: Dimensions;
  readonly dpr: number;
  /** RAW channel-visibility mask (a number, or absent → RGB). The controller
   * owns the normalization: the mask vocabulary is an engine constant
   * (`DISPLAY_CHANNEL_SIGNAL_KEY`), so the derivation lives here, not in the
   * stage. */
  readonly channelMask?: unknown;
  readonly adaptiveDensity: boolean;
  readonly volatile: RenderTickVolatile;
  readonly geometry: GeometryService;
  readonly assets: AssetService;
  readonly files: Pick<FileService, 'recover' | 'decodeGainMap'>;
}

interface PerfWindow {
  n: number;
  assembleSum: number;
  assembleMax: number;
  renderSum: number;
  renderMax: number;
  gapSum: number;
  gapMax: number;
  over83: number;
  lastFlush: number;
}

export class RenderController {
  private readonly gpuEngine = getGpuEngine();
  /** The canvas this controller drives (remembered from `attachCanvas` /
   * `initCanvas`) — the surface reconfiguration in `setHdrRequested` needs it
   * without asking the stage for it back. */
  private canvas: HTMLCanvasElement | null = null;
  /** The SETTLED presentation mode currently configured on the surface. */
  private hdrPresentation = false;
  /** A mode flip waiting to be APPLIED. The physical reconfigure must run
   * INSIDE a tick body (configure → draw → present in one rAF): configuring
   * between rAF frames exposes the cleared canvas to the compositor for a
   * full frame — the 2026-11-15 checkerboard flash on HDR-off. */
  private surfaceReconfigurePending = false;

  // ── Dirty state (the tick clears it; intent methods set it) ──
  private needsRender = true;

  // ── HDR presentation sequencing ──
  private hdrRequested = false;
  private lastHdrFrameId: string | undefined = undefined;
  private disposed = false;

  // ── Cache subscriptions (bound in `bindCaches`, torn down in `dispose`) ──
  private unsubscribers: Array<() => void> = [];

  // ── CPU compose-once/view-many memo (camera-independent content half) ──
  private readonly contentCache = new SceneContentCache();
  private lastFrame: Frame | null = null;
  private lastCam: CameraState | null = null;
  // Per-tick INPUT snapshots: any change between ticks dirties the frame by
  // itself — inputs never need out-of-band markDirty signaling (2026-11-15:
  // channelMask used to knock via a stage effect; adaptiveDensity had NO
  // notification at all and could render stale until some other dirty).
  private lastChannelMask: number | null = null;
  private lastAdaptiveDensity: boolean | null = null;

  // ── [PERF_MON] rolling-window diagnostics (assemble vs render split) ──
  private lastTickTs = 0;
  private renderCount = 0;
  private readonly perfWindow: PerfWindow = {
    n: 0, assembleSum: 0, assembleMax: 0, renderSum: 0, renderMax: 0,
    gapSum: 0, gapMax: 0, over83: 0, lastFlush: 0,
  };

  constructor() {
    this.bindCaches();
  }

  /** Late-decode redraw triggers: any render-source cache landing marks the
   * next frame dirty (bitmap decode / high-depth upgrade / gain-map bright). */
  private bindCaches(): void {
    this.unsubscribers.push(
      imageBitmapCache.subscribe(() => { this.needsRender = true; }),
      // Ingest axis: a late high-depth decode (cold reload) upgrades the base
      // layer from its 8-bit display fallback to the rgba16float raw texture.
      highDepthCache.subscribe(() => { this.needsRender = true; }),
      // Gain-map axis: when the map lands the next frame flips bright.
      gainMapCache.subscribe(() => { this.needsRender = true; }),
    );
  }

  /** External intent: something outside the tick's inputs changed the
   * picture (tool overlay, surface reconfigure). Per-tick input changes
   * (frame / camera / channelMask / adaptiveDensity) do NOT go through here —
   * `renderTick` diffs them itself. Idempotent. */
  markDirty(): void {
    this.needsRender = true;
  }

  /** Per-document HDR presentation switch (render filter). `frameId`
   * identifies the frame the request belongs to — a CHANGE of frame applies
   * immediately instead of dimming (see the sequencing note on the class). */
  setHdrRequested(requested: boolean, frameId: string | undefined): void {
    // A new request always supersedes an in-flight dim settle.
    if (this.dimCancel) this.dimCancel();
    this.hdrRequested = requested;
    const sameFrame = this.lastHdrFrameId === frameId;
    this.lastHdrFrameId = frameId;
    if (requested || !sameFrame || !this.gpuEngine.isReady()) {
      this.gpuEngine.gainPresenter.cancelDim();
      this.applySurfaceMode(requested);
      return;
    }
    let live = true;
    void this.gpuEngine.gainPresenter.beginDim().then(() => {
      if (live && !this.disposed) this.applySurfaceMode(false);
    });
    // Late-cancellation handle: a re-enable before the dim settles must not
    // flip the presentation back afterwards.
    this.dimCancel = () => { live = false; };
  }

  /** Reconfigure the remembered canvas' surface to the settled mode (format +
   * toneMapping) and mark dirty — a surface reconfigure clears the canvas, so
   * the tick must repaint. No-op when the engine/boot or canvas is absent. */
  private applySurfaceMode(hdr: boolean): void {
    this.hdrPresentation = hdr;
    // Never reconfigure HERE (dim settle / frame change land between rAF
    // frames) — schedule it for the next tick body instead.
    this.surfaceReconfigurePending = true;
    this.needsRender = true;
  }

  private dimCancel: (() => void) | null = null;

  /** Bind (or re-bind after a remount) the canvas to the engine surface,
   * configured at the controller's settled presentation mode. Called from the
   * stage's layout effect so a remount lands before the next ticker frame.
   * The canvas is REMEMBERED — `setHdrRequested` reconfigures this surface
   * directly at the settled moment without going back through the stage. */
  attachCanvas(canvas: HTMLCanvasElement): boolean {
    this.canvas = canvas;
    if (!this.gpuEngine.isReady()) return false;
    this.gpuEngine.attachCanvas(canvas, { hdr: this.hdrPresentation });
    // The configure above already landed the settled mode.
    this.surfaceReconfigurePending = false;
    this.needsRender = true;
    return true;
  }

  /** Boot the engine onto the canvas (idempotency owned by GpuEngine.init;
   * a ready engine just re-binds the surface). Resolves with the engine caps
   * (consumed by PERF_MON logging in the stage). */
  async initCanvas(canvas: HTMLCanvasElement): Promise<unknown> {
    this.canvas = canvas;
    const caps = await this.gpuEngine.init(canvas, { hdr: this.hdrPresentation });
    // Cold boot configured the settled mode — nothing pending anymore.
    this.surfaceReconfigurePending = false;
    this.needsRender = true;
    return caps;
  }

  /**
   * Keep the CSS display size and the physical (dpr-scaled) swapchain buffer
   * in lockstep. Returns whether the BUFFER was resized — a resize clears the
   * canvas, so the caller must treat the frame as dirty.
   */
  syncCanvasBuffer(canvas: HTMLCanvasElement, viewportDim: Dimensions, dpr: number): boolean {
    const { w, h } = viewportDim;
    let bufferResized = false;
    if (w > 0 && h > 0) {
      if (canvas.style.width !== `${w}px`) canvas.style.width = `${w}px`;
      if (canvas.style.height !== `${h}px`) canvas.style.height = `${h}px`;
      const targetW = Math.floor(w * dpr);
      const targetH = Math.floor(h * dpr);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
        bufferResized = true; // Buffer resize clears canvas — must repaint
      }
    }
    return bufferResized;
  }

  /** Whether the engine can currently present (used by the stage to skip
   * ticks before boot completes). */
  isReady(): boolean {
    return this.gpuEngine.isReady();
  }

  /**
   * The per-tick body. Reads the dirty state + frame/camera reference
   * equality to skip static frames entirely, then: assemble (memoized) →
   * flush uploads → view fold → gain-map warm → render.
   */
  renderTick(input: RenderTickInput): void {
    // Normalize the RAW signal here (absent → RGB): the diff below compares
    // the RESOLVED mask, so a signal write that maps to the same mask never
    // dirties a frame.
    const channelMask: SceneChannelMask =
      typeof input.channelMask === 'number' ? input.channelMask : CHANNEL_MASK_RGB;

    const inputChanged =
      channelMask !== this.lastChannelMask ||
      input.adaptiveDensity !== this.lastAdaptiveDensity;
    const isDirty =
      this.needsRender || inputChanged || this.syncCanvasBuffer(input.canvas, input.viewportDim, input.dpr);

    // Skip render if scene is completely static
    if (!isDirty && input.frame === this.lastFrame && input.camera === this.lastCam) return;
    if (!this.gpuEngine.isReady()) return;

    const isInteracting = input.volatile.activeState.interacting;
    let frameT0 = 0;
    let assembleT0 = 0;
    if (PERF_MON) frameT0 = performance.now();

    // Update snapshot
    this.lastFrame = input.frame;
    this.lastCam = input.camera;
    this.lastChannelMask = channelMask;
    this.lastAdaptiveDensity = input.adaptiveDensity;
    this.needsRender = false;

    if (PERF_MON) assembleT0 = performance.now();

    // CPU compose-once/view-many: the camera-INDEPENDENT content half is
    // memoized on a reference-identity key; only the cheap view fold runs
    // every frame. `dirty` (needsRender/bufferResize) forces a rebuild, and
    // any genuine edit yields a new `input.frame.layers` reference. Canvas ±90°
    // rotation animates via a DOM-transform compensation, NOT a rebuild.
    const { content, uploads, lutUploads } = this.contentCache.get(
      {
        layersRef: input.frame.layers,
        canvasW: input.frame.canvas.w,
        canvasH: input.frame.canvas.h,
        // Mirrors `SceneContent.colorSpace` (the WORKING_GAMUT invariant) —
        // constant today, kept so the key stays a faithful 1:1 image of
        // SceneContent's inputs.
        colorSpace: WORKING_GAMUT,
        dirty: isDirty,
        animating: false,
      },
      () =>
        SceneAssembler.buildContent({
          frame: input.frame,
          geometry: input.geometry,
          assets: input.assets,
          getBitmapMaskOverride: (layerId: string) => {
            const compositeKey = `${input.frame.id}:${layerId}`;
            const draft = input.volatile.buffered.layers[compositeKey];
            return draft?.mask || undefined;
          },
          // Live fragment-transform scale (LIVE-EDIT stamp discipline).
          getLayerPoseOverride: (layerId: string) => {
            const t = input.volatile.transient['fragmentTransform'] as Partial<TransformLayer> | undefined;
            if (!t || t.layerId !== layerId || typeof t.scaleX !== 'number') return undefined;
            // Hand-over guard: once the bake lands the layer on its new
            // (already magnified) asset, the preview scale must not apply.
            if (t.sourceAssetId && input.frame.layers.byId[layerId]?.assetId !== t.sourceAssetId) return undefined;
            return {
              scale: t.scaleX,
              scaleY: typeof t.scaleY === 'number' ? t.scaleY : t.scaleX,
              ...(typeof t.rotationDeg === 'number' && typeof t.sourceAngle === 'number'
                ? { rotation: t.rotationDeg, sourceAngle: t.sourceAngle }
                : {}),
            };
          },
          // High-depth precision probe — straight off the cache singleton
          // (the former seam factory was a pure passthrough and is gone).
          getHighDepthSource: (assetId: string) => highDepthCache.get(assetId),
          // 8-bit read seam — the ImageBitmapCache's own door (kept out of
          // the high-depth seam factory: separate caches, separate seams).
          getBitmapSource: (src: string) => imageBitmapCache.getOrFetch(src),
        }),
    );

    // Flush the (possibly empty on a cache hit) upload plan into the engine.
    SceneAssembler.syncAssets(uploads, this.gpuEngine, lutUploads);

    // Fold the camera-dependent view onto the content to get the final Scene.
    const scene = SceneAssembler.composeView(content, {
      frame: input.frame,
      camera: input.camera,
      viewportDim: input.viewportDim,
      dpr: input.dpr,
      // Fixed composite density (zoom-free), read per tick from the
      // preference by the stage.
      adaptiveDensity: input.adaptiveDensity,
      geometry: input.geometry,
      channelMask,
      // LIVE-EDIT probe (session → engine seam): only a WRITER-DECLARED draft
      // (tool gesture in flight) stamps `useIncreComp`; committed layers and
      // passive previews never declare it.
      needIncreComp: (layerId) => {
        if (!input.volatile.activeState.interacting) return false;
        return !!input.volatile.buffered.layers[`${input.frame.id}:${layerId}`]?.useIncreComp;
      },
    });

    // Gain-map presentation warm: probe the source cache once for a
    // gain-eligible frame — a miss decodes the metadata-carried map and this
    // frame presents SDR; the subscription above flips the next frame bright.
    const activeFrame = input.frame;
    if (scene.display.gainMapAssetId && activeFrame.metadata) {
      gainMapCache.getOrFetch(scene.display.gainMapAssetId, () =>
        input.files.decodeGainMap(activeFrame.metadata!));
    }

    let renderT0 = 0;
    if (PERF_MON) renderT0 = performance.now();

    // Apply a pending HDR surface reconfigure HERE — inside the same rAF as
    // the draw and the present. Reconfiguring between frames would expose the
    // cleared input.canvas to the compositor for a full frame (checkerboard flash).
    if (this.surfaceReconfigurePending) {
      this.surfaceReconfigurePending = false;
      this.gpuEngine.attachCanvas(input.canvas, { hdr: this.hdrPresentation });
    }

    // Render directly to the WebGPU swapchain (the live-edit hint travels in
    // the scene, stamped by composeView above).
    this.gpuEngine.render(scene);

    if (PERF_MON) {
      this.recordPerf(frameT0, assembleT0, renderT0, scene.layers.length, isInteracting);
    }
  }

  /** Rolling-window PERF_MON flush (~1×/sec): average/max assemble vs render
   * split + inter-frame cadence jitter, so a real-machine capture can tell a
   * CPU assemble dip from a GPU present dip. */
  private recordPerf(frameT0: number, assembleT0: number, renderT0: number, layerCount: number, interacting: boolean): void {
    const now = performance.now();
    const assembleDuration = renderT0 - assembleT0;
    const renderDuration = now - renderT0;
    const frameDuration = now - frameT0;
    const gap = this.lastTickTs > 0 ? frameT0 - this.lastTickTs : 0;
    this.lastTickTs = now;
    this.renderCount++;

    // 120Hz budget is ~8.3ms end-to-end; count frames over it.
    const win = this.perfWindow;
    if (win.lastFlush === 0) win.lastFlush = now;
    if (this.renderCount > 3) {
      win.n++;
      win.assembleSum += assembleDuration;
      win.renderSum += renderDuration;
      win.gapSum += gap;
      if (assembleDuration > win.assembleMax) win.assembleMax = assembleDuration;
      if (renderDuration > win.renderMax) win.renderMax = renderDuration;
      if (gap > win.gapMax) win.gapMax = gap;
      if (frameDuration > 8.3) win.over83++;
    }

    if (win.n > 0 && now - win.lastFlush >= 1000) {
      console.warn(
        `[RenderController] window(${win.n}f) ` +
          `assemble avg=${(win.assembleSum / win.n).toFixed(2)}ms max=${win.assembleMax.toFixed(2)}ms | ` +
          `render avg=${(win.renderSum / win.n).toFixed(2)}ms max=${win.renderMax.toFixed(2)}ms | ` +
          `gap avg=${(win.gapSum / win.n).toFixed(2)}ms max=${win.gapMax.toFixed(2)}ms | ` +
          `over8.3ms=${win.over83}/${win.n} layers=${layerCount} interacting=${interacting}`,
      );
      win.n = 0; win.assembleSum = 0; win.assembleMax = 0;
      win.renderSum = 0; win.renderMax = 0;
      win.gapSum = 0; win.gapMax = 0;
      win.over83 = 0; win.lastFlush = now;
    }
  }

  /** Tear down cache subscriptions and cancel in-flight HDR sequencing. */
  dispose(): void {
    this.disposed = true;
    if (this.dimCancel) this.dimCancel();
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }
}
