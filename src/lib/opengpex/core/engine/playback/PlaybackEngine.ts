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
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * PlaybackEngine — the GPU shell of the playback pipeline, the playback twin
 * of what WebGpuEngine is for the scene pipeline.
 *
 * Owns ALL device-bound state of a playback session: the second canvas'
 * WebGPU context, the single blit pipeline (WGSL), the uniform buffer and
 * sampler, and the frame slot bind groups. The controller (clock/seek/
 * session) stays free of device vocabulary — it hands the engine a resolved
 * frame view + a view matrix and receives a bind group to present.
 *
 * Color contract: the surface mirrors GpuDevice.configureSurface's SDR form
 * (bgra8unorm / premultiplied / display-p3) and texels pass through
 * untouched — frames are display-referred sRGB, already premultiplied on the
 * GPU copy path (see RingTextureSource), so this pass adds NO color
 * transform.
 */

import type { Affine2D } from './cameraFold';
import type { PlaybackFrameHandle } from './frameSource';

const BLIT_WGSL = /* wgsl */ `
struct BlitUniforms {
  // Frame's unit-quad → NDC affine (cameraFold.composeFrameView), row-packed.
  va: f32, vb: f32, vc: f32, vd: f32,
  tx: f32, ty: f32,
  // Unused since the view matrix became self-contained (kept for layout
  // stability with writeUniforms): invW/invH/invUW/invUH.
  invW: f32, invH: f32, invUW: f32, invUH: f32,
};

@group(0) @binding(0) var<uniform> u: BlitUniforms;
@group(0) @binding(1) var s: sampler;
@group(0) @binding(2) var t: texture_2d<f32>;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0),
  );
  // The uniform matrix is the COMPLETE mapping (cameraFold.composeFrameView):
  // NDC = N ∘ M_camera ∘ M_layer ∘ S(imgW,imgH), i.e. it consumes the UNIT
  // quad directly and already carries the image scale, the camera and the
  // NDC projection + Y flip. NO further scaling or normalization here —
  // feeding pixels (or re-projecting) double-applies S and N and the quad
  // gets frustum-clipped away (the 2026-11-16 blank-overlay bug; locked by
  // tests/lib/opengpex/core/engine/playback/blitShaderContract.test.ts).
  let c = corners[vi];
  let ndc = vec2<f32>(
    u.va * c.x + u.vc * c.y + u.tx,
    u.vb * c.x + u.vd * c.y + u.ty,
  );
  var out: VsOut;
  out.pos = vec4<f32>(ndc, 0.0, 1.0);
  out.uv = c;
  return out;
}

@fragment fn fs(in: VsOut) -> @location(0) vec4<f32> {
  return textureSample(t, s, in.uv);
}
`;

export interface PlaybackEngineOptions {
  readonly canvas: HTMLCanvasElement;
  readonly device: GPUDevice;
}

/** Inputs for one frame bind: the folded view matrix (cameraFold), the image
 * dims the unit quad spans, and the resident frame's texture view. */
export interface PlaybackFrameBindInput {
  readonly view: Affine2D;
  readonly imgW: number;
  readonly imgH: number;
  readonly frameView: GPUTextureView;
}

export class PlaybackEngine {
  private readonly canvas: HTMLCanvasElement;
  private readonly device: GPUDevice;

  private context: GPUCanvasContext | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private sampler: GPUSampler | null = null;
  /** Per-slot bind groups — PRIVATE to the shell: a bind group is a WebGPU
   * implementation detail the scheduler must never see. Indexed by the frame
   * handle's ring slot (RING_DEPTH = 2 on both sides of the seam). */
  private slotBindGroups: (GPUBindGroup | null)[] = [null, null];
  private lastWrittenSlot = -1;

