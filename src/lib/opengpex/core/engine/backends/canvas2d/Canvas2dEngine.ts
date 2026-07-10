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
import { asyncFilterCache } from '../../cache/AsyncFilterCache';
import { hasAdvancedFilters } from '../../filters/normalizeDescriptors';
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

    const _flushT0 = performance.now();
    let _layerCount = 0;
    const _offscreenCount = 0;

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
        _layerCount++;
        this.drawLayerDirect(cmd.layer, cmd.options, assetService);
      }
    }

    this.commandQueue = [];

    const _flushDuration = performance.now() - _flushT0;
    if (_flushDuration > 16) {
      console.warn(`[Canvas2dEngine.flush] ⚠️ took ${_flushDuration.toFixed(1)}ms | layers=${_layerCount} offscreen=${_offscreenCount}`);
    }

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

  /** Determine if offscreen synthesis is needed (always go offscreen when bitmap mask is present or non-default blend mode) */
  private needsOffscreenComposite(layer: Layer, options: DrawLayerOptions): boolean {
    if (options.bitmapMaskOverride) return true;
    if (layer.bitmapMasks?.some(m => m.enabled)) return true;
    // [Blend Isolation] Non-source-over blend modes need offscreen pre-compositing
    // to prevent tile seam artifacts caused by overlap double-blending.
    // Tiles are drawn with source-over on the offscreen, then the composite result
    // is blended once onto the main canvas with the target blend mode.
    if (layer.blendMode && layer.blendMode !== 'source-over') return true;
    // [Blur Isolation] Neighborhood-kernel adjustments (blur) suffer from the
    // same tile-seam artifact as non-source-over blend modes: on the tiled
    // rendering path, painter.ts loops `ctx.drawImage(tile.bitmap, ...)` per
    // tile with `ctx.filter = "blur(Npx)"` active, and each drawImage call
    // convolves ONLY within that tile's bitmap — cross-tile neighbor samples
    // are clipped away, producing visible grid seams. Route blur through the
    // offscreen composite path so the kernel is applied once against a fully
    // stitched offscreen image. See filter_pipeline spec §3.2 `classifyFilter`
    // (blur is `neighborhood`) and §5.4 (tile boundary caveat).
    if ((layer.adjustments?.blur ?? 0) > 0) return true;
    return false;
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
    const _offT0 = performance.now();
    const mainCtx = this.ctx;

    // 1. Calculate physical pixel bounding box (Screen Space AABB)
    // [visibleShape Awareness] For shared-asset layers (e.g. cmdj fragments),
    // the actual content is at visibleShape.rect offset within the layer-local
    // coordinate space. We must use visibleShape.rect (not 0,0→bounding) as
    // the content area to correctly compute screen-space AABB.
    const contentRect = layer.visibleShape?.rect || { x: 0, y: 0, w: layer.bounding.w, h: layer.bounding.h };
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    if (options.matrix) {
      const m = options.matrix;
      const corners = [
        { x: contentRect.x, y: contentRect.y },
        { x: contentRect.x + contentRect.w, y: contentRect.y },
        { x: contentRect.x, y: contentRect.y + contentRect.h },
        { x: contentRect.x + contentRect.w, y: contentRect.y + contentRect.h }
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
      maxX = contentRect.w;
      maxY = contentRect.h;
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
    // Key: Pass contentLayer (excluding bitmapMasks / blendMode / blur), so recursive calls:
    // 1. Do not trigger offscreen composition again (no bitmapMasks, no blendMode, no blur)
    // 2. Can correctly take the tiling path
    // 3. Draw tiles with source-over on the offscreen (blendMode & blur applied only in final composite step 5)
    //
    // [Blur Isolation] Strip `adjustments.blur` here so the recursive tile draw
    // does NOT apply blur per-tile via painter's `ctx.filter` fast path (which
    // would re-introduce the very tile seams we're trying to eliminate). The
    // remaining point-kernel adjustments (brightness / contrast / saturation /
    // hueRotate) stay put — they're per-pixel and tile-safe. See §needsOffscreenComposite.
    const contentLayer: Layer = {
      ...layer,
      bitmapMasks: undefined,
      blendMode: undefined,
      adjustments: layer.adjustments
        ? { ...layer.adjustments, blur: 0 }
        : undefined,
    };
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
    mainCtx.globalCompositeOperation = (layer.blendMode || 'source-over') as GlobalCompositeOperation;
    // [Blur Isolation] Apply the neighborhood blur kernel HERE, exactly once,
    // against the fully stitched offscreen bitmap. This is the seam-free
    // counterpart to the per-tile ctx.filter fast path used in painter.ts.
    // Logical blur radius (in layer-local px) is scaled up by the on-screen
    // matrix scale factor so that the visual blur strength stays consistent
    // whether the layer is zoomed in or out. matrix.a already carries the
    // uniform scale under the engine's non-rotational transforms; if a shear
    // is present we fall back to |a| which matches painter.ts's convention.
    const blurLogical = layer.adjustments?.blur ?? 0;
    if (blurLogical > 0) {
      const blurScale = options.matrix ? Math.abs(options.matrix.a) : 1;
      mainCtx.filter = `blur(${blurLogical * blurScale}px)`;
    }
    mainCtx.drawImage(offscreen, 0, 0, finalW, finalH, screenX, screenY, finalW, finalH);
    mainCtx.restore(); // save/restore also clears mainCtx.filter — no leak.

    // 6. Return offscreen canvas
    this.releaseOffscreen(offscreen);

    const _offDuration = performance.now() - _offT0;
    if (_offDuration > 8) {
      const reason = (layer.bitmapMasks?.some(m => m.enabled))
        ? 'bitmapMask'
        : (layer.blendMode && layer.blendMode !== 'source-over')
          ? layer.blendMode
          : (layer.adjustments?.blur ?? 0) > 0
            ? 'blur'
            : 'blend';
      console.debug(
        `[Canvas2dEngine.offscreen] layer="${layer.name}" reason=${reason} size=${finalW}x${finalH} took ${_offDuration.toFixed(1)}ms`
      );
    }

  }

  /**
   * [Filter Pipeline §5.1 / §3.5] Resolve the "effective" image source and layer
   * clone for a given layer, transparently dispatching to AsyncFilterCache
   * when curves / levels / channelMix are declared.
   *
   * Design constraints (spec §3.5 hard invariant):
   * - This method lives in Canvas2dEngine (pure main-thread module). painter.ts
   *   MUST NOT import AsyncFilterCache — it is a shared leaf between main
   *   thread and the engine worker's EngineProvider, and reaching into worker
   *   RPC from there causes Turbopack to explode the worker module graph
   *   (see spec §3.5.2, the 2026-07-09 landing-page crash retrospective).
   *
   * Behavior:
   * - No advanced filters, or `img` is not an ImageBitmap, or we're exporting
   *   → return `img` and `layer` untouched (painter.ts's `ctx.filter` fast path
   *     still applies basic adjustments).
   * - Advanced filters + cache HIT → return the pre-filtered ImageBitmap AND a
   *   cloned layer with `adjustments` stripped, because AsyncFilterCache /
   *   Canvas2dFilter already folded adjustments into the filtered bitmap.
   *   Leaving `adjustments` on would double-apply via painter's ctx.filter.
   * - Advanced filters + cache MISS → schedule the async worker job and this
   *   frame degrades to the raw `img` with ctx.filter basic adjustments.
   *   `asyncFilterCache.subscribe(...)` in CanvasStage will trigger a redraw
   *   once the worker returns, and the next frame will hit the cache.
   */
  private resolveFilteredSource<T>(
    layer: Layer,
    img: T,
    isExporting: boolean | undefined,
  ): { img: T; layer: Layer } {
    // Cheap early-outs first — hot path stays branch-free for the 99% case
    // where a layer has no advanced filters declared.
    if (isExporting) return { img, layer };
    if (!hasAdvancedFilters(layer)) return { img, layer };
    // AsyncFilterCache accepts anything `createImageBitmap` can consume
    // (HTMLImageElement, ImageBitmap, OffscreenCanvas, …). The `imageCache`
    // hands us `HTMLImageElement` for the single-image path, so a strict
    // `img instanceof ImageBitmap` guard here would slam the door on the
    // most common source type and silently make curves/levels/mixer no-op —
    // exactly the "advanced filters don't affect the canvas" bug. Instead,
    // we only reject obviously-unsupported values.
    if (!img || typeof img !== 'object') return { img, layer };

    const filtered = asyncFilterCache.get(layer);
    if (filtered) {
      return {
        img: filtered as unknown as T,
        layer: { ...layer, adjustments: undefined },
      };
    }

    // Cache miss: fire-and-forget schedule the worker job, then serve the
    // "stale-while-revalidate" bitmap from the previous successful recipe
    // to avoid flashing the raw source between slider ticks. First-ever
    // filter on a given assetId will still show the raw source for a single
    // frame (unavoidable — nothing to fall back to yet).
    asyncFilterCache.schedule(layer, img as unknown as CanvasImageSource);
    const stale = asyncFilterCache.getStale(layer);
    if (stale) {
      return {
        img: stale as unknown as T,
        layer: { ...layer, adjustments: undefined },
      };
    }
    return { img, layer };
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

    // [Bitmap Mask / Blend Isolation Dispatch] Use offscreen composition path
    if (this.needsOffscreenComposite(layer, options)) {
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
    // [Filter Pipeline §5.1] Layers with advanced filters (curves / levels /
    // channelMix) MUST route through the single-image path so that
    // `resolveFilteredSource` can dispatch to AsyncFilterCache and eventually
    // paint the worker-produced filtered ImageBitmap. The tiled fast path
    // draws raw tile bitmaps and has no filter hook — it would silently swallow
    // the effect (only Basic adjustments would appear via `ctx.filter`). This
    // is why users reported "Basic works, but Curves/Levels/Mixer don't":
    // most bitmap layers have `tileMeta.isTiled=true`, so they took the tile
    // path and bypassed the filter dispatch entirely. Forcing the single-image
    // path only when advanced filters are declared keeps the tile fast-path
    // hot for the 99% no-filter case.
    const hasAdvanced = !isExporting && hasAdvancedFilters(layer);
    const shouldUseTiles = tileMeta?.isTiled && (!isExporting || isTooLarge) && !imageOverride && !hasBitmap && !hasAdvanced;

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
        drawLayerInstance(ctx, layer, this.tilePool, {
          matrix, opacity, clipSequence: preparedClips, width: options.width, height: options.height, drawRect, imageSmoothingQuality,
          tileCount, dprScale
        });
      } else if (layer.src) {
        // If tile is not ready, fall back to single image, using assetService.resolve to ensure retrieving the latest valid Object URL
        const fallbackSrc = assetService ? assetService.resolve(layer.assetId, layer.src) : layer.src;
        const rawImg = imageCache.getOrFetch(fallbackSrc);
        if (rawImg) {
          // [Filter Pipeline §5.1] Dispatch to AsyncFilterCache when advanced filters declared.
          const { img: effImg, layer: effLayer } = this.resolveFilteredSource(layer, rawImg, isExporting);
          drawLayerInstance(ctx, effLayer, effImg, {
            matrix, opacity, clipSequence: preparedClips, width: options.width, height: options.height, drawRect, imageSmoothingQuality,
            dprScale
          });
        }
      }

    } else {
      // --- 4B. Single Image Rendering Path (vector mask unified ctx.clip directly, bypassing Worker) ---
      const currentSrc = assetService ? assetService.resolve(layer.assetId, layer.src) : layer.src;
      const rawImg = imageOverride || (currentSrc ? imageCache.getOrFetch(currentSrc) : null);

      if (rawImg) {
        const preparedClips = clipSequence?.map(clip => ({
          ...clip,
          __compiledPath2D: this.getCachedPath2D(shrinkInvertedMask(clip.shape, clip.inverted, scale))
        }));
        // [Filter Pipeline §5.1] Dispatch to AsyncFilterCache when advanced filters declared.
        // - Cache HIT  → effImg = filtered ImageBitmap; effLayer has adjustments cleared.
        // - Cache MISS → effImg = rawImg; worker job scheduled; next frame will hit.
        // - Non-ImageBitmap sources (HTMLImageElement etc.) fall through untouched.
        const { img: effImg, layer: effLayer } = this.resolveFilteredSource(layer, rawImg, isExporting);
        drawLayerInstance(ctx, effLayer, effImg, {
          matrix, opacity, clipSequence: preparedClips, width: options.width, height: options.height, drawRect, imageSmoothingQuality,
          dprScale
        });
      }
    }

  }
}

export const canvas2dEngine = new Canvas2dEngine();
