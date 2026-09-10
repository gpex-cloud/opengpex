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
 * SceneAssembler.ts — Translates UI / Redux state & Volatile fast-track
 * into an immutable declarative `Scene` descriptor (spec §5.1, §5.4).
 *
 * KEY RESPONSIBILITIES:
 *   1. Flattening layer groups (§5.1.2): groups are purely organisational in v2.
 *   2. Computing final destination affine transforms (local quad -> screen pixels).
 *   3. Synchronising resident textures into the WebGpuEngine via zero-copy upload.
 *   4. Producing a pure-data, immutable `Scene` ready for `engine.render(scene)`.
 *
 * @module core/gpu/scene/SceneAssembler
 */

import type {
  Frame,
  CameraState,
  Dimensions,
  GeometryService,
  AssetService,
  Layer,
  VectorMask,
} from '@opengpex/editor/core/types';
import { snapCanvasRect } from '@opengpex/editor/core/geometry/operators/snapping';
import { shapeToPath2D } from '@opengpex/editor/core/helpers/path2d';
import { sourceBitmapCache } from '@opengpex/editor/core/engine/renderer';
import type { Scene, SceneContent, LayerNode, MaskDesc, Mat3 } from './Scene';
import type { IEngine } from '../WebGpuEngine';
import type { ChannelMaskMode } from '../shaders/layer';

/**
 * WP-3.1: bounded LRU cache for pre-rasterized vector-mask bitmaps, keyed by
 * `layer.id`. The old implementation was an unbounded module-level Map that
 * never `close()`d its `ImageBitmap`s on layer delete / document close, leaking
 * up to ~1.6GB after ~20 cut layers (Review §4.3).
 *
 * Fix: cap the entry count and `close()` the evicted bitmap; expose an explicit
 * `clearVectorMaskCache()` for teardown (wired into `WebGpuEngine.destroy()`).
 */
const VECTOR_MASK_CACHE_LIMIT = 32;
const vectorMaskCache = new Map<string, { key: string; bitmap: ImageBitmap }>();

/** Close an ImageBitmap if the platform supports it (guard for SSR / tests). */
function closeBitmap(bitmap: ImageBitmap | undefined): void {
  if (bitmap && typeof bitmap.close === 'function') {
    bitmap.close();
  }
}

/**
 * Insert/refresh a vector-mask cache entry with LRU eviction. Map iteration
 * order is insertion order, so deleting-then-setting moves an entry to the most
 * recent position; the oldest key is the first `keys().next()`. Exported for
 * unit tests (the OffscreenCanvas rasterize path is unavailable under `node`).
 */
export function setVectorMaskCache(layerId: string, key: string, bitmap: ImageBitmap): void {
  const prev = vectorMaskCache.get(layerId);
  if (prev && prev.bitmap !== bitmap) {
    closeBitmap(prev.bitmap);
  }
  vectorMaskCache.delete(layerId);
  vectorMaskCache.set(layerId, { key, bitmap });

  while (vectorMaskCache.size > VECTOR_MASK_CACHE_LIMIT) {
    const oldest = vectorMaskCache.keys().next().value;
    if (oldest === undefined) break;
    const evicted = vectorMaskCache.get(oldest);
    vectorMaskCache.delete(oldest);
    closeBitmap(evicted?.bitmap);
  }
}

/**
 * Release all cached vector-mask bitmaps. Call on document close / engine
 * teardown so `ImageBitmap`s do not leak (Review §4.3).
 */
export function clearVectorMaskCache(): void {
  for (const entry of vectorMaskCache.values()) {
    closeBitmap(entry.bitmap);
  }
  vectorMaskCache.clear();
}

/** Current number of cached vector-mask entries (test/diagnostics helper). */
export function vectorMaskCacheSize(): number {
  return vectorMaskCache.size;
}

function getVectorMasksKey(layerId: string, masks: VectorMask[], w: number, h: number): string {
  return `${layerId}:${w}x${h}:${masks
    .map(
      (m) =>
        `${m.id}_${m.inverted}_${m.feather}_${m.shape.rect.x}_${m.shape.rect.y}_${m.shape.rect.w}_${m.shape.rect.h}`,
    )
    .join(';')}`;
}

