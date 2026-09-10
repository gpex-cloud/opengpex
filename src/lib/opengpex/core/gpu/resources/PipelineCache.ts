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
 * PipelineCache.ts — Pipeline and shared GPU resource cache (spec §3.1, §7.1).
 *
 * Manages:
 *   • Compilation and memoization of `GPURenderPipeline` by (shader, blend, format);
 *   • The shared unit quad vertex buffer (6 vertices, 2 triangles);
 *   • The shared bilinear clamp sampler;
 *   • The shared 1×1 solid-white dummy mask texture for unmasked layers.
 *
 * @module core/gpu/resources/PipelineCache
 */

import type { LayerBlendMode } from '@opengpex/editor/core/types';
import { LAYER_WGSL, LAYER_UNIFORM_BUFFER_SIZE } from '../shaders/layer';
import { BLEND_WGSL, isHardwareBlendable } from '../shaders/blend';
import { VIEW_WGSL, VIEW_UNIFORM_BUFFER_SIZE } from '../shaders/view';
import { GPUBufferUsage, GPUTextureUsage, GPUShaderStage, GPUColorWrite } from '../constants';

export const BLEND_UNIFORM_BUFFER_SIZE = 80;

/** Unit quad vertices: 6 vertices, 2 triangles from (0,0) to (1,1). */
const UNIT_QUAD_DATA = new Float32Array([
  // pos.x, pos.y, uv.u, uv.v
  0, 0, 0, 0, // Triangle 1
  1, 0, 1, 0,
  0, 1, 0, 1,
  1, 0, 1, 0, // Triangle 2
  1, 1, 1, 1,
  0, 1, 0, 1,
]);

/** Standard pre-multiplied alpha 'over' blend state (§7.4). */
export const PREMULTIPLIED_OVER_BLEND: GPUBlendState = {
  color: {
    operation: 'add',
    srcFactor: 'one',
    dstFactor: 'one-minus-src-alpha',
  },
  alpha: {
    operation: 'add',
    srcFactor: 'one',
    dstFactor: 'one-minus-src-alpha',
  },
};

/** Direct overwrite blend state (no blend). */
export const REPLACE_BLEND: GPUBlendState = {
  color: {
    operation: 'add',
    srcFactor: 'one',
    dstFactor: 'zero',
  },
  alpha: {
    operation: 'add',
    srcFactor: 'one',
    dstFactor: 'zero',
  },
};

/** Additive blend state. */
export const ADD_BLEND: GPUBlendState = {
  color: {
    operation: 'add',
    srcFactor: 'one',
    dstFactor: 'one',
  },
  alpha: {
    operation: 'add',
    srcFactor: 'one',
    dstFactor: 'one',
  },
};

export class PipelineCache {
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private layerShaderModule: GPUShaderModule | null = null;
  private layerBindGroupLayout: GPUBindGroupLayout | null = null;
  private layerPipelineLayout: GPUPipelineLayout | null = null;

  private blendShaderModule: GPUShaderModule | null = null;
  private blendBindGroupLayout: GPUBindGroupLayout | null = null;
  private blendPipelineLayout: GPUPipelineLayout | null = null;

  private viewShaderModule: GPUShaderModule | null = null;
  private viewBindGroupLayout: GPUBindGroupLayout | null = null;
  private viewPipelineLayout: GPUPipelineLayout | null = null;

  private quadVertexBuffer: GPUBuffer | null = null;
  private linearSampler: GPUSampler | null = null;
  private nearestSampler: GPUSampler | null = null;
  private defaultMaskTexture: GPUTexture | null = null;
  private defaultMaskView: GPUTextureView | null = null;

  constructor(readonly device: GPUDevice) {}

  /**
   * Shared unit quad vertex buffer: (0,0) to (1,1).
   * Stride = 16 bytes: pos(vec2<f32>) at offset 0, uv(vec2<f32>) at offset 8.
   */
  getQuadVertexBuffer(): GPUBuffer {
    if (this.quadVertexBuffer) return this.quadVertexBuffer;

    const buffer = this.device.createBuffer({
      size: UNIT_QUAD_DATA.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      label: 'Unit Quad Vertex Buffer',
    });
    this.device.queue.writeBuffer(buffer, 0, UNIT_QUAD_DATA);
    this.quadVertexBuffer = buffer;
    return buffer;
  }

