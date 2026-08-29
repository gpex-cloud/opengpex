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
 * MosaicStrokeSession — Mosaic (pixelation) stroke session
 *
 * Implements StrokeSession interface (same contract as PaintStrokeSession).
 *
 * Differences from PaintStrokeSession:
 * - constructor: accepts a composited bitmap promise (flattened visible layers)
 * - begin/move: draws pixelated blocks (instead of stamping dabs)
 * - Does not need smoothing / spacing
 *
 * Lifecycle:
 * 1. constructor: kicks off async composite resolve → sourceImageData
 * 2. begin: buffers point (or draws immediately if source ready)
 * 3. move: buffers point (or draws immediately if source ready)
 * 4. end: awaits sourceReady, finds or creates paint layer → outputs PaintBakeRequest
 *
 * Source pixel strategy — "What You See Is What Gets Pixelated":
 *   The source pixels come from `compositeFrame()`, which flattens ALL visible
 *   layers (background, fragments, paint strokes, text, adjustments, masks, etc.)
 *   into a single canvas-sized bitmap. This ensures mosaic samples the exact
 *   same pixels the user sees on screen, regardless of layer stack complexity.
 *
 *   The composite is async (~5-15ms). Points arriving before it resolves are
 *   buffered and replayed automatically — typically 0-1 points since the first
 *   pointermove fires ~16ms after pointerdown.
 *
 * Anti-duplication:
 *   Maintains Set<string> of processed block keys to prevent
 *   re-pixelating the same block within a single stroke.
 */

import type { Layer, Frame, InteractionEvent } from '@opengpex/editor/core/types';
import { LayerFactory } from '@opengpex/editor/core/layer';
import type { Point2D } from './smoothing';
import type { StrokeSession, PaintBakeRequest, BakeRequest } from './types';

// ─── Configuration ─────────────────────────────────────────────────────────────

export interface MosaicStrokeConfig {
  brushDiameter: number;
  blockSize: number;
  canvasSize: { w: number; h: number };
  /**
   * Downsample factor for the composited source ImageData.
   *
   * The source pixels are composited at `canvasSize * sampleScale` resolution
   * to reduce memory and compositing time for large canvases. All coordinate
   * lookups into sourceImageData are scaled by this factor.
   *
   * Typical values: 1.0 (≤4K), 0.5 (4K–8K), 0.25 (>8K).
   * Clamped so that blockSize maps to at least 2 sample pixels (adequate for
   * block-average color computation).
   */
  sampleScale: number;
}

// ─── MosaicStrokeSession ───────────────────────────────────────────────────────

export class MosaicStrokeSession implements StrokeSession {
  readonly isMaskEdit = false;

  private canvas: OffscreenCanvas;
  private ctx: OffscreenCanvasRenderingContext2D;
  private config: MosaicStrokeConfig;
  private processedBlocks = new Set<string>();
  private _version = 0;
  private forceNewLayer: boolean;

  // Deferred source — null until compositeFrame resolves
  private sourceImageData: ImageData | null = null;
  private sourceReady: Promise<void>;
  private bufferedPoints: Array<{ x: number; y: number }> = [];

  // Dirty rect tracking
  private dirtyMinX = Infinity;
  private dirtyMinY = Infinity;
  private dirtyMaxX = -Infinity;
  private dirtyMaxY = -Infinity;

  get previewCanvas(): OffscreenCanvas { return this.canvas; }
  get version(): number { return this._version; }

  constructor(config: MosaicStrokeConfig, compositePromise: Promise<ImageData>, forceNewLayer: boolean = false) {
    this.config = config;
    this.forceNewLayer = forceNewLayer;

    const { w, h } = config.canvasSize;

    // Create stroke buffer (empty transparent)
    this.canvas = new OffscreenCanvas(w, h);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('[MosaicStrokeSession] Failed to get 2D context');
    this.ctx = ctx;

    // Deferred source initialization:
    // compositeFrame flattens all visible layers asynchronously (~5-15ms).
    // Points arriving before resolution are buffered and replayed.
    this.sourceReady = compositePromise.then(imageData => {
      this.sourceImageData = imageData;

      // Replay any points that arrived before source was ready
      if (this.bufferedPoints.length > 0) {
        for (const pt of this.bufferedPoints) {
          this.pixelateAt(pt.x, pt.y);
        }
        this._version++;
        this.bufferedPoints = [];
      }
    });
  }

  begin(point: Point2D, _pressure: number): void {
    if (this.sourceImageData) {
      this.pixelateAt(point.x, point.y);
    } else {
      this.bufferedPoints.push({ x: point.x, y: point.y });
    }
    this._version++;
  }

  move(point: Point2D, _pressure: number, _e: InteractionEvent): void {
    if (this.sourceImageData) {
      this.pixelateAt(point.x, point.y);
    } else {
      this.bufferedPoints.push({ x: point.x, y: point.y });
    }
    this._version++;
  }

  async end(frame: Frame): Promise<BakeRequest | null> {
    // Ensure composite has resolved before finalizing
    await this.sourceReady;

    // If no blocks were processed, no-op
    if (this.dirtyMinX > this.dirtyMaxX) return null;

    const targetInfo = this.findOrCreatePaintLayer(frame);
    const strokeBitmap = await createImageBitmap(this.canvas);

    const request: PaintBakeRequest = {
      type: 'paint',
      strokeBitmap,
      targetLayer: targetInfo.layer,
      isNewLayer: targetInfo.isNew,
      canvasSize: this.config.canvasSize,
      strokeDirtyRect: {
        x: Math.floor(this.dirtyMinX),
        y: Math.floor(this.dirtyMinY),
        w: Math.ceil(this.dirtyMaxX) - Math.floor(this.dirtyMinX),
        h: Math.ceil(this.dirtyMaxY) - Math.floor(this.dirtyMinY),
      },
    };

    return request;
  }

