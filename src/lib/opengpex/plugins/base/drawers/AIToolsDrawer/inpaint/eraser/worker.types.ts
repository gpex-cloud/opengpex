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
 * Inpaint Eraser Worker Message Protocol
 *
 * Wire-level types for the request / response / progress messages exchanged
 * between the main thread (`client.ts`) and the inpaint eraser worker (`worker.ts`).
 *
 * Design notes:
 *   - Extends shared WorkerRequest/WorkerProgress/WorkerError base types
 *   - All model/backend resolution is done on the main thread (full transparency)
 *   - Worker only receives fully resolved parameters and executes
 */

import type { WorkerRequest, WorkerProgress, WorkerError } from '../../_shared/inference/types';

// ─── Main → Worker ───────────────────────────────────────────────────────────

export interface InpaintEraserRequest extends WorkerRequest {
  /**
   * Polygon rings defining the mask area (in image-local coordinates).
   * Each ring is an array of [x, y] pairs. Multiple rings are filled (union).
   */
  polygonRings?: number[][][];
  /**
   * Bounding box of the mask area in image-local coordinates.
   * Used to crop the output patch to only the affected region.
   */
  maskBounds?: { x: number; y: number; w: number; h: number };
  /** Model's native input resolution (default 512). */
  inputSize?: number;
}

// ─── Worker → Main ───────────────────────────────────────────────────────────

/** Worker → Main thread: Progress update */
export type InpaintEraserProgress = WorkerProgress;

export interface InpaintEraserResult {
  type: 'result';
  reqId: number;
  /**
   * Output patch RGBA buffer (only mask region) — Transferable.
   * Contains transparent pixels outside the mask boundary.
   */
  patchData?: ArrayBuffer;
  /** Patch offset in image-local coordinates (top-left of the patch). */
  offsetX?: number;
  offsetY?: number;
  /** Patch dimensions. */
  width?: number;
  height?: number;
  debug?: {
    deviceUsed: 'webgpu' | 'wasm';
    inferenceMs: number;
    totalMs: number;
  };
}

/** Worker → Main thread: Error */
export type InpaintEraserError = WorkerError;

export type InpaintEraserResponse = InpaintEraserProgress | InpaintEraserResult | InpaintEraserError;
