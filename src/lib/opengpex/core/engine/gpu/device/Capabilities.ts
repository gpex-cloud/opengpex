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
 * Capabilities.ts — Runtime WebGPU feature & limit negotiation.
 *
 * POLICY: "capability adaptation ≠ fallback".
 * When an optional feature is missing we pick a more conservative WebGPU path
 * — never a Canvas2D/CPU path. v1's habit of writing a CPU degradation branch
 * for every new capability is exactly the architectural debt v2 sheds.
 *
 * Negotiated at `requestDevice` time (checklist item B1) and then treated as
 * immutable for the device's lifetime. Pass tiers key off this record.
 *
 * @module core/gpu/device/Capabilities
 */

/**
 * Optional features probed for.
 *
 * Each entry names the WebGPU feature string plus the "general tier" we fall
 * back to when the adapter does not expose it.
 */
export const OPTIONAL_FEATURES = [
  /** Half-precision arithmetic in WGSL — halves ALU cost & register pressure. */
  'shader-f16',
  /** Enables blending on rgba32float render targets (high-precision layer tier). */
  'float32-blendable',
  /**
   * Enables LINEAR SAMPLING of rgba32float textures. Distinct from
   * `float32-blendable`: blendable only covers the render-target (write) side,
   * filterable covers the sampled (read) side. The ping-pong composite tier
   * needs BOTH before `rgba32float` is safe as `workingFormat` — otherwise the
   * Blend/Blit passes bind a filtering sampler to an unfilterable-float texture
   * and pipeline creation fails validation.
   */
  'float32-filterable',
  /** Subgroup intrinsics — accelerates reductions (histogram / separable blur). */
  'subgroups',
  /** GPU timestamp queries — powers the GPU performance profiling panel. */
  'timestamp-query',
] as const;

export type OptionalFeature = (typeof OPTIONAL_FEATURES)[number];

/**
 * Key `GPUSupportedLimits` values the engine adapts to.
 *
 * `maxTextureDimension2D` is the important one: on mobile adapters it can be
 * 4096, below an 8K canvas — the compositor must then tile.
 */
export interface GpuLimits {
  readonly maxTextureDimension2D: number;
  readonly maxBufferSize: number;
  readonly maxBindGroups: number;
  readonly maxComputeWorkgroupSizeX: number;
  readonly maxComputeInvocationsPerWorkgroup: number;
}

/**
 * The negotiated capability record — the return value of `IEngine.init()`.
 */
export interface Capabilities {
  /** Features actually granted by `requestDevice` (subset of OPTIONAL_FEATURES). */
  readonly features: readonly OptionalFeature[];
  readonly limits: GpuLimits;
  /** Swapchain format from `navigator.gpu.getPreferredCanvasFormat()`. */
  readonly preferredFormat: GPUTextureFormat;
  /**
   * Working texture format for intermediate composite targets.
   * `rgba16float` is the default: linear-light, HDR-capable, and BOTH blendable
   * and filterable everywhere (unconditional WebGPU guarantee). `rgba32float`
   * is only chosen when the adapter grants BOTH `float32-blendable` (render
   * target) AND `float32-filterable` (linear sampling) — the ping-pong passes
   * need both.
   */
  readonly workingFormat: 'rgba16float' | 'rgba32float';
  /** True when the canvas exceeds `maxTextureDimension2D` and tiling is required. */
  readonly needsTiling: boolean;
  /** Adapter identification, for diagnostics / bug reports. */
  readonly adapterInfo: {
    readonly vendor: string;
    readonly architecture: string;
    readonly device: string;
    readonly description: string;
  };
}

/** Conservative placeholder used before a device has been negotiated. */
export const UNKNOWN_CAPABILITIES: Capabilities = {
  features: [],
  limits: {
    maxTextureDimension2D: 0,
    maxBufferSize: 0,
    maxBindGroups: 0,
    maxComputeWorkgroupSizeX: 0,
    maxComputeInvocationsPerWorkgroup: 0,
  },
  preferredFormat: 'bgra8unorm',
  workingFormat: 'rgba16float',
  needsTiling: false,
  adapterInfo: { vendor: '', architecture: '', device: '', description: '' },
};

/**
 * Limits that OpenGPEX benefits from expanding beyond WebGPU base minimums.
 * Each entry is a maximum limit (larger is better).
 */
export const EXPANDABLE_MAX_LIMITS: readonly (keyof GPUSupportedLimits)[] = [
  'maxBufferSize',
  'maxStorageBufferBindingSize',
  'maxTextureDimension2D',
  'maxTextureArrayLayers',
  'maxComputeWorkgroupStorageSize',
  'maxComputeInvocationsPerWorkgroup',
  'maxComputeWorkgroupSizeX',
  'maxComputeWorkgroupSizeY',
  'maxComputeWorkgroupSizeZ',
] as const;

/**
 * Intersect the features v2 wants with what the adapter offers.
 * Result is safe to hand straight to `requestDevice({ requiredFeatures })`.
 */
export function negotiateFeatures(adapter: GPUAdapter): OptionalFeature[] {
  return OPTIONAL_FEATURES.filter((f) => adapter.features.has(f));
}

/**
 * Negotiate requiredLimits to request hardware maximums for buffer sizes and texture dimensions.
 * Result is safe to hand straight to `requestDevice({ requiredLimits })`.
 */
export function negotiateLimits(adapter: GPUAdapter): Record<string, number> {
  const req: Record<string, number> = {};
  if (!adapter.limits) return req;

  for (const key of EXPANDABLE_MAX_LIMITS) {
    const val = adapter.limits[key];
    if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
      req[key] = val;
    }
  }
  return req;
}

/** Snapshot the limits the engine cares about into a plain, loggable record. */
export function readLimits(source: GPUSupportedLimits): GpuLimits {
  return {
    maxTextureDimension2D: source.maxTextureDimension2D ?? 8192,
    maxBufferSize: source.maxBufferSize ?? 268435456,
    maxBindGroups: source.maxBindGroups ?? 4,
    maxComputeWorkgroupSizeX: source.maxComputeWorkgroupSizeX ?? 256,
    maxComputeInvocationsPerWorkgroup: source.maxComputeInvocationsPerWorkgroup ?? 256,
  };
}

/** Does the negotiated set include this feature? */
export function hasFeature(caps: Capabilities, feature: OptionalFeature): boolean {
  return caps.features.includes(feature);
}
