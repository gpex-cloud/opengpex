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
 * RetouchStrokeSession (class name kept: RetouchStrokeSession) — shared stroke
 * orchestration for the retouch family (mosaic/heal/blur/sharpen/clone).
 *
 * Lifecycle:
 * 1. constructor: kicks off async composite resolve → sourceImageData
 * 2. begin: buffers point (or stamps immediately if source ready)
 * 3. move: arc-length follower emits evenly spaced stamp positions
 *    (heal/clone) or forwards the point (mosaic — its essence is the block
 *    grid, not path spacing)
 * 4. end: awaits sourceReady, finds or creates paint layer → PaintBakeRequest
 *
 * Source pixel strategy — "What You See Is What Gets Stamped":
 *   The source pixels come from capture(), which flattens ALL visible
 *   layers (background, fragments, paint strokes, text, adjustments, masks,
 *   etc.) into a single canvas-sized bitmap. Every mode samples this same
 *   snapshot; the active layer only decides where the result is baked.
 *
 * Stamp placement — arc length, not event rate:
 *   heal/clone stamp through ArcLengthFollower (follow.ts) so consecutive
 *   stamps sit exactly spacingRatio x diameter apart along the path. The
 *   old hash-grid dedupe quantized stamp positions to grid-cell entry points,
 *   making stamp distances swing randomly — the direct cause of scalloped
 *   stroke edges. Pointer event coalescing is now irrelevant to density.
 *
 * Anti-self-feedback (clone):
 *   The kernel source is always the session-start composite, never the live
 *   stroke buffer, so cloned output can never feed a later stamp.
 */

import type { Layer, Frame, InteractionEvent, LocalPolygon } from '@opengpex/editor/core/types';
import { LayerFactory } from '@opengpex/editor/core/layer';
import type { LayerService } from '@opengpex/editor/core/layer/types';
import { healStamp } from './heal/healKernel';
import { blurStamp, sharpenStamp } from './blurSharpen/convKernel';
import { cloneStamp } from './clone/cloneKernel';
import { beginCloneStroke, getCloneOriginFor } from './clone/cloneSource';
import { pixelateAt, type PixelateContext } from './mosaic/pixelateKernel';
import { ArcLengthFollower } from './follow';
import { MODE_LAYER_NAME, MODE_SOURCE_TOOL, RETOUCH_HARD_SPACING_RATIO } from './types';
import type { Point2D, StrokeSession, PaintBakeRequest, BakeRequest, RetouchMode, RetouchStampParams } from './types';

// ─── Configuration ─────────────────────────────────────────────────────────────

export interface RetouchStrokeConfig {
  /** Shared stamp-path parameters (diameter + spacing ratio) for heal/clone. */
  stamp: RetouchStampParams;
  blockSize: number;
  /**
   * Variant kernel: 'mosaic' pixelates blocks; 'heal' spot-heals stamps
   * from a ring band; 'blur'/'sharpen' run convolution stamps; 'clone'
   * copies source patches. blockSize is only used by the mosaic kernel.
   */
  mode: RetouchMode;
  canvasSize: { w: number; h: number };
  /** Layer service access — new canvases are named through the smart naming service, not static factory calls. */
  layers: LayerService;
  /**
   * Convolution stamp parameters for blur/sharpen: the box blur radius and
   * the effect strength (blur mix factor / unsharp coefficient), both in
   * [0..∞)/[0..1] source-buffer-pixel units. Unused by the other kernels.
   */
  blurRadius?: number;
  strength?: number;
  /**
   * Clone edge hardness in [0..100]: fraction of the brush radius that stays
   * fully opaque before the feather ramp (100 = hard edge). Omitted = 75.
   */
  hardness?: number;
  /**
   * Clone source anchor in CANVAS coordinates (user-picked with Alt+Click).
   * The aligned offset is anchor → first stamp of THIS stroke; each stroke
   * re-derives the offset so dragging extends the copied run (Photoshop
   * aligned-mode semantics). Unused by the other kernels.
   */
  cloneSource?: Point2D | null;
  /** The frame this session samples/bakes in — keys the clone source registry. */
  cloneFrameId?: string;
  /**
   * Downsample factor for the composited source ImageData.
   *
   * The source pixels are composited at canvasSize * sampleScale resolution
   * to reduce memory and compositing time for large canvases. All coordinate
   * lookups into sourceImageData are scaled by this factor.
   *
   * Typical values: 1.0 (≤4K), 0.5 (4K–8K), 0.25 (>8K).
   * Clamped so the finest kernel never loses meaning at the working scale.
   */
  sampleScale: number;
}

