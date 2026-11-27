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
 *   • Compilation and memoization of `GPURenderPipeline` and `GPUComputePipeline`;
 *   • Unified caching of WGSL shader modules, bind group layouts, and pipeline layouts;
 *   • Shared unit quad vertex buffer, samplers, and dummy/identity textures.
 *
 * @module core/gpu/resources/PipelineCache
 */

import type { LayerBlendMode } from '@opengpex/editor/core/types';
import { LayerTexture } from './LayerTexture';
import { LAYER_WGSL, LAYER_UNIFORM_BUFFER_SIZE } from '../shaders/layer';
import { BLEND_WGSL, BLEND_UNIFORM_BUFFER_SIZE, isHardwareBlendable } from '../shaders/blend';
import { VIEW_WGSL, VIEW_WGSL_HDR, VIEW_UNIFORM_BUFFER_SIZE } from '../shaders/view';
import { SDF_WGSL, SDF_UNIFORM_BUFFER_SIZE } from '../shaders/sdf';
import { FACE_WGSL, FACE_UNIFORM_BUFFER_SIZE } from '../shaders/face';
import {
  STROKE_EXTRUDE_WGSL,
  STROKE_PAINT_WGSL,
  STROKE_UNIFORM_BUFFER_SIZE,
  STROKE_VERTEX_STRIDE,
} from '../shaders/stroke';
import { TEXT_PAINT_WGSL, TEXT_UNIFORM_BUFFER_SIZE, TEXT_INSTANCE_STRIDE } from '../shaders/text';
import { ADJUST_UNIFORM_BUFFER_SIZE } from '../shaders/adjust';
import { ADJUST_PRE_WGSL, ADJUST_PRE_UNIFORM_BUFFER_SIZE } from '../shaders/adjustPre';
import {
  buildGaussianWgsl,
  buildFeatherCombineWgsl,
  GAUSS_UNIFORM_BUFFER_SIZE,
} from '../shaders/gaussian';
import {
  buildEdtSeedWgsl,
  buildEdtJfaWgsl,
  EDT_SEED_UNIFORM_BUFFER_SIZE,
  EDT_JFA_UNIFORM_BUFFER_SIZE,
} from '../shaders/edtJfa';
import {
  buildStrokeComposeWgsl,
  STROKE_COMPOSE_UNIFORM_BUFFER_SIZE,
} from '../shaders/strokeCompose';
import {
  buildEffectMaskBakeWgsl,
  EFFECT_MASK_BAKE_UNIFORM_BUFFER_SIZE,
} from '../shaders/effectMaskBake';
import {
  buildEffectShadowComposeWgsl,
  EFFECT_SHADOW_UNIFORM_BUFFER_SIZE,
} from '../shaders/effectShadowCompose';
import {
  buildEffectShadowSpreadWgsl,
  EFFECT_SHADOW_SPREAD_UNIFORM_BUFFER_SIZE,
} from '../shaders/effectShadowSpread';
import {
  buildEffectOverlayComposeWgsl,
  EFFECT_OVERLAY_UNIFORM_BUFFER_SIZE,
} from '../shaders/effectOverlayCompose';
import {
  buildEffectGradientComposeWgsl,
  EFFECT_GRADIENT_UNIFORM_BUFFER_SIZE,
} from '../shaders/effectGradientCompose';
import {
  buildEffectInnerInvertWgsl,
  buildEffectInnerComposeWgsl,
  EFFECT_INNER_INVERT_UNIFORM_BUFFER_SIZE,
  EFFECT_INNER_UNIFORM_BUFFER_SIZE,
} from '../shaders/effectInnerCompose';
import { VMASK_WGSL, VMASK_UNIFORM_SIZE } from '../shaders/vmask';
import { BMASK_COMBINE_WGSL, BMASK_COMBINE_UNIFORM_SIZE } from '../shaders/bmaskCombine';
import { GPUBufferUsage, GPUTextureUsage, GPUShaderStage, GPUColorWrite } from '../constants';

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

/** Shared vertex layout for full-quad render passes (pos @0, uv @8, stride 16). */
const UNIT_QUAD_VERTEX_BUFFERS: GPUVertexBufferLayout[] = [
  {
    arrayStride: 16,
    stepMode: 'vertex',
    attributes: [
      { format: 'float32x2', offset: 0, shaderLocation: 0 },
      { format: 'float32x2', offset: 8, shaderLocation: 1 },
    ],
  },
];

/** Vertex layout for vector face fill/edge passes: [x, y, dist, kind] stride 16. */
const FACE_VERTEX_BUFFERS: GPUVertexBufferLayout[] = [
  {
    arrayStride: 16,
    stepMode: 'vertex',
    attributes: [
      { format: 'float32x2', offset: 0, shaderLocation: 0 },
      { format: 'float32', offset: 8, shaderLocation: 1 },
      { format: 'float32', offset: 12, shaderLocation: 2 },
    ],
  },
];

/** Vertex layout for compute-extruded stroke ribbons (stride 40). */
const STROKE_VERTEX_BUFFERS: GPUVertexBufferLayout[] = [
  {
    arrayStride: STROKE_VERTEX_STRIDE,
    stepMode: 'vertex',
    attributes: [
      { format: 'float32x2', offset: 0, shaderLocation: 0 },
      { format: 'float32x2', offset: 8, shaderLocation: 1 },
      { format: 'float32x2', offset: 16, shaderLocation: 2 },
      { format: 'float32x2', offset: 24, shaderLocation: 3 },
      { format: 'float32x2', offset: 32, shaderLocation: 4 },
    ],
  },
];

/** Vertex layout for instanced glyph quads over a coverage atlas. */
const TEXT_VERTEX_BUFFERS: GPUVertexBufferLayout[] = [
  {
    arrayStride: 16,
    stepMode: 'vertex',
    attributes: [
      { format: 'float32x2', offset: 0, shaderLocation: 0 },
      { format: 'float32x2', offset: 8, shaderLocation: 1 },
    ],
  },
  {
    arrayStride: TEXT_INSTANCE_STRIDE,
    stepMode: 'instance',
    attributes: [
      { format: 'float32x2', offset: 0, shaderLocation: 2 },
      { format: 'float32x2', offset: 8, shaderLocation: 3 },
      { format: 'float32x2', offset: 16, shaderLocation: 4 },
      { format: 'float32x2', offset: 24, shaderLocation: 5 },
    ],
  },
];

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

