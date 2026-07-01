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

import { Layer, AssetService, Shape, LocalShape, TileData, asLocalRect } from '@opengpex/editor/core/types';
import { FontService } from '@opengpex/editor/core/fonts';
import { MAX_SAFE_EXPORT_PIXELS } from '@opengpex/editor/core/helpers/config';
import { imageCache } from '../../cache/ImageCache';
import { tileCache } from '../../cache/TileCache';
import { drawLayerInstance } from './painter';
import { IRenderer, RenderCommand, DrawLayerOptions } from '../../protocol/IRenderer';
import { shrinkInvertedMask } from '@opengpex/editor/core/helpers/sub-pixel';
import { shapeToPath2D } from '@opengpex/editor/core/helpers/path2d';
import { PixelUtils } from '../../PixelUtils';

/**
 * Canvas2dEngine: Real atomic graphics engine
 * Responsible for the lowest-level pixel push logic in Canvas environment.
 */
export class Canvas2dEngine implements IRenderer {
  private commandQueue: RenderCommand[] = [];
  private ctx: CanvasRenderingContext2D | null = null;
  private currentDim: { w: number; h: number } | null = null;
  private tilePool: TileData[] = []; // [Optimization] Zero-allocation object pool for tile jobs
  private offscreenPool: OffscreenCanvas[] = []; // [Optimization] OffscreenCanvas pool for bitmap mask compositing
  private artboardClipActive = false; // Whether artboard boundary clip is currently applied

  // [Font Loading] Dynamic font service integration
  private fontService?: FontService;
  private pendingFontLoads = new Set<string>();
  private fontReadyCallback?: () => void;

  /**
   * Inject FontService and redraw callback.
   * Called by CanvasStage during initialization to enable font-aware rendering.
   *
   * When a text layer references a font that is not yet loaded:
   * 1. This frame renders with CSS fallback (text is visible but uses generic font)
   * 2. FontService.load() is triggered asynchronously
   * 3. On success, fontReadyCallback fires to schedule a redraw with the correct font
   */
  setFontService(fonts: FontService, onFontReady: () => void): void {
    this.fontService = fonts;
    this.fontReadyCallback = onFontReady;
  }

  /** Inject drawing context (due to strong DOM binding, must be injected at component layer) */
  attach(ctx: CanvasRenderingContext2D) {
    this.ctx = ctx;
  }

  beginFrame(dim: { w: number; h: number }, artboardClip?: { x: number; y: number; w: number; h: number }): void {
    if (!this.ctx) return;
    this.currentDim = dim;
    this.commandQueue = [];
    this.artboardClipActive = false;

    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.height);

