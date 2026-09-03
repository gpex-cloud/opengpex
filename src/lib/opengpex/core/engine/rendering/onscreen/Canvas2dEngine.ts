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

import type { Layer, AssetService, Shape, LocalShape, TileData, Rect, Dimensions, ClipDescriptor } from '@opengpex/editor/core/types';
import { asLocalRect } from '@opengpex/editor/core/types';
import type { FontService } from '@opengpex/editor/core/fonts';
import { MAX_SAFE_EXPORT_PIXELS, PERF_MON } from '@opengpex/editor/core/helpers/config';
import { shapeToPath2D } from '@opengpex/editor/core/helpers/path2d';
import { shrinkInvertedMask, expandFragmentClip, isExpandableFragmentClip } from '@opengpex/editor/core/helpers/sub-pixel';

import { sourceBitmapCache } from '../../cache/SourceBitmapCache';
import { tileCache } from '../../cache/TileCache';
import { filterCache } from '../../cache/FilterCache';
import type { IRenderer, RenderCommand, DrawLayerOptions } from '../../protocol/IRenderer';
import type { DisplayTransformConfig } from '../../protocol/DisplayTransform';
import type { ChannelMask } from '../../protocol/DisplayTransform';
import { computeTileJobs } from '@opengpex/editor/core/helpers/tiling';
import { drawLayerInstance } from '../shared/painter2d';
import { FilterFastTrack } from './FilterFastTrack';
import { convertBufferTRC } from '../shared/trc';
import { blendBuffersLinear } from '../shared/blend2d';