  /**
   * Shared bilinear clamp-to-edge sampler.
   */
  getLinearSampler(): GPUSampler {
    if (this.linearSampler) return this.linearSampler;

    this.linearSampler = this.device.createSampler({
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      magFilter: 'linear',
      minFilter: 'linear',
      label: 'Bilinear Clamp Sampler',
    });
    return this.linearSampler;
  }

  /**
   * Shared nearest-neighbour clamp-to-edge sampler (缺陷 3 / §3).
   *
   * A pixel editor must show TRUE pixels when magnifying: at zoom ≥ 100% one
   * source texel maps to ≥1 screen pixel, and linear filtering would blur the
   * hard pixel edges. This matches OpenGPEX v1 (`imageSmoothingEnabled=false`),
   * GIMP (`FILTER_AUTO` → nearest when scale≥1) and Photoshop. Callers choose
   * nearest vs linear per-layer via `getSamplerForScale`.
   */
  getNearestSampler(): GPUSampler {
    if (this.nearestSampler) return this.nearestSampler;

    this.nearestSampler = this.device.createSampler({
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      magFilter: 'nearest',
      minFilter: 'nearest',
      label: 'Nearest Clamp Sampler',
    });
    return this.nearestSampler;
  }

  /**
   * GIMP `FILTER_AUTO` rule: magnify (screen-texels-per-source-texel ≥ 1) →
   * nearest (crisp pixels); minify (< 1) → linear (avoids dropped texels /
   * moiré / shimmer). `scale` is the effective on-screen scale of the sampled
   * texture (see `effectiveScale`).
   */
  getSamplerForScale(scale: number): GPUSampler {
    return scale >= 1 ? this.getNearestSampler() : this.getLinearSampler();
  }