    // [Artboard Boundary Clip] When provided, restrict all subsequent rendering
    // to the artboard area. This non-destructively hides layer content that
    // extends beyond the canvas boundary (e.g. after Re-Canvas resize).
    if (artboardClip) {
      this.ctx.save();
      this.ctx.beginPath();
      this.ctx.rect(artboardClip.x, artboardClip.y, artboardClip.w, artboardClip.h);
      this.ctx.clip();
      this.artboardClipActive = true;
    }
  }

  pushCommand(cmd: RenderCommand): void {
    this.commandQueue.push(cmd);
  }

  flush(assetService?: AssetService): void {
    if (!this.ctx) return;

    for (const cmd of this.commandQueue) {
      if (cmd.type === 'layer') {
        // [Font Loading] Check font readiness for text layers before rendering
        if (cmd.layer.type === 'text' && cmd.layer.textData && this.fontService) {
          const family = cmd.layer.textData.fontFamily;
          if (family && !this.fontService.isLoaded(family)) {
            // Font not yet available — trigger async load (deduplicated)
            if (!this.pendingFontLoads.has(family)) {
              this.pendingFontLoads.add(family);
              this.fontService.load(family).then((ok) => {
                this.pendingFontLoads.delete(family);
                if (ok && this.fontReadyCallback) {
                  // Schedule redraw on next animation frame once font is ready
                  requestAnimationFrame(() => this.fontReadyCallback!());
                }
              });
            }
            // Continue rendering this frame with CSS fallback font (FOUT strategy)
          }
        }
        this.drawLayerDirect(cmd.layer, cmd.options, assetService);
      }
    }

    this.commandQueue = [];

    // [Artboard Boundary Clip] Restore context state if artboard clip was applied in beginFrame
    if (this.artboardClipActive) {
      this.ctx.restore();
      this.artboardClipActive = false;
    }
  }



  /**
   * Renders shape to Canvas context (supports regular Clipping or physical-level binarized clipping)
   */
  drawShape(
    ctx: CanvasRenderingContext2D,
    shape: Shape | LocalShape
  ): void {
    const { type, rect } = shape;

    if (type === 'rect') {
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.w, rect.h);
      if (ctx.globalCompositeOperation === 'destination-out' || ctx.globalCompositeOperation === 'destination-in') {
        ctx.fill();
      } else {
        ctx.clip();
      }
    } else if (type === 'circle') {
      const centerX = rect.x + rect.w / 2;
      const centerY = rect.y + rect.h / 2;
      const radiusX = rect.w / 2;
      const radiusY = rect.h / 2;

      ctx.beginPath();
      ctx.ellipse(centerX, centerY, Math.abs(radiusX), Math.abs(radiusY), 0, 0, Math.PI * 2);
      if (ctx.globalCompositeOperation === 'destination-out' || ctx.globalCompositeOperation === 'destination-in') {
        ctx.fill();
      } else {
        ctx.clip();
      }
    }
  }

  /** Determine if offscreen synthesis is needed (always go offscreen when bitmap mask is present) */
  private needsOffscreenComposite(layer: Layer, options: DrawLayerOptions): boolean {
    if (options.bitmapMaskOverride) return true;
    return !!(layer.bitmapMasks?.some(m => m.enabled));
  }

  /** Inline Path2D cache (replaces deleted AsyncMaskCache.getPath2D) */
  private pathCache = new Map<string, Path2D>();
  private getCachedPath2D(shape: Shape): Path2D {
    const { rect } = shape;
    const extShape = shape as Shape & { antiAliased?: boolean; pathData?: string };
    const aa = extShape.antiAliased !== false;
    const key = `${shape.type}-${rect.x},${rect.y},${rect.w},${rect.h}-${extShape.pathData || ""}-aa:${aa}`;
    let path = this.pathCache.get(key);
    if (!path) {
      path = shapeToPath2D(shape);
      this.pathCache.set(key, path);
      if (this.pathCache.size > 100) {
        const firstKey = this.pathCache.keys().next().value;
        if (firstKey) this.pathCache.delete(firstKey);
      }
    }
    return path;
  }

  /** Get/create offscreen canvas (pooled reuse) */
  private acquireOffscreen(w: number, h: number): OffscreenCanvas {
    // Get a sufficiently large canvas from pool, or create a new one
    const idx = this.offscreenPool.findIndex(c => c.width >= w && c.height >= h);
    if (idx !== -1) {
      return this.offscreenPool.splice(idx, 1)[0];
    }
    return new OffscreenCanvas(w, h);
  }

  /** Return offscreen canvas to pool */
  private releaseOffscreen(canvas: OffscreenCanvas): void {
    if (this.offscreenPool.length < 4) { // Cache up to 4
      this.offscreenPool.push(canvas);
    } else {
      // Find the index of the canvas with the smallest area in the pool
      let minIdx = 0;
      let minArea = this.offscreenPool[0].width * this.offscreenPool[0].height;
      for (let i = 1; i < this.offscreenPool.length; i++) {
        const area = this.offscreenPool[i].width * this.offscreenPool[i].height;
        if (area < minArea) {
          minArea = area;
          minIdx = i;
        }
      }

      const newArea = canvas.width * canvas.height;
      // If the newly released canvas is larger than the smallest cached canvas, replace it
      if (newArea > minArea) {
        this.offscreenPool[minIdx] = canvas;
      }
    }
  }

  /**
   * Offscreen synthesis path: content -> vector clip -> bitmap mask -> synthesize to main canvas
   *
   * [Performance Optimization - Viewport Clipping] Offscreen Canvas size is limited to "layer screen projection ∩ actual viewport",
   * rather than the screen projection of the entire layer. This avoids allocating huge OffscreenCanvas under high zoom (worst case
   * 16384x16384), preventing performance drops and content disappearance.
   */
  private drawLayerOffscreen(
    layer: Layer,
    options: DrawLayerOptions,
    assetService: AssetService | undefined
  ): void {
    if (!this.ctx) return;
    const mainCtx = this.ctx;

    // 1. Calculate physical pixel bounding box (Screen Space AABB)
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    if (options.matrix) {
      const m = options.matrix;
      const w = layer.bounding.w;
      const h = layer.bounding.h;
      const corners = [
        { x: 0, y: 0 },
        { x: w, y: 0 },
        { x: 0, y: h },
        { x: w, y: h }
      ];
      for (const p of corners) {
        const tx = m.a * p.x + m.c * p.y + m.tx;
        const ty = m.b * p.x + m.d * p.y + m.ty;
        if (tx < minX) minX = tx;
        if (tx > maxX) maxX = tx;
        if (ty < minY) minY = ty;
        if (ty > maxY) maxY = ty;
      }
    }

    if (!options.matrix || minX === Infinity) {
      minX = 0;
      minY = 0;
      maxX = layer.bounding.w;
      maxY = layer.bounding.h;
    }

    // 1b. Viewport clipping: intersect layer AABB with the actual viewport (main canvas physical size)
    // This ensures offscreen Canvas never exceeds viewport size, resolving performance and overflow issues under high zoom.
    const viewportW = mainCtx.canvas.width;
    const viewportH = mainCtx.canvas.height;

    const clipLeft = Math.max(Math.floor(minX), 0);
    const clipTop = Math.max(Math.floor(minY), 0);
    const clipRight = Math.min(Math.ceil(maxX), viewportW);
    const clipBottom = Math.min(Math.ceil(maxY), viewportH);

    // If layer is completely outside viewport, skip directly
    if (clipRight <= clipLeft || clipBottom <= clipTop) return;

    const finalW = clipRight - clipLeft;
    const finalH = clipBottom - clipTop;
    const screenX = clipLeft;
    const screenY = clipTop;

    // 2. Get offscreen canvas (pooled allocation, avoiding unnecessary resizing to optimize performance)
    const offscreen = this.acquireOffscreen(finalW, finalH);
    if (offscreen.width < finalW || offscreen.height < finalH) {
      offscreen.width = finalW;
      offscreen.height = finalH;
    }
    const offCtx = offscreen.getContext('2d')!;
    offCtx.clearRect(0, 0, finalW, finalH);

    // 3. Draw layer content on offscreen canvas (using adjusted translation matrix at physical resolution)
    const oldCtx = this.ctx;
    this.ctx = offCtx as unknown as CanvasRenderingContext2D;

    const m = options.matrix;
    const offscreenMatrix = m ? {
      a: m.a,
      b: m.b,
      c: m.c,
      d: m.d,
      tx: m.tx - screenX,
      ty: m.ty - screenY
    } : undefined;

    const offscreenOptions: DrawLayerOptions = {
      ...options,
      matrix: offscreenMatrix,
      opacity: 1.0,                  // Do not apply opacity in offscreen; apply it during final composition
      bitmapMaskOverride: undefined  // Prevent recursion
    };
    // Key: Pass contentLayer (excluding bitmapMasks), so recursive calls do not trigger offscreen composition again and can correctly take the tiling path
    const contentLayer = { ...layer, bitmapMasks: undefined };
    this.drawLayerDirect(contentLayer, offscreenOptions, assetService);
    this.ctx = oldCtx;

    // 4. Apply bitmap masks one by one on offscreen canvas (drawn with destination-in / destination-out under offscreenMatrix transformation)
    const activeBitmapMasks = [...(layer.bitmapMasks?.filter(m => m.enabled) || [])];

    // If the maskId corresponding to the override is not in activeBitmapMasks (e.g., a newly created uncommitted mask), manually add it to allow previewing
    if (options.bitmapMaskOverride) {
      const overrideId = options.bitmapMaskOverride.maskId;
      if (!activeBitmapMasks.some(m => m.id === overrideId)) {
        activeBitmapMasks.push({
          id: overrideId,
          src: '',
          assetId: '',
          bounds: asLocalRect({ x: 0, y: 0, w: layer.bounding.w, h: layer.bounding.h }),
          inverted: false,
          enabled: true,
          feather: 0
        });
      }
    }

    const hasBitmapMasks = activeBitmapMasks.length > 0 || !!options.bitmapMaskOverride;

    if (hasBitmapMasks) {
      for (const bm of activeBitmapMasks) {
        // Check for fast-track override
        const maskSource = (options.bitmapMaskOverride?.maskId === bm.id)
          ? options.bitmapMaskOverride.source
          : imageCache.getOrFetch(bm.src);

        if (!maskSource) continue;

        offCtx.save();
        if (offscreenMatrix) {
          // Set offscreen coordinate system, drawing mask bounds in layer local coordinates mapped to physical space
          offCtx.setTransform(
            offscreenMatrix.a,
            offscreenMatrix.b,
            offscreenMatrix.c,
            offscreenMatrix.d,
            offscreenMatrix.tx,
            offscreenMatrix.ty
          );
        }
        // Apply feather (Gaussian blur) if specified on this bitmap mask
        if (bm.feather > 0) {
          const physicalRadius = bm.feather * (offscreenMatrix?.a || 1);
          offCtx.filter = `blur(${physicalRadius}px)`;
        }
        offCtx.imageSmoothingEnabled = false; // Match content layer to avoid double-linear interpolation causing mask edge feathering
        offCtx.globalCompositeOperation = bm.inverted ? 'destination-out' : 'destination-in';
        offCtx.drawImage(maskSource as CanvasImageSource, bm.bounds.x, bm.bounds.y, bm.bounds.w, bm.bounds.h);
        offCtx.restore();
      }
    }

    // 5. Draw offscreen composition result to main canvas
    mainCtx.save();
    mainCtx.setTransform(1, 0, 0, 1, 0, 0); // Directly copy 1:1 in physical pixel space
    mainCtx.globalAlpha = options.opacity ?? layer.opacity ?? 1;
    mainCtx.drawImage(offscreen, 0, 0, finalW, finalH, screenX, screenY, finalW, finalH);
    mainCtx.restore();

    // 6. Return offscreen canvas
    this.releaseOffscreen(offscreen);
  }

  /**
   * IRenderer interface method: draw layer directly (no queue)
   */
  drawLayerDirect(layer: Layer, options: DrawLayerOptions, assetService?: AssetService): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const {
      matrix, opacity, clipSequence, drawRect,
      imageSmoothingQuality = 'high', imageOverride,
      isExporting
    } = options;

    const scale = matrix ? Math.sqrt(matrix.a * matrix.a + matrix.b * matrix.b) : 1;

    // [Bitmap Mask Dispatch] If active durable/preview bitmap mask exists, use offscreen composition path
    if (this.needsOffscreenComposite(layer, options)) {
      if ((window as unknown as Record<string, unknown>).__SEAM_DEBUG) {
        console.log(`[SeamDebug:Engine] layer="${layer.name}" → OFFSCREEN path (bitmapMask)`);
      }
      this.drawLayerOffscreen(layer, options, assetService);
      return;
    }

    if (layer.type === 'color') {
      const preparedClips = clipSequence?.map(clip => ({
        ...clip,
        __compiledPath2D: this.getCachedPath2D(shrinkInvertedMask(clip.shape, clip.inverted, scale))
      }));
      drawLayerInstance(ctx, layer, null, {
        matrix, opacity, clipSequence: preparedClips, width: options.width, height: options.height, drawRect, imageSmoothingQuality
      });
      return;
    }


    const asset = (layer.assetId && assetService) ? assetService.get(layer.assetId) : null;
    const tileMeta = asset?.tileMeta;
    const dprScale = tileMeta?.dprScale;

    // [Core Dispatch Logic]
    const hasBitmap = !!(layer.bitmapMasks && layer.bitmapMasks.some(m => m.enabled));
    const isTooLarge = (layer.bounding.w * layer.bounding.h) > MAX_SAFE_EXPORT_PIXELS;
    const shouldUseTiles = tileMeta?.isTiled && (!isExporting || isTooLarge) && !imageOverride && !hasBitmap;

    if (shouldUseTiles) {
      // --- 4A. Tile Rendering Path (Tiling) ---
      // Tiling mode has unique per-tile translation and scaling logic; we apply context transformation separately here
      const preparedClips = clipSequence?.map(clip => ({
        ...clip,
        __compiledPath2D: this.getCachedPath2D(shrinkInvertedMask(clip.shape, clip.inverted, scale))
      }));

      const tileCount = PixelUtils.computeTileJobs(
        layer.assetId!,
        tileMeta!,
        matrix,
        drawRect,
        isExporting || false,
        this.tilePool,
        tileCache
      );

      if (tileCount > 0) {
        if ((window as unknown as Record<string, unknown>).__SEAM_DEBUG) {
          console.log(`[SeamDebug:Engine] layer="${layer.name}" → TILES path (${tileCount} tiles), dprScale=${dprScale}, drawRect=`, drawRect);
        }
        drawLayerInstance(ctx, layer, this.tilePool, {
          matrix, opacity, clipSequence: preparedClips, width: options.width, height: options.height, drawRect, imageSmoothingQuality,
          tileCount, dprScale
        });
      } else if (layer.src) {
        // If tile is not ready, fall back to single image, using assetService.resolve to ensure retrieving the latest valid Object URL
        if ((window as unknown as Record<string, unknown>).__SEAM_DEBUG) {
          console.log(`[SeamDebug:Engine] layer="${layer.name}" → TILE FALLBACK (single image, tiles not ready)`);
        }
        const fallbackSrc = assetService ? assetService.resolve(layer.assetId, layer.src) : layer.src;
        const img = imageCache.getOrFetch(fallbackSrc);
        if (img) {
          drawLayerInstance(ctx, layer, img, {
            matrix, opacity, clipSequence: preparedClips, width: options.width, height: options.height, drawRect, imageSmoothingQuality,
            dprScale
          });
        }
      }

    } else {
      // --- 4B. Single Image Rendering Path (vector mask unified ctx.clip directly, bypassing Worker) ---
      if ((window as unknown as Record<string, unknown>).__SEAM_DEBUG) {
        console.log(`[SeamDebug:Engine] layer="${layer.name}" → SINGLE IMAGE path, isTiled=${tileMeta?.isTiled}, assetId=${layer.assetId}`);
      }
      const currentSrc = assetService ? assetService.resolve(layer.assetId, layer.src) : layer.src;
      const img = imageOverride || (currentSrc ? imageCache.getOrFetch(currentSrc) : null);

      if (img) {
        const preparedClips = clipSequence?.map(clip => ({
          ...clip,
          __compiledPath2D: this.getCachedPath2D(shrinkInvertedMask(clip.shape, clip.inverted, scale))
        }));
        drawLayerInstance(ctx, layer, img, {
          matrix, opacity, clipSequence: preparedClips, width: options.width, height: options.height, drawRect, imageSmoothingQuality,
          dprScale
        });
      }
    }
  }
}

export const canvas2dEngine = new Canvas2dEngine();
