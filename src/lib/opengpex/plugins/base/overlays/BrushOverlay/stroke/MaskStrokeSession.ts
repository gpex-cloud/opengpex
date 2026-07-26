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
 * MaskStrokeSession — Mask editing session (eraser/restore)
 *
 * Manages the lifecycle of a non-destructive mask editing stroke:
 * - Mask OffscreenCanvas creation + existing mask loading
 * - Coordinate transformation (canvas-local → layer-local)
 * - StampEngine with pre-rendered dab for efficient rendering in local space
 * - Real-time fast-track override for live preview
 */

import type { Frame, InteractionEvent, IMatrix3x3 } from '@opengpex/editor/core/types';
import { CraftDrawerAPI } from '../../../drawers/CraftDrawer/protocols';
import { StrokeSmoother, type Point2D } from './smoothing';
import { StampEngine } from './stamp';
import type { StrokeSession, StrokeConfig, MaskBakeRequest, BakeRequest } from './types';

/** Shared signal key for active craft */
const ACTIVE_CRAFT_KEY = CraftDrawerAPI.signals.activeCraft;

// ─── Construction Params ───────────────────────────────────────────────────────

export interface MaskSessionParams {
  config: StrokeConfig;
  isEraser: boolean;
  isRestore: boolean;
  targetLayerId: string;
  maskId: string;
  existingMaskId: string | undefined;
  maskCanvas: OffscreenCanvas;
  maskCtx: OffscreenCanvasRenderingContext2D;
  localMatrixInverse: IMatrix3x3;
  localBrushSize: number;
  frameId: string;
}

// ─── MaskStrokeSession ─────────────────────────────────────────────────────────

export class MaskStrokeSession implements StrokeSession {
  readonly isMaskEdit = true;

  private placeholderCanvas: OffscreenCanvas;
  private maskCanvas: OffscreenCanvas;
  private maskCtx: OffscreenCanvasRenderingContext2D;
  private smoother: StrokeSmoother;
  private stamp: StampEngine;
  private lastDrawnPoint: Point2D | null = null;
  private lastPoint: Point2D | null = null;
  private pointCount = 0;
  private _version = 0;

  private localMatrixInverse: IMatrix3x3;
  private config: StrokeConfig;

  private isEraser: boolean;
  private targetLayerId: string;
  private maskId: string;
  private existingMaskId: string | undefined;
  private frameId: string;

  /** Tracks the current eraser/restore mode (may toggle via Tab during stroke) */
  private currentIsRestore: boolean;

  get previewCanvas(): OffscreenCanvas {
    return this.placeholderCanvas;
  }

  get version(): number {
    return this._version;
  }

  constructor(params: MaskSessionParams) {
    this.config = params.config;
    this.isEraser = params.isEraser;
    this.currentIsRestore = params.isRestore;
    this.targetLayerId = params.targetLayerId;
    this.maskId = params.maskId;
    this.existingMaskId = params.existingMaskId;
    this.maskCanvas = params.maskCanvas;
    this.maskCtx = params.maskCtx;
    this.localMatrixInverse = params.localMatrixInverse;
    this.frameId = params.frameId;

    // Placeholder canvas for StrokePreview interface (mask preview uses fast.override)
    this.placeholderCanvas = new OffscreenCanvas(1, 1);

    // Create pre-rendered stamp engine in local space (white color for mask, local brush size)
    this.stamp = new StampEngine(
      params.localBrushSize, params.config.brushHardness,
      '#FFFFFF', params.config.brushOpacity,
    );

    this.smoother = new StrokeSmoother();
  }

  begin(point: Point2D, _pressure: number): void {
    this.lastPoint = point;
    this.lastDrawnPoint = point;
    this.pointCount = 1;

    // Transform start point to local (layer) coordinates
    const localPoint = this.localMatrixInverse.apply(point);

    // Initialize stamp position in local space
    this.stamp.lastStampX = localPoint.x;
    this.stamp.lastStampY = localPoint.y;

    // Draw initial stamp dot with appropriate composite operation
    this.maskCtx.save();
    this.maskCtx.globalCompositeOperation = this.isEraser ? 'destination-out' : 'source-over';
    this.stamp.stampAt(this.maskCtx, localPoint.x, localPoint.y);
    this.maskCtx.restore();

    // Initialize smoother
    this.smoother.begin(point);
  }

  move(point: Point2D, pressure: number, e: InteractionEvent): void {
    if (!this.lastPoint) return;

    const dx = point.x - this.lastPoint.x;
    const dy = point.y - this.lastPoint.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 2) return;

    this.pointCount++;
    const smoothPoints = this.smoother.addPoint(point);

    // Determine erase vs restore from current craft signal (toggled via Tab key)
    const craft = e.state.interaction.signals[ACTIVE_CRAFT_KEY] as string;
    this.currentIsRestore = craft === 'restore';

    // Transform smooth points to local space
    const localSmoothPoints = smoothPoints.map(p => this.localMatrixInverse.apply(p));

    this.maskCtx.save();
    this.maskCtx.globalCompositeOperation = this.currentIsRestore ? 'source-over' : 'destination-out';

    if (localSmoothPoints.length > 0) {
      this.stamp.stampAlongPath(this.maskCtx, localSmoothPoints);
      this.lastDrawnPoint = smoothPoints[smoothPoints.length - 1];
    } else if (this.pointCount === 2) {
      const localNewPoint = this.localMatrixInverse.apply(point);
      this.stamp.stampAlongPath(this.maskCtx, [localNewPoint]);
    }

    this.maskCtx.restore();

    // Trigger real-time fast-track override for live preview
    e.actions.fast.override(this.frameId, this.targetLayerId, {
      bitmapMaskOverride: { maskId: this.maskId, source: this.maskCanvas },
    }, 'layer');

    this.lastPoint = point;
    this._version++;
  }

  async end(_frame: Frame): Promise<BakeRequest | null> {
    // Flush trailing segment from smoother
    if (this.lastDrawnPoint) {
      const finalSegment = this.smoother.finish();
      if (finalSegment.length > 0) {
        const localFinalSegment = finalSegment.map(p => this.localMatrixInverse.apply(p));

        this.maskCtx.save();
        this.maskCtx.globalCompositeOperation = this.currentIsRestore ? 'source-over' : 'destination-out';
        this.stamp.stampAlongPath(this.maskCtx, localFinalSegment);
        this.maskCtx.restore();

        this._version++;
      }
    }

    // Encode mask canvas to WebP lossless (3-4x faster than PNG, pixel-perfect)
    const blob = await this.maskCanvas.convertToBlob({ type: 'image/webp', quality: 1.0 });

    const request: MaskBakeRequest = {
      type: 'mask',
      blob,
      maskId: this.maskId,
      targetLayerId: this.targetLayerId,
      existingMaskId: this.existingMaskId,
      maskBounds: {
        w: this.maskCanvas.width,
        h: this.maskCanvas.height,
      },
    };

    return request;
  }
}
