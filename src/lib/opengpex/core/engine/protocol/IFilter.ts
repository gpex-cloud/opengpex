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
 * IFilter — Pixel-level filter processing protocol for Engine V2.
 *
 * Adapted from v1 `engine/filters/IFilter.ts`.
 * Contains:
 * - FilterDescriptor union type
 * - IFilter interface
 * - HighResPixelBuffer type
 * - FilterColorHint (Phase A: color-aware foundation)
 * - classifyFilter() classification helper
 */

import type { WorkingColorSpace, TRC } from '@opengpex/editor/core/types';

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
// Color Balance descriptor (Plan B: luminance-aware)
// ────────────────────────────────────────────────────────────

export interface ColorBalanceData {
  shadows: [number, number, number];
  midtones: [number, number, number];
  highlights: [number, number, number];
  preserveLuminosity: boolean;
}

export interface ColorBalanceFilter {
  type: 'colorBalance';
  data: ColorBalanceData;
}

// ────────────────────────────────────────────────────────────
// Custom / extensible descriptor
// ────────────────────────────────────────────────────────────

export interface CustomFilter {
  type: 'custom';
  /** Registered id in the Worker-side CustomFilterRegistry */
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
  | ColorBalanceFilter
  | CustomFilter;

export type FilterType = FilterDescriptor['type'];

// ────────────────────────────────────────────────────────────
// Filter classification — tile-parallel safety
// ────────────────────────────────────────────────────────────

/**
 * Filter kind — decides tile-rendering strategy:
 * - `point`         : each output pixel depends only on the same input pixel;
 *                     tile-parallel is safe.
 * - `neighborhood`  : output depends on surrounding pixels (blur / sharpen …).
 *                     Must run on the full layer buffer OR use padding.
 */
export type FilterKind = 'point' | 'neighborhood';

/**
 * Classify a filter descriptor. Custom filters default to `point`.
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
  return filters.some((f) => classifyFilter(f) === 'neighborhood');
}

// ────────────────────────────────────────────────────────────
// High-resolution pixel buffer (16-bit / 32-bit path)
// ────────────────────────────────────────────────────────────

/**
 * Explicit pixel buffer for the 16-bit fidelity export path.
 * Distinct from ImageBitmap because we need bit-exact control.
 */
export interface HighResPixelBuffer {
  data: Uint16Array | Float32Array;
  width: number;
  height: number;
  /** 3 (RGB) or 4 (RGBA) */
  channels: 3 | 4;
  bitDepth: 16 | 32;

  // ─── Color metadata (Phase A) ───────────────────────────────────────────
  /**
   * Color space of the pixel data in this buffer.
   * Allows consumers to know what color space the values represent
   * without relying on external context.
   *
   * @default 'srgb' — existing buffers without this field are treated as sRGB.
   */
  colorSpace?: WorkingColorSpace;

  /**
   * Transfer characteristic (gamma encoding) of the pixel values.
   * Informs the pipeline whether values are perceptually-encoded or linear-light.
   *
   * @default 'srgb-trc' — existing buffers without this field are treated as sRGB-TRC encoded.
   */
  trc?: TRC;
}

/** A source frame for IFilter.apply() — either 8-bit or high-precision. */
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
 * - `Canvas2dFilter`  — ImageData loops in a Web Worker
 * - `WebglFilter`     — GLSL fragment-shader pass (future)
 * - `WebgpuFilter`    — WebGPU compute shaders (future)
 */
export interface IFilter {
  /**
   * Apply a chain of filter descriptors to a source frame in order.
   *
   * Precision rules:
   * - ImageBitmap in → returns ImageBitmap (8-bit preview path).
   * - HighResPixelBuffer in → returns HighResPixelBuffer (16/32-bit export path).
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

// ────────────────────────────────────────────────────────────
// Filter Color Hints (Phase A: color-aware foundation)
// ────────────────────────────────────────────────────────────

/**
 * Color hint for a filter algorithm — declares the TRC (transfer
 * characteristic) the algorithm expects or prefers.
 *
 * This is a **declarative annotation** — it does NOT change runtime behavior
 * in Phase A. It serves as documentation and lays the groundwork for Phase B
 * (linear-light compositing) where the pipeline may auto-convert TRC before
 * applying a filter.
 *
 */
export interface FilterColorHint {
  /**
   * The TRC this filter algorithm expects/prefers.
   *
   * - `'srgb-trc'`: Perceptual operations (color balance, HSL, curves on perceived values)
   * - `'linear'`:   Physically-correct operations (blend modes, Gaussian blur, resize)
   * - `'any'`:      Operation is TRC-agnostic (levels, channel swap)
   */
  preferredTRC: TRC | 'any';

  /**
   * Policy when the buffer's TRC doesn't match `preferredTRC`.
   *
   * - `'convert'`: Pipeline should auto-convert before applying (correct but slower)
   * - `'ignore'`:  Apply anyway (current behavior, slight inaccuracy but fast)
   * - `'warn'`:    Apply but log a developer warning
   *
   * Phase A: All filters default to `'ignore'` → zero behavior change.
   * Phase B: Specific filters (blur) can be upgraded to `'convert'` or `'warn'`.
   */
  mismatchPolicy: 'convert' | 'ignore' | 'warn';
}

/**
 * Static color hint registry for all built-in filter types.
 *
 * Phase A: Most `mismatchPolicy` values are `'ignore'` to ensure zero
 * runtime behavior change.
 *
 * Phase B: Blur upgraded to `'convert'` — pipeline will auto-convert to linear
 * before blur execution, producing physically-correct Gaussian blur results.
 */
export const FILTER_COLOR_HINTS: Record<FilterType, FilterColorHint> = {
  brightness:   { preferredTRC: 'srgb-trc', mismatchPolicy: 'ignore' },
  contrast:     { preferredTRC: 'srgb-trc', mismatchPolicy: 'ignore' },
  saturation:   { preferredTRC: 'srgb-trc', mismatchPolicy: 'ignore' },
  hueRotate:    { preferredTRC: 'srgb-trc', mismatchPolicy: 'ignore' },
  blur:         { preferredTRC: 'linear',   mismatchPolicy: 'convert' },
  curves:       { preferredTRC: 'any',      mismatchPolicy: 'ignore' },
  levels:       { preferredTRC: 'any',      mismatchPolicy: 'ignore' },
  channelMix:   { preferredTRC: 'any',      mismatchPolicy: 'ignore' },
  colorBalance: { preferredTRC: 'srgb-trc', mismatchPolicy: 'ignore' },
  custom:       { preferredTRC: 'any',      mismatchPolicy: 'ignore' },
};

/**
 * Get the color hint for a filter descriptor.
 * Custom filters always return TRC-agnostic hint.
 */
export function getFilterColorHint(desc: FilterDescriptor): FilterColorHint {
  return FILTER_COLOR_HINTS[desc.type] ?? { preferredTRC: 'any', mismatchPolicy: 'ignore' };
}