  // ─── Paint Layer Resolution ────────────────────────────────────────────────

  /**
   * Finds an existing paint layer to write to, or creates a new one.
   *
   * Strategy:
   * 1. Active layer is paint type, unlocked, visible, AND has no bitmap masks → reuse
   * 2. Otherwise → create new "Mosaic" paint layer
   *
   * Note: layers with bitmapMasks are NOT reused because the mask would clip
   * newly painted content (the mask was applied to previous layer state and
   * doesn't account for the new stroke).
   */
  private findOrCreatePaintLayer(frame: Frame): { layer: Layer; isNew: boolean } {
    const activeLayerId = frame.activeLayerId;
    const activeLayer = activeLayerId ? frame.layers.byId[activeLayerId] : null;

    const hasMasks = activeLayer?.bitmapMasks && activeLayer.bitmapMasks.length > 0;
    if (!this.forceNewLayer && !hasMasks && activeLayer && activeLayer.type === 'paint' && !activeLayer.locked && activeLayer.visible) {
      return { layer: activeLayer, isNew: false };
    }

    // Create new Paint Layer
    const layersArray = frame.layers.order.map(id => frame.layers.byId[id]);
    const smartName = LayerFactory.getNewLayerName(layersArray, 'Mosaic');
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

  // ─── Pixelation Core ───────────────────────────────────────────────────────

  /**
   * Pixelates all blocks within brush radius of the given center point.
   * Uses a circular brush area check to determine which blocks to process.
   */
  private pixelateAt(cx: number, cy: number): void {
    const { blockSize, brushDiameter, canvasSize } = this.config;
    const radius = brushDiameter / 2;

    // Determine block range that could be affected
    const startBX = Math.floor((cx - radius) / blockSize);
    const startBY = Math.floor((cy - radius) / blockSize);
    const endBX = Math.floor((cx + radius) / blockSize);
    const endBY = Math.floor((cy + radius) / blockSize);

    for (let by = startBY; by <= endBY; by++) {
      for (let bx = startBX; bx <= endBX; bx++) {
        const key = `${bx},${by}`;
        if (this.processedBlocks.has(key)) continue;

        const px = bx * blockSize;
        const py = by * blockSize;

        // Skip blocks completely outside canvas
        if (px + blockSize <= 0 || py + blockSize <= 0) continue;
        if (px >= canvasSize.w || py >= canvasSize.h) continue;

        // Circular brush check: block center must be within brush radius
        const blockCx = px + blockSize / 2;
        const blockCy = py + blockSize / 2;
        const dx = blockCx - cx;
        const dy = blockCy - cy;
        if (dx * dx + dy * dy > radius * radius) continue;

        // Pixelate this block
        this.pixelateBlock(px, py, blockSize);
        this.processedBlocks.add(key);

        // Update dirty rect
        this.dirtyMinX = Math.min(this.dirtyMinX, px);
        this.dirtyMinY = Math.min(this.dirtyMinY, py);
        this.dirtyMaxX = Math.max(this.dirtyMaxX, px + blockSize);
        this.dirtyMaxY = Math.max(this.dirtyMaxY, py + blockSize);
      }
    }
  }

  /**
   * Computes the average color of a block from source pixels
   * and fills that block on the stroke buffer.
   *
   * Source ImageData may be downsampled (sampleScale < 1). Canvas-space
   * coordinates are mapped to sample-space for pixel lookups, while
   * fillRect still operates in full canvas coordinates.
   */
  private pixelateBlock(px: number, py: number, size: number): void {
    const { canvasSize, sampleScale } = this.config;
    const sourceData = this.sourceImageData!; // guaranteed non-null: called only after sourceReady
    const data = sourceData.data;
    const sW = sourceData.width;
    const stride = sW * 4;

    // Map canvas-space block bounds to sample-space
    const sx0 = Math.max(0, Math.floor(px * sampleScale));
    const sy0 = Math.max(0, Math.floor(py * sampleScale));
    const sx1 = Math.min(sW, Math.ceil((px + size) * sampleScale));
    const sy1 = Math.min(sourceData.height, Math.ceil((py + size) * sampleScale));

    // Compute average color of pixels in the block (sample-space)
    let totalR = 0, totalG = 0, totalB = 0, totalA = 0;
    let count = 0;

    for (let y = sy0; y < sy1; y++) {
      const rowOffset = y * stride;
      for (let x = sx0; x < sx1; x++) {
        const i = rowOffset + x * 4;
        totalR += data[i];
        totalG += data[i + 1];
        totalB += data[i + 2];
        totalA += data[i + 3];
        count++;
      }
    }

    if (count === 0) return;

    // Fill block with average color (canvas-space coordinates)
    const avgR = Math.round(totalR / count);
    const avgG = Math.round(totalG / count);
    const avgB = Math.round(totalB / count);
    const avgA = Math.round(totalA / count) / 255;

    // Clamp fill rect to canvas bounds
    const x0 = Math.max(0, px);
    const y0 = Math.max(0, py);
    const x1 = Math.min(canvasSize.w, px + size);
    const y1 = Math.min(canvasSize.h, py + size);

    this.ctx.fillStyle = `rgba(${avgR}, ${avgG}, ${avgB}, ${avgA})`;
    this.ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  }
}
