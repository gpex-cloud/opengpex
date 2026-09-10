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
 * webgpu.d.ts — Minimal ambient WebGPU type declarations.
 *
 * WHY THIS FILE EXISTS:
 * TypeScript 5.9's bundled `lib.dom.d.ts` does NOT ship WebGPU interfaces
 * (`GPUDevice` / `GPUAdapter` / `GPUCanvasContext` / `navigator.gpu` are all
 * absent — only an unrelated `GPUError` doc-comment mentions the name). Under
 * `strict: true` the engine cannot compile without them.
 *
 * Rather than pull in the `@webgpu/types` dependency, v2 declares the narrow
 * subset the engine actually touches. This keeps the dependency graph clean and
 * makes the exact API surface we rely on explicit and auditable.
 *
 * SCOPE POLICY (spec §13.3 "stub-first"):
 *   Only members reachable from the current stubs and phase implementations are
 *   declared. Phase 1–2 adds render pipelines, bind groups, textures, buffers
 *   and render pass encoders. Phase 3 will add compute pipelines, and Phase 4
 *   will add Readback buffer mappings.
 *
 * @module core/gpu/webgpu
 */

// ─── Enums (string unions — WebGPU uses plain strings) ───

type GPUFeatureName = string;
type GPUTextureFormat = string;
type GPUPowerPreference = 'low-power' | 'high-performance';
type GPUCanvasAlphaMode = 'opaque' | 'premultiplied';
type GPUCanvasToneMappingMode = 'standard' | 'extended';
type GPUPredefinedColorSpace = 'srgb' | 'display-p3';
type GPUTextureDimension = '1d' | '2d' | '3d';
type GPUTextureViewDimension = '1d' | '2d' | '2d-array' | 'cube' | 'cube-array' | '3d';
type GPUTextureAspect = 'all' | 'stencil-only' | 'depth-only';
type GPUAddressMode = 'clamp-to-edge' | 'repeat' | 'mirror-repeat';
type GPUFilterMode = 'nearest' | 'linear';
type GPUMipmapFilterMode = 'nearest' | 'linear';
type GPUCompareFunction = 'never' | 'less' | 'equal' | 'less-equal' | 'greater' | 'not-equal' | 'greater-equal' | 'always';
type GPUBlendFactor =
  | 'zero'
  | 'one'
  | 'src'
  | 'one-minus-src'
  | 'src-alpha'
  | 'one-minus-src-alpha'
  | 'dst'
  | 'one-minus-dst'
  | 'dst-alpha'
  | 'one-minus-dst-alpha'
  | 'src-alpha-saturated'
  | 'constant'
  | 'one-minus-constant';
type GPUBlendOperation = 'add' | 'subtract' | 'reverse-subtract' | 'min' | 'max';
type GPUVertexFormat = 'float32x2' | 'float32x3' | 'float32x4' | 'float32';
type GPUPrimitiveTopology = 'point-list' | 'line-list' | 'line-strip' | 'triangle-list' | 'triangle-strip';
type GPULoadOp = 'load' | 'clear';
type GPUStoreOp = 'store' | 'discard';

// ─── Bitflag Constants (declared as namespaces / const objects) ───

declare namespace GPUTextureUsage {
  const COPY_SRC: number;
  const COPY_DST: number;
  const TEXTURE_BINDING: number;
  const STORAGE_BINDING: number;
  const RENDER_ATTACHMENT: number;
}

declare namespace GPUBufferUsage {
  const MAP_READ: number;
  const MAP_WRITE: number;
  const COPY_SRC: number;
  const COPY_DST: number;
  const INDEX: number;
  const VERTEX: number;
  const UNIFORM: number;
  const STORAGE: number;
  const INDIRECT: number;
  const QUERY_RESOLVE: number;
}

declare namespace GPUShaderStage {
  const VERTEX: number;
  const FRAGMENT: number;
  const COMPUTE: number;
}

declare namespace GPUColorWrite {
  const RED: number;
  const GREEN: number;
  const BLUE: number;
  const ALPHA: number;
  const ALL: number;
}

// ─── Limits & Features ───

interface GPUSupportedLimits {
  readonly maxTextureDimension2D: number;
  readonly maxBufferSize: number;
  readonly maxBindGroups: number;
  readonly maxComputeWorkgroupSizeX: number;
  readonly maxComputeInvocationsPerWorkgroup: number;
  readonly minUniformBufferOffsetAlignment: number;
}

/** Set-like collection of supported feature name strings. */
type GPUSupportedFeatures = ReadonlySet<GPUFeatureName>;

