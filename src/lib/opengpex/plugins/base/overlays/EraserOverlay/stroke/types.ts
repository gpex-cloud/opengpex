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
  /**
   * Tool-neutral field names mirroring BrushOverlay's `PaintParams` / the shared
   * CraftDrawer panel — values are resolved from the PERSISTED panel keys
   * (`craftConfig.brushSize` etc.) once at session start. No colour field: mask
   * edits always stamp pure white (`MaskStrokeSession` hardcodes it).
   */
  size: number;
  opacity: number;   // 0-100
  hardness: number;  // 0-100
  /**
   * HARD mask edge ("pencil eraser"): the GPU thresholds the sampled mask alpha
   * at 0.5 for a binary edge. Resolved once at session start from the panel's
   * AA toggle (two-way bound to hardness: AA on ⇒ hardness 100, but AA off is a
   * deliberate choice at any hardness). Drives BOTH the live preview override
   * and the baked `BitmapMask.hard`, so preview == landing. Named `hard` (not
   * `antiAliased`) because it belongs to the bmask sampling-threshold family —
   * same name and polarity all the way to `BitmapMask.hard`.
   */
  hard: boolean;
  canvasSize: { w: number; h: number };
}

// ─── Bake Request Types ────────────────────────────────────────────────────────

/**
 * ONE record write inside a stroke's bake. A single stroke may commit SEVERAL
 * records at once (an erase op updates the erase-family record AND white
 * hole-fills every painted restore-family record), and all of them must land
 * as ONE undoable unit — see `MaskBakeRequest.records`.
 */
export interface MaskBakeRecord {
  /** Encoded mask canvas (WebP lossless) */
  blob: Blob;
  /**
   * THE record identity, decided once at session open by the family targeting:
   * an existing record's id when this stroke continues it, or the session's
   * transient id (`mask-*-erase` / `mask-*-restore`) for a brand-new record.
   * The batch command routes on its own membership lookup (id present → update,
   * absent → create + adopt) — no separate add/update flag is needed, because
   * a transient id is guaranteed absent until the bake adopts it.
   */
  maskId: string;
  /**
   * Record FAMILY (persisted as `BitmapMask.inverted` when the batch lands as
   * a create; an existing record's family is never rewritten): `false` = erase
   * family, `true` = restore family.
   */
  inverted: boolean;
  /** HARD mask edge — persisted as `BitmapMask.hard` (same value the live preview used) */
  hard: boolean;
}

export interface MaskBakeRequest {
  type: 'mask';
  /** Target layer ID for the masks */
  targetLayerId: string;
  /**
   * ALL records this stroke modified, committed as ONE undoable batch. Every
   * entry whose canvas received stamps (or hole-fills) is listed — the erase
   * record AND each hole-filled restore record — so the bake preserves the
   * "erase and hole-fill move together" invariant across undo/redo.
   */
  records: MaskBakeRecord[];
  /**
   * Mask placement in layer-local space (identical for every record of the
   * stroke — all canvases cover the layer bounding).
   *
   * `w/h` = target layer bounding. `x/y` = the layer-local ORIGIN the mask
   * canvases are anchored to (`LayerUtils.getMaskOrigin`) — non-zero for
   * zero-copy logical fragments and for imported layers with a `contentBounds`
   * offset, `(0,0)` for regular full-layer images. Written verbatim into
   * `BitmapMask.bounds`, which both the main-thread and Worker composite
   * branches consume as-is.
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
  /**
   * End the stroke, flush trailing smoother segment, return bake request.
   * `upPoint` is the pointerup position — the stroke must end exactly where
   * the pointer was released (BrushOverlay parity), even when the <2px move
   * gate dropped the final micro-moves. Omitted → the last move point.
   * `e` dispatches the FINAL live preview covering the trailing segment and
   * the final cap (they land after the last move's dispatch; without it the
   * preview ends short of the baked result).
   */
  end(frame: Frame, upPoint?: Point2D, e?: InteractionEvent): Promise<BakeRequest | null>;
}