function renderVectorMasksToBitmap(
  masks: VectorMask[],
  width: number,
  height: number,
): ImageBitmap | undefined {
  if (typeof OffscreenCanvas === 'undefined') return undefined;
  if (width <= 0 || height <= 0) return undefined;

  try {
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(width)),
      Math.max(1, Math.round(height)),
    );
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    const hasInverted = masks.some((m) => m.inverted);

    if (hasInverted) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);

      for (const m of masks) {
        const isFeathered = (m.feather || 0) > 0;
        if (!isFeathered && m.shape.type === 'rect') {
          const r = m.shape.rect;
          const rx = Math.round(r.x);
          const ry = Math.round(r.y);
          const rw = Math.round(r.w);
          const rh = Math.round(r.h);
          if (m.inverted) {
            ctx.clearRect(rx, ry, rw, rh);
          } else {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(rx, ry, rw, rh);
          }
        } else {
          const path = shapeToPath2D(m.shape);
          if (m.inverted) {
            ctx.globalCompositeOperation = 'destination-out';
            if (isFeathered) {
              ctx.filter = `blur(${m.feather}px)`;
            }
            ctx.fillStyle = '#ffffff';
            ctx.fill(path, m.shape.type === 'path' ? 'evenodd' : 'nonzero');
            ctx.filter = 'none';
            ctx.globalCompositeOperation = 'source-over';
          } else {
            ctx.globalCompositeOperation = 'destination-in';
            if (isFeathered) {
              ctx.filter = `blur(${m.feather}px)`;
            }
            ctx.fillStyle = '#ffffff';
            ctx.fill(path, m.shape.type === 'path' ? 'evenodd' : 'nonzero');
            ctx.filter = 'none';
            ctx.globalCompositeOperation = 'source-over';
          }
        }
      }
    } else {
      ctx.clearRect(0, 0, width, height);
      for (const m of masks) {
        const isFeathered = (m.feather || 0) > 0;
        if (!isFeathered && m.shape.type === 'rect') {
          const r = m.shape.rect;
          const rx = Math.round(r.x);
          const ry = Math.round(r.y);
          const rw = Math.round(r.w);
          const rh = Math.round(r.h);
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(rx, ry, rw, rh);
        } else {
          const path = shapeToPath2D(m.shape);
          if (isFeathered) {
            ctx.filter = `blur(${m.feather}px)`;
          }
          ctx.fillStyle = '#ffffff';
          ctx.fill(path, m.shape.type === 'path' ? 'evenodd' : 'nonzero');
          ctx.filter = 'none';
        }
      }
    }

    return canvas.transferToImageBitmap();
  } catch {
    return undefined;
  }
}

/**
 * One resident-texture upload the built Scene depends on (WP-5.4). Captured by
 * `buildScene` (pure) and flushed by `syncAssets` (side-effecting).
 */
export interface AssetUpload {
  readonly assetId: string;
  readonly bitmap: ImageBitmap;
}

/**
 * The CAMERA-INDEPENDENT inputs to assembly — everything that determines the
 * composited document texture (P1 §4). `buildContent` consumes ONLY these, so
 * its output ({@link SceneContent} + uploads) is safe to memoize across
 * cam-only frames (pan/zoom). Deliberately excludes camera/viewport/dpr.
 */
export interface SceneContentOptions {
  readonly frame: Frame;
  readonly geometry: GeometryService;
  readonly assets?: AssetService;
  readonly engine?: IEngine;
  readonly getAnimatedRotation?: (layer: Layer) => number;
  readonly getImageOverride?: (layerId: string) => ImageBitmap | CanvasImageSource | undefined;
  readonly getBitmapMaskOverride?: (
    layerId: string,
  ) => { maskId: string; source: CanvasImageSource; bounds?: { x: number; y: number } } | undefined;
  readonly hdr?: boolean;
}

/**
 * The CAMERA-DEPENDENT inputs — cheap to recompute every frame. `composeView`
 * folds these onto a (possibly reused) {@link SceneContent} to produce the final
 * `Scene`. This is the only work that MUST run on a pan/zoom frame.
 */
export interface SceneViewOptions {
  readonly frame: Frame;
  readonly camera: CameraState;
  readonly viewportDim: Dimensions;
  readonly dpr: number;
  readonly geometry: GeometryService;
  readonly channelMask?: ChannelMaskMode;
}

