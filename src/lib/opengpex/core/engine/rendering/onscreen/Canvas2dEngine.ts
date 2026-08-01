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
 * Canvas2dEngine — Engine V2 onscreen rendering backend.
 *
 * Responsible for the lowest-level pixel push logic in the Canvas 2D environment.
 * This is the main-thread real-time renderer that composes layers onto the
 * visible <canvas> element for the user.
 *
 * Phase 1 adaptation from v1 `engine/backends/canvas2d/Canvas2dEngine.ts`:
 * - Import painter from `../shared/painter` (v2 shared rendering layer).
 * - Uses Engine V2 protocol/IRenderer interface from `../../protocol/IRenderer`.
 * - Uses Engine V2 caches (SourceBitmapCache, TileCache, FilterCache).
 * - Filter fast-track logic extracted to `./FilterFastTrack.ts`.
 * - No dependency on v1 compositors/ or WorkerProxy.
 *
 * Architecture invariants:
 * - Reads from SourceBitmapCache (main-thread bitmap truth source).
 * - Zero pixel-intensive computation — only drawImage / ctx.filter CSS path.
 * - Advanced filters routed through FilterFastTrack (Track A) or FilterCache (Track B).
 */

import type { Layer, AssetService, Shape, LocalShape, TileData, Rect, Dimensions } from '@opengpex/editor/core/types';
import { asLocalRect } from '@opengpex/editor/core/types';
import type { FontService } from '@opengpex/editor/core/fonts';
import { MAX_SAFE_EXPORT_PIXELS } from '@opengpex/editor/core/helpers/config';
import { shapeToPath2D } from '@opengpex/editor/core/helpers/path2d';
import { shrinkInvertedMask } from '@opengpex/editor/core/helpers/sub-pixel';

import { sourceBitmapCache } from '../../cache/SourceBitmapCache';
import { tileCache } from '../../cache/TileCache';
import { filterCache } from '../../cache/FilterCache';
import type { IRenderer, RenderCommand, DrawLayerOptions } from '../../protocol/IRenderer';
import type { DisplayTransformConfig } from '../../protocol/DisplayTransform';
import type { ChannelMask } from '../../protocol/DisplayTransform';
import { drawLayerInstance } from '../shared/painter2d';
import { FilterFastTrack } from './FilterFastTrack';
import { PixelUtils } from './PixelUtils';

/**
 * SVG filter IDs for GPU-accelerated channel isolation.
 * These reference <filter> elements injected into the document by ensureChannelFiltersSVG().
 *
 * Single-channel filters (red/green/blue/alpha) → grayscale output.
 * Multi-channel filters (rg/rb/gb) → color output with disabled channel zeroed.
 *
 * Alpha uses feColorMatrix `values="0 0 0 1 0 ..."` which reads the A component
 * directly — this works correctly because canvas stores A as un-premultiplied in
 * the alpha byte (premultiplication only affects R/G/B storage).
 */
const CHANNEL_FILTER_MAP: Record<Exclude<ChannelMask, 'rgb'>, string> = {
  red:   'url(#__gpex_ch_red)',
  green: 'url(#__gpex_ch_green)',
  blue:  'url(#__gpex_ch_blue)',
  alpha: 'url(#__gpex_ch_alpha)',
  rg:    'url(#__gpex_ch_rg)',
  rb:    'url(#__gpex_ch_rb)',
  gb:    'url(#__gpex_ch_gb)',
};

/**
 * Canvas2dEngine: Real atomic graphics engine for Engine V2.
 * Implements IRenderer for on-screen rendering via Canvas 2D API.
 */
export class Canvas2dEngine implements IRenderer {
  private commandQueue: RenderCommand[] = [];
  private ctx: CanvasRenderingContext2D | null = null;
  private currentDim: Dimensions | null = null;
  private tilePool: TileData[] = [];
  private offscreenPool: OffscreenCanvas[] = [];
  private artboardClipActive = false;
  /** Cold-start frame counter — suppress perf warnings for first 3 flushes (GPU warm-up) */
  private _flushCount = 0;

  /** Filter Fast-Track (Track A) — synchronous LUT/matrix preview */
  private filterFastTrack = new FilterFastTrack();

  // ─── Display Transform Pipeline ───

  /** Current frame's display transform config (set in beginFrame, consumed in endFrame) */
  private displayConfig: DisplayTransformConfig | null = null;
  /** Screen canvas context — saved when display transform redirects drawing to intermediate */
  private screenCtx: CanvasRenderingContext2D | null = null;
  /** Intermediate offscreen canvas for display transform compositing */
  private dtIntermediate: OffscreenCanvas | null = null;
  private dtIntermediateCtx: OffscreenCanvasRenderingContext2D | null = null;

