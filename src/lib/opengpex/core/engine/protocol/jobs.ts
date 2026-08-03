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
 * jobs.ts — Declarative job descriptors sent from main thread to Worker.
 *
 * All fields must be structured-clone compatible (no functions, no DOM refs).
 * Transferable fields (Blob, ArrayBuffer) are annotated for the bridge to extract.
 */

import type { LayerDescriptor } from './descriptors';
import type { FilterDescriptor } from './IFilter';
import type { Shape, TRC, WorkingColorSpace } from '@opengpex/editor/core/types';

// ─── CompositeJob ───

export interface CompositeJob {
  type: 'COMPOSITE';
  layers: LayerDescriptor[];
  roi: Shape;
  precision: 8 | 16 | 32;
  dpr: number;
  outputWidth: number;
  outputHeight: number;

  /**
   * Target TRC for compositing — determines the blending path.
   *
   * ⚠️ PERFORMANCE-CRITICAL MODE SWITCH:
   *   - `'srgb-trc'` (default): Hardware-accelerated Canvas 2D globalCompositeOperation.
   *     Blend modes operate in gamma space. Fast (~1ms/frame for 4K).
   *   - `'linear'`: Manual per-pixel blending via ImageData + blend2d module.
   *     Blend modes operate in physically-correct linear-light space
   *     (matching Photoshop CC+ "Blend Colors Using Gamma 1.0").
   *     Slow (~50-200ms/frame for 4K). Only used for offscreen export,
   *     NOT for onscreen preview.
   *
   * Derived from Frame.trc. Default frames use 'srgb-trc'; frames with
   * bitDepth >= 16 may default to 'linear' (set by LayerFactory.getNewFrame).
   *
   * @default 'srgb-trc'
   * @see docs/opengpex/plans/20260729_color_management_architecture_evolution.md §Phase B
   */
  compositeTRC?: TRC;

  /**
   * Color space for the compositing pipeline (Phase C — wide gamut).
   *
   * Must match the frame's working color space to prevent implicit browser color
   * conversions when drawing bitmaps. Only `'srgb'` and `'display-p3'` are supported
   * by the Canvas 2D API as of 2026.
   *
   * Named `compositeColorSpace` (not `canvasColorSpace`) to decouple from the
   * Canvas 2D implementation detail — for a future WebGPU backend this field
   * determines the compute shader's pixel encoding, not a canvas context option.
   *
   * @default 'srgb'
   */
  compositeColorSpace?: 'srgb' | 'display-p3';
}

// ─── FilterJob ───

export interface FilterJob {
  type: 'FILTER';
  /** Worker-transferred ImageBitmap (owned clone). Neutered after transfer. */
  source: ImageBitmap;
  /** Ordered filter descriptors to apply */
  descriptors: FilterDescriptor[];
  /** Opaque cache key echoed back for bookkeeping (not read by Worker). */
  key?: string;
}

// ─── ResampleJob ───

export interface ResampleJob {
  type: 'RESAMPLE';
  src: string;
  targetWidth: number;
  targetHeight: number;
}

// ─── RasterizeJob ───

export interface RasterizeJob {
  type: 'RASTERIZE';
  subType: 'text' | 'mask';
  payload: unknown;
}

// ─── DecodeJob ───

/**
 * Fetch → decode → cache in WorkerCache → transfer bitmap to main thread.
 */
export interface DecodeJob {
  type: 'DECODE';
  subType: 'BITMAP';
  src: string;
}

// ─── EnsureAssetJob ───

export interface EnsureAssetJob {
  type: 'ENSURE_ASSET';
  hash: string;
  blob: Blob;
}

// ─── ForgetJob ───

export interface ForgetJob {
  type: 'FORGET';
  hash: string;
}

// ─── ExtractPixelsJob ───

export interface ExtractPixelsJob {
  type: 'EXTRACT_PIXELS';
  src: string;         // content hash (WorkerCache key)
  rect?: { x: number; y: number; w: number; h: number };  // optional crop region
}

// ─── GetTileJob ───

export interface GetTileJob {
  type: 'GET_TILE';
  hash: string;
  level: number;
  x: number;
  y: number;
}

// ─── HistogramJob ───

/**
 * Compute full-resolution RGB composite histogram in the Worker thread.
 * Returns a 256-bin Uint32Array (sum of per-channel R+G+B counts, matching
 * Photoshop's Levels dialog "RGB" channel histogram).
 */
export interface HistogramJob {
  type: 'HISTOGRAM';
  src: string;  // content hash (WorkerCache key)
}

// ─── FileIoJob ───

export interface FileIoJob {
  type: 'FILE_IO';
  fn: 'decodeTiff' | 'encodeTiff' | 'encodeAvif' | 'decodePages' | 'decodePage' | 'getPageCount' | 'composite16bit' | 'exportHighRes' | 'iccToSrgb' | 'srgbToIcc';
  /** Whether to preserve original color space pixels (skip ICC transform). Used by decodeTiff. */
  preserveColorSpace?: boolean;
  bytes?: Uint8Array;
  rgbaData?: Uint8Array;
  width?: number;
  height?: number;
  page?: number;
  options?: Record<string, unknown>;
  /** Target ICC Profile binary data (used by srgbToIcc for reverse color conversion). */
  iccProfileData?: Uint8Array;
  layers?: Array<{
    bytes: Uint8Array;
    x: number;
    y: number;
    blendMode: string;
    opacity: number;
    is8bit: boolean;
    adjustments?: Record<string, unknown>;
  }>;
  canvasWidth?: number;
  canvasHeight?: number;
}

// ─── Job union ───

export type Job =
  | CompositeJob
  | FilterJob
  | ResampleJob
  | RasterizeJob
  | DecodeJob
  | EnsureAssetJob
  | ForgetJob
  | ExtractPixelsJob
  | GetTileJob
  | HistogramJob
  | FileIoJob;
