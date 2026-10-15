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
 * GpuDevice.ts — Adapter / device / queue ownership + capability negotiation
 * + device-loss recovery.
 *
 * SINGLE OWNER: this is the only module that calls `requestAdapter` /
 * `requestDevice` / `context.configure`. Everything downstream (TexturePool,
 * PipelineCache, passes) borrows the `GPUDevice` from here, so device loss has
 * exactly one recovery site.
 *
 * NO CPU FALLBACK: if WebGPU is unavailable, `init()` throws
 * `WebGpuUnavailableError`. The shell is expected to catch it and route the
 * user to the v1.x LTS build — v2 never silently degrades to Canvas2D.
 *
 * Handles adapter/device acquisition, feature negotiation, and swapchain configuration.
 *
 * @module core/gpu/device/GpuDevice
 */

import { PERF_MON } from '@opengpex/editor/core/helpers/config';

import {
  type Capabilities,
  type GpuLimits,
  negotiateFeatures,
  negotiateLimits,
  readLimits,
} from './Capabilities';

/** Thrown when the environment cannot provide a WebGPU device. */
export class WebGpuUnavailableError extends Error {
  constructor(reason: string) {
    super(`[WebGPU] Unavailable: ${reason}`);
    this.name = 'WebGpuUnavailableError';
  }
}

/**
 * Surface configuration for the swapchain sink.
 *
 * ⚠️ There is NO `colorSpace` here. The swapchain gamut is a hard
 * invariant — `configureSurface` below configures `colorSpace:'display-p3'`
 * unconditionally, and `view.wgsl` projects `WORKING_GAMUT` (ProPhoto) →
 * display-p3 into it (see `core/engine/color/gamut.ts::WORKING_GAMUT`). The field this
 * interface used to carry was fed from the now-deleted `Frame.colorSpace`, which is
 * exactly the "document dictates the working space" inversion that this deletion
 * removes. `hdr` remains a genuine surface choice.
 */
export interface SurfaceConfig {
  readonly hdr: boolean;
}

/**
 * The swapchain texture formats, per presentation mode.
 *
 * ⚠️ SDR pin (A-phase terminal state): `SWAPCHAIN_FORMAT_SDR` is deliberately
 * NOT `navigator.gpu.getPreferredCanvasFormat()`. That call may return an `-srgb`
 * variant, whose hardware would TRC-encode on write — and the SDR `view.wgsl`
 * variant already performs the pipeline's single terminal encode, so the result
 * would be double-encoded (visibly washed out) on those platforms only. Pinning
 * a non-`-srgb` format keeps the encode point unique, visible in code, and
 * testable. `Capabilities.preferredFormat` still records the real probe result
 * for diagnostics. `bgra8unorm` is guaranteed usable as a canvas format by the
 * WebGPU spec and is the value `getPreferredCanvasFormat()` returns on the
 * overwhelming majority of targets anyway.
 *
 * HDR pin (per-document HDR presentation switch): `rgba16float` — an 8-bit
 * unorm target hard-clamps [0,1] at the ROP, so `bgra8unorm` can never carry
 * the > 1.0 values the HDR contract outputs, no matter what `toneMapping` says
 * (configure accepting it ≠ delivering HDR). `rgba16float` +
 * `toneMapping:'extended'` lets the encode TAIL past white (linear light
 * above display white encodes > 1.0) survive the write; the OS projects that
 * excess onto the device headroom. The terminal encode STAYS in `view.wgsl`
 * for both variants — device-verified: the compositor applies the canvas
 * colorspace's transfer to float16 content as-is (linear content displayed
 * raw reads crushed-dark), so the canvas holds encoded display-p3 either way.
 *
 * `SWAPCHAIN_FORMAT` keeps the historical name as the SDR pin; consumers that
 * need the ACTIVE surface format read {@link GpuDevice.getSwapchainFormat}.
 */
export const SWAPCHAIN_FORMAT_SDR: GPUTextureFormat = 'bgra8unorm';
export const SWAPCHAIN_FORMAT_HDR: GPUTextureFormat = 'rgba16float';
export const SWAPCHAIN_FORMAT = SWAPCHAIN_FORMAT_SDR;

export class GpuDevice {
  private adapter: GPUAdapter | null = null;
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private caps: Capabilities | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private surface: SurfaceConfig = { hdr: false };
  /** Invoked after device loss so the engine can rebuild resources and replay. */
  private onLost: ((info: GPUDeviceLostInfo) => void) | null = null;
  /** In-flight initialization promise to prevent dual GPUDevice creation on concurrent calls. */
  private initPromise: Promise<Capabilities> | null = null;