// ─── Textures & Samplers ───

interface GPUTextureView {
  readonly label?: string;
}

interface GPUTextureViewDescriptor {
  label?: string;
  format?: GPUTextureFormat;
  dimension?: GPUTextureViewDimension;
  aspect?: GPUTextureAspect;
  baseMipLevel?: number;
  mipLevelCount?: number;
  baseArrayLayer?: number;
  arrayLayerCount?: number;
}

interface GPUTexture {
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
  readonly mipLevelCount: number;
  readonly sampleCount: number;
  readonly dimension: GPUTextureDimension;
  readonly format: GPUTextureFormat;
  readonly usage: number;
  readonly label?: string;
  createView(descriptor?: GPUTextureViewDescriptor): GPUTextureView;
  destroy(): void;
}

interface GPUExtent3DDict {
  width: number;
  height?: number;
  depthOrArrayLayers?: number;
}
type GPUExtent3D = [number, number?, number?] | GPUExtent3DDict;

interface GPUTextureDescriptor {
  label?: string;
  size: GPUExtent3D;
  mipLevelCount?: number;
  sampleCount?: number;
  dimension?: GPUTextureDimension;
  format: GPUTextureFormat;
  usage: number;
  viewFormats?: GPUTextureFormat[];
}

interface GPUSampler {
  readonly label?: string;
}

interface GPUSamplerDescriptor {
  label?: string;
  addressModeU?: GPUAddressMode;
  addressModeV?: GPUAddressMode;
  addressModeW?: GPUAddressMode;
  magFilter?: GPUFilterMode;
  minFilter?: GPUFilterMode;
  mipmapFilter?: GPUMipmapFilterMode;
  lodMinClamp?: number;
  lodMaxClamp?: number;
  compare?: GPUCompareFunction;
  maxAnisotropy?: number;
}

// ─── Buffers ───

interface GPUBuffer {
  readonly size: number;
  readonly usage: number;
  readonly label?: string;
  getMappedRange(offset?: number, size?: number): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}

interface GPUBufferDescriptor {
  label?: string;
  size: number;
  usage: number;
  mappedAtCreation?: boolean;
}

// ─── Bind Groups & Layouts ───

interface GPUBufferBinding {
  buffer: GPUBuffer;
  offset?: number;
  size?: number;
}

type GPUBindingResource = GPUSampler | GPUTextureView | GPUBufferBinding;

interface GPUBindGroupEntry {
  binding: number;
  resource: GPUBindingResource;
}

interface GPUBindGroupDescriptor {
  label?: string;
  layout: GPUBindGroupLayout;
  entries: GPUBindGroupEntry[];
}

interface GPUBindGroup {
  readonly label?: string;
}

interface GPUBufferBindingLayout {
  type?: 'uniform' | 'storage' | 'read-only-storage';
  hasDynamicOffset?: boolean;
  minBindingSize?: number;
}

interface GPUSamplerBindingLayout {
  type?: 'filtering' | 'non-filtering' | 'comparison';
}

interface GPUTextureBindingLayout {
  sampleType?: 'float' | 'unfilterable-float' | 'depth' | 'sint' | 'uint';
  viewDimension?: GPUTextureViewDimension;
  multisampled?: boolean;
}

interface GPUStorageTextureBindingLayout {
  access?: 'write-only' | 'read-only' | 'read-write';
  format: GPUTextureFormat;
  viewDimension?: GPUTextureViewDimension;
}

interface GPUBindGroupLayoutEntry {
  binding: number;
  visibility: number;
  buffer?: GPUBufferBindingLayout;
  sampler?: GPUSamplerBindingLayout;
  texture?: GPUTextureBindingLayout;
  storageTexture?: GPUStorageTextureBindingLayout;
}

interface GPUBindGroupLayoutDescriptor {
  label?: string;
  entries: GPUBindGroupLayoutEntry[];
}

interface GPUBindGroupLayout {
  readonly label?: string;
}

interface GPUPipelineLayoutDescriptor {
  label?: string;
  bindGroupLayouts: GPUBindGroupLayout[];
}

interface GPUPipelineLayout {
  readonly label?: string;
}

// ─── Shaders & Render Pipeline ───

interface GPUShaderModuleDescriptor {
  label?: string;
  code: string;
}

interface GPUCompilationMessage {
  readonly message: string;
  readonly type: 'error' | 'warning' | 'info';
  readonly lineNum: number;
  readonly linePos: number;
  readonly offset: number;
  readonly length: number;
}

interface GPUCompilationInfo {
  readonly messages: ReadonlyArray<GPUCompilationMessage>;
}