  // ─── Font Service Integration ───

  private fontService?: FontService;
  private pendingFontLoads = new Set<string>();
  private fontReadyCallback?: () => void;

  /**
   * Inject FontService and redraw callback.
   * Called by CanvasStage during initialization to enable font-aware rendering.
   */
  setFontService(fonts: FontService, onFontReady: () => void): void {
    this.fontService = fonts;
    this.fontReadyCallback = onFontReady;
  }

  // ─── IRenderer Interface ───

  /** Inject drawing context (DOM binding, must be injected at component layer). */
  attach(ctx: CanvasRenderingContext2D): void {
    this.ctx = ctx;
  }

  /** Detach context (cleanup). */
  detach(): void {
    this.ctx = null;
  }

  beginFrame(dim: Dimensions, artboardClip?: Rect, displayConfig?: DisplayTransformConfig): void {
    if (!this.ctx) return;
    this.currentDim = dim;
    this.commandQueue = [];
    this.artboardClipActive = false;
    this.displayConfig = displayConfig || null;
    this.screenCtx = null;

    const needsTransform = displayConfig && displayConfig.channelMask !== 'rgb';

    if (needsTransform) {
      // [Display Transform] Redirect drawing to intermediate offscreen canvas.
      // All layer drawing (pushCommand → flush) will target the intermediate.
      // endFrame() blits intermediate → screen with channel filter applied.
      this.screenCtx = this.ctx;
      const w = this.ctx.canvas.width;
      const h = this.ctx.canvas.height;
      this.ensureDTIntermediate(w, h);
      this.ctx = this.dtIntermediateCtx as unknown as CanvasRenderingContext2D;
    }

    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.height);

    // [Artboard Boundary Clip] Restrict all subsequent rendering to artboard area.
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

    for (const cmd of this.commandQueue) {
      if (cmd.type === 'layer') {
        // [Font Loading] Check font readiness for text layers
        if (cmd.layer.type === 'text' && cmd.layer.textData && this.fontService) {
          const family = cmd.layer.textData.fontFamily;
          if (family && !this.fontService.isLoaded(family)) {
            if (!this.pendingFontLoads.has(family)) {
              this.pendingFontLoads.add(family);
              this.fontService.load(family).then((ok) => {
                this.pendingFontLoads.delete(family);
                if (ok && this.fontReadyCallback) {
                  requestAnimationFrame(() => this.fontReadyCallback!());
                }
              });
            }
          }
        }
        _layerCount++;
        this.drawLayerDirect(cmd.layer, cmd.options, assetService);
      }
    }

    this.commandQueue = [];

    const _flushDuration = performance.now() - _flushT0;
    this._flushCount++;
    if (_flushDuration > 16 && this._flushCount > 3) {
      console.warn(`[Canvas2dEngine.flush] ⚠️ took ${_flushDuration.toFixed(1)}ms | layers=${_layerCount}`);
    }