// ─── RetouchStrokeSession ───────────────────────────────────────────────────────

export class RetouchStrokeSession implements StrokeSession {
  private canvas: OffscreenCanvas;
  private ctx: OffscreenCanvasRenderingContext2D;
  private config: RetouchStrokeConfig;
  /** Mosaic block grid cells already pixelated within this stroke. */
  private processedBlocks = new Set<string>();
  /** Arc-length stamp placement for the path-spaced modes (heal/clone). */
  private follower: ArcLengthFollower | null = null;
  private _version = 0;
  /** First stamp position of this stroke (canvas coords) — the clone offset reference point. */
  private strokeStart: Point2D | null = null;

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

  constructor(config: RetouchStrokeConfig, compositePromise: Promise<ImageData>, confinement: LocalPolygon | null = null) {
    this.config = config;
    this.confinement = confinement;

    const { w, h } = config.canvasSize;

    // Create stroke buffer (empty transparent)
    this.canvas = new OffscreenCanvas(w, h);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('[RetouchStrokeSession] Failed to get 2D context');
    this.ctx = ctx;

    // Path-spaced modes place stamps via the arc-length follower; spacing is
    // a fraction of the brush diameter (Photoshop Spacing semantics). Near-
    // hard brushes tighten the spacing: with no soft edge to fuse neighboring
    // stamps, the default spacing's union-boundary dip would read as scallops.
    if (config.mode === 'heal' || config.mode === 'clone') {
      const hard = (config.hardness ?? 75) / 100 >= 0.9;
      const ratio = hard ? RETOUCH_HARD_SPACING_RATIO : config.stamp.spacingRatio;
      this.follower = new ArcLengthFollower(Math.max(1, config.stamp.brushDiameter * ratio));
    }

    // Deferred source initialization:
    // compositeFrame flattens all visible layers asynchronously (~5-15ms).
    // Points arriving before resolution are buffered and replayed.
    this.sourceReady = compositePromise.then(imageData => {
      this.sourceImageData = imageData;
      if (this.config.canvasSize.w > 0) {
        this.config.sampleScale = imageData.width / this.config.canvasSize.w;
      }

      // Replay any points that arrived before source was ready. The first
      // buffered point is the stroke ORIGIN — stamp it directly (the
      // follower was already anchored there in begin; feeding it would emit
      // nothing and a single click would stamp nothing).
      if (this.bufferedPoints.length > 0) {
        const [origin, ...rest] = this.bufferedPoints;
        this.stampAt(origin.x, origin.y);
        for (const pt of rest) {
          this.feedStamp(pt);
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
      console.warn('[RetouchStrokeSession] Failed to load composite source:', err);
    });
  }

  begin(point: Point2D, _pressure: number): void {
    // The stroke origin's bookkeeping (clone offset reference + follower
    // anchor) must happen REGARDLESS of source readiness: pointerdown almost
    // always beats the async composite, and a deferred begin that skipped it
    // made every stamp sample the anchor itself (lamp chain) and single
    // clicks stamp nothing.
    if (this.config.mode === 'clone') {
      // Aligned semantics: the offset reference is captured on the FIRST
      // stroke after a pick and then persists across strokes (pointer lifts
      // continue the sampled film; only a re-pick resets it).
      const frameId = this.config.cloneFrameId ?? '';
      beginCloneStroke(frameId, point);
      this.strokeStart = getCloneOriginFor(frameId) ?? { x: point.x, y: point.y };
    }
    this.follower?.reset(point);
    if (this.sourceImageData) {
      this.stampAt(point.x, point.y);
      this.applyConfinementClip();
    } else {
      this.bufferedPoints.push({ x: point.x, y: point.y });
    }
    this._version++;
  }

  move(point: Point2D, _pressure: number, _e: InteractionEvent): void {
    if (this.sourceImageData) {
      this.feedStamp(point);
      this.applyConfinementClip();
    } else {
      this.bufferedPoints.push({ x: point.x, y: point.y });
    }
    this._version++;
  }

  /**
   * Routes one path point (or its arc-length emissions) into the mode's
   * kernel. heal/clone stamp through the follower (even spacing); mosaic
   * stamps every move (block grid is its own spacing domain).
   */
  private feedStamp(point: Point2D): void {
    if (this.follower) {
      for (const p of this.follower.feed(point)) {
        this.stampAt(p.x, p.y);
      }
    } else {
      this.stampAt(point.x, point.y);
    }
  }

  /**
   * Variant dispatch: routes one brush stamp to the mode's kernel. Every
   * kernel reads the same composited source and writes the same stroke
   * buffer, so confinement, dirty tracking and bake are shared unchanged.
   */
  private stampAt(cx: number, cy: number): void {
    switch (this.config.mode) {
      case 'heal': this.healStampAt(cx, cy); break;
      case 'blur': this.convStampAt(cx, cy, 'blur'); break;
      case 'sharpen': this.convStampAt(cx, cy, 'sharpen'); break;
      case 'clone': this.cloneStampAt(cx, cy); break;
      default: this.pixelateAt(cx, cy); break;
    }
  }

  /**
   * Live confinement clip: keeps the stroke buffer clean at all times so the
   * preview shows stamps ONLY inside the selection (the preview renders this
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
    // bake — stamps then only paint inside the selection, and the clip is
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
    // (a bake would create an empty layer for a click that never
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
      type: 'image',
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
   * 2. Otherwise → create a new layer named after the mode's family
   *
   * Note: layers with bitmapMasks are NOT reused because the mask would clip
   * newly painted content (the mask was applied to previous layer state and
   * doesn't account for the new stroke).
   */
  private findOrCreatePaintLayer(frame: Frame): { layer: Layer; isNew: boolean } {
    const activeLayerId = frame.activeLayerId;
    const activeLayer = activeLayerId ? frame.layers.byId[activeLayerId] : null;

    // Each variant owns its layer family exclusively: no mode ever reuses
    // another mode's canvas, so any tool's result can be deleted or erased
    // independently without touching the others' pixels.
    const expectedSourceTool = MODE_SOURCE_TOOL[this.config.mode];
    const layerNameBase = MODE_LAYER_NAME[this.config.mode];

    const hasMasks = activeLayer?.bitmapMasks && activeLayer.bitmapMasks.length > 0;
    // P5: the dedicated paint kind merged into image — a reusable retouch
    // canvas is an image stamped with the mode's own sourceTool. Unstamped
    // image layers (photos, baked text) are NOT targets: painting onto a
    // photo must stay impossible.
    if (!hasMasks && activeLayer && activeLayer.type === 'image' && activeLayer.metadata?.sourceTool === expectedSourceTool && !activeLayer.locked && activeLayer.visible) {
      return { layer: activeLayer, isNew: false };
    }

    // Create new Paint Layer
    const smartName = this.config.layers.factory.getNewLayerNameFor(frame, layerNameBase);
    const newLayer = LayerFactory.createLayer('blank', {
      name: smartName,
      cx: 0,
      cy: 0,
      bounding: { w: frame.canvas.w, h: frame.canvas.h },
      visible: true,
      metadata: { sourceTool: expectedSourceTool },
    });

    return { layer: newLayer, isNew: true };
  }

  // ─── Mosaic Core ───────────────────────────────────────────────────────────

  /**
   * Delegate to the extracted mosaic kernel. The kernel's dirty-rect writes
   * are proxied onto the session fields via getters/setters, so the session
   * stays the single owner of the stroke dirty rect.
   */
  private pixelateAt(cx: number, cy: number): void {
    // The kernel mutates a plain dirty object; copy results back afterwards
    // so the session stays the single owner of the stroke dirty rect.
    const dirty = { minX: this.dirtyMinX, minY: this.dirtyMinY, maxX: this.dirtyMaxX, maxY: this.dirtyMaxY };
    const pc: PixelateContext = {
      ctx: this.ctx,
      source: this.sourceImageData!,
      canvasSize: this.config.canvasSize,
      blockSize: this.config.blockSize,
      brushRadius: this.config.stamp.brushDiameter / 2,
      sampleScale: this.config.sampleScale,
      processedBlocks: this.processedBlocks,
      confinementRect: this.confinement ? this.confinement.rect : null,
      dirty,
    };
    pixelateAt(pc, cx, cy);
    this.dirtyMinX = dirty.minX;
    this.dirtyMinY = dirty.minY;
    this.dirtyMaxX = dirty.maxX;
    this.dirtyMaxY = dirty.maxY;
  }

  // ─── Heal Core ─────────────────────────────────────────────────────────────

  /**
   * Synthesizes one spot-heal stamp at the brush position.
   *
   * Placement is arc-length spaced (follower) — consecutive stamps sit at a
   * fixed fraction of the diameter along the path, so dragged strokes heal
   * with a uniform profile independent of pointer event timing. Stamps chain
   * visually through the working buffer (source-over over earlier stamps).
   */
  private healStampAt(cx: number, cy: number): void {
    const { canvasSize, sampleScale } = this.config;
    const radius = this.config.stamp.brushDiameter / 2;

    // Confinement rect fast-reject: stamps fully outside the selection would
    // be clipped by the compose anyway, but drawing them would dirty the
    // session and bake an empty layer.
    if (this.confinement) {
      const r = this.confinement.rect;
      if (cx + radius <= r.x || cx - radius >= r.x + r.w) return;
      if (cy + radius <= r.y || cy - radius >= r.y + r.h) return;
    }

    const sourceData = this.sourceImageData!; // guaranteed non-null: called only after sourceReady
    const size = Math.ceil(radius) * 2;
    if (size <= 0) return;

    // Run the kernel in sample space, then draw the patch back into the
    // canvas-space stroke buffer scaled by 1/sampleScale. A temp canvas is
    // required because putImageData ignores compositing and would punch
    // transparent holes over previously stamped areas of the buffer.
    const patch = healStamp(
      { source: sourceData, cx: cx * sampleScale, cy: cy * sampleScale, radius: radius * sampleScale },
    );
    if (patch.size <= 0) return;

    const tmp = new OffscreenCanvas(patch.size, patch.size);
    const tmpCtx = tmp.getContext('2d');
    if (!tmpCtx) return;
    tmpCtx.putImageData(new ImageData(patch.data as unknown as ImageDataArray, patch.size, patch.size), 0, 0);

    // Clamp the destination rect to canvas bounds (drawImage handles
    // out-of-bounds fine, but the dirty rect must stay sane).
    const dx = cx - radius;
    const dy = cy - radius;
    this.ctx.drawImage(tmp, 0, 0, patch.size, patch.size, dx, dy, radius * 2, radius * 2);

    this.dirtyMinX = Math.min(this.dirtyMinX, Math.max(0, dx));
    this.dirtyMinY = Math.min(this.dirtyMinY, Math.max(0, dy));
    this.dirtyMaxX = Math.max(this.dirtyMaxX, Math.min(canvasSize.w, dx + radius * 2));
    this.dirtyMaxY = Math.max(this.dirtyMaxY, Math.min(canvasSize.h, dy + radius * 2));
  }

  // ─── Blur / Sharpen Core (A5) ──────────────────────────────────────────────

  /**
   * Synthesizes one convolution stamp (blur or sharpen) at the brush
   * position. Same scaffolding as the heal stamp: confinement fast-reject,
   * kernel in sample space, patch drawn back into the canvas-space stroke
   * buffer via a temp canvas (putImageData would punch transparent holes
   * over previously stamped areas). Blur/sharpen are NOT arc-length spaced
   * (V1): they stamp per move event — re-stamping only strengthens the
   * effect locally, and event-rate stamping matches their soft-brush feel.
   */
  private convStampAt(cx: number, cy: number, mode: 'blur' | 'sharpen'): void {
    const { canvasSize, sampleScale, blurRadius, strength } = this.config;
    const radius = this.config.stamp.brushDiameter / 2;

    // Confinement rect fast-reject (same contract as healStampAt).
    if (this.confinement) {
      const r = this.confinement.rect;
      if (cx + radius <= r.x || cx - radius >= r.x + r.w) return;
      if (cy + radius <= r.y || cy - radius >= r.y + r.h) return;
    }

    const sourceData = this.sourceImageData!; // guaranteed non-null: called only after sourceReady
    const kernelRadius = Math.max(1, radius * sampleScale);
    const stamp = mode === 'blur' ? blurStamp : sharpenStamp;
    const patch = stamp({
      source: sourceData,
      cx: cx * sampleScale,
      cy: cy * sampleScale,
      radius: kernelRadius,
      blurRadius: Math.max(1, (blurRadius ?? 8) * sampleScale),
      strength: strength ?? 0.6,
    });
    if (patch.size <= 0) return;

    // Draw the patch back scaled by 1/sampleScale (temp canvas required for
    // source-over compositing — same reasoning as healStampAt).
    const tmp = new OffscreenCanvas(patch.size, patch.size);
    const tmpCtx = tmp.getContext('2d');
    if (!tmpCtx) return;
    tmpCtx.putImageData(new ImageData(patch.data as unknown as ImageDataArray, patch.size, patch.size), 0, 0);

    const dx = cx - radius;
    const dy = cy - radius;
    this.ctx.drawImage(tmp, 0, 0, patch.size, patch.size, dx, dy, radius * 2, radius * 2);

    this.dirtyMinX = Math.min(this.dirtyMinX, Math.max(0, dx));
    this.dirtyMinY = Math.min(this.dirtyMinY, Math.max(0, dy));
    this.dirtyMaxX = Math.max(this.dirtyMaxX, Math.min(canvasSize.w, dx + radius * 2));
    this.dirtyMaxY = Math.max(this.dirtyMaxY, Math.min(canvasSize.h, dy + radius * 2));
  }

  // ─── Clone Core (A4) ───────────────────────────────────────────────────────

  /**
   * Copies one clone stamp at the brush position from the aligned source.
   * The sample center is anchor + (brush − strokeStart), so dragging from
   * the stroke start extends a continuous copied run (aligned mode) while
   * the SOURCE always stays this session's start composite — cloned output
   * can never feed a later stamp (anti-self-feedback). No dedupe grid: the
   * arc-length follower already guarantees stamp positions, and re-copying
   * the same pixels would be a no-op anyway.
   */
  private cloneStampAt(cx: number, cy: number): void {
    const { canvasSize, sampleScale, cloneSource, hardness } = this.config;
    if (!cloneSource) return; // guarded by the factory/handler; belt-and-suspenders
    const radius = this.config.stamp.brushDiameter / 2;
    // Near-hard stamps snap the center to the pixel grid: the kernel's 1px AA
    // band is only meaningful if drawImage never resamples it at a fractional
    // destination (soft edges hide the extra blur; hard edges expose it).
    let sx = cx, sy = cy;
    if ((hardness ?? 75) / 100 >= 0.9) {
      sx = Math.round(cx);
      sy = Math.round(cy);
    }
    cx = sx;
    cy = sy;

    // Confinement rect fast-reject (same contract as healStampAt).
    if (this.confinement) {
      const r = this.confinement.rect;
      if (cx + radius <= r.x || cx - radius >= r.x + r.w) return;
      if (cy + radius <= r.y || cy - radius >= r.y + r.h) return;
    }

    // The aligned offset anchor→strokeStart maps every brush position to its
    // sample position (strokeStart recorded at begin).
    const start = this.strokeStart ?? { x: cx, y: cy };

    const sourceData = this.sourceImageData!; // guaranteed non-null: called only after sourceReady
    const patch = cloneStamp({
      source: sourceData,
      cx: cx * sampleScale,
      cy: cy * sampleScale,
      sx: (cloneSource.x + (cx - start.x)) * sampleScale,
      sy: (cloneSource.y + (cy - start.y)) * sampleScale,
      radius: Math.max(1, radius * sampleScale),
      hardness: (hardness ?? 75) / 100,
    });
    if (patch.size <= 0) return;

    const tmp = new OffscreenCanvas(patch.size, patch.size);
    const tmpCtx = tmp.getContext('2d');
    if (!tmpCtx) return;
    tmpCtx.putImageData(new ImageData(patch.data as unknown as ImageDataArray, patch.size, patch.size), 0, 0);

    const dx = cx - radius;
    const dy = cy - radius;
    this.ctx.drawImage(tmp, 0, 0, patch.size, patch.size, dx, dy, radius * 2, radius * 2);

    this.dirtyMinX = Math.min(this.dirtyMinX, Math.max(0, dx));
    this.dirtyMinY = Math.min(this.dirtyMinY, Math.max(0, dy));
    this.dirtyMaxX = Math.max(this.dirtyMaxX, Math.min(canvasSize.w, dx + radius * 2));
    this.dirtyMaxY = Math.max(this.dirtyMaxY, Math.min(canvasSize.h, dy + radius * 2));
  }
}