interface GPUShaderModule {
  readonly label?: string;
  /** Async WGSL diagnostics; authoritative error surface for device-side compile. */
  getCompilationInfo(): Promise<GPUCompilationInfo>;
}

/** Base type returned by popErrorScope / uncapturederror (validation, OOM, internal). */
interface GPUError {
  readonly message: string;
}

interface GPUBlendComponent {
  operation?: GPUBlendOperation;
  srcFactor?: GPUBlendFactor;
  dstFactor?: GPUBlendFactor;
}

interface GPUBlendState {
  color: GPUBlendComponent;
  alpha: GPUBlendComponent;
}

interface GPUColorTargetState {
  format: GPUTextureFormat;
  blend?: GPUBlendState;
  writeMask?: number;
}

interface GPUVertexAttribute {
  format: GPUVertexFormat;
  offset: number;
  shaderLocation: number;
}

interface GPUVertexBufferLayout {
  arrayStride: number;
  stepMode?: 'vertex' | 'instance';
  attributes: GPUVertexAttribute[];
}

interface GPUVertexState {
  module: GPUShaderModule;
  entryPoint?: string;
  buffers?: GPUVertexBufferLayout[];
}

interface GPUFragmentState {
  module: GPUShaderModule;
  entryPoint?: string;
  targets: (GPUColorTargetState | null)[];
}

interface GPUPrimitiveState {
  topology?: GPUPrimitiveTopology;
  stripIndexFormat?: 'uint16' | 'uint32';
  frontFace?: 'ccw' | 'cw';
  cullMode?: 'none' | 'front' | 'back';
}

interface GPUMultisampleState {
  count?: number;
  mask?: number;
  alphaToCoverageEnabled?: boolean;
}

interface GPURenderPipelineDescriptor {
  label?: string;
  layout: GPUPipelineLayout | 'auto';
  vertex: GPUVertexState;
  fragment?: GPUFragmentState;
  primitive?: GPUPrimitiveState;
  multisample?: GPUMultisampleState;
}

interface GPURenderPipeline {
  readonly label?: string;
  getBindGroupLayout(index: number): GPUBindGroupLayout;
}

// ─── Commands & Passes ───

type GPUColor = { r: number; g: number; b: number; a: number } | [number, number, number, number];

interface GPURenderPassColorAttachment {
  view: GPUTextureView;
  resolveTarget?: GPUTextureView;
  clearValue?: GPUColor;
  loadOp: GPULoadOp;
  storeOp: GPUStoreOp;
}

interface GPURenderPassDescriptor {
  label?: string;
  colorAttachments: (GPURenderPassColorAttachment | null)[];
  depthStencilAttachment?: unknown;
}

interface GPURenderPassEncoder {
  readonly label?: string;
  setPipeline(pipeline: GPURenderPipeline): void;
  setBindGroup(index: number, bindGroup: GPUBindGroup, dynamicOffsets?: number[] | Uint32Array): void;
  setVertexBuffer(slot: number, buffer: GPUBuffer, offset?: number, size?: number): void;
  setIndexBuffer(buffer: GPUBuffer, indexFormat: 'uint16' | 'uint32', offset?: number, size?: number): void;
  setViewport(x: number, y: number, width: number, height: number, minDepth: number, maxDepth: number): void;
  setScissorRect(x: number, y: number, width: number, height: number): void;
  draw(vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number): void;
  drawIndexed(indexCount: number, instanceCount?: number, firstIndex?: number, baseVertex?: number, firstInstance?: number): void;
  end(): void;
}

interface GPUCommandBuffer {
  readonly label?: string;
}

interface GPUCommandEncoder {
  readonly label?: string;
  beginRenderPass(descriptor: GPURenderPassDescriptor): GPURenderPassEncoder;
  copyTextureToTexture(
    source: { texture: GPUTexture; origin?: [number, number, number] },
    destination: { texture: GPUTexture; origin?: [number, number, number] },
    copySize: GPUExtent3D,
  ): void;
  finish(descriptor?: { label?: string }): GPUCommandBuffer;
}

// ─── Device / Queue / Adapter ───

interface GPUDeviceLostInfo {
  readonly reason: 'unknown' | 'destroyed';
  readonly message: string;
}

interface GPUImageCopyExternalImage {
  source: ImageBitmap | HTMLCanvasElement | OffscreenCanvas | VideoFrame;
  origin?: [number, number] | { x: number; y: number };
  flipY?: boolean;
}