export interface SceneAssemblerOptions extends SceneContentOptions, SceneViewOptions {}


export class SceneAssembler {
  /**
   * Build an immutable `Scene` plus the ordered list of asset uploads it needs,
   * WITHOUT performing any GPU side-effects (WP-5.4). Pure w.r.t. the engine:
   * safe to unit-test with no engine mock. `options.engine` is ignored here;
   * the caller flushes `uploads` via {@link SceneAssembler.syncAssets}.
   *
   * NOTE (deviation from the literal `syncAssets(scene, engine)` sketch): a
   * `Scene` only carries `assetId`s, not the decoded bitmaps, so the upload plan
   * must be captured here where the bitmaps are resolved — hence `buildScene`
   * returns `{ scene, uploads }` and `syncAssets` consumes `uploads`.
   */
  /**
   * Build the CAMERA-INDEPENDENT content half (P1 §4 / 缺陷 5 阶段 3): the
   * composited-document descriptor ({@link SceneContent}) + ordered upload plan.
   * Consumes ONLY {@link SceneContentOptions} (no camera/viewport/dpr), so its
   * output is safe to MEMOIZE across pan/zoom frames — the residual P1 cost was
   * re-running this O(layers) loop every camera frame even though nothing here
   * changes on a cam-only frame.
   *
   * SOUNDNESS: every field produced here is an input to
   * `computeCompositeSignature`; nothing camera/present-related leaks in. So a
   * reused content object implies an unchanged composite signature — reference
   * identity is a safe reuse key that can only ever be falsely-DIRTY (a wasted
   * rebuild), never falsely-CLEAN (which would regress 缺陷 5). Pure w.r.t. the
   * engine: `options.engine` is ignored; the caller flushes `uploads`.
   */
  static buildContent(options: SceneContentOptions): { content: SceneContent; uploads: AssetUpload[] } {
    const {
      frame: f,
      geometry,
      assets,
      getAnimatedRotation,
      getImageOverride,
      getBitmapMaskOverride,
      hdr = false,
    } = options;

    const uploads: AssetUpload[] = [];

    // 缺陷 5 §5 阶段 1b: the DOCUMENT composite size is the canvas NATIVE pixel
    // count (canvas.w × canvas.h, NO dpr) — camera- AND display-INDEPENDENT, so
    // the composited texture can be cached and only the view pass replays on
    // pan/zoom. DPR is a DISPLAY concern owned by the view pass (via M_camera's
    // renderScale, which maps canvas-logical → device-physical). Compositing at
    // native resolution + view-upscaling by dpr matches Photoshop's "100% on
    // retina = 1 image px → dpr device px". (阶段 1a used the screen size here.)
    const docW = Math.max(1, Math.floor(f.canvas.w));
    const docH = Math.max(1, Math.floor(f.canvas.h));

    // Collect hidden groups so their children are culled (§5.1.2)
    const hiddenGroupIds = new Set<string>();
    for (const id of f.layers.order) {
      const l = f.layers.byId[id];
      if (l && l.type === 'group' && !l.visible) {
        hiddenGroupIds.add(l.id);
      }
    }

    const sceneLayers: LayerNode[] = [];

    // WP-4 / 缺陷 5 §5 阶段 1b: CPU coarse-culling now culls against the CANVAS
    // (document) bounds, NOT the viewport. Compositing happens in document space
    // and is clipped to the canvas (画板外内容不参与合成、不显示 — the confirmed
    // Photoshop behavior), so a layer whose world AABB lies fully outside the
    // canvas contributes nothing and can be skipped. Culling against the canvas
    // (camera-independent) — rather than the viewport (camera-dependent) — is
    // also required for compose-caching: the composite set must not change when
    // only the camera pans/zooms. Guarded: fall back to no culling if the
    // geometry service lacks the APIs (slim test mocks).
    const canCull =
      typeof geometry.space?.getLayerBoundingBox === 'function' &&
      typeof geometry.space?.getRectIntersection === 'function';
    // Canvas rect in world space (centered at canvas center — the convention of
    // getLayerWorldMatrix). Pad by 2px so edge-straddling layers are never wrongly culled.
    const CULL_PADDING = 2;
    const canvasWorldRect = canCull
      ? {
          x: -f.canvas.w / 2 - CULL_PADDING,
          y: -f.canvas.h / 2 - CULL_PADDING,
          w: f.canvas.w + CULL_PADDING * 2,
          h: f.canvas.h + CULL_PADDING * 2,
        }
      : null;

    // Traverse layers bottom-to-top
    for (const layerId of f.layers.order) {
      const layer = f.layers.byId[layerId];
      if (!layer || !layer.visible) continue;

      // Group layers have no pixel data — skip rendering (§5.1.2)
      if (layer.type === 'group') continue;

      // If parent group is hidden, skip
      const groupId = layer.groupId;
      if (groupId && hiddenGroupIds.has(groupId)) continue;

      // Construct layer snapshot with animation state
      const displayRotation = getAnimatedRotation ? getAnimatedRotation(layer) : layer.rotation;
      const latestLayer: Layer = {
        ...layer,
        rotation: displayRotation,
      };

      // WP-4 / 缺陷 5 §5 阶段 1b: cull layers whose world AABB is fully outside the
      // CANVAS. Skips packing the LayerNode and any upload check for layers that
      // lie entirely in the (now non-composited) off-canvas scratch area.
      if (canCull && canvasWorldRect) {
        const layerBBox = geometry.space.getLayerBoundingBox(latestLayer);
        if (!geometry.space.getRectIntersection(layerBBox, canvasWorldRect)) continue;
      }

      // 缺陷 5 §5 阶段 1b: layer transform is now CAMERA-INDEPENDENT — local quad
      // → canvas/document space only. The camera lives in `scene.view.transform`
      // and is applied by the view pass, NOT baked here (that baking was the root
      // cause of 缺陷 5: camera changes forced a full re-composite every frame).
      const M_layer = geometry.transform.getLayerLocalMatrix(latestLayer, f);

      const transform: Mat3 = {
        a: M_layer.a,
        b: M_layer.b,
        c: M_layer.c,
        d: M_layer.d,
        tx: M_layer.tx,
        ty: M_layer.ty,
      };

      const layerWidth = latestLayer.bounding.w;
      const layerHeight = latestLayer.bounding.h;

      let crop: { x: number; y: number; w: number; h: number } | undefined;
      if (latestLayer.visibleShape) {
        crop = {
          x: latestLayer.visibleShape.rect.x,
          y: latestLayer.visibleShape.rect.y,
          w: latestLayer.visibleShape.rect.w,
          h: latestLayer.visibleShape.rect.h,
        };
      }

      // Resolve source bitmap
      const currentSrc = layer.src
        ? assets
          ? assets.resolve(layer.assetId, layer.src)
          : layer.src
        : null;

      const overrideImg = getImageOverride ? getImageOverride(layer.id) : undefined;
      const rawImg = overrideImg || (currentSrc ? sourceBitmapCache.getOrFetch(currentSrc) : null);

      // Upload bitmap to GPU resident texture.
      // §6.3 invariant 2: key by `assetId` (source content hash), NOT `layer.id`,
      // so a cut fragment and its origin share ONE resident GPUTexture. Per-layer
      // differences (uv_rect / localOffset / mask) live in the LayerNode, not the
      // shared texture.
      //
      // §6.3 invariant 1 (zero-transfer pan/zoom): the upload is ALWAYS recorded
      // and the engine dedups by bitmap reference / version at flush time. We
      // deliberately do NOT skip via `engine.has()`: without a per-layer
      // `pixelsDirty` flag that would suppress re-transfer after a genuine pixel
      // edit (draw/erase/filter yields a fresh ImageBitmap), leaving a stale image
      // on screen. The engine's reference check is both zero-transfer on pan/zoom
      // AND correct on edit (a new bitmap ref → re-DMA).
      const sourceAssetId = layer.assetId || layer.id;
      // §fix/20260911: a DPR-aware rasterized texture (e.g. a committed Text
      // layer produced by `pixels.rasterize.layer`, sized `bounding × dpr`) tags
      // its asset with `tileMeta.dprScale = dpr`. `crop` here is in LOGICAL
      // (document) pixels, so the crop→UV mapping in `resolveLayerGeometry` needs
      // this factor to sample the physical texture correctly. Bitmap / fragment
      // assets have `dprScale` undefined → treated as 1 (crop already in source
      // pixels), so their UV is unchanged.
      const sourceDprScale = assets?.get(sourceAssetId)?.tileMeta?.dprScale ?? 1;
      if (rawImg && typeof (rawImg as ImageBitmap).close === 'function') {
        uploads.push({ assetId: sourceAssetId, bitmap: rawImg as ImageBitmap });
      }

      // Resolve optional mask
      let maskDesc: MaskDesc | undefined;
      const maskOverride = getBitmapMaskOverride ? getBitmapMaskOverride(layer.id) : undefined;
      if (maskOverride && maskOverride.source) {
        if (typeof (maskOverride.source as ImageBitmap).close === 'function') {
          uploads.push({
            assetId: maskOverride.maskId,
            bitmap: maskOverride.source as ImageBitmap,
          });
        }
        maskDesc = {
          kind: 'bitmap',
          maskId: maskOverride.maskId,
          inverted: false,
        };
      } else if (layer.bitmapMasks && layer.bitmapMasks.length > 0) {
        const activeMask = layer.bitmapMasks.find((m) => m.enabled !== false);
        if (activeMask) {
          const maskSrc = assets
            ? assets.resolve(activeMask.assetId, activeMask.src)
            : activeMask.src;
          const maskImg = sourceBitmapCache.getOrFetch(maskSrc);
          if (maskImg && typeof (maskImg as ImageBitmap).close === 'function') {
            uploads.push({ assetId: activeMask.id, bitmap: maskImg as ImageBitmap });
          }
          maskDesc = {
            kind: 'bitmap',
            maskId: activeMask.id,
            inverted: !!activeMask.inverted,
          };
        }
      } else if (latestLayer.vectorMasks && latestLayer.vectorMasks.length > 0) {
        const activeVectorMasks = latestLayer.vectorMasks.filter((m) => m.enabled !== false);
        if (activeVectorMasks.length > 0 && layerWidth > 0 && layerHeight > 0) {
          const maskId = `vmask-${layer.id}`;
          const cacheKey = getVectorMasksKey(layer.id, activeVectorMasks, layerWidth, layerHeight);
          const cached = vectorMaskCache.get(layer.id);
          let maskBitmap: ImageBitmap | undefined;
          if (cached && cached.key === cacheKey) {
            maskBitmap = cached.bitmap;
          } else {
            maskBitmap = renderVectorMasksToBitmap(activeVectorMasks, layerWidth, layerHeight);
            if (maskBitmap) {
              setVectorMaskCache(layer.id, cacheKey, maskBitmap);
            }
          }
          const isHard = activeVectorMasks.every((m) => !m.feather || m.feather === 0);
          if (maskBitmap) {
            uploads.push({ assetId: maskId, bitmap: maskBitmap });
            maskDesc = {
              kind: 'bitmap',
              maskId,
              inverted: false,
              hard: isHard,
            };
          }
        }
      }

      sceneLayers.push({
        id: layer.id,
        source: {
          kind: 'raster',
          // Must match the resident-texture key used in the upload above (§6.3
          // invariant 2): the source content hash, so fragments sharing an origin
          // resolve to the same GPUTexture in RenderGraph.
          assetId: sourceAssetId,
        },
        transform,
        width: layerWidth,
        height: layerHeight,
        crop,
        dprScale: sourceDprScale,
        opacity: typeof layer.opacity === 'number' ? layer.opacity : 1.0,
        blendMode: layer.blendMode || 'source-over',
        mask: maskDesc,
        clip: !!layer.clip,
      });
    }

    const content: SceneContent = {
      // 缺陷 5 §5 阶段 1b: `frame` is the DOCUMENT (canvas) size — the composite
      // target — NOT the screen. Camera-independent, cacheable.
      frame: {
        width: docW,
        height: docH,
      },
      // Artboard clip bounds in DOCUMENT space. The document IS the canvas here,
      // so the artboard is the full frame (origin 0,0). Off-canvas scratch is not
      // composited (画板外不显示), so no separate clip rect is needed.
      artboard: {
        x: 0,
        y: 0,
        w: docW,
        h: docH,
      },
      colorSpace: f.colorSpace,
      hdr,
      layers: sceneLayers,
    };

    return { content, uploads };
  }

