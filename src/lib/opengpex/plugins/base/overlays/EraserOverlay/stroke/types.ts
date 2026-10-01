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
 * Mask Stroke Session Type Definitions
 *
 * Defines the StrokeSession interface and related data types for eraser/restore
 * mask editing. Kept intentionally independent from the raster-brush overlay so
 * each tool can evolve its bake request shape without coupling.
 */

import type { Frame, InteractionEvent } from '@opengpex/editor/core/types';
import type { Point2D } from './smoothing';

// ─── Stroke Configuration ──────────────────────────────────────────────────────

export interface StrokeConfig {
  brushSize: number;
  brushColor: string;
  brushOpacity: number;   // 0-100
  brushHardness: number;  // 0-100
  canvasSize: { w: number; h: number };
}

// ─── Bake Request Types ────────────────────────────────────────────────────────

export interface MaskBakeRequest {
  type: 'mask';
  /** Encoded mask canvas as PNG blob */
  blob: Blob;
  /** Mask ID (existing or newly generated) */
  maskId: string;
  /** Target layer ID for the mask */
  targetLayerId: string;
  /** Existing mask ID if editing (undefined if creating new) */
  existingMaskId: string | undefined;
  /**
   * Mask placement in layer-local space.
   *
   * `w/h` = target layer bounding. `x/y` = the layer-local ORIGIN the mask canvas
   * is anchored to (`LayerUtils.getMaskOrigin`) — non-zero for zero-copy logical
   * fragments and for imported layers with a `contentBounds` offset, `(0,0)` for
   * regular full-layer images. Written verbatim into `BitmapMask.bounds`, which
   * both the main-thread and Worker composite branches consume as-is.
   */
  maskBounds: { x: number; y: number; w: number; h: number };
}

export type BakeRequest = MaskBakeRequest;

// ─── StrokeSession Interface ───────────────────────────────────────────────────

export interface StrokeSession {
  /** Preview canvas (read by StrokePreview component via getStrokeBuffer) */
  readonly previewCanvas: OffscreenCanvas;
  /** Dirty version counter (incremented on each move draw, for dirty detection) */
  readonly version: number;
  /** Whether this is a mask editing session */
  readonly isMaskEdit: boolean;

  /** Start a stroke at the given point */
  begin(point: Point2D, pressure: number): void;
  /** Continue the stroke to a new point */
  move(point: Point2D, pressure: number, e: InteractionEvent): void;
  /** End the stroke, flush trailing smoother segment, return bake request */
  end(frame: Frame): Promise<BakeRequest | null>;
}