import type { TRC, WorkingColorSpace, LayerBlendMode } from '@opengpex/editor/core/types';

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

  // ─── Frame Color Config ───

  /** Current frame's TRC (transfer characteristic). Set via setFrameConfig() before beginFrame. */
  private frameTRC: TRC = 'srgb-trc';
  /** Current frame's working color space. Used for P3 luminance coefficients in HSL blend. */
  private frameColorSpace: 'srgb' | 'display-p3' = 'srgb';

  /**
   * Set the current frame's color configuration.
   * Must be called before beginFrame() each rAF cycle so that the engine
   * can decide whether to use linear-light blending for blend mode layers.
   *
   * @param config.trc - Frame's transfer characteristic ('srgb-trc' or 'linear')
   * @param config.colorSpace - Frame's working color space (for HSL luminance coefficients)
   */
  setFrameConfig(config: { trc: TRC; colorSpace: WorkingColorSpace }): void {
    this.frameTRC = config.trc;
    // Map WorkingColorSpace to the subset supported by blend2d.ts
    this.frameColorSpace = config.colorSpace === 'display-p3' ? 'display-p3' : 'srgb';
  }

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

    let _flushT0 = 0;
    let _layerCount = 0;
    if (PERF_MON) { _flushT0 = performance.now(); }

    for (const cmd of this.commandQueue) {
      if (cmd.type === 'layer') {
        // Group layers have no pixel data — defensive skip (normally filtered upstream by StageComposer)
        if (cmd.layer.type === 'group') continue;

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
        if (PERF_MON) { _layerCount++; }
        this.drawLayerDirect(cmd.layer, cmd.options, assetService);
      }
    }

    this.commandQueue = [];

    if (PERF_MON) {
      const _flushDuration = performance.now() - _flushT0;
      this._flushCount++;
      if (_flushDuration > 16 && this._flushCount > 3) {
        console.warn(`[Canvas2dEngine.flush] ⚠️ took ${_flushDuration.toFixed(1)}ms | layers=${_layerCount}`);
      }
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
    if (this.needsOffscreenComposite(layer, options, assetService)) {
      this.drawLayerOffscreen(layer, options, assetService);
      return;
    }

    if (layer.type === 'color') {
      const preparedClips = this.prepareClipSequence(clipSequence, layer, scale);
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
      const preparedClips = this.prepareClipSequence(clipSequence, layer, scale);

      const { tileCount, missCount } = computeTileJobs(
        layer.assetId!,
        tileMeta!,
        matrix,
        drawRect,
        isExporting || false,
        this.tilePool,
        tileCache,
      );

      if (tileCount > 0 && missCount === 0) {
        // ── Perfect path: all tiles ready → pure tile rendering (fastest) ──
        drawLayerInstance(ctx, layer, this.tilePool, {
          matrix, opacity, clipSequence: preparedClips, width: options.width, height: options.height, drawRect, imageSmoothingQuality,
          tileCount, dprScale,
        });
      } else {
        // ── Fallback path: tiles not fully ready → use SourceBitmapCache single image ──
        // Design: the source image is already full-resolution (same data tiles are cut from).
        // Drawing source + partial tiles on top would double GPU draw calls with zero quality gain.
        // This ensures no white blocks regardless of cache state (robustness guarantee).
        //
        // [Perf] Use 'low' (bilinear) smoothing in fallback: this is a transient display
        // that will be replaced by tile-perfect path once tiles load. For downscale scenarios
        // (e.g. 4284×5712 source → 3174×2270 canvas), bilinear is visually indistinguishable
        // from bicubic but ~4× faster (24M-pixel bicubic ≈ 35ms → bilinear ≈ 8ms).
        const fallbackSrc = layer.src ? (assetService ? assetService.resolve(layer.assetId, layer.src) : layer.src) : null;
        const rawImg = fallbackSrc ? sourceBitmapCache.getOrFetch(fallbackSrc) : null;
        if (rawImg) {
          drawLayerInstance(ctx, layer, rawImg, {
            matrix, opacity, clipSequence: preparedClips, width: options.width, height: options.height, drawRect,
            imageSmoothingQuality: 'low',
            dprScale,
          });
        }
      }
    } else {
      // --- Single Image Rendering Path ---
      const currentSrc = assetService ? assetService.resolve(layer.assetId, layer.src) : layer.src;
      const rawImg = imageOverride || (currentSrc ? sourceBitmapCache.getOrFetch(currentSrc) : null);

      if (rawImg) {
        const preparedClips = this.prepareClipSequence(clipSequence, layer, scale);
        const { img: effImg, layer: effLayer } = this.resolveFilteredSource(layer, rawImg, isExporting, isInteracting);
        drawLayerInstance(ctx, effLayer, effImg, {
          matrix, opacity, clipSequence: preparedClips, width: options.width, height: options.height, drawRect, imageSmoothingQuality,
          dprScale,
        });
      }
    }
  }

  // ─── Offscreen Composite Path ───

  /**
   * Determine if offscreen synthesis is needed.
   *
   * Phase 4 optimization: For non-tiled layers in gamma-space, blend mode can be
   * applied directly via globalCompositeOperation without offscreen isolation
   * (single drawImage has no tile seam issue). Only tiled layers and linear-light
   * path still require offscreen isolation for blend modes.
   *
   * Opacity/fill < 1 also requires offscreen isolation for tiled layers:
   * globalAlpha is set before the tile loop in painter2d.ts, so tile overlap
   * regions get drawn twice with reduced alpha → overlap accumulates more opacity
   * than the center → visible seam lines. Same root cause as blend mode seams (§3.2.1).
   */
  private needsOffscreenComposite(layer: Layer, options: DrawLayerOptions, assetService?: AssetService): boolean {
    // 1. Bitmap mask always needs offscreen
    if (options.bitmapMaskOverride) return true;
    if (layer.bitmapMasks?.some(m => m.enabled)) return true;

    // 2. Blur always needs offscreen (neighborhood operator can't apply per-tile)
    if ((layer.adjustments?.blur ?? 0) > 0) return true;

    // 3. Blend mode: conditional offscreen
    if (layer.blendMode && layer.blendMode !== 'source-over') {
      // Tiled layers need isolation to prevent tile seam artifacts
      if (this.wouldUseTiles(layer, options, assetService)) return true;
      // Linear-light path needs offscreen to get ImageData for manual blend
      if (this.frameTRC === 'linear') return true;
      // ★ Gamma path + non-tiled layer: no isolation needed (single drawImage is safe)
      return false;
    }

    // 4. Opacity/fill < 1 on tiled layers: same seam issue as blend mode
    // Tile overlap regions get globalAlpha applied twice → double-opacity seam lines
    const effectiveAlpha = (options.opacity ?? layer.opacity ?? 1) * (layer.fill ?? 1);
    if (effectiveAlpha < 1 && this.wouldUseTiles(layer, options, assetService)) return true;

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
      fill: undefined, // Strip fill — applied in final composite to prevent tile seam (§3.2.3)
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
    const hasBlendMode = !!(layer.blendMode && layer.blendMode !== 'source-over');
    const blurLogical = layer.adjustments?.blur ?? 0;

    // Compute effective alpha for final composite: opacity × fill
    // Fill was stripped from contentLayer (drawn at full alpha to prevent tile seam §3.2.3),
    // so we must re-apply it here alongside opacity.
    const compositeAlpha = (options.opacity ?? layer.opacity ?? 1) * (layer.fill ?? 1);

    if (hasBlendMode && this.frameTRC === 'linear' && blurLogical === 0) {
      // ★ Linear-light blend path: manual per-pixel blend for WYSIWYG with export
      this.blendOffscreenLinear(offscreen, layer, mainCtx, screenX, screenY, compositeAlpha);
    } else {
      // Gamma-space path: use browser's native globalCompositeOperation
      mainCtx.save();
      mainCtx.setTransform(1, 0, 0, 1, 0, 0);
      mainCtx.globalAlpha = compositeAlpha;
      mainCtx.globalCompositeOperation = (layer.blendMode || 'source-over') as GlobalCompositeOperation;

      if (blurLogical > 0) {
        const blurScale = options.matrix ? Math.abs(options.matrix.a) : 1;
        mainCtx.filter = `blur(${blurLogical * blurScale}px)`;
      }
      mainCtx.drawImage(offscreen, 0, 0, finalW, finalH, screenX, screenY, finalW, finalH);
      mainCtx.restore();
    }

    // 6. Return offscreen canvas
    this.releaseOffscreen(offscreen);

    // const _offDuration = performance.now() - _offT0;
    // if (_offDuration > 8) {
    //   const reason = (layer.bitmapMasks?.some(bm => bm.enabled))
    //     ? 'bitmapMask'
    //     : (layer.blendMode && layer.blendMode !== 'source-over')
    //       ? layer.blendMode
    //       : (layer.adjustments?.blur ?? 0) > 0
    //         ? 'blur'
    //         : 'blend';
    //   console.debug(
    //     `[Canvas2dEngine.offscreen] layer="${layer.name}" reason=${reason} size=${finalW}x${finalH} took ${_offDuration.toFixed(1)}ms`,
    //   );
    // }
  }

  // ─── Filter Resolution ───

  /**
   * Resolve the "effective" image source for a layer.
   *
   * Fallback priority chain (highest to lowest quality):
   *   1. TrackB (filterCache HIT) — full-res Worker result, exact params ✅
   *   2. TrackA (applyInteractionPreview) — synchronous main-thread LUT/matrix ✅
   *   3. STALE (filterCache.getStale) — full-res but OLD params ⚠️
   *   4. RAW (original unfiltered image) — last resort ⚠️
   *
   * ═══ BUG FIX: Multi-layer filter flash (2026-08-08) ═══
   *
   * Problem: When two+ layers both had adjustments, releasing the slider
   * caused a 1-frame flash on the transitional frame (isInteracting: true→false).
   *
   * Root causes (two issues combined):
   *   A) FilterFastTrack used a SINGLE shared resultCanvas for ALL layers.
   *      In the same render frame, Layer B's TrackA computation overwrote
   *      Layer A's data. On the transition frame, getBridgeResult() for A
   *      returned B's pixels → wrong colors flash.
   *      Fix: per-assetId result canvases in FilterFastTrack.resultCanvasMap.
   *
   *   B) TrackA was gated by `if (isInteracting)`. On the transition frame,
   *      isInteracting=false meant TrackA was skipped entirely. The code fell
   *      through to BRIDGE (downsampled → resolution flash) or STALE (old
   *      params → color flash).
   *      Fix: removed the isInteracting gate. TrackA now always runs when
   *      filterCache misses. Its internal frame-cache (cachedFilterHash per
   *      assetId) ensures <0.1ms return when params haven't changed, so there
   *      is no performance regression for non-interacting frames.
   *
   * Result: TrackA provides visually-correct output on every frame. The Worker
   * delivers full-res quality async (TrackB) which seamlessly replaces TrackA
   * with only a quality improvement (no color/resolution discontinuity).
   */
  private resolveFilteredSource<T>(
    layer: Layer,
    img: T,
    isExporting: boolean | undefined,
    _isInteracting: boolean | undefined,
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

    // --- Standard Path (Track B: AsyncFilterCache via Worker) ---
    // Check Worker cache first — this is the highest quality (full-res, exact params).
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

    // --- Track A: Synchronous LUT/matrix preview ---
    // Always try TrackA when filterCache misses (not just during interaction).
    // This prevents the "transitional frame flash" — on mouseup, params are correct
    // in the frame-cache so TrackA returns immediately (<0.1ms) with correct appearance.
    // The Worker will deliver full-res shortly after (quality-only improvement, no flash).
    const resultCanvas = this.filterFastTrack.applyInteractionPreview(layer, img);
    if (resultCanvas) {
      // Schedule Worker for full-res version (fires in background)
      filterCache.schedule(layer, img);
      return {
        img: resultCanvas as unknown as T,
        layer: { ...layer, adjustments: strippedAdjustments },
      };
    }

    // TrackA failed — schedule Worker and use fallback
    filterCache.schedule(layer, img);

    // Fallback: STALE (full-res, old params) or RAW
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

  // ─── Linear-Light Blend ───

  /**
   * Blend the offscreen layer content onto the main canvas using linear-light compositing.
   *
   * This provides WYSIWYG parity with the Worker export path (Canvas2dBackend.composeLinear)
   * for 16-bit documents where Frame.trc === 'linear'.
   *
   * Algorithm:
   * 1. getImageData from both offscreen (source) and main canvas (destination)
   * 2. Convert both from sRGB-TRC → linear encoding
   * 3. Execute manual per-pixel blend via blend2d.ts
   * 4. Convert result from linear → sRGB-TRC
   * 5. putImageData back to main canvas
   *
   * @param offscreen - The offscreen canvas containing the rendered layer content
   * @param layer - The layer (for blendMode and opacity)
   * @param mainCtx - The main canvas 2D context
   * @param destX - X offset in main canvas where the offscreen should be composited
   * @param destY - Y offset in main canvas where the offscreen should be composited
   * @param opacityOverride - Optional opacity override from DrawLayerOptions
   */
  private blendOffscreenLinear(
    offscreen: OffscreenCanvas,
    layer: Layer,
    mainCtx: CanvasRenderingContext2D,
    destX: number,
    destY: number,
    opacityOverride?: number,
  ): void {
    const { width, height } = offscreen;
    if (width === 0 || height === 0) return;

    const offCtx = offscreen.getContext('2d')!;

    // Get offscreen content (already contains transforms, vector clips, bitmap masks)
    const srcData = offCtx.getImageData(0, 0, width, height);

    // Get main canvas corresponding region
    const dstData = mainCtx.getImageData(destX, destY, width, height);

    // sRGB-TRC → linear
    convertBufferTRC(srcData.data, 'srgb-trc', 'linear');
    convertBufferTRC(dstData.data, 'srgb-trc', 'linear');

    // Manual per-pixel blend in linear space
    const blendMode = (layer.blendMode || 'source-over') as LayerBlendMode;
    const opacity = opacityOverride ?? layer.opacity ?? 1;
    blendBuffersLinear(dstData.data, srcData.data, blendMode, opacity, this.frameColorSpace);

    // linear → sRGB-TRC
    convertBufferTRC(dstData.data, 'linear', 'srgb-trc');

    // Write back to main canvas
    mainCtx.putImageData(dstData, destX, destY);
  }

  // ─── Tile Detection (Phase 4 optimization) ───

  /**
   * Determine if a layer would use tile rendering (multiple drawImage calls).
   * Used by needsOffscreenComposite to decide if blend isolation is required.
   *
   * Checks BOTH the actual tileMeta.isTiled flag from asset service (primary)
   * and the pixel-count heuristic (fallback when assetService is unavailable).
   * This ensures the prediction matches the actual tile decision in drawLayerDirect.
   */
  private wouldUseTiles(layer: Layer, options: DrawLayerOptions, assetService?: AssetService): boolean {
    if (options.imageOverride) return false;
    if (layer.bitmapMasks?.some(m => m.enabled)) return false;

    // Primary check: use actual tileMeta from asset service (matches shouldUseTiles in drawLayerDirect)
    if (assetService && layer.assetId) {
      const asset = assetService.get(layer.assetId);
      if (asset?.tileMeta?.isTiled) return true;
    }

    // Fallback heuristic: pixel count exceeds safe threshold
    const totalPixels = layer.bounding.w * layer.bounding.h;
    return totalPixels > MAX_SAFE_EXPORT_PIXELS;
  }

  // ─── Clip Preparation (Phase 2 seam prevention) ───

  /**
   * Prepare clip descriptors with pre-compiled Path2D objects.
   *
   * For cut fragments (layer.metadata.assocMaskId), the visibleShape clip is
   * expanded outward by 0.75/scale to prevent anti-aliasing seams between
   * adjacent fragments sharing a visibleShape boundary.
   *
   * This is the PRIMARY fix for Phase 2: the visibleShape enters the clipSequence
   * via getRenderPipeline() in StageComposer, and applyClipSequence() applies it
   * BEFORE drawLayerContent(). Without expansion here, the original (tighter) clip
   * constrains the canvas before any expansion in drawLayerContent could take effect.
   */
  private prepareClipSequence(
    clipSequence: ClipDescriptor[] | undefined,
    layer: Layer,
    scale: number,
  ): ClipDescriptor[] | undefined {
    return clipSequence?.map(clip => {
      // Phase 2: Expand visibleShape clip for cut fragments (seam prevention).
      if (isExpandableFragmentClip(clip.shape, clip.inverted, layer.visibleShape, layer.metadata?.assocMaskId)) {
        const pathData = (clip.shape as Shape & { pathData: string }).pathData;
        const expandedPathData = expandFragmentClip(pathData, scale);
        const expandedShape = { ...clip.shape, pathData: expandedPathData } as Shape;
        return {
          ...clip,
          __compiledPath2D: this.getCachedPath2D(expandedShape),
        };
      }
      return {
        ...clip,
        __compiledPath2D: this.getCachedPath2D(shrinkInvertedMask(clip.shape, clip.inverted, scale, layer.bounding)),
      };
    });
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
