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
 * PipelineCache.ts — Pipeline and shared GPU resource cache.
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
import { SDF_WGSL, SDF_UNIFORM_BUFFER_SIZE } from '../shaders/sdf';
import { STROKE_EXTRUDE_WGSL, STROKE_PAINT_WGSL, STROKE_UNIFORM_BUFFER_SIZE } from '../shaders/stroke';
import { ADJUST_UNIFORM_BUFFER_SIZE } from '../shaders/adjust';
import { ADJUST_PRE_WGSL, ADJUST_PRE_UNIFORM_BUFFER_SIZE } from '../shaders/adjustPre';
import { buildGaussianWgsl, GAUSS_UNIFORM_BUFFER_SIZE } from '../shaders/gaussian';
import { VMASK_WGSL, VMASK_UNIFORM_SIZE } from '../shaders/vmask';
import { BMASK_COMBINE_WGSL, BMASK_COMBINE_UNIFORM_SIZE } from '../shaders/bmaskCombine';
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

/** Standard pre-multiplied alpha 'over' blend state. */
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

/**
 * Coverage-UNION blend state (`max`): dst = max(src, dst) per channel. For a
 * SINGLE-COLOUR stroke ribbon whose per-segment quads overlap on the inner side of
 * every turn, `max` merges their soft-edge coverage into the union — a later segment's
 * low-coverage AA edge can NEVER punch a hole through a solid pixel a neighbour already
 * wrote (which REPLACE / 'over' both do), and equal-colour overlaps do not double-darken.
 * srcFactor/dstFactor are ignored under `operation: 'max'` but must stay valid.
 */
