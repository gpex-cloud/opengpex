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

import type { GamutId } from '@opengpex/editor/core/types';

// ─── ResampleJob ───

export interface ResampleJob {
  type: 'RESAMPLE';
  src: string;
  targetWidth: number;
  targetHeight: number;
  /**
   * Gamut of the source image, resolved by the caller (light asset record).
   * Drives the OffscreenCanvas `colorSpace` so wide-gamut sources aren't
   * silently clamped to sRGB during resample. Absent → handler defaults to 'srgb'.
   */
  sourceGamut?: GamutId;
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

// ─── Job union ───

export type Job =
  | ResampleJob
  | DecodeJob
  | EnsureAssetJob
  | ForgetJob
  | ExtractPixelsJob
  | HistogramJob;
