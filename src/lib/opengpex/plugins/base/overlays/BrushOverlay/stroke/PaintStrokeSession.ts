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
 * PaintStrokeSession — Normal brush painting session
 *
 * Manages the lifecycle of a single paint stroke:
 * - OffscreenCanvas creation + 2D context initialization
 * - StampEngine with pre-rendered dab for efficient rendering
 * - Smoother lifecycle (begin/addPoint/finish)
 * - Target layer resolution on end
 */

import type { Layer, Frame, InteractionEvent } from '@opengpex/editor/core/types';
import { LayerFactory } from '@opengpex/editor/core/layer';
import { StrokeSmoother, type Point2D } from './smoothing';
import { StampEngine } from './stamp';
import type { StrokeSession, StrokeConfig, PaintBakeRequest, BakeRequest } from './types';

// ─── PaintStrokeSession ────────────────────────────────────────────────────────

export class PaintStrokeSession implements StrokeSession {
  readonly isMaskEdit = false;

  private canvas: OffscreenCanvas;
  private ctx: OffscreenCanvasRenderingContext2D;
  private smoother: StrokeSmoother;
  private stamp: StampEngine;
  private lastDrawnPoint: Point2D | null = null;
  private lastPoint: Point2D | null = null;
  private pointCount = 0;
  private _version = 0;

  private config: StrokeConfig;
  private forceNewLayer: boolean;

  get previewCanvas(): OffscreenCanvas {
    return this.canvas;
  }

  get version(): number {
    return this._version;
  }

  constructor(config: StrokeConfig, forceNewLayer: boolean) {
    this.config = config;
    this.forceNewLayer = forceNewLayer;

    const { canvasSize } = config;
    this.canvas = new OffscreenCanvas(canvasSize.w, canvasSize.h);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('[PaintStrokeSession] Failed to get OffscreenCanvas 2D context');
    this.ctx = ctx;

    // Create pre-rendered stamp engine (dab bitmap created once here)
    this.stamp = new StampEngine(
      config.brushSize, config.brushHardness,
      config.brushColor, config.brushOpacity,
    );

    this.smoother = new StrokeSmoother();
  }

  begin(point: Point2D, _pressure: number): void {
    this.lastPoint = point;
    this.lastDrawnPoint = point;
    this.pointCount = 1;

    // Initialize stamp position
    this.stamp.lastStampX = point.x;
    this.stamp.lastStampY = point.y;

    // Stamp a dab at the start point
    this.stamp.stampAt(this.ctx, point.x, point.y);

    // Initialize Catmull-Rom smoother
    this.smoother.begin(point);
  }

  move(point: Point2D, _pressure: number, _e: InteractionEvent): void {
    if (!this.lastPoint) return;

    const dx = point.x - this.lastPoint.x;
    const dy = point.y - this.lastPoint.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 2) return;

    this.pointCount++;
    const smoothPoints = this.smoother.addPoint(point);

    if (smoothPoints.length > 0 && this.lastDrawnPoint) {
      // Stamp along smooth path (single drawImage per stamp, GPU-accelerated)
      this.stamp.stampAlongPath(this.ctx, smoothPoints);
      this.lastDrawnPoint = smoothPoints[smoothPoints.length - 1];
    } else if (this.pointCount === 2 && this.lastDrawnPoint) {
      // First two points do not have smooth data yet, stamp with line
      this.stamp.stampAlongPath(this.ctx, [point]);
    }

    this.lastPoint = point;
    this._version++;
  }

  async end(frame: Frame): Promise<BakeRequest | null> {
    // Flush trailing segment from smoother
    if (this.lastDrawnPoint) {
      const finalSegment = this.smoother.finish();
      if (finalSegment.length > 0) {
        this.stamp.stampAlongPath(this.ctx, finalSegment);
        this._version++;
      }
    }

    // Resolve target layer
    const targetLayerInfo = this.findOrCreatePaintLayer(frame);
    if (!targetLayerInfo) return null;

    // Create bitmap copy (keeps preview canvas intact so overlay continues
    // showing the stroke until bake completes — prevents flash on mouse release)
    const strokeBitmap = await createImageBitmap(this.canvas);

    const request: PaintBakeRequest = {
      type: 'paint',
      strokeBitmap,
      targetLayer: targetLayerInfo.layer,
      isNewLayer: targetLayerInfo.isNew,
      canvasSize: this.config.canvasSize,
      strokeDirtyRect: this.stamp.getDirtyRect(),
    };

    return request;
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  /**
   * Determines target Paint Layer for writing the stroke.
   *
   * Strategy:
   * 1. Current active layer is paint type and unlocked -> reuse directly (unless forceNewLayer)
   * 2. Current active layer is other type -> create new Paint Layer above it
   * 3. No layer on canvas -> create Paint Layer automatically
   */
  private findOrCreatePaintLayer(frame: Frame): { layer: Layer; isNew: boolean } {
    const activeLayerId = frame.activeLayerId;
    const activeLayer = activeLayerId ? frame.layers.byId[activeLayerId] : null;

    // Case 1: Current active layer is a paintable paint layer
    if (!this.forceNewLayer && activeLayer && isPaintLayerCandidate(activeLayer)) {
      return { layer: activeLayer, isNew: false };
    }

    // Case 2 & 3: Create new Paint Layer
    const layersArray = frame.layers.order.map(id => frame.layers.byId[id]);
    const smartName = LayerFactory.getNewLayerName(layersArray, 'Paint');
    const newLayer = LayerFactory.getNewLayer({
      name: smartName,
      type: 'paint',
      cx: 0,
      cy: 0,
      bounding: { w: frame.canvas.w, h: frame.canvas.h },
      visible: true,
    });

    return { layer: newLayer, isNew: true };
  }
}

// ─── Helper ────────────────────────────────────────────────────────────────────

/**
 * Determines if layer can be a target Paint Layer.
 *
 * Conditions:
 * - type === 'paint' (dedicated paint layer type)
 * - unlocked and visible
 * - no active bitmap mask
 */
function isPaintLayerCandidate(layer: Layer): boolean {
  return (
    layer.type === 'paint' &&
    !layer.locked &&
    layer.visible &&
    !layer.bitmapMasks?.some(m => m.enabled)
  );
}