export const MAX_BLEND: GPUBlendState = {
  color: {
    operation: 'max',
    srcFactor: 'one',
    dstFactor: 'one',
  },
  alpha: {
    operation: 'max',
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

  /** Group-1 adjustment bind group layout (shared by layer + blend pipelines). */
  private adjustBindGroupLayout: GPUBindGroupLayout | null = null;
  /** Persistent identity (flags=0) AdjustUniforms buffer + bind group. */
  private defaultAdjustBuffer: GPUBuffer | null = null;
  private defaultAdjustBindGroup: GPUBindGroup | null = null;
  /** Shared clamp sampler + 1×1 identity 1D LUT for adjust group-1 bindings. */
  private lutSampler: GPUSampler | null = null;
  private identityLutTexture: GPUTexture | null = null;
  private identityLutView: GPUTextureView | null = null;
  private identityLut3dTexture: GPUTexture | null = null;
  private identityLut3dView: GPUTextureView | null = null;

  private quadVertexBuffer: GPUBuffer | null = null;
  private linearSampler: GPUSampler | null = null;
  private nearestSampler: GPUSampler | null = null;
  private defaultMaskTexture: GPUTexture | null = null;
  private defaultMaskView: GPUTextureView | null = null;

  /** Adjust-bake (pre-filter) render pipeline + its group-0 layout. */
  private adjustPreShaderModule: GPUShaderModule | null = null;
  private adjustPreBindGroupLayout: GPUBindGroupLayout | null = null;
  private adjustPrePipelineLayout: GPUPipelineLayout | null = null;

  /** Vector spine SDF strategy: zero-texture procedural pipeline (`shaders/sdf.ts`). */
  private sdfShaderModule: GPUShaderModule | null = null;
  private sdfBindGroupLayout: GPUBindGroupLayout | null = null;
  private sdfPipelineLayout: GPUPipelineLayout | null = null;

  /**
   * Vector spine STROKE strategy: compute-extrude + paint pipelines (`shaders/stroke.ts`).
   * The compute (`cs_extrude`) and render (`vs/fs_paint`) stages are DISTINCT WGSL
   * modules — a single module cannot share `@group(0) @binding(0)` across the compute
   * storage bindings and the paint uniform. The extrude pipeline is format-agnostic
   * (writes a storage buffer), so it is a single cached field; the paint pipeline is
   * keyed by target format in `this.pipelines` alongside the other render pipelines.
   */
  private strokeExtrudeShaderModule: GPUShaderModule | null = null;
  private strokeExtrudeBindGroupLayout: GPUBindGroupLayout | null = null;
  private strokeExtrudePipelineLayout: GPUPipelineLayout | null = null;
  private strokeExtrudePipeline: GPUComputePipeline | null = null;
  private strokePaintShaderModule: GPUShaderModule | null = null;
  private strokeRenderBindGroupLayout: GPUBindGroupLayout | null = null;
  private strokeRenderPipelineLayout: GPUPipelineLayout | null = null;

  /**
   * Vmask polygon fill COMPUTE pipeline (even-odd winding + SDF feather,
   * writes an `rgba8unorm` storage texture). The output format is fixed, so like
   * the stroke-extrude pipeline it is a single cached field, not format-keyed.
   */
  private vmaskShaderModule: GPUShaderModule | null = null;
  private vmaskBindGroupLayout: GPUBindGroupLayout | null = null;
  private vmaskPipelineLayout: GPUPipelineLayout | null = null;
  private vmaskPipeline: GPUComputePipeline | null = null;
  private bmaskCombineShaderModule: GPUShaderModule | null = null;
  private bmaskCombineBindGroupLayout: GPUBindGroupLayout | null = null;
  private bmaskCombinePipelineLayout: GPUPipelineLayout | null = null;
  private bmaskCombinePipeline: GPUComputePipeline | null = null;

  /** Separable-Gaussian COMPUTE pipelines, keyed by storage format. */
  private readonly computePipelines = new Map<string, GPUComputePipeline>();
  private readonly gaussianShaderModules = new Map<string, GPUShaderModule>();
  private readonly filterBindGroupLayouts = new Map<string, GPUBindGroupLayout>();
  private readonly filterPipelineLayouts = new Map<string, GPUPipelineLayout>();

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
   * Shared nearest-neighbour clamp-to-edge sampler.
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
    // relying on driver-dependent behavior.
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
        {
          // Vmask texture (polygon-baked coverage). Analytic / no-vmask
          // layers bind the 1×1 default white view so the slot is always valid.
          binding: 4,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' },
        },
        // The bmask stack slots (retired bindings 5..7) are gone: the bmask
        // combine pass bakes ALL enabled records into ONE texture bound at
        // slot 3, so the layer pipeline needs no per-record slots.
      ],
    });
    return this.layerBindGroupLayout;
  }

  /**
   * Group-1 adjustment bind group layout. Shared by the layer and
   * blend pipelines: binding 0 is the `AdjustUniforms` buffer (dynamic offset,
   * FRAGMENT-only). Also accommodates the 1D LUT sampler + textures.
   */
  getAdjustBindGroupLayout(): GPUBindGroupLayout {
    if (this.adjustBindGroupLayout) return this.adjustBindGroupLayout;

    this.adjustBindGroupLayout = this.device.createBindGroupLayout({
      label: 'Adjust Bind Group Layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: {
            type: 'uniform',
            hasDynamicOffset: true,
            minBindingSize: ADJUST_UNIFORM_BUFFER_SIZE,
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
          texture: { sampleType: 'float', viewDimension: '1d' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '1d' },
        },
        {
          // 3D `.cube` LUT. `sampleType: 'float'` + the shared filtering
          // sampler is what gives hardware trilinear interpolation; the format is
          // always a FILTERABLE float (rgba16float, or rgba32float only when
          // `float32-filterable` is granted — see lut3dPlan.selectLut3dFormat).
          binding: 4,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '3d' },
        },
      ],
    });
    return this.adjustBindGroupLayout;
  }

  /**
   * Persistent identity adjustment bind group (flags = 0). Bound at group 1 for
   * every layer that has NO scalar/matrix adjustment, so `apply_adjustments`
   * returns its input bit-exactly. Uses a NON-dynamic-offset layout variant is
   * unnecessary — the buffer is exactly `ADJUST_UNIFORM_BUFFER_SIZE`, bound at
   * offset 0 via a dynamic offset of 0 by the passes.
   */
  getDefaultAdjustBindGroup(): GPUBindGroup {
    if (this.defaultAdjustBindGroup) return this.defaultAdjustBindGroup;

    // A zero-filled buffer is exactly the identity: flags = 0 (slot 31 = 0).
    this.defaultAdjustBuffer = this.device.createBuffer({
      size: ADJUST_UNIFORM_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'Default (identity) AdjustUniforms',
    });
    this.device.queue.writeBuffer(
      this.defaultAdjustBuffer,
      0,
      new Float32Array(ADJUST_UNIFORM_BUFFER_SIZE / 4),
    );

    this.defaultAdjustBindGroup = this.device.createBindGroup({
      layout: this.getAdjustBindGroupLayout(),
      label: 'Default (identity) Adjust BindGroup',
      entries: [
        {
          binding: 0,
          resource: { buffer: this.defaultAdjustBuffer, offset: 0, size: ADJUST_UNIFORM_BUFFER_SIZE },
        },
        { binding: 1, resource: this.getLutSampler() },
        { binding: 2, resource: this.getIdentityLutView() },
        { binding: 3, resource: this.getIdentityLutView() },
        { binding: 4, resource: this.getIdentityLut3dView() },
      ],
    });
    return this.defaultAdjustBindGroup;
  }

  /**
   * Shared LUT sampler for the adjust group-1 1D-LUT bindings: linear filtering
   * (hardware interpolation between LUT entries) with clamp-to-edge (out-of-range
   * inputs saturate to the endpoint entries).
   */
  getLutSampler(): GPUSampler {
    if (this.lutSampler) return this.lutSampler;
    this.lutSampler = this.device.createSampler({
      label: 'Adjust LUT Sampler (linear/clamp)',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
    });
    return this.lutSampler;
  }

  /**
   * A 1-texel identity 1D LUT bound at LUT slots for layers that do not sample
   * that table. Its value is irrelevant when the corresponding flag is off — the
   * shader never samples it — but a valid texture MUST be bound to satisfy the
   * bind group layout. rgba16float matches the resident curve/levels LUT format.
   */
  getIdentityLutView(): GPUTextureView {
    if (this.identityLutView) return this.identityLutView;
    this.identityLutTexture = this.device.createTexture({
      size: [1, 1, 1],
      dimension: '1d',
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: 'Adjust Identity 1D LUT',
    });
    this.identityLutView = this.identityLutTexture.createView({ dimension: '1d' });
    return this.identityLutView;
  }

  /**
   * A 1×1×1 placeholder 3D LUT bound at group-1 binding 4 for every layer WITHOUT
   * a `.cube` grade. Its value is irrelevant — the shader only samples it when
   * `ADJUST_FLAG_LUT3D` is set, and that bit is only set once a real LUT is
   * confirmed resident — but a valid texture MUST be bound to satisfy the layout.
   *
   * `rgba16float` matches the default (and degraded) resident 3D LUT format from
   * `lut3dPlan.selectLut3dFormat`, and is unconditionally FILTERABLE, so binding it
   * alongside the filtering `lutSampler` can never fail validation on an adapter
   * lacking `float32-filterable`.
   */
  getIdentityLut3dView(): GPUTextureView {
    if (this.identityLut3dView) return this.identityLut3dView;
    this.identityLut3dTexture = this.device.createTexture({
      size: [1, 1, 1],
      dimension: '3d',
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: 'Adjust Identity 3D LUT',
    });
    this.identityLut3dView = this.identityLut3dTexture.createView({ dimension: '3d' });
    return this.identityLut3dView;
  }

  // ──────────────────────────────────────────────────────────
  // Adjust-bake (pre-filter) pipeline — enforces adjust→filter order
  // ──────────────────────────────────────────────────────────

  /**
   * Group-0 layout for {@link ADJUST_PRE_WGSL}: uv-rect uniform + sampler + source.
   * Group 1 is the SAME adjust layout the compositing pipelines use, so the bake
   * and the inline path share one `apply_adjustments` and one bind-group shape.
   */
  getAdjustPreBindGroupLayout(): GPUBindGroupLayout {
    if (this.adjustPreBindGroupLayout) return this.adjustPreBindGroupLayout;
    this.adjustPreBindGroupLayout = this.device.createBindGroupLayout({
      label: 'Adjust Pre Bind Group Layout',
      entries: [
        {
          binding: 0,
          // VERTEX too: vs_adjust_pre reads uv_rect to build the sampling UVs.
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: {
            type: 'uniform',
            hasDynamicOffset: true,
            minBindingSize: ADJUST_PRE_UNIFORM_BUFFER_SIZE,
          },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    return this.adjustPreBindGroupLayout;
  }

  getAdjustPrePipelineLayout(): GPUPipelineLayout {
    if (this.adjustPrePipelineLayout) return this.adjustPrePipelineLayout;
    this.adjustPrePipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.getAdjustPreBindGroupLayout(), this.getAdjustBindGroupLayout()],
      label: 'Adjust Pre Pipeline Layout',
    });
    return this.adjustPrePipelineLayout;
  }

  getAdjustPreShaderModule(): GPUShaderModule {
    if (this.adjustPreShaderModule) return this.adjustPreShaderModule;
    this.adjustPreShaderModule = this.device.createShaderModule({
      code: ADJUST_PRE_WGSL,
      label: 'Adjust Pre WGSL Module',
    });
    return this.adjustPreShaderModule;
  }

  /**
   * 1:1 adjust-bake pipeline. REPLACE blend (the pass fully owns its target) and no
   * mask/opacity handling — those stay with the compositing pass, so this bake is a
   * pure colour transform of the layer's own pixels.
   */
  getAdjustPrePipeline(targetFormat: GPUTextureFormat = 'rgba16float'): GPURenderPipeline {
    const key = `adjustPre:${targetFormat}`;
    const cached = this.pipelines.get(key);
    if (cached) return cached;

    const pipeline = this.device.createRenderPipeline({
      label: `Adjust Pre Pipeline (${targetFormat})`,
      layout: this.getAdjustPrePipelineLayout(),
      vertex: {
        module: this.getAdjustPreShaderModule(),
        entryPoint: 'vs_adjust_pre',
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
        module: this.getAdjustPreShaderModule(),
        entryPoint: 'fs_adjust_pre',
        targets: [{ format: targetFormat, blend: REPLACE_BLEND }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.pipelines.set(key, pipeline);
    return pipeline;
  }
  // ──────────────────────────────────────────────────────────
  // Separable-Gaussian compute pipeline
  // ──────────────────────────────────────────────────────────

  /**
   * Group-0 layout for the Gaussian compute pass: uniform + sampled source +
   * write-only storage destination.
   *
   * Keyed by STORAGE FORMAT because `storageTexture.format` must match the WGSL
   * `texture_storage_2d<F, write>` declaration exactly. The source binding uses
   * `unfilterable-float` for the 32-bit tier (the compute kernel only ever calls
   * `textureLoad`, never `textureSample`, so filtering is not required and demanding
   * it would break on adapters without `float32-filterable`).
   */
  getFilterBindGroupLayout(
    storageFormat: 'rgba16float' | 'rgba32float' = 'rgba16float',
  ): GPUBindGroupLayout {
    const cached = this.filterBindGroupLayouts.get(storageFormat);
    if (cached) return cached;

    const layout = this.device.createBindGroupLayout({
      label: `Filter (Gaussian) Bind Group Layout [${storageFormat}]`,
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: {
            type: 'uniform',
            hasDynamicOffset: true,
            minBindingSize: GAUSS_UNIFORM_BUFFER_SIZE,
          },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          // textureLoad-only access ⇒ no filtering requirement (see above).
          texture: {
            sampleType: storageFormat === 'rgba32float' ? 'unfilterable-float' : 'float',
          },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: storageFormat },
        },
      ],
    });
    this.filterBindGroupLayouts.set(storageFormat, layout);
    return layout;
  }

  getFilterPipelineLayout(
    storageFormat: 'rgba16float' | 'rgba32float' = 'rgba16float',
  ): GPUPipelineLayout {
    const cached = this.filterPipelineLayouts.get(storageFormat);
    if (cached) return cached;
    const layout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.getFilterBindGroupLayout(storageFormat)],
      label: `Filter Pipeline Layout [${storageFormat}]`,
    });
    this.filterPipelineLayouts.set(storageFormat, layout);
    return layout;
  }

  /**
   * Separable-Gaussian compute pipeline. BOTH passes (horizontal and vertical) reuse
   * this ONE pipeline — the axis is a uniform, not a pipeline variant — so a blur is
   * two dispatches with two bind groups and zero extra shader compilation. The
   * kernel radius is also a uniform, so changing the blur slider never recompiles.
   */
  getGaussianPipeline(
    storageFormat: 'rgba16float' | 'rgba32float' = 'rgba16float',
  ): GPUComputePipeline {
    const key = `gaussian:${storageFormat}`;
    const cached = this.computePipelines.get(key);
    if (cached) return cached;

    let shaderModule = this.gaussianShaderModules.get(storageFormat);
    if (!shaderModule) {
      shaderModule = this.device.createShaderModule({
        code: buildGaussianWgsl(storageFormat),
        label: `Gaussian WGSL Module (${storageFormat})`,
      });
      this.gaussianShaderModules.set(storageFormat, shaderModule);
    }

    const pipeline = this.device.createComputePipeline({
      label: `Gaussian Compute Pipeline (${storageFormat})`,
      layout: this.getFilterPipelineLayout(storageFormat),
      compute: { module: shaderModule, entryPoint: 'cs_gaussian' },
    });
    this.computePipelines.set(key, pipeline);
    return pipeline;
  }



  getLayerPipelineLayout(): GPUPipelineLayout {
    if (this.layerPipelineLayout) return this.layerPipelineLayout;

    this.layerPipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.getLayerBindGroupLayout(), this.getAdjustBindGroupLayout()],
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
    // (When LayerBlendMode gains Add, map it to ADD_BLEND here.)
    let blendState: GPUBlendState = PREMULTIPLIED_OVER_BLEND;
    if (isBottomOpaque) {
      blendState = REPLACE_BLEND;
    } else if (!isHardwareBlendable(blendMode)) {
      // Defensive: a class-B mode must never be drawn with a hardware blend
      // state (would silently degrade to Normal).
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
        {
          // Vmask texture (polygon-baked coverage), symmetric to the
          // layer layout's binding(4). Default white view when absent/analytic.
          binding: 5,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' },
        },
        // The bmask stack slots (retired bindings 6..8) are gone: the bmask
        // combine pass bakes ALL enabled records into ONE texture bound at
        // slot 4, so the blend pipeline needs no per-record slots.
      ],
    });
    return this.blendBindGroupLayout;
  }

  getBlendPipelineLayout(): GPUPipelineLayout {
    if (this.blendPipelineLayout) return this.blendPipelineLayout;

    this.blendPipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.getBlendBindGroupLayout(), this.getAdjustBindGroupLayout()],
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

  // ─── View pipeline (composited document → swapchain, camera-applied) ───

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
          // not FRAGMENT only (a FRAGMENT-only visibility would reject the pipeline
          // at creation).
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
   * Acquire the VIEW pipeline. Maps the composited document texture
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

  // ─── Vector spine SDF pipeline (procedural primitive → transient) ───

  getSdfShaderModule(): GPUShaderModule {
    if (this.sdfShaderModule) return this.sdfShaderModule;
    this.sdfShaderModule = this.device.createShaderModule({
      code: SDF_WGSL,
      label: 'SDF WGSL Module',
    });
    return this.sdfShaderModule;
  }

  /**
   * ZERO-TEXTURE group-0 layout: only the SDF uniform dynamic-offset buffer. No
   * sampler / source texture / mask binding — the SDF primitive is procedural.
   */
  getSdfBindGroupLayout(): GPUBindGroupLayout {
    if (this.sdfBindGroupLayout) return this.sdfBindGroupLayout;

    this.sdfBindGroupLayout = this.device.createBindGroupLayout({
      label: 'SDF Bind Group Layout',
      entries: [
        {
          binding: 0,
          // The SDF VERTEX stage reads `layer_size` (see sdf.ts vs_main), so this
          // binding must be visible to VERTEX too — not FRAGMENT only.
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: {
            type: 'uniform',
            hasDynamicOffset: true,
            minBindingSize: SDF_UNIFORM_BUFFER_SIZE,
          },
        },
      ],
    });
    return this.sdfBindGroupLayout;
  }

  getSdfPipelineLayout(): GPUPipelineLayout {
    if (this.sdfPipelineLayout) return this.sdfPipelineLayout;
    this.sdfPipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.getSdfBindGroupLayout()],
      label: 'SDF Pipeline Layout',
    });
    return this.sdfPipelineLayout;
  }

  /**
   * Acquire the SDF pipeline. Writes with REPLACE blend: the primitive draws into
   * its OWN transparent-cleared transient, then the output is consumed downstream as
   * a straight-alpha source — there is nothing to composite against at this stage.
   */
  getSdfPipeline(targetFormat: GPUTextureFormat = 'rgba16float'): GPURenderPipeline {
    const key = `sdf:${targetFormat}`;
    let pipeline = this.pipelines.get(key);
    if (pipeline) return pipeline;

    pipeline = this.device.createRenderPipeline({
      label: `SDF Pipeline (${key})`,
      layout: this.getSdfPipelineLayout(),
      vertex: {
        module: this.getSdfShaderModule(),
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
        module: this.getSdfShaderModule(),
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

  // ─── Vector spine STROKE pipelines (compute-extrude ribbon → paint) ───

  getStrokeExtrudeShaderModule(): GPUShaderModule {
    if (this.strokeExtrudeShaderModule) return this.strokeExtrudeShaderModule;
    this.strokeExtrudeShaderModule = this.device.createShaderModule({
      code: STROKE_EXTRUDE_WGSL,
      label: 'Stroke Extrude WGSL Module',
    });
    return this.strokeExtrudeShaderModule;
  }

  /**
   * Group-0 layout for `cs_extrude`: binding 0 = the trajectory `pts` (read-only
   * storage), binding 1 = the ribbon `verts` (read_write storage). No dynamic offset —
   * the StrokeRenderer binds each slot at an explicit offset from its own storage ring.
   */
  getStrokeExtrudeBindGroupLayout(): GPUBindGroupLayout {
    if (this.strokeExtrudeBindGroupLayout) return this.strokeExtrudeBindGroupLayout;
    this.strokeExtrudeBindGroupLayout = this.device.createBindGroupLayout({
      label: 'Stroke Extrude Bind Group Layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'read-only-storage' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'storage' },
        },
      ],
    });
    return this.strokeExtrudeBindGroupLayout;
  }

  getStrokeExtrudePipelineLayout(): GPUPipelineLayout {
    if (this.strokeExtrudePipelineLayout) return this.strokeExtrudePipelineLayout;
    this.strokeExtrudePipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.getStrokeExtrudeBindGroupLayout()],
      label: 'Stroke Extrude Pipeline Layout',
    });
    return this.strokeExtrudePipelineLayout;
  }

  /**
   * The ribbon-extrusion COMPUTE pipeline. Format-agnostic (writes a storage buffer,
   * not a storage texture), so a single cached instance serves every target format.
   */
  getStrokeExtrudePipeline(): GPUComputePipeline {
    if (this.strokeExtrudePipeline) return this.strokeExtrudePipeline;
    this.strokeExtrudePipeline = this.device.createComputePipeline({
      label: 'Stroke Extrude Compute Pipeline',
      layout: this.getStrokeExtrudePipelineLayout(),
      compute: { module: this.getStrokeExtrudeShaderModule(), entryPoint: 'cs_extrude' },
    });
    return this.strokeExtrudePipeline;
  }

  // ─── vmask polygon fill COMPUTE pipeline ───

  getVmaskShaderModule(): GPUShaderModule {
    if (this.vmaskShaderModule) return this.vmaskShaderModule;
    this.vmaskShaderModule = this.device.createShaderModule({
      code: VMASK_WGSL,
      label: 'Vmask WGSL Module',
    });
    return this.vmaskShaderModule;
  }

  /**
   * Group-0 layout for `cs_main`: binding 0 = `VmaskUniforms` (STATIC offset — a
   * fresh bind group is created per bake with the slot baked into `resource.offset`,
   * so dynamic offset would buy nothing and, combined with a `setBindGroup` dynamic
   * array, double-counted the slot offset → garbage read → transparent coverage),
   * binding 1 =
   * flattened edges of ALL sub-masks concatenated (read-only storage), binding 2 =
   * the sub-mask table (`[edge_start, edge_count, feather, inverted]` per intersected
   * sub-mask, read-only storage — mask multiplication), binding 3 = the `rgba8unorm` write-only
   * storage texture the coverage field is baked into.
   */
  getVmaskBindGroupLayout(): GPUBindGroupLayout {
    if (this.vmaskBindGroupLayout) return this.vmaskBindGroupLayout;
    this.vmaskBindGroupLayout = this.device.createBindGroupLayout({
      label: 'Vmask Bind Group Layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform', hasDynamicOffset: false, minBindingSize: VMASK_UNIFORM_SIZE },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'read-only-storage' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'read-only-storage' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' },
        },
      ],
    });
    return this.vmaskBindGroupLayout;
  }

  getVmaskPipelineLayout(): GPUPipelineLayout {
    if (this.vmaskPipelineLayout) return this.vmaskPipelineLayout;
    this.vmaskPipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.getVmaskBindGroupLayout()],
      label: 'Vmask Pipeline Layout',
    });
    return this.vmaskPipelineLayout;
  }

  /**
   * The polygon-coverage COMPUTE pipeline. Fixed `rgba8unorm` storage output, so a
   * single cached instance serves every mask size.
   */
  getVmaskPipeline(): GPUComputePipeline {
    if (this.vmaskPipeline) return this.vmaskPipeline;
    this.vmaskPipeline = this.device.createComputePipeline({
      label: 'Vmask Compute Pipeline',
      layout: this.getVmaskPipelineLayout(),
      compute: { module: this.getVmaskShaderModule(), entryPoint: 'cs_main' },
    });
    return this.vmaskPipeline;
  }

  getBmaskCombineShaderModule(): GPUShaderModule {
    if (this.bmaskCombineShaderModule) return this.bmaskCombineShaderModule;
    this.bmaskCombineShaderModule = this.device.createShaderModule({
      code: BMASK_COMBINE_WGSL,
      label: 'Bmask Combine WGSL Module',
    });
    return this.bmaskCombineShaderModule;
  }

  /**
   * Group-0 layout for the bmask combine compute pass: binding 0 = the 32B
   * `BmaskCombineUniforms` dynamic-free uniform, binding 1 = the record texture
   * this fold reads (textureLoad — no sampler), binding 2 = the running
   * accumulator (previous fold's output; the record texture placeholder on the
   * first fold), binding 3 = the `rgba8unorm` write-only storage texture the
   * fold writes (an intermediate ping/pong accumulator, or the final combined
   * output on the last fold).
   */
  getBmaskCombineBindGroupLayout(): GPUBindGroupLayout {
    if (this.bmaskCombineBindGroupLayout) return this.bmaskCombineBindGroupLayout;
    this.bmaskCombineBindGroupLayout = this.device.createBindGroupLayout({
      label: 'Bmask Combine Bind Group Layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform', hasDynamicOffset: false, minBindingSize: BMASK_COMBINE_UNIFORM_SIZE },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'float' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'float' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' },
        },
      ],
    });
    return this.bmaskCombineBindGroupLayout;
  }

  getBmaskCombinePipelineLayout(): GPUPipelineLayout {
    if (this.bmaskCombinePipelineLayout) return this.bmaskCombinePipelineLayout;
    this.bmaskCombinePipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.getBmaskCombineBindGroupLayout()],
      label: 'Bmask Combine Pipeline Layout',
    });
    return this.bmaskCombinePipelineLayout;
  }

  /**
   * The bmask-coverage COMPUTE pipeline (one fold per record + the final
   * two-family combine). Fixed `rgba8unorm` storage output, so a single cached
   * instance serves every layer/record count.
   */
  getBmaskCombinePipeline(): GPUComputePipeline {
    if (this.bmaskCombinePipeline) return this.bmaskCombinePipeline;
    this.bmaskCombinePipeline = this.device.createComputePipeline({
      label: 'Bmask Combine Compute Pipeline',
      layout: this.getBmaskCombinePipelineLayout(),
      compute: { module: this.getBmaskCombineShaderModule(), entryPoint: 'cs_main' },
    });
    return this.bmaskCombinePipeline;
  }

  getStrokePaintShaderModule(): GPUShaderModule {
    if (this.strokePaintShaderModule) return this.strokePaintShaderModule;
    this.strokePaintShaderModule = this.device.createShaderModule({
      code: STROKE_PAINT_WGSL,
      label: 'Stroke Paint WGSL Module',
    });
    return this.strokePaintShaderModule;
  }

  /**
   * Group-0 layout for the paint pass: the sole `StrokeUniforms` dynamic-offset buffer.
   * VERTEX visibility too — `vs_paint` reads `u.target_size` to map the trajectory into
   * NDC (a FRAGMENT-only visibility would reject the pipeline at creation, the classic
   * bindgroup-visibility trap).
   */
  getStrokeRenderBindGroupLayout(): GPUBindGroupLayout {
    if (this.strokeRenderBindGroupLayout) return this.strokeRenderBindGroupLayout;
    this.strokeRenderBindGroupLayout = this.device.createBindGroupLayout({
      label: 'Stroke Render Bind Group Layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: {
            type: 'uniform',
            hasDynamicOffset: true,
            minBindingSize: STROKE_UNIFORM_BUFFER_SIZE,
          },
        },
      ],
    });
    return this.strokeRenderBindGroupLayout;
  }

  getStrokeRenderPipelineLayout(): GPUPipelineLayout {
    if (this.strokeRenderPipelineLayout) return this.strokeRenderPipelineLayout;
    this.strokeRenderPipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.getStrokeRenderBindGroupLayout()],
      label: 'Stroke Render Pipeline Layout',
    });
    return this.strokeRenderPipelineLayout;
  }

  /**
   * Acquire the stroke PAINT pipeline. The vertex buffer is the `array<vec4<f32>>`
   * ribbon `cs_extrude` produced (arrayStride 16: pos @0, uv @8). MAX blend (coverage
   * union): per-segment quads overlap on the inner side of every turn, so a later
   * segment's AA edge must not REPLACE a neighbour's solid pixel with a transparent one
   * (the white-speckle artifact). The colour is constant across the stroke, so `max`
   * yields the union of soft-edge coverage without holes or double-darkening. Consumed
   * downstream as an ordinary straight-alpha source.
   */
  getStrokePipeline(targetFormat: GPUTextureFormat = 'rgba16float'): GPURenderPipeline {
    const key = `stroke:${targetFormat}`;
    const cached = this.pipelines.get(key);
    if (cached) return cached;

    const pipeline = this.device.createRenderPipeline({
      label: `Stroke Pipeline (${key})`,
      layout: this.getStrokeRenderPipelineLayout(),
      vertex: {
        module: this.getStrokePaintShaderModule(),
        entryPoint: 'vs_paint',
        buffers: [
          {
            arrayStride: 32,
            stepMode: 'vertex',
            attributes: [
              { format: 'float32x2', offset: 0, shaderLocation: 0 },  // pos
              { format: 'float32x2', offset: 8, shaderLocation: 1 },  // core_a
              { format: 'float32x2', offset: 16, shaderLocation: 2 }, // core_b
              { format: 'float32x2', offset: 24, shaderLocation: 3 }, // radii (ra, rb)
            ],
          },
        ],
      },
      fragment: {
        module: this.getStrokePaintShaderModule(),
        entryPoint: 'fs_paint',
        targets: [
          {
            format: targetFormat,
            blend: MAX_BLEND,
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
    this.defaultAdjustBuffer?.destroy();
    this.identityLutTexture?.destroy();
    this.identityLut3dTexture?.destroy();
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
    this.sdfShaderModule = null;
    this.sdfBindGroupLayout = null;
    this.sdfPipelineLayout = null;
    this.strokeExtrudeShaderModule = null;
    this.strokeExtrudeBindGroupLayout = null;
    this.strokeExtrudePipelineLayout = null;
    this.strokeExtrudePipeline = null;
    this.strokePaintShaderModule = null;
    this.strokeRenderBindGroupLayout = null;
    this.strokeRenderPipelineLayout = null;
    this.vmaskShaderModule = null;
    this.vmaskBindGroupLayout = null;
    this.vmaskPipelineLayout = null;
    this.vmaskPipeline = null;
    this.bmaskCombineShaderModule = null;
    this.bmaskCombineBindGroupLayout = null;
    this.bmaskCombinePipelineLayout = null;
    this.bmaskCombinePipeline = null;
    this.adjustBindGroupLayout = null;
    this.defaultAdjustBuffer = null;
    this.defaultAdjustBindGroup = null;
    this.lutSampler = null;
    this.identityLutTexture = null;
    this.identityLutView = null;
  }
}
