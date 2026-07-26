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
import type { Shape } from '@opengpex/editor/core/types';

// ─── CompositeJob ───

export interface CompositeJob {
  type: 'COMPOSITE';
  layers: LayerDescriptor[];
  roi: Shape;
  precision: 8 | 16 | 32;
  dpr: number;
  outputWidth: number;
  outputHeight: number;
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

// ─── FileIoJob ───

export interface FileIoJob {
  type: 'FILE_IO';
  fn: 'decodeTiff' | 'encodeTiff' | 'decodePages' | 'decodePage' | 'getPageCount' | 'composite16bit' | 'exportHighRes';
  bytes?: Uint8Array;
  rgbaData?: Uint8Array;
  width?: number;
  height?: number;
  page?: number;
  options?: Record<string, unknown>;
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
  | FileIoJob;