    // Restore artboard clip
    if (this.artboardClipActive) {
      this.ctx.restore();
      this.artboardClipActive = false;
    }
  }

  // ─── Shape Drawing ───

  drawShape(ctx: CanvasRenderingContext2D, shape: Shape | LocalShape): void {
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

  // ─── Direct Layer Drawing (IRenderer) ───

  drawLayerDirect(layer: Layer, options: DrawLayerOptions, assetService?: AssetService): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const {
      matrix, opacity, clipSequence, drawRect,
      imageSmoothingQuality = 'high', imageOverride,
      isExporting,
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
        __compiledPath2D: this.getCachedPath2D(shrinkInvertedMask(clip.shape, clip.inverted, scale)),
      }));
      drawLayerInstance(ctx, layer, null, {
        matrix, opacity, clipSequence: preparedClips, width: options.width, height: options.height, drawRect, imageSmoothingQuality,
      });
      return;
    }

    const asset = (layer.assetId && assetService) ? assetService.get(layer.assetId) : null;
    const tileMeta = asset?.tileMeta;
    const dprScale = tileMeta?.dprScale;

    // [Core Dispatch Logic]
    const hasBitmap = !!(layer.bitmapMasks && layer.bitmapMasks.some(m => m.enabled));
    const isTooLarge = (layer.bounding.w * layer.bounding.h) > MAX_SAFE_EXPORT_PIXELS;
    const hasFiltersPipeline = !isExporting && this.filterFastTrack.hasFilters(layer);
    const isInteracting = !!(options.isInteracting || filterCache.isDragging());
    const shouldUseTiles = tileMeta?.isTiled && (!isExporting || isTooLarge) && !imageOverride && !hasBitmap && !hasFiltersPipeline;

    if (shouldUseTiles) {
      // --- Tile Rendering Path ---
      const preparedClips = clipSequence?.map(clip => ({
        ...clip,
        __compiledPath2D: this.getCachedPath2D(shrinkInvertedMask(clip.shape, clip.inverted, scale)),
      }));

      const tileCount = PixelUtils.computeTileJobs(
        layer.assetId!,
        tileMeta!,
        matrix,
        drawRect,
        isExporting || false,
        this.tilePool,
        tileCache,
      );

      if (tileCount > 0) {
        drawLayerInstance(ctx, layer, this.tilePool, {
          matrix, opacity, clipSequence: preparedClips, width: options.width, height: options.height, drawRect, imageSmoothingQuality,
          tileCount, dprScale,
        });
      } else if (layer.src) {
        // Tile not ready — fall back to single image
        const fallbackSrc = assetService ? assetService.resolve(layer.assetId, layer.src) : layer.src;
        const rawImg = sourceBitmapCache.getOrFetch(fallbackSrc);
        if (rawImg) {
          const { img: effImg, layer: effLayer } = this.resolveFilteredSource(layer, rawImg, isExporting, isInteracting);
          drawLayerInstance(ctx, effLayer, effImg, {
            matrix, opacity, clipSequence: preparedClips, width: options.width, height: options.height, drawRect, imageSmoothingQuality,
            dprScale,
          });
        }
      }
    } else {
      // --- Single Image Rendering Path ---
      const currentSrc = assetService ? assetService.resolve(layer.assetId, layer.src) : layer.src;
      const rawImg = imageOverride || (currentSrc ? sourceBitmapCache.getOrFetch(currentSrc) : null);

      if (rawImg) {
        const preparedClips = clipSequence?.map(clip => ({
          ...clip,
          __compiledPath2D: this.getCachedPath2D(shrinkInvertedMask(clip.shape, clip.inverted, scale)),
        }));
        const { img: effImg, layer: effLayer } = this.resolveFilteredSource(layer, rawImg, isExporting, isInteracting);
        drawLayerInstance(ctx, effLayer, effImg, {
          matrix, opacity, clipSequence: preparedClips, width: options.width, height: options.height, drawRect, imageSmoothingQuality,
          dprScale,
        });
      }
    }
  }

  // ─── Offscreen Composite Path ───

  /** Determine if offscreen synthesis is needed */
  private needsOffscreenComposite(layer: Layer, options: DrawLayerOptions): boolean {
    if (options.bitmapMaskOverride) return true;
    if (layer.bitmapMasks?.some(m => m.enabled)) return true;
    if (layer.blendMode && layer.blendMode !== 'source-over') return true;
    if ((layer.adjustments?.blur ?? 0) > 0) return true;
    return false;
  }

  /**
   * Offscreen synthesis path: content → vector clip → bitmap mask → composite to main canvas.
   * Viewport-clipped offscreen size prevents performance degradation under high zoom.
   */
  private drawLayerOffscreen(
    layer: Layer,
    options: DrawLayerOptions,
    assetService: AssetService | undefined,
  ): void {
    if (!this.ctx) return;
    const _offT0 = performance.now();
    const mainCtx = this.ctx;

    // 1. Calculate physical pixel bounding box (Screen Space AABB)
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
        { x: contentRect.x + contentRect.w, y: contentRect.y + contentRect.h },
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

    // 1b. Viewport clipping
    const viewportW = mainCtx.canvas.width;
    const viewportH = mainCtx.canvas.height;

    const clipLeft = Math.max(Math.floor(minX), 0);
    const clipTop = Math.max(Math.floor(minY), 0);
    const clipRight = Math.min(Math.ceil(maxX), viewportW);
    const clipBottom = Math.min(Math.ceil(maxY), viewportH);

    if (clipRight <= clipLeft || clipBottom <= clipTop) return;

    const finalW = clipRight - clipLeft;
    const finalH = clipBottom - clipTop;
    const screenX = clipLeft;
    const screenY = clipTop;

    // 2. Get offscreen canvas (pooled)
    const offscreen = this.acquireOffscreen(finalW, finalH);
    if (offscreen.width < finalW || offscreen.height < finalH) {
      offscreen.width = finalW;
      offscreen.height = finalH;
    }
    const offCtx = offscreen.getContext('2d')!;
    offCtx.clearRect(0, 0, finalW, finalH);

    // 3. Draw layer content on offscreen (adjusted matrix)
    const oldCtx = this.ctx;
    this.ctx = offCtx as unknown as CanvasRenderingContext2D;

    const m = options.matrix;
    const offscreenMatrix = m ? {
      a: m.a, b: m.b, c: m.c, d: m.d,
      tx: m.tx - screenX, ty: m.ty - screenY,
    } : undefined;

    const offscreenOptions: DrawLayerOptions = {
      ...options,
      matrix: offscreenMatrix,
      opacity: 1.0,
      bitmapMaskOverride: undefined,
    };

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

    // 4. Apply bitmap masks on offscreen
    const activeBitmapMasks = [...(layer.bitmapMasks?.filter(bm => bm.enabled) || [])];

    if (options.bitmapMaskOverride) {
      const overrideId = options.bitmapMaskOverride.maskId;
      if (!activeBitmapMasks.some(bm => bm.id === overrideId)) {
        activeBitmapMasks.push({
          id: overrideId,
          src: '',
          assetId: '',
          bounds: asLocalRect({ x: 0, y: 0, w: layer.bounding.w, h: layer.bounding.h }),
          inverted: false,
          enabled: true,
          feather: 0,
        });
      }
    }

    const hasBitmapMasks = activeBitmapMasks.length > 0 || !!options.bitmapMaskOverride;

    if (hasBitmapMasks) {
      for (const bm of activeBitmapMasks) {
        const maskSource = (options.bitmapMaskOverride?.maskId === bm.id)
          ? options.bitmapMaskOverride.source
          : sourceBitmapCache.getOrFetch(bm.src);

        if (!maskSource) continue;

        offCtx.save();
        if (offscreenMatrix) {
          offCtx.setTransform(
            offscreenMatrix.a, offscreenMatrix.b,
            offscreenMatrix.c, offscreenMatrix.d,
            offscreenMatrix.tx, offscreenMatrix.ty,
          );
        }
        if (bm.feather > 0) {
          const physicalRadius = bm.feather * (offscreenMatrix?.a || 1);
          offCtx.filter = `blur(${physicalRadius}px)`;
        }
        offCtx.imageSmoothingEnabled = false;
        offCtx.globalCompositeOperation = bm.inverted ? 'destination-out' : 'destination-in';
        offCtx.drawImage(maskSource as CanvasImageSource, bm.bounds.x, bm.bounds.y, bm.bounds.w, bm.bounds.h);
        offCtx.restore();
      }
    }

    // 5. Composite offscreen result to main canvas
    mainCtx.save();
    mainCtx.setTransform(1, 0, 0, 1, 0, 0);
    mainCtx.globalAlpha = options.opacity ?? layer.opacity ?? 1;
    mainCtx.globalCompositeOperation = (layer.blendMode || 'source-over') as GlobalCompositeOperation;

    const blurLogical = layer.adjustments?.blur ?? 0;
    if (blurLogical > 0) {
      const blurScale = options.matrix ? Math.abs(options.matrix.a) : 1;
      mainCtx.filter = `blur(${blurLogical * blurScale}px)`;
    }
    mainCtx.drawImage(offscreen, 0, 0, finalW, finalH, screenX, screenY, finalW, finalH);
    mainCtx.restore();

    // 6. Return offscreen canvas
    this.releaseOffscreen(offscreen);

    const _offDuration = performance.now() - _offT0;
    if (_offDuration > 8) {
      const reason = (layer.bitmapMasks?.some(bm => bm.enabled))
        ? 'bitmapMask'
        : (layer.blendMode && layer.blendMode !== 'source-over')
          ? layer.blendMode
          : (layer.adjustments?.blur ?? 0) > 0
            ? 'blur'
            : 'blend';
      console.debug(
        `[Canvas2dEngine.offscreen] layer="${layer.name}" reason=${reason} size=${finalW}x${finalH} took ${_offDuration.toFixed(1)}ms`,
      );
    }
  }

  // ─── Filter Resolution ───

  /**
   * Resolve the "effective" image source for a layer.
   * Transparently dispatches to FilterFastTrack (Track A) during interaction,
   * or FilterCache (Track B) for full-res async results.
   */
  private resolveFilteredSource<T>(
    layer: Layer,
    img: T,
    isExporting: boolean | undefined,
    isInteracting: boolean | undefined,
  ): { img: T; layer: Layer } {
    if (isExporting) return { img, layer };
    if (!this.filterFastTrack.hasFilters(layer)) return { img, layer };
    if (!(img instanceof ImageBitmap)) return { img, layer };

    const filters = this.filterFastTrack.normalize(layer);
    if (filters.length === 0) return { img, layer };

    // Build the "stripped" layer: all filter adjustments baked into pixels,
    // but blur is preserved (handled separately by offscreen composite path).
    const strippedAdjustments = layer.adjustments?.blur
      ? { brightness: 100 as const, contrast: 100 as const, saturation: 100 as const, hueRotate: 0 as const, blur: layer.adjustments.blur }
      : undefined;

    // --- Interaction Fast-Track Path (Track A: synchronous LUT/matrix preview) ---
    if (isInteracting) {
      const resultCanvas = this.filterFastTrack.applyInteractionPreview(layer, img);
      if (resultCanvas) {
        return {
          img: resultCanvas as unknown as T,
          layer: { ...layer, adjustments: strippedAdjustments },
        };
      }
    }

    // --- Standard Path (Track B: AsyncFilterCache via Worker) ---
    const filtered = filterCache.get(layer);
    if (filtered) {
      if (layer.assetId) {
        this.filterFastTrack.clearBridgeResult(layer.assetId);
      }
      return {
        img: filtered as unknown as T,
        layer: { ...layer, adjustments: strippedAdjustments },
      };
    }

    // Cache miss: schedule async worker job
    filterCache.schedule(layer, img);

    // Bridge: prefer last Track A result over stale/raw
    if (layer.assetId) {
      const bridge = this.filterFastTrack.getBridgeResult(layer.assetId);
      if (bridge) {
        return {
          img: bridge as unknown as T,
          layer: { ...layer, adjustments: strippedAdjustments },
        };
      }
    }

    const stale = filterCache.getStale(layer);
    if (stale) {
      return {
        img: stale as unknown as T,
        layer: { ...layer, adjustments: strippedAdjustments },
      };
    }
    return { img, layer };
  }

  // ─── Display Transform: endFrame ───

  /**
   * Post-composite display transform — final pipeline stage.
   * Blits the intermediate buffer to screen canvas with channel filter applied.
   */
  endFrame(): void {
    const mask = this.displayConfig?.channelMask || 'rgb';

    // Fast path: no transform active, drawing went directly to screen canvas
    if (mask === 'rgb' || !this.screenCtx || !this.dtIntermediate) {
      this.displayConfig = null;
      return;
    }

    // Restore artboard clip on the intermediate (if still active after flush)
    if (this.artboardClipActive) {
      this.ctx!.restore();
      this.artboardClipActive = false;
    }

    // Blit intermediate → screen with channel filter
    const screen = this.screenCtx;
    screen.setTransform(1, 0, 0, 1, 0, 0);
    screen.clearRect(0, 0, screen.canvas.width, screen.canvas.height);

    // All channels (including alpha) use GPU-accelerated SVG feColorMatrix path.
    // Alpha filter reads the A component directly via matrix row `0 0 0 1 0`.
    screen.filter = CHANNEL_FILTER_MAP[mask];
    screen.drawImage(this.dtIntermediate, 0, 0);
    screen.filter = 'none';

    // Restore ctx pointer to screen
    this.ctx = this.screenCtx;
    this.screenCtx = null;
    this.displayConfig = null;
  }

  /**
   * Ensure the display transform intermediate canvas exists and is correctly sized.
   * GPU-backed (no willReadFrequently) for maximum drawImage + filter performance.
   */
  private ensureDTIntermediate(w: number, h: number): void {
    if (!this.dtIntermediate || this.dtIntermediate.width !== w || this.dtIntermediate.height !== h) {
      this.dtIntermediate = new OffscreenCanvas(w, h);
      this.dtIntermediateCtx = this.dtIntermediate.getContext('2d')!;
    }
  }

  // ─── Path2D Cache ───

  private pathCache = new Map<string, Path2D>();
  private getCachedPath2D(shape: Shape): Path2D {
    const { rect } = shape;
    const extShape = shape as Shape & { antiAliased?: boolean; pathData?: string };
    const aa = extShape.antiAliased !== false;
    const key = `${shape.type}-${rect.x},${rect.y},${rect.w},${rect.h}-${extShape.pathData || ''}-aa:${aa}`;
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

  // ─── OffscreenCanvas Pool ───

  private acquireOffscreen(w: number, h: number): OffscreenCanvas {
    const idx = this.offscreenPool.findIndex(c => c.width >= w && c.height >= h);
    if (idx !== -1) {
      return this.offscreenPool.splice(idx, 1)[0];
    }
    return new OffscreenCanvas(w, h);
  }

  private releaseOffscreen(canvas: OffscreenCanvas): void {
    if (this.offscreenPool.length < 4) {
      this.offscreenPool.push(canvas);
    } else {
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
      if (newArea > minArea) {
        this.offscreenPool[minIdx] = canvas;
      }
    }
  }
}