interface GPUImageCopyTextureTagged {
  texture: GPUTexture;
  mipLevel?: number;
  origin?: [number, number, number] | { x: number; y: number; z?: number };
  aspect?: GPUTextureAspect;
  colorSpace?: GPUPredefinedColorSpace;
  premultipliedAlpha?: boolean;
}

interface GPUQueue {
  writeBuffer(
    buffer: GPUBuffer,
    bufferOffset: number,
    data: BufferSource | ArrayBufferView,
    dataOffset?: number,
    size?: number,
  ): void;
  copyExternalImageToTexture(
    source: GPUImageCopyExternalImage,
    destination: GPUImageCopyTextureTagged,
    copySize: GPUExtent3D,
  ): void;
  writeTexture(
    destination: { texture: GPUTexture; mipLevel?: number; origin?: [number, number, number] | { x?: number; y?: number; z?: number }; aspect?: GPUTextureAspect },
    data: BufferSource | ArrayBufferView,
    dataLayout: { offset?: number; bytesPerRow?: number; rowsPerImage?: number },
    size: GPUExtent3D,
  ): void;
  submit(commandBuffers: GPUCommandBuffer[]): void;
}

interface GPUDeviceDescriptor {
  label?: string;
  requiredFeatures?: Iterable<GPUFeatureName>;
  requiredLimits?: Record<string, number>;
}

interface GPUDevice {
  readonly features: GPUSupportedFeatures;
  readonly limits: GPUSupportedLimits;
  readonly queue: GPUQueue;
  readonly lost: Promise<GPUDeviceLostInfo>;
  createShaderModule(descriptor: GPUShaderModuleDescriptor): GPUShaderModule;
  createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor): GPUBindGroupLayout;
  createPipelineLayout(descriptor: GPUPipelineLayoutDescriptor): GPUPipelineLayout;
  createRenderPipeline(descriptor: GPURenderPipelineDescriptor): GPURenderPipeline;
  createTexture(descriptor: GPUTextureDescriptor): GPUTexture;
  createSampler(descriptor?: GPUSamplerDescriptor): GPUSampler;
  createBuffer(descriptor: GPUBufferDescriptor): GPUBuffer;
  createBindGroup(descriptor: GPUBindGroupDescriptor): GPUBindGroup;
  createCommandEncoder(descriptor?: { label?: string }): GPUCommandEncoder;
  /** Error-scope API: capture validation/out-of-memory errors around a code region. */
  pushErrorScope(filter: 'validation' | 'out-of-memory' | 'internal'): void;
  popErrorScope(): Promise<GPUError | null>;
  /** Fires for validation/out-of-memory/internal errors not inside an error scope. */
  addEventListener(
    type: 'uncapturederror',
    listener: (event: { readonly error: { readonly message: string } }) => void,
  ): void;
  destroy(): void;
}

interface GPUAdapterInfo {
  readonly vendor: string;
  readonly architecture: string;
  readonly device: string;
  readonly description: string;
}

interface GPUAdapter {
  readonly features: GPUSupportedFeatures;
  readonly limits: GPUSupportedLimits;
  readonly info?: GPUAdapterInfo;
  requestDevice(descriptor?: GPUDeviceDescriptor): Promise<GPUDevice>;
}

interface GPURequestAdapterOptions {
  powerPreference?: GPUPowerPreference;
  forceFallbackAdapter?: boolean;
}

interface GPU {
  requestAdapter(options?: GPURequestAdapterOptions): Promise<GPUAdapter | null>;
  getPreferredCanvasFormat(): GPUTextureFormat;
}

// ─── Canvas context (swapchain sink, spec §3.1) ───

interface GPUCanvasToneMapping {
  mode?: GPUCanvasToneMappingMode;
}

interface GPUCanvasConfiguration {
  device: GPUDevice;
  format: GPUTextureFormat;
  usage?: number;
  alphaMode?: GPUCanvasAlphaMode;
  colorSpace?: GPUPredefinedColorSpace;
  toneMapping?: GPUCanvasToneMapping;
  viewFormats?: GPUTextureFormat[];
}

interface GPUCanvasContext {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  configure(configuration: GPUCanvasConfiguration): void;
  unconfigure(): void;
  getCurrentTexture(): GPUTexture;
}

// ─── Global wiring ───

interface Navigator {
  readonly gpu?: GPU;
}

interface WorkerNavigator {
  readonly gpu?: GPU;
}

interface HTMLCanvasElement {
  getContext(contextId: 'webgpu'): GPUCanvasContext | null;
}

interface OffscreenCanvas {
  getContext(contextId: 'webgpu'): GPUCanvasContext | null;
}