/**
 * Straight-alpha 'over' blend state: for targets holding non-premultiplied
 * color (the vector face renderer's output contract).
 */
export const STRAIGHT_OVER_BLEND: GPUBlendState = {
  color: {
    operation: 'add',
    srcFactor: 'src-alpha',
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
 * Coverage-union blend state (`max`): dst = max(src, dst) per channel.
 * Merges overlapping single-color AA rims without holes or double-darkening.
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

type ComputeInputSlot = 'sample' | 'float' | 'unfilterable-float' | 'uint' | 'sampler';

export class PipelineCache {
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly computePipelines = new Map<string, GPUComputePipeline>();
  private readonly shaderModules = new Map<string, GPUShaderModule>();
  private readonly bindGroupLayouts = new Map<string, GPUBindGroupLayout>();
  private readonly pipelineLayouts = new Map<string, GPUPipelineLayout>();

  private defaultAdjustBuffer: GPUBuffer | null = null;
  private defaultAdjustBindGroup: GPUBindGroup | null = null;
  private lutSampler: GPUSampler | null = null;
  private identityLutTexture: GPUTexture | null = null;
  private identityLutView: GPUTextureView | null = null;
  private defaultCoverageArrayTexture: GPUTexture | null = null;
  private defaultCoverageArrayView: GPUTextureView | null = null;
  private identityLut3dTexture: GPUTexture | null = null;
  private identityLut3dView: GPUTextureView | null = null;

  private quadVertexBuffer: GPUBuffer | null = null;
  private linearSampler: GPUSampler | null = null;
  private nearestSampler: GPUSampler | null = null;
  private defaultMaskTexture: GPUTexture | null = null;
  private defaultMaskView: GPUTextureView | null = null;
  private defaultSourceTexture: LayerTexture | null = null;
  private gainDummyTexture: GPUTexture | null = null;
  private gainDummyView: GPUTextureView | null = null;
  private strokeConfinementDummy: { texture: GPUTexture; view: GPUTextureView; sampler: GPUSampler } | null = null;

  constructor(readonly device: GPUDevice) {}

  protected getOrCreateShaderModule(key: string, label: string, code: string): GPUShaderModule {
    const cached = this.shaderModules.get(key);
    if (cached) return cached;
    const mod = this.device.createShaderModule({ code, label });
    this.shaderModules.set(key, mod);
    return mod;
  }

  protected getOrCreateBindGroupLayout(
    key: string,
    label: string,
    entries: GPUBindGroupLayoutEntry[],
  ): GPUBindGroupLayout {
    const cached = this.bindGroupLayouts.get(key);
    if (cached) return cached;
    const layout = this.device.createBindGroupLayout({ label, entries });
    this.bindGroupLayouts.set(key, layout);
    return layout;
  }

  protected getOrCreatePipelineLayout(
    key: string,
    label: string,
    bindGroupLayouts: GPUBindGroupLayout[],
  ): GPUPipelineLayout {
    const cached = this.pipelineLayouts.get(key);
    if (cached) return cached;
    const layout = this.device.createPipelineLayout({ label, bindGroupLayouts });
    this.pipelineLayouts.set(key, layout);
    return layout;
  }

  /**
   * Acquire or build a compute bind group layout following the standard
   * dynamic-uniform (binding 0) + input slots + write-only storageTexture pattern.
   */
  protected getOrCreateComputeLayout(
    key: string,
    label: string,
    spec: {
      readonly uniformSize: number;
      readonly storageFormat: 'rgba16float' | 'rgba32float';
      readonly storageTextureFormat?: GPUTextureFormat;
      readonly inputs: readonly ComputeInputSlot[];
    },
  ): GPUBindGroupLayout {
    const cached = this.bindGroupLayouts.get(key);
    if (cached) return cached;

    const workingSampleType: 'float' | 'unfilterable-float' =
      spec.storageFormat === 'rgba32float' ? 'unfilterable-float' : 'float';

    const entries: GPUBindGroupLayoutEntry[] = [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: 'uniform',
          hasDynamicOffset: true,
          minBindingSize: spec.uniformSize,
        },
      },
    ];

    let binding = 1;
    for (const slot of spec.inputs) {
      if (slot === 'sampler') {
        entries.push({
          binding: binding++,
          visibility: GPUShaderStage.COMPUTE,
          sampler: { type: 'filtering' },
        });
      } else {
        const sampleType: 'float' | 'unfilterable-float' | 'uint' =
          slot === 'sample' ? workingSampleType : slot;
        entries.push({
          binding: binding++,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType },
        });
      }
    }

    entries.push({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      storageTexture: {
        access: 'write-only',
        format: spec.storageTextureFormat ?? spec.storageFormat,
      },
    });

    return this.getOrCreateBindGroupLayout(key, label, entries);
  }

  /**
   * Generic acquire-or-build template for one-bind-group COMPUTE pipelines:
   * pipeline, layout, and WGSL module are each cached under explicit keys.
   */
  protected getOrCreateComputePipeline(spec: {
    readonly cacheKey: string;
    readonly label: string;
    readonly moduleKey: string;
    readonly wgsl: string;
    readonly entryPoint: string;
    readonly bindGroupLayout: GPUBindGroupLayout;
    readonly pipelineLayout?: GPUPipelineLayout;
  }): GPUComputePipeline {
    const cached = this.computePipelines.get(spec.cacheKey);
    if (cached) return cached;

    const shaderModule = this.getOrCreateShaderModule(
      spec.moduleKey,
      `${spec.label} WGSL Module`,
      spec.wgsl,
    );
    const layout =
      spec.pipelineLayout ??
      this.getOrCreatePipelineLayout(
        `compute:${spec.cacheKey}`,
        `${spec.label} Pipeline Layout`,
        [spec.bindGroupLayout],
      );

    const pipeline = this.device.createComputePipeline({
      label: `${spec.label} Compute Pipeline`,
      layout,
      compute: { module: shaderModule, entryPoint: spec.entryPoint },
    });
    this.computePipelines.set(spec.cacheKey, pipeline);
    return pipeline;
  }

  /**
   * Generic acquire-or-build template for single-target RENDER pipelines.
   * Defaults to the shared unit quad vertex layout and triangle-list topology.
   */
  protected getOrCreateRenderPipeline(spec: {
    readonly cacheKey: string;
    readonly label: string;
    readonly layout: GPUPipelineLayout;
    readonly module: GPUShaderModule;
    readonly vertexEntry: string;
    readonly fragmentEntry: string;
    readonly targetFormat: GPUTextureFormat;
    readonly blend: GPUBlendState;
    readonly buffers?: GPUVertexBufferLayout[];
  }): GPURenderPipeline {
    const cached = this.pipelines.get(spec.cacheKey);
    if (cached) return cached;

    const pipeline = this.device.createRenderPipeline({
      label: spec.label,
      layout: spec.layout,
      vertex: {
        module: spec.module,
        entryPoint: spec.vertexEntry,
        buffers: spec.buffers ?? UNIT_QUAD_VERTEX_BUFFERS,
      },
      fragment: {
        module: spec.module,
        entryPoint: spec.fragmentEntry,
        targets: [
          {
            format: spec.targetFormat,
            blend: spec.blend,
            writeMask: GPUColorWrite.ALL,
          },
        ],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none',
      },
    });
    this.pipelines.set(spec.cacheKey, pipeline);
    return pipeline;
  }

  // ──────────────────────────────────────────────────────────
  // Shared primitive buffers, samplers, and dummy/identity textures
  // ──────────────────────────────────────────────────────────

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

  /** Shared bilinear clamp-to-edge sampler. */
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

  /** Shared nearest-neighbour clamp-to-edge sampler. */
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

  /** Magnify (scale >= 1) selects nearest; minify (scale < 1) selects linear. */
  getSamplerForScale(scale: number): GPUSampler {
    return scale >= 1 ? this.getNearestSampler() : this.getLinearSampler();
  }

  /** 1x1 opaque-white dummy mask view for layers without an explicit mask. */
  getDefaultMaskView(): GPUTextureView {
    if (this.defaultMaskView) return this.defaultMaskView;

    const texture = this.device.createTexture({
      size: [1, 1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: 'Default 1x1 Dummy Mask',
    });
    this.device.queue.writeTexture(
      { texture },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4, rowsPerImage: 1 },
      [1, 1, 1],
    );

    this.defaultMaskTexture = texture;
    this.defaultMaskView = texture.createView({ label: 'Default 1x1 Dummy Mask View' });
    return this.defaultMaskView;
  }

  /** Shared 1x1 opaque-white source texture for declarative solid layers. */
  getSolidPixelTexture(): LayerTexture {
    if (this.defaultSourceTexture) return this.defaultSourceTexture;
    const texture = this.device.createTexture({
      size: [1, 1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: 'Default 1x1 White Source (solid binding formality)',
    });
    this.device.queue.writeTexture(
      { texture },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4, rowsPerImage: 1 },
      [1, 1, 1],
    );
    this.defaultSourceTexture = new LayerTexture({
      texture,
      width: 1,
      height: 1,
      allocatedWidth: 1,
      allocatedHeight: 1,
      format: 'rgba8unorm',
    });
    return this.defaultSourceTexture;
  }

  // ──────────────────────────────────────────────────────────
  // Group-1 adjustment layout & identity bindings
  // ──────────────────────────────────────────────────────────

  getAdjustBindGroupLayout(): GPUBindGroupLayout {
    return this.getOrCreateBindGroupLayout('adjust', 'Adjust Bind Group Layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: {
          type: 'uniform',
          hasDynamicOffset: true,
          minBindingSize: ADJUST_UNIFORM_BUFFER_SIZE,
        },
      },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '3d' } },
    ]);
  }

  /** Persistent identity adjustment bind group (stage_count = 0). */
  getDefaultAdjustBindGroup(): GPUBindGroup {
    if (this.defaultAdjustBindGroup) return this.defaultAdjustBindGroup;

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
        { binding: 3, resource: this.getAdjustCoverageArrayView() },
        { binding: 4, resource: this.getIdentityLut3dView() },
      ],
    });
    return this.defaultAdjustBindGroup;
  }

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

  getIdentityLutView(): GPUTextureView {
    if (this.identityLutView) return this.identityLutView;
    this.identityLutTexture = this.device.createTexture({
      size: [1, 1, 1],
      dimension: '2d',
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: 'Adjust Identity LUT Atlas',
    });
    this.identityLutView = this.identityLutTexture.createView({ dimension: '2d' });
    return this.identityLutView;
  }

  getAdjustCoverageArrayView(): GPUTextureView {
    if (this.defaultCoverageArrayView) return this.defaultCoverageArrayView;
    const texture = this.device.createTexture({
      size: [1, 1, 1],
      dimension: '2d',
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: 'Adjust Default Coverage Array',
    });
    this.device.queue.writeTexture(
      { texture },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4, rowsPerImage: 1 },
      [1, 1, 1],
    );
    this.defaultCoverageArrayTexture = texture;
    this.defaultCoverageArrayView = texture.createView({
      dimension: '2d-array',
      label: 'Adjust Default Coverage Array View',
    });
    return this.defaultCoverageArrayView;
  }

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
  // Compute pipelines & layouts
  // ──────────────────────────────────────────────────────────

  getFilterBindGroupLayout(
    storageFormat: 'rgba16float' | 'rgba32float' = 'rgba16float',
  ): GPUBindGroupLayout {
    return this.getOrCreateComputeLayout(
      `filter:${storageFormat}`,
      `Filter (Gaussian) Bind Group Layout [${storageFormat}]`,
      { uniformSize: GAUSS_UNIFORM_BUFFER_SIZE, storageFormat, inputs: ['sample'] },
    );
  }

  getFilterPipelineLayout(
    storageFormat: 'rgba16float' | 'rgba32float' = 'rgba16float',
  ): GPUPipelineLayout {
    return this.getOrCreatePipelineLayout(
      `filter:${storageFormat}`,
      `Filter Pipeline Layout [${storageFormat}]`,
      [this.getFilterBindGroupLayout(storageFormat)],
    );
  }

  getGaussianPipeline(
    storageFormat: 'rgba16float' | 'rgba32float' = 'rgba16float',
  ): GPUComputePipeline {
    return this.getOrCreateComputePipeline({
      cacheKey: `gaussian:${storageFormat}`,
      label: `Gaussian (${storageFormat})`,
      moduleKey: `gaussian:${storageFormat}`,
      wgsl: buildGaussianWgsl(storageFormat),
      entryPoint: 'cs_gaussian',
      bindGroupLayout: this.getFilterBindGroupLayout(storageFormat),
      pipelineLayout: this.getFilterPipelineLayout(storageFormat),
    });
  }

  getFeatherCombineBindGroupLayout(
    storageFormat: 'rgba16float' | 'rgba32float' = 'rgba16float',
  ): GPUBindGroupLayout {
    return this.getOrCreateComputeLayout(
      `feather-combine:${storageFormat}`,
      `Feather Combine Bind Group Layout [${storageFormat}]`,
      { uniformSize: GAUSS_UNIFORM_BUFFER_SIZE, storageFormat, inputs: ['sample', 'sample'] },
    );
  }

  getFeatherCombinePipelineLayout(
    storageFormat: 'rgba16float' | 'rgba32float' = 'rgba16float',
  ): GPUPipelineLayout {
    return this.getOrCreatePipelineLayout(
      `feather-combine:${storageFormat}`,
      `Feather Combine Pipeline Layout [${storageFormat}]`,
      [this.getFeatherCombineBindGroupLayout(storageFormat)],
    );
  }

  getFeatherCombinePipeline(
    storageFormat: 'rgba16float' | 'rgba32float' = 'rgba16float',
  ): GPUComputePipeline {
    return this.getOrCreateComputePipeline({
      cacheKey: `feather-combine:${storageFormat}`,
      label: `Feather Combine (${storageFormat})`,
      moduleKey: `feather-combine:${storageFormat}`,
      wgsl: buildFeatherCombineWgsl(storageFormat),
      entryPoint: 'cs_feather_combine',
      bindGroupLayout: this.getFeatherCombineBindGroupLayout(storageFormat),
      pipelineLayout: this.getFeatherCombinePipelineLayout(storageFormat),
    });
  }

  getEdtSeedBindGroupLayout(
    contentSampleType: 'float' | 'unfilterable-float' = 'float',
  ): GPUBindGroupLayout {
    return this.getOrCreateComputeLayout(
      `edt-seed:${contentSampleType}`,
      `EDT Seed Bind Group Layout [${contentSampleType}]`,
      {
        uniformSize: EDT_SEED_UNIFORM_BUFFER_SIZE,
        storageFormat: 'rgba16float',
        storageTextureFormat: 'rgba16uint',
        inputs: [contentSampleType],
      },
    );
  }

  getEdtSeedPipeline(
    contentSampleType: 'float' | 'unfilterable-float' = 'float',
  ): GPUComputePipeline {
    return this.getOrCreateComputePipeline({
      cacheKey: `edt-seed:${contentSampleType}`,
      label: `EDT Seed [${contentSampleType}]`,
      moduleKey: `edt-seed:${contentSampleType}`,
      wgsl: buildEdtSeedWgsl(),
      entryPoint: 'cs_edt_seed',
      bindGroupLayout: this.getEdtSeedBindGroupLayout(contentSampleType),
    });
  }

  getEdtJfaBindGroupLayout(): GPUBindGroupLayout {
    return this.getOrCreateComputeLayout('edt-jfa', 'EDT JFA Bind Group Layout', {
      uniformSize: EDT_JFA_UNIFORM_BUFFER_SIZE,
      storageFormat: 'rgba16float',
      storageTextureFormat: 'rgba16uint',
      inputs: ['uint'],
    });
  }

  getEdtJfaPipeline(): GPUComputePipeline {
    return this.getOrCreateComputePipeline({
      cacheKey: 'edt-jfa',
      label: 'EDT JFA',
      moduleKey: 'edt-jfa',
      wgsl: buildEdtJfaWgsl(),
      entryPoint: 'cs_edt_jfa',
      bindGroupLayout: this.getEdtJfaBindGroupLayout(),
    });
  }

  getStrokeComposeBindGroupLayout(
    storageFormat: 'rgba16float' | 'rgba32float' = 'rgba16float',
  ): GPUBindGroupLayout {
    return this.getOrCreateComputeLayout(
      `stroke-compose:${storageFormat}`,
      `Stroke Compose Bind Group Layout [${storageFormat}]`,
      { uniformSize: STROKE_COMPOSE_UNIFORM_BUFFER_SIZE, storageFormat, inputs: ['uint', 'sample'] },
    );
  }

  getStrokeComposePipeline(
    storageFormat: 'rgba16float' | 'rgba32float' = 'rgba16float',
  ): GPUComputePipeline {
    return this.getOrCreateComputePipeline({
      cacheKey: `stroke-compose:${storageFormat}`,
      label: `Stroke Compose [${storageFormat}]`,
      moduleKey: `stroke-compose:${storageFormat}`,
      wgsl: buildStrokeComposeWgsl(storageFormat),
      entryPoint: 'cs_stroke_compose',
      bindGroupLayout: this.getStrokeComposeBindGroupLayout(storageFormat),
    });
  }

  getEffectMaskBakeBindGroupLayout(
    storageFormat: 'rgba16float' | 'rgba32float' = 'rgba16float',
  ): GPUBindGroupLayout {
    return this.getOrCreateComputeLayout(
      `effect-mask-bake:${storageFormat}`,
      `Effect Mask Bake Bind Group Layout [${storageFormat}]`,
      {
        uniformSize: EFFECT_MASK_BAKE_UNIFORM_BUFFER_SIZE,
        storageFormat,
        inputs: ['sample', 'float', 'float', 'sampler'],
      },
    );
  }

  getEffectMaskBakePipeline(
    storageFormat: 'rgba16float' | 'rgba32float' = 'rgba16float',
  ): GPUComputePipeline {
    return this.getOrCreateComputePipeline({
      cacheKey: `effect-mask-bake:${storageFormat}`,
      label: `Effect Mask Bake [${storageFormat}]`,
      moduleKey: `effect-mask-bake:${storageFormat}`,
      wgsl: buildEffectMaskBakeWgsl(storageFormat),
      entryPoint: 'cs_effect_mask_bake',
      bindGroupLayout: this.getEffectMaskBakeBindGroupLayout(storageFormat),
    });
  }

  getEffectShadowBindGroupLayout(
    storageFormat: 'rgba16float' | 'rgba32float' = 'rgba16float',
  ): GPUBindGroupLayout {
    return this.getOrCreateComputeLayout(
      `effect-shadow:${storageFormat}`,
      `Effect Shadow Bind Group Layout [${storageFormat}]`,
      { uniformSize: EFFECT_SHADOW_UNIFORM_BUFFER_SIZE, storageFormat, inputs: ['sample', 'sample'] },
    );
  }

  getEffectShadowPipeline(
    storageFormat: 'rgba16float' | 'rgba32float' = 'rgba16float',
  ): GPUComputePipeline {
    return this.getOrCreateComputePipeline({
      cacheKey: `effect-shadow:${storageFormat}`,
      label: `Effect Shadow [${storageFormat}]`,
      moduleKey: `effect-shadow:${storageFormat}`,
      wgsl: buildEffectShadowComposeWgsl(storageFormat),
      entryPoint: 'cs_effect_shadow_compose',
      bindGroupLayout: this.getEffectShadowBindGroupLayout(storageFormat),
    });
  }

  getEffectShadowSpreadBindGroupLayout(
    storageFormat: 'rgba16float' | 'rgba32float' = 'rgba16float',
  ): GPUBindGroupLayout {
    return this.getOrCreateComputeLayout(
      `effect-shadow-spread:${storageFormat}`,
      `Effect Shadow Spread Bind Group Layout [${storageFormat}]`,
      {
        uniformSize: EFFECT_SHADOW_SPREAD_UNIFORM_BUFFER_SIZE,
        storageFormat,
        inputs: ['uint', 'sample'],
      },
    );
  }

  getEffectShadowSpreadPipeline(
    storageFormat: 'rgba16float' | 'rgba32float' = 'rgba16float',
  ): GPUComputePipeline {
    return this.getOrCreateComputePipeline({
      cacheKey: `effect-shadow-spread:${storageFormat}`,
      label: `Effect Shadow Spread [${storageFormat}]`,
      moduleKey: `effect-shadow-spread:${storageFormat}`,
      wgsl: buildEffectShadowSpreadWgsl(storageFormat),
      entryPoint: 'cs_effect_shadow_spread',
      bindGroupLayout: this.getEffectShadowSpreadBindGroupLayout(storageFormat),
    });
  }

  getEffectOverlayBindGroupLayout(
    storageFormat: 'rgba16float' | 'rgba32float' = 'rgba16float',
  ): GPUBindGroupLayout {
    return this.getOrCreateComputeLayout(
      `effect-overlay:${storageFormat}`,
      `Effect Overlay Bind Group Layout [${storageFormat}]`,
      { uniformSize: EFFECT_OVERLAY_UNIFORM_BUFFER_SIZE, storageFormat, inputs: ['sample'] },
    );
  }

  getEffectOverlayPipeline(
    storageFormat: 'rgba16float' | 'rgba32float' = 'rgba16float',
  ): GPUComputePipeline {
    return this.getOrCreateComputePipeline({
      cacheKey: `effect-overlay:${storageFormat}`,
      label: `Effect Overlay [${storageFormat}]`,
      moduleKey: `effect-overlay:${storageFormat}`,
      wgsl: buildEffectOverlayComposeWgsl(storageFormat),
      entryPoint: 'cs_effect_overlay_compose',
      bindGroupLayout: this.getEffectOverlayBindGroupLayout(storageFormat),
    });
  }

  getEffectGradientBindGroupLayout(
    storageFormat: 'rgba16float' | 'rgba32float' = 'rgba16float',
  ): GPUBindGroupLayout {
    return this.getOrCreateComputeLayout(
      `effect-gradient:${storageFormat}`,
      `Effect Gradient Bind Group Layout [${storageFormat}]`,
      { uniformSize: EFFECT_GRADIENT_UNIFORM_BUFFER_SIZE, storageFormat, inputs: ['sample'] },
    );
  }

  getEffectGradientPipeline(
    storageFormat: 'rgba16float' | 'rgba32float' = 'rgba16float',
  ): GPUComputePipeline {
    return this.getOrCreateComputePipeline({
      cacheKey: `effect-gradient:${storageFormat}`,
      label: `Effect Gradient [${storageFormat}]`,
      moduleKey: `effect-gradient:${storageFormat}`,
      wgsl: buildEffectGradientComposeWgsl(storageFormat),
      entryPoint: 'cs_effect_gradient_compose',
      bindGroupLayout: this.getEffectGradientBindGroupLayout(storageFormat),
    });
  }

  getEffectInnerInvertBindGroupLayout(
    storageFormat: 'rgba16float' | 'rgba32float' = 'rgba16float',
  ): GPUBindGroupLayout {
    return this.getOrCreateComputeLayout(
      `effect-inner-invert:${storageFormat}`,
      `Effect Inner Invert Bind Group Layout [${storageFormat}]`,
      { uniformSize: EFFECT_INNER_INVERT_UNIFORM_BUFFER_SIZE, storageFormat, inputs: ['sample'] },
    );
  }

  getEffectInnerInvertPipeline(
    storageFormat: 'rgba16float' | 'rgba32float' = 'rgba16float',
  ): GPUComputePipeline {
    return this.getOrCreateComputePipeline({
      cacheKey: `effect-inner-invert:${storageFormat}`,
      label: `Effect Inner Invert [${storageFormat}]`,
      moduleKey: `effect-inner-invert:${storageFormat}`,
      wgsl: buildEffectInnerInvertWgsl(storageFormat),
      entryPoint: 'cs_effect_inner_invert',
      bindGroupLayout: this.getEffectInnerInvertBindGroupLayout(storageFormat),
    });
  }

  getEffectInnerComposeBindGroupLayout(
    storageFormat: 'rgba16float' | 'rgba32float' = 'rgba16float',
  ): GPUBindGroupLayout {
    return this.getOrCreateComputeLayout(
      `effect-inner-compose:${storageFormat}`,
      `Effect Inner Compose Bind Group Layout [${storageFormat}]`,
      {
        uniformSize: EFFECT_INNER_UNIFORM_BUFFER_SIZE,
        storageFormat,
        inputs: ['sample', 'sample', 'sample'],
      },
    );
  }

  getEffectInnerComposePipeline(
    storageFormat: 'rgba16float' | 'rgba32float' = 'rgba16float',
  ): GPUComputePipeline {
    return this.getOrCreateComputePipeline({
      cacheKey: `effect-inner-compose:${storageFormat}`,
      label: `Effect Inner Compose [${storageFormat}]`,
      moduleKey: `effect-inner-compose:${storageFormat}`,
      wgsl: buildEffectInnerComposeWgsl(storageFormat),
      entryPoint: 'cs_effect_inner_compose',
      bindGroupLayout: this.getEffectInnerComposeBindGroupLayout(storageFormat),
    });
  }

  getStrokeExtrudeShaderModule(): GPUShaderModule {
    return this.getOrCreateShaderModule('stroke-extrude', 'Stroke Extrude WGSL Module', STROKE_EXTRUDE_WGSL);
  }

  getStrokeExtrudeBindGroupLayout(): GPUBindGroupLayout {
    return this.getOrCreateBindGroupLayout('stroke-extrude', 'Stroke Extrude Bind Group Layout', [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ]);
  }

  getStrokeExtrudePipelineLayout(): GPUPipelineLayout {
    return this.getOrCreatePipelineLayout(
      'stroke-extrude',
      'Stroke Extrude Pipeline Layout',
      [this.getStrokeExtrudeBindGroupLayout()],
    );
  }

  getStrokeExtrudePipeline(): GPUComputePipeline {
    return this.getOrCreateComputePipeline({
      cacheKey: 'stroke-extrude',
      label: 'Stroke Extrude',
      moduleKey: 'stroke-extrude',
      wgsl: STROKE_EXTRUDE_WGSL,
      entryPoint: 'cs_extrude',
      bindGroupLayout: this.getStrokeExtrudeBindGroupLayout(),
      pipelineLayout: this.getStrokeExtrudePipelineLayout(),
    });
  }

  getVmaskShaderModule(): GPUShaderModule {
    return this.getOrCreateShaderModule('vmask', 'Vmask WGSL Module', VMASK_WGSL);
  }

  getVmaskBindGroupLayout(): GPUBindGroupLayout {
    return this.getOrCreateBindGroupLayout('vmask', 'Vmask Bind Group Layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform', hasDynamicOffset: false, minBindingSize: VMASK_UNIFORM_SIZE },
      },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      {
        binding: 3,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' },
      },
    ]);
  }

  getVmaskPipelineLayout(): GPUPipelineLayout {
    return this.getOrCreatePipelineLayout('vmask', 'Vmask Pipeline Layout', [this.getVmaskBindGroupLayout()]);
  }

  getVmaskPipeline(): GPUComputePipeline {
    return this.getOrCreateComputePipeline({
      cacheKey: 'vmask',
      label: 'Vmask',
      moduleKey: 'vmask',
      wgsl: VMASK_WGSL,
      entryPoint: 'cs_main',
      bindGroupLayout: this.getVmaskBindGroupLayout(),
      pipelineLayout: this.getVmaskPipelineLayout(),
    });
  }

  getBmaskCombineShaderModule(): GPUShaderModule {
    return this.getOrCreateShaderModule('bmask-combine', 'Bmask Combine WGSL Module', BMASK_COMBINE_WGSL);
  }

  getBmaskCombineBindGroupLayout(): GPUBindGroupLayout {
    return this.getOrCreateBindGroupLayout('bmask-combine', 'Bmask Combine Bind Group Layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform', hasDynamicOffset: false, minBindingSize: BMASK_COMBINE_UNIFORM_SIZE },
      },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
      {
        binding: 3,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' },
      },
    ]);
  }

  getBmaskCombinePipelineLayout(): GPUPipelineLayout {
    return this.getOrCreatePipelineLayout(
      'bmask-combine',
      'Bmask Combine Pipeline Layout',
      [this.getBmaskCombineBindGroupLayout()],
    );
  }

  getBmaskCombinePipeline(): GPUComputePipeline {
    return this.getOrCreateComputePipeline({
      cacheKey: 'bmask-combine',
      label: 'Bmask Combine',
      moduleKey: 'bmask-combine',
      wgsl: BMASK_COMBINE_WGSL,
      entryPoint: 'cs_main',
      bindGroupLayout: this.getBmaskCombineBindGroupLayout(),
      pipelineLayout: this.getBmaskCombinePipelineLayout(),
    });
  }

  // ──────────────────────────────────────────────────────────
  // Render pipelines & layouts
  // ──────────────────────────────────────────────────────────

  getAdjustPreBindGroupLayout(): GPUBindGroupLayout {
    return this.getOrCreateBindGroupLayout('adjustPre', 'Adjust Pre Bind Group Layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: {
          type: 'uniform',
          hasDynamicOffset: true,
          minBindingSize: ADJUST_PRE_UNIFORM_BUFFER_SIZE,
        },
      },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    ]);
  }

  getAdjustPrePipelineLayout(): GPUPipelineLayout {
    return this.getOrCreatePipelineLayout('adjustPre', 'Adjust Pre Pipeline Layout', [
      this.getAdjustPreBindGroupLayout(),
      this.getAdjustBindGroupLayout(),
    ]);
  }

  getAdjustPreShaderModule(): GPUShaderModule {
    return this.getOrCreateShaderModule('adjustPre', 'Adjust Pre WGSL Module', ADJUST_PRE_WGSL);
  }

  getAdjustPrePipeline(targetFormat: GPUTextureFormat = 'rgba16float'): GPURenderPipeline {
    return this.getOrCreateRenderPipeline({
      cacheKey: `adjustPre:${targetFormat}`,
      label: `Adjust Pre Pipeline (${targetFormat})`,
      layout: this.getAdjustPrePipelineLayout(),
      module: this.getAdjustPreShaderModule(),
      vertexEntry: 'vs_adjust_pre',
      fragmentEntry: 'fs_adjust_pre',
      targetFormat,
      blend: REPLACE_BLEND,
    });
  }

  getLayerShaderModule(): GPUShaderModule {
    return this.getOrCreateShaderModule('layer', 'Layer WGSL Module', LAYER_WGSL);
  }

  getLayerBindGroupLayout(): GPUBindGroupLayout {
    return this.getOrCreateBindGroupLayout('layer', 'Layer Bind Group Layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: {
          type: 'uniform',
          hasDynamicOffset: true,
          minBindingSize: LAYER_UNIFORM_BUFFER_SIZE,
        },
      },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    ]);
  }

  getLayerPipelineLayout(): GPUPipelineLayout {
    return this.getOrCreatePipelineLayout('layer', 'Layer Pipeline Layout', [
      this.getLayerBindGroupLayout(),
      this.getAdjustBindGroupLayout(),
    ]);
  }

  getLayerPipeline(
    blendMode: LayerBlendMode = 'source-over',
    targetFormat: GPUTextureFormat = 'rgba16float',
    isBottomOpaque = false,
  ): GPURenderPipeline {
    const key = `layer:${blendMode}:${targetFormat}:${isBottomOpaque ? 'opaque' : 'blend'}`;
    const cached = this.pipelines.get(key);
    if (cached) return cached;

    let blendState: GPUBlendState = PREMULTIPLIED_OVER_BLEND;
    if (isBottomOpaque) {
      blendState = REPLACE_BLEND;
    } else if (!isHardwareBlendable(blendMode)) {
      throw new Error(
        `getLayerPipeline: blend mode '${blendMode}' is not hardware-blendable; ` +
          `it must be composited via BlendPass (ping-pong), not the layer pipeline.`,
      );
    }

    return this.getOrCreateRenderPipeline({
      cacheKey: key,
      label: `Layer Pipeline (${key})`,
      layout: this.getLayerPipelineLayout(),
      module: this.getLayerShaderModule(),
      vertexEntry: 'vs_main',
      fragmentEntry: 'fs_main',
      targetFormat,
      blend: blendState,
    });
  }

  getBlendShaderModule(): GPUShaderModule {
    return this.getOrCreateShaderModule('blend', 'Blend WGSL Module', BLEND_WGSL);
  }

  getBlendBindGroupLayout(): GPUBindGroupLayout {
    return this.getOrCreateBindGroupLayout('blend', 'Blend Bind Group Layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: {
          type: 'uniform',
          hasDynamicOffset: true,
          minBindingSize: BLEND_UNIFORM_BUFFER_SIZE,
        },
      },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    ]);
  }

  getBlendPipelineLayout(): GPUPipelineLayout {
    return this.getOrCreatePipelineLayout('blend', 'Blend Pipeline Layout', [
      this.getBlendBindGroupLayout(),
      this.getAdjustBindGroupLayout(),
    ]);
  }

  getBlendPipeline(targetFormat: GPUTextureFormat = 'rgba16float'): GPURenderPipeline {
    const key = `blend:${targetFormat}`;
    return this.getOrCreateRenderPipeline({
      cacheKey: key,
      label: `Blend Pipeline (${key})`,
      layout: this.getBlendPipelineLayout(),
      module: this.getBlendShaderModule(),
      vertexEntry: 'vs_main',
      fragmentEntry: 'fs_main',
      targetFormat,
      blend: REPLACE_BLEND,
    });
  }

  getViewShaderModule(hdr: boolean): GPUShaderModule {
    return hdr
      ? this.getOrCreateShaderModule('view:hdr', 'View HDR WGSL Module', VIEW_WGSL_HDR)
      : this.getOrCreateShaderModule('view:sdr', 'View WGSL Module', VIEW_WGSL);
  }

  getViewBindGroupLayout(): GPUBindGroupLayout {
    return this.getOrCreateBindGroupLayout('view', 'View Bind Group Layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: {
          type: 'uniform',
          hasDynamicOffset: true,
          minBindingSize: VIEW_UNIFORM_BUFFER_SIZE,
        },
      },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    ]);
  }

  getGainDummyView(): GPUTextureView {
    if (this.gainDummyView) return this.gainDummyView;

    const texture = this.device.createTexture({
      label: 'View Gain Dummy (1x1)',
      size: { width: 1, height: 1 },
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture },
      new Uint8Array([0]),
      { bytesPerRow: 1 },
      { width: 1, height: 1 },
    );
    this.gainDummyTexture = texture;
    this.gainDummyView = texture.createView({ label: 'View Gain Dummy View' });
    return this.gainDummyView;
  }

  getViewPipelineLayout(): GPUPipelineLayout {
    return this.getOrCreatePipelineLayout('view', 'View Pipeline Layout', [this.getViewBindGroupLayout()]);
  }

  getViewPipeline(targetFormat: GPUTextureFormat = 'bgra8unorm', hdr = false): GPURenderPipeline {
    const key = `view:${targetFormat}:${hdr ? 'hdr' : 'sdr'}`;
    return this.getOrCreateRenderPipeline({
      cacheKey: key,
      label: `View Pipeline (${key})`,
      layout: this.getViewPipelineLayout(),
      module: this.getViewShaderModule(hdr),
      vertexEntry: 'vs_main',
      fragmentEntry: 'fs_main',
      targetFormat,
      blend: REPLACE_BLEND,
    });
  }

  getSdfShaderModule(): GPUShaderModule {
    return this.getOrCreateShaderModule('sdf', 'SDF WGSL Module', SDF_WGSL);
  }

  getSdfBindGroupLayout(): GPUBindGroupLayout {
    return this.getOrCreateBindGroupLayout('sdf', 'SDF Bind Group Layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: {
          type: 'uniform',
          hasDynamicOffset: true,
          minBindingSize: SDF_UNIFORM_BUFFER_SIZE,
        },
      },
    ]);
  }

  getSdfPipelineLayout(): GPUPipelineLayout {
    return this.getOrCreatePipelineLayout('sdf', 'SDF Pipeline Layout', [this.getSdfBindGroupLayout()]);
  }

  getSdfPipeline(targetFormat: GPUTextureFormat = 'rgba16float'): GPURenderPipeline {
    const key = `sdf:${targetFormat}`;
    return this.getOrCreateRenderPipeline({
      cacheKey: key,
      label: `SDF Pipeline (${key})`,
      layout: this.getSdfPipelineLayout(),
      module: this.getSdfShaderModule(),
      vertexEntry: 'vs_main',
      fragmentEntry: 'fs_main',
      targetFormat,
      blend: REPLACE_BLEND,
    });
  }

  getFaceShaderModule(): GPUShaderModule {
    return this.getOrCreateShaderModule('face', 'Face WGSL Module', FACE_WGSL);
  }

  getFaceBindGroupLayout(): GPUBindGroupLayout {
    return this.getOrCreateBindGroupLayout('face', 'Face Bind Group Layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: {
          type: 'uniform',
          hasDynamicOffset: true,
          minBindingSize: FACE_UNIFORM_BUFFER_SIZE,
        },
      },
    ]);
  }

  getFacePipelineLayout(): GPUPipelineLayout {
    return this.getOrCreatePipelineLayout('face', 'Face Pipeline Layout', [this.getFaceBindGroupLayout()]);
  }

  getFaceFillPipeline(targetFormat: GPUTextureFormat = 'rgba16float'): GPURenderPipeline {
    const key = `face-fill:${targetFormat}`;
    return this.getOrCreateRenderPipeline({
      cacheKey: key,
      label: `Face Fill Pipeline (${key})`,
      layout: this.getFacePipelineLayout(),
      module: this.getFaceShaderModule(),
      vertexEntry: 'vs_face',
      fragmentEntry: 'fs_face',
      targetFormat,
      blend: REPLACE_BLEND,
      buffers: FACE_VERTEX_BUFFERS,
    });
  }

  getFaceEdgePipeline(targetFormat: GPUTextureFormat = 'rgba16float'): GPURenderPipeline {
    const key = `face-edge:${targetFormat}`;
    return this.getOrCreateRenderPipeline({
      cacheKey: key,
      label: `Face Edge Pipeline (${key})`,
      layout: this.getFacePipelineLayout(),
      module: this.getFaceShaderModule(),
      vertexEntry: 'vs_face',
      fragmentEntry: 'fs_face',
      targetFormat,
      blend: STRAIGHT_OVER_BLEND,
      buffers: FACE_VERTEX_BUFFERS,
    });
  }

  getStrokePaintShaderModule(): GPUShaderModule {
    return this.getOrCreateShaderModule('stroke-paint', 'Stroke Paint WGSL Module', STROKE_PAINT_WGSL);
  }

  getStrokeRenderBindGroupLayout(): GPUBindGroupLayout {
    return this.getOrCreateBindGroupLayout('stroke-render', 'Stroke Render Bind Group Layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: {
          type: 'uniform',
          hasDynamicOffset: true,
          minBindingSize: STROKE_UNIFORM_BUFFER_SIZE,
        },
      },
    ]);
  }

  getStrokeRenderPipelineLayout(): GPUPipelineLayout {
    return this.getOrCreatePipelineLayout('stroke-render', 'Stroke Render Pipeline Layout', [
      this.getStrokeRenderBindGroupLayout(),
      this.getStrokeConfinementBindGroupLayout(),
    ]);
  }

  getStrokeConfinementBindGroupLayout(): GPUBindGroupLayout {
    return this.getOrCreateBindGroupLayout('stroke-confinement', 'Stroke Confinement Bind Group Layout', [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ]);
  }

  getStrokeConfinementBindGroup(coverageView?: GPUTextureView): GPUBindGroup {
    if (!coverageView) {
      if (!this.strokeConfinementDummy) {
        const texture = this.device.createTexture({
          size: [1, 1, 1],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
          label: 'Stroke Confinement Dummy',
        });
        this.device.queue.writeTexture(
          { texture },
          new Uint8Array([255, 255, 255, 255]),
          { bytesPerRow: 4, rowsPerImage: 1 },
          [1, 1, 1],
        );
        this.strokeConfinementDummy = {
          texture,
          view: texture.createView(),
          sampler: this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
        };
      }
      coverageView = this.strokeConfinementDummy.view;
    }
    return this.device.createBindGroup({
      layout: this.getStrokeConfinementBindGroupLayout(),
      label: 'Stroke Confinement BindGroup',
      entries: [
        { binding: 0, resource: coverageView },
        { binding: 1, resource: this.getStrokeConfinementSampler() },
      ],
    });
  }

  private getStrokeConfinementSampler(): GPUSampler {
    if (!this.strokeConfinementDummy) {
      this.getStrokeConfinementBindGroup(undefined);
    }
    return this.strokeConfinementDummy!.sampler;
  }

  getStrokePipeline(targetFormat: GPUTextureFormat = 'rgba16float'): GPURenderPipeline {
    const key = `stroke:${targetFormat}`;
    return this.getOrCreateRenderPipeline({
      cacheKey: key,
      label: `Stroke Pipeline (${key})`,
      layout: this.getStrokeRenderPipelineLayout(),
      module: this.getStrokePaintShaderModule(),
      vertexEntry: 'vs_paint',
      fragmentEntry: 'fs_paint',
      targetFormat,
      blend: MAX_BLEND,
      buffers: STROKE_VERTEX_BUFFERS,
    });
  }

  getTextPaintShaderModule(): GPUShaderModule {
    return this.getOrCreateShaderModule('text-paint', 'Text Paint WGSL Module', TEXT_PAINT_WGSL);
  }

  getTextBindGroupLayout(): GPUBindGroupLayout {
    return this.getOrCreateBindGroupLayout('text', 'Text Bind Group Layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: {
          type: 'uniform',
          hasDynamicOffset: true,
          minBindingSize: TEXT_UNIFORM_BUFFER_SIZE,
        },
      },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ]);
  }

  getTextPipelineLayout(): GPUPipelineLayout {
    return this.getOrCreatePipelineLayout('text', 'Text Pipeline Layout', [this.getTextBindGroupLayout()]);
  }

  getTextPipeline(targetFormat: GPUTextureFormat = 'rgba16float'): GPURenderPipeline {
    const key = `text:${targetFormat}`;
    return this.getOrCreateRenderPipeline({
      cacheKey: key,
      label: `Text Pipeline (${key})`,
      layout: this.getTextPipelineLayout(),
      module: this.getTextPaintShaderModule(),
      vertexEntry: 'vs_text_instanced',
      fragmentEntry: 'fs_text',
      targetFormat,
      blend: MAX_BLEND,
      buffers: TEXT_VERTEX_BUFFERS,
    });
  }

  destroy(): void {
    this.pipelines.clear();
    this.computePipelines.clear();
    this.shaderModules.clear();
    this.bindGroupLayouts.clear();
    this.pipelineLayouts.clear();

    this.quadVertexBuffer?.destroy();
    this.defaultMaskTexture?.destroy();
    this.defaultSourceTexture?.destroy();
    this.defaultAdjustBuffer?.destroy();
    this.identityLutTexture?.destroy();
    this.identityLut3dTexture?.destroy();
    this.defaultCoverageArrayTexture?.destroy();
    this.gainDummyTexture?.destroy();
    this.strokeConfinementDummy?.texture.destroy();

    this.quadVertexBuffer = null;
    this.linearSampler = null;
    this.nearestSampler = null;
    this.defaultMaskTexture = null;
    this.defaultMaskView = null;
    this.defaultSourceTexture = null;
    this.defaultAdjustBuffer = null;
    this.defaultAdjustBindGroup = null;
    this.lutSampler = null;
    this.identityLutTexture = null;
    this.identityLutView = null;
    this.defaultCoverageArrayTexture = null;
    this.defaultCoverageArrayView = null;
    this.identityLut3dTexture = null;
    this.identityLut3dView = null;
    this.gainDummyTexture = null;
    this.gainDummyView = null;
    this.strokeConfinementDummy = null;
  }
}