  /**
   * Fold the CAMERA-DEPENDENT view onto a (possibly reused) {@link SceneContent}
   * to produce the final immutable `Scene` (P1 §4 / 缺陷 5 阶段 3). CHEAP and
   * pure: one snap + one matrix multiply + object spread — the only assembly work
   * that must run on a pan/zoom frame. `channelMask` is a view (present-pass)
   * concern, not a compositing one, so it lives here — matching its exclusion
   * from `computeCompositeSignature`.
   */
  static composeView(content: SceneContent, options: SceneViewOptions): Scene {
    const {
      frame: f,
      camera: cam,
      viewportDim,
      dpr,
      geometry,
      channelMask = 'rgb',
    } = options;

    const targetW = Math.max(1, Math.floor(viewportDim.w * dpr));
    const targetH = Math.max(1, Math.floor(viewportDim.h * dpr));

    // Pixel-snap canvas boundary to integer physical pixels
    const snap = snapCanvasRect(cam, f.canvas, dpr);

    // M_camera maps canvas-space coordinates (0..canvas.w, 0..canvas.h)
    // to physical screen pixel coordinates. 缺陷 5 §5: this is now the SOLE
    // camera source — it lives in `scene.view.transform` and is NO LONGER baked
    // into per-layer transforms (which stay in document/canvas space).
    const M_camera = geometry.Matrix.translate(snap.physical.x, snap.physical.y).multiply(
      geometry.Matrix.scale(snap.renderScale.x, snap.renderScale.y),
    );

    return {
      frame: content.frame,
      artboard: content.artboard,
      display: {
        channelMask,
        colorSpace: content.colorSpace,
        hdr: content.hdr,
      },
      // 缺陷 5 §5 阶段 1b: the SOLE camera source. `M_camera` maps document/canvas
      // space → swapchain physical pixels; the view pass folds it into the
      // unit-quad→NDC matrix (see ViewPass.composeViewMatrix). `target` is the
      // swapchain physical size (viewport × dpr).
      view: {
        transform: {
          a: M_camera.a,
          b: M_camera.b,
          c: M_camera.c,
          d: M_camera.d,
          tx: M_camera.tx,
          ty: M_camera.ty,
        },
        target: { width: targetW, height: targetH },
      },
      layers: content.layers,
    };
  }

