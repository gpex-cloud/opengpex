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
 * unconditionally (see `core/engine/color/gamut.ts::WORKING_GAMUT`) — so the field this
 * interface used to carry could only ever be ignored. It was fed from the
 * now-deleted `Frame.colorSpace`, which is exactly the "document dictates the
 * working space" inversion R2 removed. `hdr` remains a genuine surface choice.
 */
export interface SurfaceConfig {
  readonly hdr: boolean;
}

/**
 * The swapchain texture format, PINNED.
 *
 * ⚠️ Deliberately NOT `navigator.gpu.getPreferredCanvasFormat()`. That call may
 * return an `-srgb` variant, whose hardware would TRC-encode on write — and
 * `view.wgsl` already performs the pipeline's single terminal encode,
 * so the result would be double-encoded (visibly washed out) on those platforms
 * only. Pinning a non-`-srgb` format keeps the encode point unique, visible in
 * code, and testable. `Capabilities.preferredFormat` still records the real probe
 * result for diagnostics. See `configureSurface` for the full contract.
 *
 * `bgra8unorm` is guaranteed usable as a canvas format by the WebGPU spec and is
 * the value `getPreferredCanvasFormat()` returns on the overwhelming majority of
 * targets anyway, so this costs no fast path.
 */
export const SWAPCHAIN_FORMAT: GPUTextureFormat = 'bgra8unorm';

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
   * The format is deliberately PINNED to a non-`-srgb` format and we deliberately do
   * NOT use `navigator.gpu.getPreferredCanvasFormat()`'s return value here, in order
   * to eliminate the `-srgb` DOUBLE-ENCODE risk: `view.wgsl` performs the pipeline's
   * single terminal TRC encode (linear light → sRGB). If the swapchain
   * were an `-srgb` format the hardware would encode a SECOND time on write, and the
   * canvas would render visibly washed out on exactly those platforms whose preferred
   * format happens to carry the suffix — a platform-dependent bug that no Node test
   * can observe (H1 blind spot).
   *
   * `caps.preferredFormat` still records the true probe result for diagnostics and
   * logging; it is simply not the authority for the surface's colour behaviour. If
   * this ever needs to change, `view.wgsl`'s encode must be removed in the same
   * commit — the two are a matched pair.
   */
  private configureSurface(): void {
    if (!this.device || !this.caps || !this.canvas) return;

    const ctx = this.canvas.getContext('webgpu');
    if (!ctx) throw new WebGpuUnavailableError("canvas.getContext('webgpu') returned null");

    ctx.configure({
      device: this.device,
      format: SWAPCHAIN_FORMAT,
      alphaMode: 'premultiplied',
      // The swapchain is ALWAYS Display-P3. The working buffer is
      // Linear Display-P3, and view.wgsl encodes linear→sRGB-TRC only —
      // no gamut projection. Presenting on a P3 surface lets the OS map P3
      // pixels correctly on both P3 and sRGB monitors. A gamut-following srgb
      // swapchain would clip P3 content; abolished (no `toCanvasColorSpace`).
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