  constructor(options: PlaybackEngineOptions) {
    this.canvas = options.canvas;
    this.device = options.device;

    const ctx = this.canvas.getContext('webgpu');
    if (!ctx) return;
    // Mirrors GpuDevice.configureSurface's SDR contract (bgra8unorm,
    // premultiplied, display-p3) — the playback surface presents into the
    // same surface family the stage does, so an overlay frame and the stage
    // composite land with identical color behavior.
    ctx.configure({
      device: this.device,
      format: 'bgra8unorm',
      alphaMode: 'premultiplied',
      colorSpace: 'display-p3',
    });
    this.context = ctx;

    const blitModule = this.device.createShaderModule({ code: BLIT_WGSL });
    this.pipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: blitModule, entryPoint: 'vs' },
      fragment: {
        module: blitModule,
        entryPoint: 'fs',
        targets: [{
          format: 'bgra8unorm',
          blend: {
            // The canvas holds ONLY the frame (DOM compositor blends it over
            // the stage): texels are already premultiplied — straight-over.
            color: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.uniformBuffer = this.device.createBuffer({
      size: 48, // 10 floats, padded to 12 (uniform alignment)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.sampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  }

  /** Whether the GPU shell came up (context + pipeline usable). */
  get isUsable(): boolean {
    return this.context !== null && this.pipeline !== null;
  }

  /**
   * Keep the canvas' physical buffer AND its CSS size in lockstep with the
   * viewport (mirror of the stage's syncCanvasBuffer contract — without the
   * style half the canvas renders at its PHYSICAL attribute size in CSS px,
   * i.e. dpr× off). A resize clears the canvas; the caller must redraw.
   */
  syncTarget(viewportDim: { w: number; h: number }, dpr: number): void {
    const targetW = Math.max(1, Math.floor(viewportDim.w * dpr));
    const targetH = Math.max(1, Math.floor(viewportDim.h * dpr));
    const wpx = `${viewportDim.w}px`;
    const hpx = `${viewportDim.h}px`;
    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }
    if (this.canvas.style.width !== wpx) this.canvas.style.width = wpx;
    if (this.canvas.style.height !== hpx) this.canvas.style.height = hpx;
  }

  /**
   * Refresh the frame uniforms — UNCONDITIONALLY, every tick, BEFORE any
   * present: a pan/zoom while the current frame is not resident (decode
   * miss) must still re-place the last presented frame under the NEW camera.
   * The uniform buffer is shared by every slot's bind group, so this write
   * alone re-places whatever is on screen.
   */
  updateView(view: Affine2D, imgW: number, imgH: number, targetW: number, targetH: number): void {
    if (!this.uniformBuffer) return;
    const data = new Float32Array(12);
    data[0] = view.a; data[1] = view.b; data[2] = view.c; data[3] = view.d;
    data[4] = view.tx; data[5] = view.ty;
    data[6] = 1 / targetW; data[7] = 1 / targetH;
    data[8] = 1 / Math.max(1, imgW); data[9] = 1 / Math.max(1, imgH);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, data);
  }

  /**
   * Present one frame: `handle` non-null = a NEWLY uploaded frame (its ring
   * slot's bind group is created/refreshed and becomes the presented one);
   * null = decode miss — re-present the most recently written slot under the
   * freshly updated uniforms (newest pixels, never a stall); nothing ever
   * uploaded → clear-only.
   */
  presentFrame(handle: PlaybackFrameHandle | null): void {
    if (handle) {
      this.slotBindGroups[handle.slot] = this.device.createBindGroup({
        layout: this.pipeline!.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer! } },
          { binding: 1, resource: this.sampler! },
          { binding: 2, resource: handle.view },
        ],
      });
      this.lastWrittenSlot = handle.slot;
    }
    const bind = this.lastWrittenSlot >= 0 ? this.slotBindGroups[this.lastWrittenSlot] : null;
    this.present(bind);
  }

  /** Blit + present. `bind === null` → clear-only (no frame resident yet). */
  private present(bind: GPUBindGroup | null): void {
    if (!this.context || !this.pipeline) return;
    let texture: GPUTexture;
    try {
      texture = this.context.getCurrentTexture();
    } catch {
      return;
    }
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: texture.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(this.pipeline);
    if (bind) {
      pass.setBindGroup(0, bind);
      pass.draw(6);
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  dispose(): void {
    this.slotBindGroups = [null, null];
    this.uniformBuffer?.destroy();
    try {
      this.context?.unconfigure();
    } catch {
      /* context already lost */
    }
    this.context = null;
    this.pipeline = null;
    this.uniformBuffer = null;
    this.sampler = null;
  }
}