  /**
   * Build an immutable `Scene` plus the ordered list of asset uploads it needs,
   * WITHOUT performing any GPU side-effects (WP-5.4). Pure w.r.t. the engine:
   * safe to unit-test with no engine mock. `options.engine` is ignored here;
   * the caller flushes `uploads` via {@link SceneAssembler.syncAssets}.
   *
   * Orchestrator over {@link SceneAssembler.buildContent} (camera-independent) +
   * {@link SceneAssembler.composeView} (camera-dependent). CanvasStage calls the
   * two halves separately so it can memoize `buildContent` across pan/zoom; this
   * combined entry stays for one-shot / test callers.
   *
   * NOTE (deviation from the literal `syncAssets(scene, engine)` sketch): a
   * `Scene` only carries `assetId`s, not the decoded bitmaps, so the upload plan
   * must be captured here where the bitmaps are resolved — hence `buildScene`
   * returns `{ scene, uploads }` and `syncAssets` consumes `uploads`.
   */
  static buildScene(options: SceneAssemblerOptions): { scene: Scene; uploads: AssetUpload[] } {
    const { content, uploads } = SceneAssembler.buildContent(options);
    const scene = SceneAssembler.composeView(content, options);
    return { scene, uploads };
  }

  /**
   * Flush the upload plan produced by {@link SceneAssembler.buildScene} into the
   * engine (WP-5.4 side-effect half). Idempotent w.r.t. residency: the engine
   * dedups unchanged assets (§6.3), so calling this every frame is zero-transfer
   * on pan/zoom.
   */
  static syncAssets(uploads: readonly AssetUpload[], engine: IEngine): void {
    for (const u of uploads) {
      engine.upload(u.assetId, u.bitmap);
    }
  }

  /**
   * Assemble an immutable `Scene` and synchronize its assets into the engine in
   * one call. Backward-compatible orchestrator over `buildScene` + `syncAssets`.
   */
  static assemble(options: SceneAssemblerOptions): Scene {
    const { scene, uploads } = SceneAssembler.buildScene(options);
    if (options.engine) {
      SceneAssembler.syncAssets(uploads, options.engine);
    }
    return scene;
  }
}
