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
 * Mosaic Stroke Session Type Definitions
 *
 * Defines the StrokeSession interface, Worker message types, and related
 * data types for mosaic interaction.
 */

import type { Layer, Frame, InteractionEvent } from '@opengpex/editor/core/types';

export interface Point2D {
  x: number;
  y: number;
}

// ─── Shared Worker Message Types ───────────────────────────────────────────────

export interface BakeWorkerRequest {
  existingBitmap: ImageBitmap | null;
  existingLayerRect: { x: number; y: number; w: number; h: number } | null;
  strokeBitmap: ImageBitmap;
  canvasSize: { w: number; h: number };
  isNewLayer: boolean;
  strokeDirtyRect: { x: number; y: number; w: number; h: number } | null;
  existingLayerBounding: { w: number; h: number; cx: number; cy: number } | null;
}

export interface BakeWorkerResult {
  blob: Blob;
  bitmap: ImageBitmap;
  cropX: number;
  cropY: number;
  cropW: number;
  cropH: number;
  /** SHA-256 content hash of the blob, precomputed in Worker to avoid main-thread blocking. */
  hash: string;
}

// ─── Bake Request Types ────────────────────────────────────────────────────────

export interface PaintBakeRequest {
  type: 'paint';
  /** Stroke pixels as ImageBitmap (obtained via transferToImageBitmap, zero-copy) */
  strokeBitmap: ImageBitmap;
  /** Resolved target layer (existing or newly created) */
  targetLayer: Layer;
  /** Whether targetLayer is a newly created layer */
  isNewLayer: boolean;
  /** Document canvas dimensions */
  canvasSize: { w: number; h: number };
  /** Stroke dirty rect — tight bounding box of all processed blocks */
  strokeDirtyRect: { x: number; y: number; w: number; h: number } | null;
}

export type BakeRequest = PaintBakeRequest;

// ─── StrokeSession Interface ───────────────────────────────────────────────────

export interface StrokeSession {
  /** Preview canvas (read by StrokePreview component via getStrokeBuffer) */
  readonly previewCanvas: OffscreenCanvas;
  /** Dirty version counter (incremented on each move draw, for dirty detection) */
  readonly version: number;

  /** Start a stroke at the given point */
  begin(point: Point2D, pressure: number): void;
  /** Continue the stroke to a new point */
  move(point: Point2D, pressure: number, e: InteractionEvent): void;
  /** End the stroke, return bake request */
  end(frame: Frame): Promise<BakeRequest | null>;
}
