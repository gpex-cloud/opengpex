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
 * IFilter — Pixel-level filter processing protocol.
 *
 * This module defines the declarative filter descriptors and the abstract
 * runtime interface used by the OpenGPEX filter pipeline (see spec
 * `docs/opengpex/plans/20260604_filter_pipeline_architecture_spec.md`).
 *
 * Design rules:
 * 1. **Declarative & Serializable** — every field must be JSON-safe so a
 *    descriptor can be transferred across Web Workers via postMessage.
 * 2. **Backend-agnostic** — this file contains ONLY protocol types. Concrete
 *    implementations (Canvas2dFilter / WebglFilter / WebgpuFilter) live under
 *    `core/engine/backends/*` and are wired via `FilterFactory`.
 * 3. **assetId-safe** — applying an IFilter never mutates the source asset
 *    identity, which keeps the 16-bit fidelity export channel intact
 *    (see spec §10).
 */

// ────────────────────────────────────────────────────────────
// Point-operation descriptors
// ────────────────────────────────────────────────────────────

export interface BrightnessFilter {
  type: 'brightness';
  /** 0–200, 100 = original */
  value: number;
}

export interface ContrastFilter {
  type: 'contrast';
  /** 0–200, 100 = original */
  value: number;
}

export interface SaturationFilter {
  type: 'saturation';
  /** 0–200, 100 = original */
  value: number;
}

export interface HueRotateFilter {
  type: 'hueRotate';
  /** 0–360 degrees */
  value: number;
}

// ────────────────────────────────────────────────────────────
// Neighborhood-operation descriptors
// ────────────────────────────────────────────────────────────

export interface BlurFilter {
  type: 'blur';
  /** 0–20 px */
  value: number;
}

// ────────────────────────────────────────────────────────────
// Advanced descriptors (curves / levels / channel mixer)
// ────────────────────────────────────────────────────────────

/** Curve control points [input, output] normalized to 0..1 range. */
export type CurvePoints = Array<[number, number]>;

export interface CurvesData {
  /** Master luminance curve */
  rgb?: CurvePoints;
  red?: CurvePoints;
  green?: CurvePoints;
  blue?: CurvePoints;
}

export interface CurvesFilter {
  type: 'curves';
  channels: CurvesData;
}

export interface LevelsData {
  /** 0–255 */
  inputBlack: number;
  /** 0–255 */
  inputWhite: number;
  /** 0.1–10, 1.0 = linear */
  gamma: number;
  /** 0–255 */
  outputBlack: number;
  /** 0–255 */
  outputWhite: number;
}

export interface LevelsFilter {
  type: 'levels';
  config: LevelsData;
}

export interface ChannelMixData {
  /** [fromR, fromG, fromB] → outputR */
  red: [number, number, number];
  /** [fromR, fromG, fromB] → outputG */
  green: [number, number, number];
  /** [fromR, fromG, fromB] → outputB */
  blue: [number, number, number];
  /** Optional constant offset per output channel */
  constant?: [number, number, number];
}

export interface ChannelMixFilter {
  type: 'channelMix';
  data: ChannelMixData;
}

// ────────────────────────────────────────────────────────────
// Custom / extensible descriptor
// ────────────────────────────────────────────────────────────

export interface CustomFilter {
  type: 'custom';
  /** Registered id in the Worker-side CustomFilterRegistry (§5.7) */
  id: string;
  /** Serializable, primitive-only parameter bag */
  params: Record<string, number | string | boolean>;
}

// ────────────────────────────────────────────────────────────
// FilterDescriptor union
// ────────────────────────────────────────────────────────────

export type FilterDescriptor =
  | BrightnessFilter
  | ContrastFilter
  | SaturationFilter
  | HueRotateFilter
  | BlurFilter
  | CurvesFilter
  | LevelsFilter
  | ChannelMixFilter
  | CustomFilter;

export type FilterType = FilterDescriptor['type'];

// ────────────────────────────────────────────────────────────
// Filter classification — tile-parallel safety
// ────────────────────────────────────────────────────────────

/**
 * Filter kind — decides tile-rendering strategy (§5.4):
 * - `point`         : each output pixel depends only on the same input pixel;
 *                     tile-parallel is safe.
 * - `neighborhood`  : output depends on surrounding pixels (blur / sharpen …).
 *                     Must run on the full layer buffer OR use padding, else
 *                     tile seams appear at boundaries.
 */
export type FilterKind = 'point' | 'neighborhood';

/**
 * Classify a filter descriptor. Custom filters default to `point` — plugins
 * that provide neighborhood-style custom filters must declare their kind on
 * the Worker-side registry (§5.7).
 */
export function classifyFilter(desc: FilterDescriptor): FilterKind {
  switch (desc.type) {
    case 'blur':
      return 'neighborhood';
    default:
      return 'point';
  }
}

/**
 * Convenience helper — does this descriptor list contain any neighborhood op?
 */
export function hasNeighborhoodFilter(filters: FilterDescriptor[]): boolean {
  return filters.some(f => classifyFilter(f) === 'neighborhood');
}

// ────────────────────────────────────────────────────────────
// High-resolution pixel buffer (16-bit / 32-bit path, spec §10)
// ────────────────────────────────────────────────────────────

/**
 * Explicit pixel buffer for the 16-bit fidelity export path.
 *
 * Distinct from `ImageBitmap` because we need bit-exact control over the
 * source samples — vips-worker decodes into this shape and the filter
 * pipeline reads/writes it in-place before vips re-encodes.
 */
export interface HighResPixelBuffer {
  data: Uint16Array | Float32Array;
  width: number;
  height: number;
  /** 3 (RGB) or 4 (RGBA) */
  channels: 3 | 4;
  bitDepth: 16 | 32;
}

/** A source frame for `IFilter.apply()` — either 8-bit or high-precision. */
export type FilterInput = ImageBitmap | HighResPixelBuffer;

export interface FilterApplyOptions {
  /** Requested output precision. Defaults to input precision. */
  bitDepth?: 8 | 16 | 32;
  /** Optional AbortSignal for cancellable long-running work. */
  signal?: AbortSignal;
}

// ────────────────────────────────────────────────────────────
// IFilter interface
// ────────────────────────────────────────────────────────────

/**
 * IFilter — abstract pixel-level filter runtime.
 *
 * Implementations:
 * - `Canvas2dFilter`  — ImageData loops in a Web Worker (Step 2, this spec)
 * - `WebglFilter`     — GLSL fragment-shader pass (§8.3, future)
 * - `WebgpuFilter`    — WebGPU compute shaders (§8.5, future)
 */
export interface IFilter {
  /**
   * Apply a chain of filter descriptors to a source frame in order.
   *
   * Precision rules (§10.4):
   * - `ImageBitmap` in  → returns `ImageBitmap` (8-bit preview path).
   * - `HighResPixelBuffer` in → returns `HighResPixelBuffer` (16/32-bit
   *   export path). Callers can request downcast by passing `options.bitDepth`.
   */
  apply(
    source: FilterInput,
    filters: FilterDescriptor[],
    options?: FilterApplyOptions,
  ): Promise<FilterInput>;

  /** Whether this backend can execute the given descriptor type. */
  supports(type: FilterType): boolean;

  /** Maximum bit depth this backend can output natively. */
  maxBitDepth(): 8 | 16 | 32;

  /** Release backend-owned resources (GL contexts, cached LUTs, etc.). */
  dispose(): void;
}
