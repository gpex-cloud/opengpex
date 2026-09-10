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
 * core/gpu — Public surface of the OpenGPEX v2 WebGPU engine.
 *
 * Consumers import ONLY from this barrel. Internals (device negotiation,
 * RenderGraph, passes, WGSL) stay private so the engine can be restructured
 * pipeline-by-pipeline without touching call sites.
 *
 * ARCHITECTURAL BOUNDARY (§16.2 acceptance criterion):
 *   `core/gpu/` must have ZERO dependency on Canvas2D compositing or CPU
 *   filtering. If you find yourself importing from `core/engine/rendering/`,
 *   stop — that is exactly the coupling v2 exists to eliminate.
 *
 * Planned sub-modules (spec §3.3), landing per phase:
 *   graph/     — RenderGraph, SceneCompiler, passes/     (Phase 1–2)
 *   resources/ — TexturePool, LayerTexture, BufferRing, PipelineCache (Phase 1–2)
 *   shaders/   — layer.ts, blend.ts, blit.ts (WGSL embedded as TS consts), … (Phase 1–4)
 *   export/    — Readback.ts                             (Phase 4)
 *
 * @module core/gpu
 */

// ── Engine entry point + contract ──
export { WebGpuEngine } from './WebGpuEngine';
export type { IEngine, ExportOptions, ExportResult } from './WebGpuEngine';

// ── Device & capability negotiation (§4) ──
export { GpuDevice, WebGpuUnavailableError } from './device/GpuDevice';
export type { SurfaceConfig } from './device/GpuDevice';
export {
  OPTIONAL_FEATURES,
  UNKNOWN_CAPABILITIES,
  negotiateFeatures,
  readLimits,
  hasFeature,
} from './device/Capabilities';
export type { Capabilities, GpuLimits, OptionalFeature } from './device/Capabilities';

// ── Declarative Scene contract (§5.1) ──
export { MAT3_IDENTITY, EMPTY_SCENE } from './scene/Scene';
export type {
  Scene,
  LayerNode,
  LayerSource,
  MaskDesc,
  AdjustmentDesc,
  FilterDesc,
  DisplayConfig,
  SceneChannelMask,
  Mat3,
} from './scene/Scene';

// ── Resources & passes (§6, §7) ──
export { TexturePool, LayerTexture, BufferRing, PipelineCache } from './resources';
export type { TexturePoolStats, AcquireTextureOptions, BufferSlot } from './resources';
export { CompositePass, packLayerUniforms } from './graph/passes/CompositePass';
export type { CompositePassContext, DrawLayerParams } from './graph/passes/CompositePass';

// ── Scene Assembly (§5.1, §5.4) ──
export { SceneAssembler } from './scene/SceneAssembler';
export type { SceneAssemblerOptions } from './scene/SceneAssembler';

// ── Graph & Passes (§7.2, §8.3) ──
export { SceneCompiler } from './graph/SceneCompiler';
export type { CompiledScene, ExecutionStep, HardwareBlendableBatch, PingPongStep } from './graph/SceneCompiler';
export { RenderGraph, compositeDims } from './graph/RenderGraph';
export type { RenderGraphContext, CompositeContext, PresentContext, CompositeResult } from './graph/RenderGraph';
export { computeCompositeSignature } from './scene/compositeSignature';
export type { CompositeSignatureOptions } from './scene/compositeSignature';
export { BlendPass } from './graph/passes/BlendPass';
export type { BlendPassContext, DrawBlendParams } from './graph/passes/BlendPass';
export { ViewPass, IDENTITY_VIEW_MATRIX, composeViewMatrix } from './graph/passes/ViewPass';
export type { ViewPassContext, ViewMatrix } from './graph/passes/ViewPass';
export { BLEND_MODE_MAP, isHardwareBlendable, BLEND_WGSL } from './shaders/blend';


