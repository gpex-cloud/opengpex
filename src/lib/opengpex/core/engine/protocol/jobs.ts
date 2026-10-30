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
  /**
   * Optional SOURCE-space crop window applied before scaling (9-arg drawImage):
   * the output shows only `targetRect`, scaled to targetWidth×targetHeight.
   * Absent → the whole image is resampled (legacy behavior). Lets a thumbnail
   * be cut from a slice of a LARGER shared asset in the Worker instead of a
   * main-thread decode (paste's "New Frame" path).
   */
  targetRect?: { x: number; y: number; w: number; h: number };
  /**
   * Terminal ENCODE format of the output blob. Default 'image/png' (lossless —
   * the fidelity contract of resampleLayer's user-content bakes). Thumbnails
   * pass 'image/webp' to get their storage format straight from the Worker's
   * canvas, skipping a PNG encode + decode + re-encode round-trip in the
   * caller (and making the content hash describe the FINAL artifact).
   */
  format?: 'image/png' | 'image/webp';
  /** Encoder quality for lossy formats. Default 0.92 (canvasToBlob's default). */
  quality?: number;
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
 * Compute the full-resolution layer histograms in the Worker thread.
 * Returns a single packed ArrayBuffer (5 × 256 × 4 B) holding per-channel
 * r/g/b, per-pixel Rec.601 luma, and the composite r+g+b sum (Photoshop's
 * Levels dialog "RGB" channel histogram). Segment layout + pack/unpack live
 * in `core/engine/color/histograms.ts`.
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
