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
 * - constructor: additionally reads source layer sourceImageData (for block average calculation)
 * - begin/move: draws pixelated blocks (instead of stamping dabs)
 * - Does not need smoothing / spacing
 *
 * Lifecycle:
 * 1. constructor: reads source layer pixels → sourceImageData
 * 2. begin: draws starting point blocks on strokeBuffer
 * 3. move: draws blocks along stroke path on strokeBuffer
 * 4. end: finds or creates paint layer → outputs PaintBakeRequest
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
}

// ─── MosaicStrokeSession ───────────────────────────────────────────────────────

export class MosaicStrokeSession implements StrokeSession {
  readonly isMaskEdit = false;

  private canvas: OffscreenCanvas;
  private ctx: OffscreenCanvasRenderingContext2D;
  private config: MosaicStrokeConfig;
  private sourceImageData: ImageData;
  private processedBlocks = new Set<string>();
  private _version = 0;

  // Dirty rect tracking
  private dirtyMinX = Infinity;
  private dirtyMinY = Infinity;
  private dirtyMaxX = -Infinity;
  private dirtyMaxY = -Infinity;

  get previewCanvas(): OffscreenCanvas { return this.canvas; }
  get version(): number { return this._version; }

  constructor(config: MosaicStrokeConfig, sourceLayer: Layer, sourceBitmap: ImageBitmap) {
    this.config = config;

    const { w, h } = config.canvasSize;

    // Create stroke buffer (empty transparent)
    this.canvas = new OffscreenCanvas(w, h);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('[MosaicStrokeSession] Failed to get 2D context');
    this.ctx = ctx;

    // Read source layer pixels into ImageData for block averaging
    const tmpCanvas = new OffscreenCanvas(w, h);
    const tmpCtx = tmpCanvas.getContext('2d')!;

    const drawX = w / 2 + sourceLayer.cx - sourceLayer.bounding.w / 2;
    const drawY = h / 2 + sourceLayer.cy - sourceLayer.bounding.h / 2;
    tmpCtx.drawImage(sourceBitmap, drawX, drawY, sourceLayer.bounding.w, sourceLayer.bounding.h);

    this.sourceImageData = tmpCtx.getImageData(0, 0, w, h);
  }

  begin(point: Point2D, _pressure: number): void {
    this.pixelateAt(point.x, point.y);
    this._version++;
  }

  move(point: Point2D, _pressure: number, _e: InteractionEvent): void {
    this.pixelateAt(point.x, point.y);
    this._version++;
  }

  async end(frame: Frame): Promise<BakeRequest | null> {
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
   * 1. Active layer is paint type, unlocked, visible → reuse
   * 2. Otherwise → create new "Mosaic" paint layer
   */
  private findOrCreatePaintLayer(frame: Frame): { layer: Layer; isNew: boolean } {
    const activeLayerId = frame.activeLayerId;
    const activeLayer = activeLayerId ? frame.layers.byId[activeLayerId] : null;

    if (activeLayer && activeLayer.type === 'paint' && !activeLayer.locked && activeLayer.visible) {
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
   */
  private pixelateBlock(px: number, py: number, size: number): void {
    const { canvasSize } = this.config;
    const data = this.sourceImageData.data;
    const stride = canvasSize.w * 4;

    // Clamp block to canvas bounds
    const x0 = Math.max(0, px);
    const y0 = Math.max(0, py);
    const x1 = Math.min(canvasSize.w, px + size);
    const y1 = Math.min(canvasSize.h, py + size);

    // Compute average color of pixels in the block
    let totalR = 0, totalG = 0, totalB = 0, totalA = 0;
    let count = 0;

    for (let y = y0; y < y1; y++) {
      const rowOffset = y * stride;
      for (let x = x0; x < x1; x++) {
        const i = rowOffset + x * 4;
        totalR += data[i];
        totalG += data[i + 1];
        totalB += data[i + 2];
        totalA += data[i + 3];
        count++;
      }
    }

    if (count === 0) return;

    // Fill block with average color
    const avgR = Math.round(totalR / count);
    const avgG = Math.round(totalG / count);
    const avgB = Math.round(totalB / count);
    const avgA = Math.round(totalA / count) / 255;

    this.ctx.fillStyle = `rgba(${avgR}, ${avgG}, ${avgB}, ${avgA})`;
    this.ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  }
}