  /** Cheap synchronous probe — safe to call before `init()`. */
  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.gpu;
  }

  /**
   * Acquire adapter + device, negotiate capabilities, configure the swapchain.
   * Idempotent: repeat calls return the already-negotiated capabilities.
   *
   * @throws {WebGpuUnavailableError} when no adapter/device can be obtained.
   */
  async init(canvas: HTMLCanvasElement, surface?: SurfaceConfig): Promise<Capabilities> {
    if (this.caps && this.device) {
      this.attachCanvas(canvas, surface);
      return this.caps;
    }

    if (this.initPromise) {
      const caps = await this.initPromise;
      this.attachCanvas(canvas, surface);
      return caps;
    }

    this.initPromise = (async () => {
      try {
        if (PERF_MON) {
          console.info('[OpenGPEX] WebGPU Initializing');
        }
        
        if (!GpuDevice.isSupported()) {
          throw new WebGpuUnavailableError('navigator.gpu is undefined');
        }
        const gpu = navigator.gpu!;

        const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter) {
          throw new WebGpuUnavailableError('requestAdapter() returned null');
        }

        // Ask for everything available, adapt to whatever we are granted.
        const requiredFeatures = negotiateFeatures(adapter);
        const requiredLimits = negotiateLimits(adapter);
        let device: GPUDevice;
        try {
          device = await adapter.requestDevice({
            label: 'OpenGPEX v2 Engine Device',
            requiredFeatures,
            requiredLimits,
          });
        } catch (limitsErr) {
          console.warn('[OpenGPEX] requestDevice with requiredLimits failed, retrying with requiredFeatures only:', limitsErr);
          device = await adapter.requestDevice({
            label: 'OpenGPEX v2 Engine Device',
            requiredFeatures,
          });
        }

        this.adapter = adapter;
        this.device = device;
        this.canvas = canvas;
        if (surface) this.surface = surface;

        const limits: GpuLimits = readLimits(device.limits);
        const maxDim = Math.max(canvas.width, canvas.height);

        this.caps = {
          features: requiredFeatures,
          limits,
          preferredFormat: gpu.getPreferredCanvasFormat(),
          // rgba32float as a composite target needs BOTH blendable (write side)
          // AND filterable (read/sample side). The ping-pong Blend/Blit passes
          // sample the intermediate texture with a filtering sampler, so having
          // only `float32-blendable` would make pipeline creation fail
          // validation (unfilterable-float + filtering sampler). Require both;
          // otherwise stay on the unconditionally-safe rgba16float.
          workingFormat:
            requiredFeatures.includes('float32-blendable') &&
            requiredFeatures.includes('float32-filterable')
              ? 'rgba32float'
              : 'rgba16float',
          // Small mobile texture limits force tiled composition.
          needsTiling: limits.maxTextureDimension2D > 0 && maxDim > limits.maxTextureDimension2D,
          adapterInfo: {
            vendor: adapter.info?.vendor ?? '',
            architecture: adapter.info?.architecture ?? '',
            device: adapter.info?.device ?? '',
            description: adapter.info?.description ?? '',
          },
        };

        this.configureSurface();
        this.watchDeviceLoss(device);
        this.watchUncapturedErrors(device);

        if (PERF_MON) {
          console.info(
            `[OpenGPEX] WebGPU ready — format=${this.caps.preferredFormat} ` +
              `working=${this.caps.workingFormat} ` +
              `features=[${requiredFeatures.join(', ') || 'none'}] ` +
              `maxTex2D=${limits.maxTextureDimension2D}${this.caps.needsTiling ? ' (tiling)' : ''}`,
          );
        }

        return this.caps;
      } catch (err) {
        this.initPromise = null;
        throw err;
      }
    })();

    return await this.initPromise;
  }

  /**
   * (Re)configure the canvas swapchain.
   *
   * `premultiplied` alpha matches the engine's blend state; `display-p3` opts
   * into wide gamut; `toneMapping: 'extended'` unlocks true HDR headroom.
   *
   * ⚠️ COLOUR-SPACE CONTRACT — DO NOT "optimise" THIS BACK.
   * SDR mode (`hdr:false`) pins a non-`-srgb` format (`bgra8unorm`) and we
   * deliberately do NOT use `navigator.gpu.getPreferredCanvasFormat()`'s return
   * value here, in order to eliminate the `-srgb` DOUBLE-ENCODE risk: the SDR
   * `view.wgsl` variant performs the pipeline's single terminal TRC encode
   * (linear light → sRGB). If the swapchain were an `-srgb` format the hardware
   * would encode a SECOND time on write, and the canvas would render visibly
   * washed out on exactly those platforms whose preferred format happens to
   * carry the suffix — a platform-dependent bug that no Node test can observe
   * (H1 blind spot).
   *
   * HDR mode (`hdr:true`) pins `rgba16float` + `toneMapping:'extended'`: an
   * 8-bit unorm ROP hard-clamps [0,1] so it can never deliver > 1.0, while the
   * float16 surface carries the encode tail past white and 'extended' tells
   * the OS to project that excess onto the device headroom. The HDR
   * `view.wgsl` variant is the SDR contract minus the upper clamp — the
   * terminal encode stays in the shader for BOTH variants (device-verified:
   * the compositor does not re-encode float16 content; see `view.ts`). The
   * single-encode invariant is untouched. `caps.preferredFormat` still records the true probe result for
   * diagnostics and logging; it is simply not the authority for the surface's
   * colour behaviour. Format and shader variant are a matched pair —
   * `PipelineCache.getViewPipeline(format, hdr)` must be called with the same
   * mode this function configured (the engine reads both from
   * {@link getSwapchainFormat} / {@link isHdrPresentation}).
   */
  private configureSurface(): void {
    if (!this.device || !this.caps || !this.canvas) return;

    const ctx = this.canvas.getContext('webgpu');
    if (!ctx) throw new WebGpuUnavailableError("canvas.getContext('webgpu') returned null");

    ctx.configure({
      device: this.device,
      format: this.getSwapchainFormat(),
      alphaMode: 'premultiplied',
      // The swapchain is ALWAYS Display-P3. The working buffer is Linear
      // ProPhoto (`WORKING_GAMUT`); the view pass projects W → display-p3
      // (SDR variant: + clamp [0,1] + sRGB TRC in-shader; HDR variant: lower
      // clamp only, linear out — the compositor encodes). Presenting on a P3
      // surface lets the OS map P3 pixels correctly on both P3 and sRGB
      // monitors. A gamut-following srgb swapchain would clip wide-gamut
      // content; abolished (no `toCanvasColorSpace`).
      colorSpace: 'display-p3',
      ...(this.surface.hdr ? { toneMapping: { mode: 'extended' as const } } : {}),
    });
    this.context = ctx;
  }

  /** Update the presentation surface (e.g. the user switched working space). */
  setSurface(surface: SurfaceConfig): void {
    this.surface = surface;
    this.configureSurface();
  }

  /**
   * Synchronously attach a new or re-mounted canvas to the existing device.
   * Runs in the React layout phase so the GPU surface is configured before paint.
   */
  attachCanvas(canvas: HTMLCanvasElement, surface?: SurfaceConfig): boolean {
    if (!this.device || !this.caps) return false;
    if (surface) this.surface = surface;

    if (this.canvas !== canvas) {
      if (this.canvas && this.context) {
        try {
          this.context.unconfigure();
        } catch {
          // Ignore unconfigure errors on detached canvases
        }
      }
      this.canvas = canvas;
      this.configureSurface();
    } else if (surface) {
      this.configureSurface();
    }
    return true;
  }

  /**
   * Register the device-loss handler.
   * The engine re-inits and replays the last Scene — possible precisely because
   * Scene is immutable pure data.
   */
  setLostHandler(handler: (info: GPUDeviceLostInfo) => void): void {
    this.onLost = handler;
  }

  private watchDeviceLoss(device: GPUDevice): void {
    void device.lost.then((info) => {
      console.warn(`[OpenGPEX] WebGPU device lost (${info.reason}): ${info.message}`);
      // Drop stale handles so a subsequent init() performs a clean re-acquire.
      this.device = null;
      this.context = null;
      this.caps = null;
      this.initPromise = null;
      this.onLost?.(info);
    });
  }

  /**
   * Surface GPU validation / OOM / internal errors that occur OUTSIDE an
   * explicit error scope. Without this, a bad pipeline/bind group silently
   * invalidates the command buffer and the frame just goes blank with no clue
   * why (exactly how the Blit visibility bug hid). This turns every such error
   * into a loud console message naming the offending object.
   */
  private watchUncapturedErrors(device: GPUDevice): void {
    if (typeof device.addEventListener !== 'function') return;
    device.addEventListener('uncapturederror', (event) => {
      console.error(`[OpenGPEX] WebGPU uncaptured error: ${event.error.message}`);
    });
  }

  // ─── Accessors (borrowed by TexturePool / PipelineCache / passes) ───

  /**
   * The swapchain format the CURRENT surface mode configures — the single
   * authority for "which format the present pipeline must be compiled against"
   * (the engine's view pass reads this; it must never guess or read the probe
   * result). SDR → `bgra8unorm`, HDR → `rgba16float`, matching
   * {@link configureSurface} exactly.
   */
  getSwapchainFormat(): GPUTextureFormat {
    return this.surface.hdr ? SWAPCHAIN_FORMAT_HDR : SWAPCHAIN_FORMAT_SDR;
  }

  /** True when the surface is configured for HDR presentation (f16 + extended). */
  isHdrPresentation(): boolean {
    return this.surface.hdr;
  }

  getDevice(): GPUDevice | null {
    return this.device;
  }

  getContext(): GPUCanvasContext | null {
    return this.context;
  }

  getCanvas(): HTMLCanvasElement | null {
    return this.canvas;
  }

  getCapabilities(): Capabilities | null {
    return this.caps;
  }

  getAdapter(): GPUAdapter | null {
    return this.adapter;
  }

  /** True once a device has been negotiated and not since lost. */
  isReady(): boolean {
    return !!this.device && !!this.caps;
  }

  destroy(): void {
    this.context?.unconfigure();
    this.device?.destroy();
    this.adapter = null;
    this.device = null;
    this.context = null;
    this.caps = null;
    this.canvas = null;
    this.onLost = null;
    this.initPromise = null;
  }
}

