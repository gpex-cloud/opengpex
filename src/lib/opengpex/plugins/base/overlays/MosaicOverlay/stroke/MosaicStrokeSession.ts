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
 * Implements StrokeSession interface.
 *
 * Lifecycle:
 * 1. constructor: kicks off async composite resolve → sourceImageData
 * 2. begin: buffers point (or draws immediately if source ready)
 * 3. move: buffers point (or draws immediately if source ready)
 * 4. end: awaits sourceReady, finds or creates paint layer → outputs PaintBakeRequest
 *
 * Source pixel strategy — "What You See Is What Gets Pixelated":
 *   The source pixels come from `capture()`, which flattens ALL visible
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

import type { Layer, Frame, InteractionEvent, LocalPolygon } from '@opengpex/editor/core/types';
import { LayerFactory } from '@opengpex/editor/core/layer';
import type { Point2D, StrokeSession, PaintBakeRequest, BakeRequest } from './types';

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

  /** Selection-confinement snapshot (canvas coords, gesture-start reference) — see factory. */
  private confinement: LocalPolygon | null;

  constructor(config: MosaicStrokeConfig, compositePromise: Promise<ImageData>, forceNewLayer: boolean = false, confinement: LocalPolygon | null = null) {
    this.config = config;
    this.forceNewLayer = forceNewLayer;
    this.confinement = confinement;

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
      if (this.config.canvasSize.w > 0) {
        this.config.sampleScale = imageData.width / this.config.canvasSize.w;
      }

      // Replay any points that arrived before source was ready
      if (this.bufferedPoints.length > 0) {
        for (const pt of this.bufferedPoints) {
          this.pixelateAt(pt.x, pt.y);
        }
        // Same confinement contract as begin()/move(): a buffered point may
        // sit outside the selection — clip before the replayed blocks reach
        // the preview, or a first press outside the selection would flash a
        // mosaic dot that then vanishes on the next move.
        this.applyConfinementClip();
        this._version++;
        this.bufferedPoints = [];
      }
    }).catch(err => {
      console.warn('[MosaicStrokeSession] Failed to load composite source:', err);
    });
  }

  begin(point: Point2D, _pressure: number): void {
    if (this.sourceImageData) {
      this.pixelateAt(point.x, point.y);
      this.applyConfinementClip();
    } else {
      this.bufferedPoints.push({ x: point.x, y: point.y });
    }
    this._version++;
  }

  move(point: Point2D, _pressure: number, _e: InteractionEvent): void {
    if (this.sourceImageData) {
      this.pixelateAt(point.x, point.y);
      this.applyConfinementClip();
    } else {
      this.bufferedPoints.push({ x: point.x, y: point.y });
    }
    this._version++;
  }

  /**
   * Live confinement clip: keeps the stroke buffer clean at all times so the
   * preview shows mosaic ONLY inside the selection (the preview renders this
   * canvas directly — there is no downstream multiply to rely on). Re-applied
   * after every stamp: the operation keeps everything inside the polygon and
   * clears whatever a stamp just added outside it, so it is idempotent and
   * costs one canvas-sized composite per move.
   */
  private applyConfinementClip(): void {
    if (!this.confinement) return;
    this.ctx.save();
    this.ctx.globalCompositeOperation = 'destination-in';
    this.ctx.beginPath();
    for (const ring of this.confinement.rings) {
      for (let i = 0; i < ring.length; i++) {
        if (i === 0) this.ctx.moveTo(ring[i].x, ring[i].y);
        else this.ctx.lineTo(ring[i].x, ring[i].y);
      }
      this.ctx.closePath();
    }
    this.ctx.fill('evenodd');
    this.ctx.restore();
  }

  async end(frame: Frame): Promise<BakeRequest | null> {
    // Ensure composite has resolved before finalizing
    await this.sourceReady;

    // If no blocks were processed, no-op
    if (this.dirtyMinX > this.dirtyMaxX) return null;

    // Selection confinement: clip the stroke buffer to the frozen selection
    // polygon (destination-in, even-odd) before handing the bitmap to the
    // bake — mosaic then only paints inside the selection, and the clip is
    // part of the committed pixels (undo/redo replays stay self-sufficient).
    // The session canvas IS canvas space, so the polygon needs no transform.
    if (this.confinement) {
      this.ctx.globalCompositeOperation = 'destination-in';
      this.ctx.beginPath();
      for (const ring of this.confinement.rings) {
        for (let i = 0; i < ring.length; i++) {
          if (i === 0) this.ctx.moveTo(ring[i].x, ring[i].y);
          else this.ctx.lineTo(ring[i].x, ring[i].y);
        }
        this.ctx.closePath();
      }
      this.ctx.fill('evenodd');
      this.ctx.globalCompositeOperation = 'source-over';
    }

    // Content check AFTER the confinement clip: blocks drawn inside the
    // selection's bounding rect but outside an IRREGULAR selection polygon
    // were cleared by the clip — if nothing survived, do not bake at all
    // (a bake would create an empty mosaic layer for a click that never
    // painted anything). Scans the dirty rect only.
    const sx = Math.max(0, Math.floor(this.dirtyMinX));
    const sy = Math.max(0, Math.floor(this.dirtyMinY));
    const sw = Math.min(this.config.canvasSize.w, Math.ceil(this.dirtyMaxX)) - sx;
    const sh = Math.min(this.config.canvasSize.h, Math.ceil(this.dirtyMaxY)) - sy;
    if (sw > 0 && sh > 0) {
      const data = this.ctx.getImageData(sx, sy, sw, sh).data;
      let anyPaint = false;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 0) { anyPaint = true; break; }
      }
      if (!anyPaint) return null;
    }

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
      metadata: { sourceTool: 'mosaic' },
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

        // Skip blocks completely outside the selection: a block whose whole
        // area sits beyond the confinement rect would be clipped away by the
        // confinement compose anyway, but drawing it first would still mark
        // the session dirty — end() would then create an EMPTY mosaic layer
        // for a click that never painted anything (observed on-device).
        // Blocks straddling the selection edge still draw here; the clip
        // trims the overhang.
        if (this.confinement) {
          const r = this.confinement.rect;
          if (px + blockSize <= r.x || px >= r.x + r.w) continue;
          if (py + blockSize <= r.y || py >= r.y + r.h) continue;
        }

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
    const sx1 = Math.min(sW, Math.max(sx0 + 1, Math.ceil((px + size) * sampleScale)));
    const sy1 = Math.min(sourceData.height, Math.max(sy0 + 1, Math.ceil((py + size) * sampleScale)));

    const spanX = sx1 - sx0;
    const spanY = sy1 - sy0;
    if (spanX <= 0 || spanY <= 0) return;

    // Adaptive grid step: cap maximum sample points per block dimension to ~5 (up to 25-36 samples).
    // An evenly spaced 5×5 grid yields a statistically identical block-average color while reducing
    // CPU iterations from thousands down to ≤36 per block, pinning drag performance at 120 FPS.
    const stepX = Math.max(1, Math.floor(spanX / 5));
    const stepY = Math.max(1, Math.floor(spanY / 5));

    let totalR = 0, totalG = 0, totalB = 0, totalA = 0;
    let count = 0;

    for (let y = sy0; y < sy1; y += stepY) {
      const rowOffset = y * stride;
      for (let x = sx0; x < sx1; x += stepX) {
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
    if (avgA <= 0) return;

    // Clamp fill rect to canvas bounds
    const x0 = Math.max(0, px);
    const y0 = Math.max(0, py);
    const x1 = Math.min(canvasSize.w, px + size);
    const y1 = Math.min(canvasSize.h, py + size);

    this.ctx.fillStyle = `rgba(${avgR}, ${avgG}, ${avgB}, ${avgA})`;
    this.ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  }
}
