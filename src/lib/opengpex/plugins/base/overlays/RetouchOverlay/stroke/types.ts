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

import type { Layer, Frame, InteractionEvent, LayerSourceTool } from '@opengpex/editor/core/types';

export interface Point2D {
  x: number;
  y: number;
}

// ─── Variant Mode ──────────────────────────────────────────────────────────────

/**
 * Which retouch-family variant the overlay synthesizes under the single
 * mosaic craft button: 'mosaic' pixelates blocks; 'heal' spot-heals stamps
 * from a ring band (A2); 'blur'/'sharpen' run convolution stamps (A5);
 * 'clone' copies pixels from a user-picked source anchor (A4).
 */
export type RetouchMode = 'mosaic' | 'heal' | 'blur' | 'sharpen' | 'clone';

/**
 * Exhaustive whitelist of every session mode (single source of truth). The
 * ORDER is the panel display / Tab-cycle ring order (by usage frequency:
 * heal → clone → mosaic → blur → sharpen).
 */
export const RETOUCH_SESSION_MODES: readonly RetouchMode[] = ['heal', 'clone', 'mosaic', 'blur', 'sharpen'];

/** Default retouch mode when nothing (or an unknown value) is persisted. */
const DEFAULT_RETOUCH_MODE: RetouchMode = 'clone';

/**
 * Normalizes a persisted mode value against the whitelist. Unknown/omitted
 * values fall back to DEFAULT_RETOUCH_MODE ('clone') — the panel hook and the
 * session factory share this single normalization so a stale/partial config
 * can never route a stroke to the wrong kernel (previously each site
 * hand-rolled `=== 'heal' ? … : …`, which silently swallowed any new mode).
 */
export function normalizeMosaicMode(value: unknown): RetouchMode {
  return RETOUCH_SESSION_MODES.includes(value as RetouchMode) ? (value as RetouchMode) : DEFAULT_RETOUCH_MODE;
}

/** The paint-layer stamp each mode bakes into its layer's metadata. */
export const MODE_SOURCE_TOOL: Record<RetouchMode, LayerSourceTool> = {
  mosaic: 'mosaic',
  heal: 'heal',
  blur: 'blur',
  sharpen: 'sharpen',
  clone: 'clone',
};

/** Layer-family base name each mode owns for smart layer naming. */
export const MODE_LAYER_NAME: Record<RetouchMode, string> = {
  mosaic: 'Mosaic',
  heal: 'Heal',
  blur: 'Blur',
  sharpen: 'Sharpen',
  clone: 'Clone',
};

// ─── Shared Stamp-Path Parameters ──────────────────────────────────────────────

/**
 * Stamp-path parameters shared by every arc-length-spaced retouch mode
 * (heal/clone today; smudge and friends later). The session feeds these to
 * the ArcLengthFollower; kernels stay geometry-only and never see spacing.
 */
export interface RetouchStampParams {
  /** Stamp (brush) diameter in canvas pixels. */
  brushDiameter: number;
  /**
   * Distance between consecutive stamps as a fraction of the brush diameter
   * (the Photoshop Spacing semantics). The Photoshop default is 0.25.
   */
  spacingRatio: number;
}

/** The family default spacing (PS default): a stamp every 25% of the diameter. */
export const RETOUCH_SPACING_RATIO = 0.25;

/**
 * Spacing for (near-)hard brushes: soft-edge feathering is what hides the
 * tiny union-boundary dip between neighboring stamps (~s²/8r); a hard edge
 * exposes it as scalloping, so hard brushes tighten to 10% of the diameter
 * (dip ≈ 0.005r — sub-pixel at every preset).
 */
export const RETOUCH_HARD_SPACING_RATIO = 0.1;

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
  type: 'image';
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