  /**
   * 1×1 dummy mask texture view for layers without an explicit mask.
   * Ensures binding 3 is always valid.
   */
  getDefaultMaskView(): GPUTextureView {
    if (this.defaultMaskView) return this.defaultMaskView;

    const texture = this.device.createTexture({
      size: [1, 1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: 'Default 1x1 Dummy Mask',
    });

    // WP-3.2: initialize to opaque white (a=255). The layer/blend shaders only
    // sample the mask when `flags & has_mask`, but an uninitialized texture is
    // undefined per WebGPU spec — writing white makes an accidental sample a
    // safe no-op (mask_alpha=1 keeps the source fully visible) instead of
    // relying on driver-dependent behavior (Review §4.4).
    const whitePixel = new Uint8Array([255, 255, 255, 255]);
    this.device.queue.writeTexture(
      { texture },
      whitePixel,
      { bytesPerRow: 4, rowsPerImage: 1 },
      [1, 1, 1],
    );

    this.defaultMaskTexture = texture;
    this.defaultMaskView = texture.createView({ label: 'Default 1x1 Dummy Mask View' });
    return this.defaultMaskView;
  }

  getLayerShaderModule(): GPUShaderModule {
    if (this.layerShaderModule) return this.layerShaderModule;
    this.layerShaderModule = this.device.createShaderModule({
      code: LAYER_WGSL,
      label: 'Layer WGSL Module',
    });
    return this.layerShaderModule;
  }

  getLayerBindGroupLayout(): GPUBindGroupLayout {
    if (this.layerBindGroupLayout) return this.layerBindGroupLayout;

    this.layerBindGroupLayout = this.device.createBindGroupLayout({
      label: 'Layer Bind Group Layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: {
            type: 'uniform',
            hasDynamicOffset: true,
            minBindingSize: LAYER_UNIFORM_BUFFER_SIZE,
          },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' },
        },
      ],
    });
    return this.layerBindGroupLayout;
  }

  getLayerPipelineLayout(): GPUPipelineLayout {
    if (this.layerPipelineLayout) return this.layerPipelineLayout;

    this.layerPipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.getLayerBindGroupLayout()],
      label: 'Layer Pipeline Layout',
    });
    return this.layerPipelineLayout;
  }

  /**
   * Acquire a compiled render pipeline for drawing a layer.
   * Cached by `(blendMode, targetFormat)`.
   */
  getLayerPipeline(
    blendMode: LayerBlendMode = 'source-over',
    targetFormat: GPUTextureFormat = 'rgba16float',
    isBottomOpaque = false,
  ): GPURenderPipeline {
    const key = `layer:${blendMode}:${targetFormat}:${isBottomOpaque ? 'opaque' : 'blend'}`;
    let pipeline = this.pipelines.get(key);
    if (pipeline) return pipeline;

    // Class-A layers only ever reach the layer pipeline (SceneCompiler routes
    // everything else through the ping-pong BlendPass). Under premultiplied
    // alpha the correct fixed-function factors are:
    //   • isBottomOpaque first layer → REPLACE (src:one, dst:zero)
    //   • source-over               → OVER (src:one, dst:one-minus-src-alpha)
    // (When LayerBlendMode gains Add, map it to ADD_BLEND here — see core §7.2.)
    let blendState: GPUBlendState = PREMULTIPLIED_OVER_BLEND;
    if (isBottomOpaque) {
      blendState = REPLACE_BLEND;
    } else if (!isHardwareBlendable(blendMode)) {
      // Defensive: a class-B mode must never be drawn with a hardware blend
      // state (would silently degrade to Normal — the P0 bug from core §7.2).
      throw new Error(
        `getLayerPipeline: blend mode '${blendMode}' is not hardware-blendable; ` +
          `it must be composited via BlendPass (ping-pong), not the layer pipeline.`,
      );
    }

    pipeline = this.device.createRenderPipeline({
      label: `Layer Pipeline (${key})`,
      layout: this.getLayerPipelineLayout(),
      vertex: {
        module: this.getLayerShaderModule(),
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 16,
            stepMode: 'vertex',
            attributes: [
              { format: 'float32x2', offset: 0, shaderLocation: 0 }, // pos
              { format: 'float32x2', offset: 8, shaderLocation: 1 }, // uv
            ],
          },
        ],
      },
      fragment: {
        module: this.getLayerShaderModule(),
        entryPoint: 'fs_main',
        targets: [
          {
            format: targetFormat,
            blend: blendState,
            writeMask: GPUColorWrite.ALL,
          },
        ],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none',
      },
    });

    this.pipelines.set(key, pipeline);
    return pipeline;
  }

  getBlendShaderModule(): GPUShaderModule {
    if (this.blendShaderModule) return this.blendShaderModule;
    this.blendShaderModule = this.device.createShaderModule({
      code: BLEND_WGSL,
      label: 'Blend WGSL Module',
    });
    return this.blendShaderModule;
  }

  getBlendBindGroupLayout(): GPUBindGroupLayout {
    if (this.blendBindGroupLayout) return this.blendBindGroupLayout;

    this.blendBindGroupLayout = this.device.createBindGroupLayout({
      label: 'Blend Bind Group Layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: {
            type: 'uniform',
            hasDynamicOffset: true,
            minBindingSize: BLEND_UNIFORM_BUFFER_SIZE,
          },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' },
        },
      ],
    });
    return this.blendBindGroupLayout;
  }

  getBlendPipelineLayout(): GPUPipelineLayout {
    if (this.blendPipelineLayout) return this.blendPipelineLayout;

    this.blendPipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.getBlendBindGroupLayout()],
      label: 'Blend Pipeline Layout',
    });
    return this.blendPipelineLayout;
  }

  /**
   * Acquire a compiled render pipeline for ping-pong blend passes.
   * Outputs the alpha-composited result directly (REPLACE_BLEND).
   */
  getBlendPipeline(targetFormat: GPUTextureFormat = 'rgba16float'): GPURenderPipeline {
    const key = `blend:${targetFormat}`;
    let pipeline = this.pipelines.get(key);
    if (pipeline) return pipeline;

    pipeline = this.device.createRenderPipeline({
      label: `Blend Pipeline (${key})`,
      layout: this.getBlendPipelineLayout(),
      vertex: {
        module: this.getBlendShaderModule(),
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 16,
            stepMode: 'vertex',
            attributes: [
              { format: 'float32x2', offset: 0, shaderLocation: 0 },
              { format: 'float32x2', offset: 8, shaderLocation: 1 },
            ],
          },
        ],
      },
      fragment: {
        module: this.getBlendShaderModule(),
        entryPoint: 'fs_main',
        targets: [
          {
            format: targetFormat,
            blend: REPLACE_BLEND,
            writeMask: GPUColorWrite.ALL,
          },
        ],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none',
      },
    });

    this.pipelines.set(key, pipeline);
    return pipeline;
  }

  // ─── View pipeline (缺陷 5 §5: composited document → swapchain, camera-applied) ───

  getViewShaderModule(): GPUShaderModule {
    if (this.viewShaderModule) return this.viewShaderModule;
    this.viewShaderModule = this.device.createShaderModule({
      code: VIEW_WGSL,
      label: 'View WGSL Module',
    });
    return this.viewShaderModule;
  }

  getViewBindGroupLayout(): GPUBindGroupLayout {
    if (this.viewBindGroupLayout) return this.viewBindGroupLayout;

    this.viewBindGroupLayout = this.device.createBindGroupLayout({
      label: 'View Bind Group Layout',
      entries: [
        {
          binding: 0,
          // The view VERTEX stage reads `view_u.view_matrix` + `uv_scale`
          // (see view.ts vs_main), so binding 0 must be visible to VERTEX too —
          // not FRAGMENT only. (This was the 缺陷 1 环④ trap for the old blit:
          // a FRAGMENT-only visibility rejected the pipeline at creation.)
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: {
            type: 'uniform',
            hasDynamicOffset: true,
            minBindingSize: VIEW_UNIFORM_BUFFER_SIZE,
          },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' },
        },
      ],
    });
    return this.viewBindGroupLayout;
  }

  getViewPipelineLayout(): GPUPipelineLayout {
    if (this.viewPipelineLayout) return this.viewPipelineLayout;
    this.viewPipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.getViewBindGroupLayout()],
      label: 'View Pipeline Layout',
    });
    return this.viewPipelineLayout;
  }

  /**
   * Acquire the VIEW pipeline (缺陷 5 §5). Maps the composited document texture
   * onto the swapchain applying the camera; writes with REPLACE_BLEND (the
   * swapchain is cleared first, matching the previous BlitPass behavior).
   */
  getViewPipeline(targetFormat: GPUTextureFormat = 'bgra8unorm'): GPURenderPipeline {
    const key = `view:${targetFormat}`;
    let pipeline = this.pipelines.get(key);
    if (pipeline) return pipeline;

    pipeline = this.device.createRenderPipeline({
      label: `View Pipeline (${key})`,
      layout: this.getViewPipelineLayout(),
      vertex: {
        module: this.getViewShaderModule(),
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 16,
            stepMode: 'vertex',
            attributes: [
              { format: 'float32x2', offset: 0, shaderLocation: 0 },
              { format: 'float32x2', offset: 8, shaderLocation: 1 },
            ],
          },
        ],
      },
      fragment: {
        module: this.getViewShaderModule(),
        entryPoint: 'fs_main',
        targets: [
          {
            format: targetFormat,
            blend: REPLACE_BLEND,
            writeMask: GPUColorWrite.ALL,
          },
        ],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none',
      },
    });

    this.pipelines.set(key, pipeline);
    return pipeline;
  }

  destroy(): void {
    this.pipelines.clear();
    this.quadVertexBuffer?.destroy();
    this.defaultMaskTexture?.destroy();
    this.quadVertexBuffer = null;
    this.linearSampler = null;
    this.nearestSampler = null;
    this.defaultMaskTexture = null;
    this.defaultMaskView = null;
    this.layerShaderModule = null;
    this.layerBindGroupLayout = null;
    this.layerPipelineLayout = null;
    this.blendShaderModule = null;
    this.blendBindGroupLayout = null;
    this.blendPipelineLayout = null;
    this.viewShaderModule = null;
    this.viewBindGroupLayout = null;
    this.viewPipelineLayout = null;
  }
}
