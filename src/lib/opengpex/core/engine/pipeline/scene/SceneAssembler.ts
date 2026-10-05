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
 * into an immutable declarative `Scene` descriptor.
 *
 * KEY RESPONSIBILITIES:
 *   1. Flattening layer groups: groups are purely organisational in v2.
 *   2. Computing final destination affine transforms (local quad -> screen pixels).
 *   3. Synchronising resident textures into the WebGpuEngine via `uploadSource`.
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
  LocalShape,
} from '@opengpex/editor/core/types';
import { snapCanvasRect } from '@opengpex/editor/core/geometry/operators/snapping';
import { translatePathData } from '@opengpex/editor/core/geometry/operators/shape';
import { shapeToPoint2D } from '@opengpex/editor/core/geometry/operators/point2d';
import { sourceBitmapCache } from '@opengpex/editor/core/engine/sources';
import { buildSolidColorSource, SOLID_COLOR_SOURCE_FORMAT, type SolidColorSource } from '@opengpex/editor/core/engine/sources/SolidColorSource';
import type { Scene, SceneContent, LayerNode, BitmapMaskDesc, VectorMaskDesc, VectorSubMask, Mat3, SceneChannelMask } from './Scene';
import { CHANNEL_MASK_RGB } from './Scene';
import type { IEngine, UploadSource, LutUpload } from '@opengpex/editor/core/engine/pipeline/IEngine';
import type { HighDepthSource } from '@opengpex/editor/core/engine/sources/HighDepthSource';
import { translateLayerAdjustments } from './adjustments';
import { markerToVectorSource } from './markerToVectorSource';
import { strokeToVectorSource } from './strokeToVectorSource';

/**
 * UNIFIED raw-upload seam — the single convergence point for every
 * high-precision layer source onto the engine's one `{kind:'raw'}` upload
 * contract (`UploadSource`, WebGpuEngine).
 *
 * The two producers are HETEROGENEOUS BY ORIGIN but identical downstream:
 *  - `SolidColorSource` (core/color) — a synthesized 1×1 pure-colour fill.
 *  - `HighDepthSource`  (core/engine/cache) — a decoded 16/32-bit image buffer.
 * Both reduce to naked float texels + a `{w,h,format}` descriptor, so the engine
 * (and the RenderGraph beyond it) never needs to know which produced a texture.
 * Keeping this reduction in ONE pure function is why the assembler has a single
 * raw branch instead of one hand-written mapping per producer.
 *
 * `solid` wins when both are present (a `color` layer owns no real bitmap /
 * high-depth asset). Returns undefined when neither applies — an 8-bit source
 * then stays on the zero-copy `{kind:'bitmap'}` path.
 */
function toRawUpload(
  solid: SolidColorSource | undefined,
  highDepth: HighDepthSource | undefined,
): Extract<UploadSource, { kind: 'raw' }> | undefined {
  if (solid) {
    return { kind: 'raw', data: solid.texels, desc: { w: 1, h: 1, format: SOLID_COLOR_SOURCE_FORMAT } };
  }
  if (highDepth) {
    return {
      kind: 'raw',
      data: highDepth.data,
      desc: { w: highDepth.width, h: highDepth.height, format: highDepth.dataFormat },
    };
  }
  return undefined;
}

/**
 * Normalize a `LocalShape` (as stored on `Layer.visibleShape`,
 * in the SOURCE layer's local space) into the FRAGMENT layer's own local
 * origin `(0, 0)`. Mirrors the old Canvas2D engine's implicit-clip convention
 * (`buildClipSequence`) so a non-rect `visibleShape` can be re-expressed as a
 * `VectorMask` and pushed through the existing mask pipeline.
 *
 * `rect` is always translated. `pathData` (type `'path'`) stores ABSOLUTE
 * coordinates independent of `rect` and must be translated in lockstep via
 * `translatePathData`, or the path renders offset from the mask canvas.
 * `circle` has no coordinates of its own (derived entirely from `rect`).
 */
export function translateLocalShapeToOrigin(shape: LocalShape, dx: number, dy: number): LocalShape {
  return {
    ...shape,
    rect: { ...shape.rect, x: shape.rect.x + dx, y: shape.rect.y + dy },
    pathData: shape.type === 'path' && shape.pathData
      ? translatePathData(shape.pathData, dx, dy)
      : shape.pathData,
  };
}

/**
 * Build the DECLARATIVE {@link VectorMaskDesc} for a layer's vmask set.
 * No CPU rasterization, no upload — the descriptor is consumed on the GPU:
 *   • analytic — a SINGLE unfeathered-or-feathered rect/circle collapses to a
 *     per-fragment SDF in `layer.ts`/`blend.ts`, no intermediate texture. `rect`
 *     is a NORMALIZED FRACTION `[cx/w, cy/h, halfW/w, halfH/h]` so it is
 *     resolution-independent (vmaskUniform multiplies back to content px).
 *   • polygon — every other case (paths, ≥2 stacked masks) becomes a sub-mask
 *     table baked by the compute fill-pass (`prepareVmaskSources.ts`). Each mask
 *     contributes its rings (layer-local px, via `shapeToPoint2D`) plus its own
 *     feather/invert/antiAliased; the shader INTERSECTS them (v1 `ctx.clip()`
 *     intersection).
 *
 * `masks` are the already-combined, origin-translated `VectorMask`s for the layer
 * (same set the deleted CPU path consumed). `w`/`h` are the layer's content dims.
 * Exported for the dispatch truth-table tests.
 */
export function buildVectorMaskDesc(
  masks: VectorMask[],
  w: number,
  h: number,
): VectorMaskDesc {
  if (masks.length === 1) {
    const m = masks[0];
    const t = m.shape.type;
    if (t === 'rect' || t === 'circle') {
      const r = m.shape.rect;
      const sw = w > 0 ? w : 1;
      const sh = h > 0 ? h : 1;
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      return {
        kind: 'analytic',
        shape: t === 'circle' ? 'ellipse' : 'rect',
        rect: [cx / sw, cy / sh, r.w / 2 / sw, r.h / 2 / sh] as const,
        featherPx: m.feather ?? 0,
        inverted: m.inverted,
        // `antiAliased === false` is the ONLY hard-edge signal (Shape.hardEdge
        // was deleted — it was a v1 leftover that was false everywhere with no
        // UI to set it). A rect's edges are pixel-snapped upstream
        // (geometry/operators/snapping.ts), so the flag is effectively a no-op
        // for plain rects, but the mapping stays uniform for the ellipse
        // legacy branch.
        hard: m.shape.antiAliased === false,
      };
    }
  }

  const subMasks: VectorSubMask[] = masks.map((m) => ({
    rings: shapeToPoint2D(m.shape).map((ring) => ring.map((p) => [p.x, p.y] as const)),
    featherPx: m.feather ?? 0,
    inverted: m.inverted,
    // GPU-side AA switch (default ON): only an EXPLICIT `antiAliased: false`
    // downgrades the fill-pass to the 1-bit binary edge. Display-only modes
    // (e.g. the future ssdepMode) must never reach the GPU descriptor.
    antiAliased: m.shape.antiAliased !== false,
  }));
  return { kind: 'polygon', subMasks };
}

/**
 * One resident-texture upload the built Scene depends on. Captured by
 * `buildScene` (pure) and flushed by `syncAssets` (side-effecting).
 *
 * `source` is the `UploadSource` discriminated union: 8-bit layers carry
 * `{ kind: 'bitmap' }`; 16/32-bit sources carry `{ kind: 'raw' }`.
 * The engine selects the resident texture format from the source bit depth.
 */
export interface AssetUpload {
  readonly assetId: string;
  readonly source: UploadSource;
  /**
   * Content-change stamp consumed by the engine's upload dedup. Optional —
   * most producers upload a fresh bitmap reference per call and don't need
   * it. Omitting it on a producer that mutates and re-dispatches the SAME
   * source reference (e.g. a live-preview `OffscreenCanvas`) silently falls
   * back to reference-equality dedup, which treats every in-place edit as
   * "unchanged" and freezes the preview.
   */
  readonly version?: number;
}

/**
 * Re-exported from the ingest-axis cache: decoded high-bit-depth naked
 * pixels for a single asset. `SceneAssembler` consumes it PURELY to choose the
 * resident texture format per layer: when present for a
 * layer's source asset, that layer uploads via `{ kind: 'raw' }` → `rgba16float`;
 * when absent, the layer stays on the 8-bit `{ kind: 'bitmap' }` path.
 */
export type { HighDepthSource } from '@opengpex/editor/core/engine/sources/HighDepthSource';

/**
 * The CAMERA-INDEPENDENT inputs to assembly — everything that determines the
 * composited document texture. `buildContent` consumes ONLY these, so
 * its output ({@link SceneContent} + uploads) is safe to memoize across
 * cam-only frames (pan/zoom). Deliberately excludes camera/viewport/dpr.
 */
export interface SceneContentOptions {
  readonly frame: Frame;
  readonly geometry: GeometryService;
  readonly assets?: AssetService;
  readonly engine?: IEngine;
  readonly getImageOverride?: (layerId: string) => ImageBitmap | CanvasImageSource | undefined;
  readonly getBitmapMaskOverride?: (
    layerId: string,
  ) => { maskId: string; source: ImageBitmap | OffscreenCanvas; bounds?: { x: number; y: number }; version?: number } | undefined;
  /**
   * Per-layer precision seam. Given a source `assetId`,
   * returns decoded high-bit-depth pixels when that asset is a 16/32-bit source,
   * or `undefined` for an 8-bit source (the overwhelming majority).
   * The dispatch judges ONLY the single source's bit depth here — NEVER `frame.bitDepth`.
   */
  readonly getHighDepthSource?: (assetId: string) => HighDepthSource | undefined;
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
  readonly channelMask?: SceneChannelMask;
}

export interface SceneAssemblerOptions extends SceneContentOptions, SceneViewOptions {}


export class SceneAssembler {
  /**
   * Build an immutable `Scene` plus the ordered list of asset uploads it needs,
   * WITHOUT performing any GPU side-effects. Pure w.r.t. the engine:
   * safe to unit-test with no engine mock. `options.engine` is ignored here;
   * the caller flushes `uploads` via {@link SceneAssembler.syncAssets}.
   *
   * NOTE: a `Scene` only carries `assetId`s, not the decoded bitmaps, so the upload plan
   * must be captured here where the bitmaps are resolved — hence `buildScene`
   * returns `{ scene, uploads }` and `syncAssets` consumes `uploads`.
   */
  /**
   * Build the CAMERA-INDEPENDENT content half: the
   * composited-document descriptor ({@link SceneContent}) + ordered upload plan.
   * Consumes ONLY {@link SceneContentOptions} (no camera/viewport/dpr), so its
   * output is safe to MEMOIZE across pan/zoom frames — avoiding
   * re-running this O(layers) loop every camera frame even though nothing here
   * changes on a cam-only frame.
   *
   * SOUNDNESS: every field produced here is an input to
   * `computeCompositeSignature`; nothing camera/present-related leaks in. So a
   * reused content object implies an unchanged composite signature — reference
   * identity is a safe reuse key that can only ever be falsely-DIRTY (a wasted
   * rebuild), never falsely-CLEAN. Pure w.r.t. the
   * engine: `options.engine` is ignored; the caller flushes `uploads`.
   */
  static buildContent(options: SceneContentOptions): { content: SceneContent; uploads: AssetUpload[]; lutUploads: LutUpload[] } {
    const {
      frame: f,
      geometry,
      assets,
      getImageOverride,
      getBitmapMaskOverride,
      getHighDepthSource,
      hdr = false,
    } = options;

    const uploads: AssetUpload[] = [];
    // Curves/levels 1D-LUT upload plan (dedup by lutId across layers).
    const lutUploads: LutUpload[] = [];
    const lutSeen = new Set<string>();

    // The DOCUMENT composite size is the canvas NATIVE pixel
    // count (canvas.w × canvas.h, NO dpr) — camera- AND display-INDEPENDENT, so
    // the composited texture can be cached and only the view pass replays on
    // pan/zoom. DPR is a DISPLAY concern owned by the view pass (via M_camera's
    // renderScale, which maps canvas-logical → device-physical). Compositing at
    // native resolution + view-upscaling by dpr matches Photoshop's "100% on
    // retina = 1 image px → dpr device px".
    const docW = Math.max(1, Math.floor(f.canvas.w));
    const docH = Math.max(1, Math.floor(f.canvas.h));

    // Collect hidden groups so their children are culled
    const hiddenGroupIds = new Set<string>();
    for (const id of f.layers.order) {
      const l = f.layers.byId[id];
      if (l && l.type === 'group' && !l.visible) {
        hiddenGroupIds.add(l.id);
      }
    }

    const sceneLayers: LayerNode[] = [];

    // CPU coarse-culling now culls against the CANVAS
    // (document) bounds, NOT the viewport. Compositing happens in document space
    // and is clipped to the canvas (off-canvas content does not participate in compositing and is not displayed — the confirmed
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

      // Group layers have no pixel data — skip rendering
      if (layer.type === 'group') continue;

      // If parent group is hidden, skip
      const groupId = layer.groupId;
      if (groupId && hiddenGroupIds.has(groupId)) continue;

      // Construct layer snapshot (rotation is read straight from committed state;
      // the ±90° canvas-rotation transition is a DOM-transform compensation, not a
      // per-frame scene rebuild — see stage/viewport swapRotate).
      const latestLayer: Layer = {
        ...layer,
      };

      // Cull layers whose world AABB is fully outside the
      // CANVAS. Skips packing the LayerNode and any upload check for layers that
      // lie entirely in the (now non-composited) off-canvas scratch area.
      if (canCull && canvasWorldRect) {
        const layerBBox = geometry.space.getLayerBoundingBox(latestLayer);
        if (!geometry.space.getRectIntersection(layerBBox, canvasWorldRect)) continue;
      }

      // Layer transform is now CAMERA-INDEPENDENT — local quad
      // → canvas/document space only. The camera lives in `scene.view.transform`
      // and is applied by the view pass, NOT baked here (keeping camera changes from
      // forcing a full re-composite every frame).
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

      // Vector spine (architecture B): a `vector` layer is rendered analytically on
      // the GPU instead of the CPU Canvas2D bitmap path. Two renderer strategies share
      // this seam, mapped ONCE here (the sole business→vector boundary):
      //   • `markerData`  → `renderer: 'sdf'`    (rect/ellipse/arrow fragment solve)
      //   • `strokeData`  → `renderer: 'stroke'` (logic brush; compute-extruded ribbon)
      // A vector layer carries exactly one of the two; the marker mapper returns
      // undefined for a stroke layer and vice-versa, so the `??` chain picks the right
      // strategy. `size`/bounding MUST match the LayerNode dims below (marker takes them
      // explicitly; stroke reads `layer.bounding` internally — same source). When
      // defined, the layer skips the bitmap upload entirely and its `source` becomes the
      // `{ kind: 'vector', ... }` descriptor; the shared tail (transform / crop / mask /
      // adjust / opacity / blend / clip) is identical to a raster's. Working gamut is
      // Display-P3 (see colorSpace below).
      const vectorSource =
        markerToVectorSource(latestLayer, 'display-p3', layerWidth, layerHeight) ??
        strokeToVectorSource(latestLayer, 'display-p3');
      const isVectorLayer = vectorSource !== undefined;

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
      // Key by `assetId` (source content hash), NOT `layer.id`,
      // so a cut fragment and its origin share ONE resident GPUTexture. Per-layer
      // differences (uv_rect / localOffset / mask) live in the LayerNode, not the
      // shared texture.
      //
      // Zero-transfer pan/zoom: the upload is ALWAYS recorded
      // and the engine dedups by bitmap reference / version at flush time. We
      // deliberately do NOT skip via `engine.has()`: without a per-layer
      // `pixelsDirty` flag that would suppress re-transfer after a genuine pixel
      // edit (draw/erase/filter yields a fresh ImageBitmap), leaving a stale image
      // on screen. The engine's reference check is both zero-transfer on pan/zoom
      // AND correct on edit (a new bitmap ref → re-DMA).
      // A `color` layer is a PURE FILL — synthesize a 1×1
      // wide-gamut solid source from its ColorValue instead of leaning on an
      // uploaded bitmap (whose only resident asset is the transparent-pixel
      // placeholder). The ColorValue's TRC-encoded float coords ride a 1×1
      // rgba16float texture (STRAIGHT RGBA) tagged with their OWN `space` gamut, so
      // the existing gamut_to_working alignment carries them losslessly.
      const fillColor = latestLayer.type === 'color' ? latestLayer.metadata?.fillColor : undefined;
      const solid = fillColor ? buildSolidColorSource(fillColor) : undefined;
      const sourceAssetId = solid ? solid.assetId : layer.assetId || layer.id;
      // A DPR-aware rasterized texture (e.g. a committed Text
      // layer produced by `pixels.rasterize.layer`, sized `bounding × dpr`) tags
      // its asset with `dprScale = dpr`. `crop` here is in LOGICAL (document)
      // pixels, so the crop→UV mapping in `resolveLayerGeometry` needs this
      // factor to sample the physical texture correctly. Bitmap / fragment
      // assets have `dprScale` undefined → treated as 1 (crop already in source
      // pixels), so their UV is unchanged.
      const sourceDprScale = assets?.get(sourceAssetId)?.dprScale ?? 1;
      // Per-layer precision dispatch: judge THIS layer's source bit depth
      // (via the ingest-axis seam), never `frame.bitDepth`. A 16/32-bit source
      // uploads its naked pixels as `{ kind: 'raw' }` → rgba16float/rgba32float;
      // an 8-bit source stays on the zero-copy `{ kind: 'bitmap' }` path. Logical
      // layers (copy/cut/paste, Cmd+J) reuse the source assetId, so precision is
      // inherited for free.
      const highDepth = getHighDepthSource ? getHighDepthSource(sourceAssetId) : undefined;

      // Dev-only drift guard, HIGH-DEPTH
      // ONLY: the naked buffer is EXIF-uprighted at decode, so its dims must equal
      // this layer's bounding (at DPR 1). A mismatch means a decoder skipped
      // `rotateNakedRgba` and we're about to upload a mis-oriented / mis-strided
      // texture. Guarded to DPR 1 to avoid false alarms on HiDPI rasters. (A solid
      // source is 1×1 by construction — nothing to check.)
      if (highDepth && process.env.NODE_ENV !== 'production' && sourceDprScale === 1) {
        console.assert(
          highDepth.width === layerWidth && highDepth.height === layerHeight,
          `SceneAssembler: high-depth texture ${highDepth.width}×${highDepth.height} ≠ ` +
          `layer bounding ${layerWidth}×${layerHeight} for asset ${sourceAssetId} — ` +
          `naked buffer not EXIF-uprighted`,
        );
      }

      // Single raw-upload branch: both high-precision producers (solid fill /
      // high-depth image) converge through `toRawUpload` onto `{kind:'raw'}`. An
      // 8-bit source yields none and falls through to the zero-copy bitmap path.
      // A vector layer has NO bitmap source at all (GPU-analytic) — skip every
      // upload; RenderGraph renders it into a transient from its `source`.
      const rawUpload = isVectorLayer ? undefined : toRawUpload(solid, highDepth);
      if (rawUpload) {
        uploads.push({ assetId: sourceAssetId, source: rawUpload });
      } else if (!isVectorLayer && rawImg && typeof (rawImg as ImageBitmap).close === 'function') {
        const resolvedGamut = assets?.get(sourceAssetId)?.gamut ?? 'srgb';
        uploads.push({
          assetId: sourceAssetId,
          // Tag the 8-bit color raster with the asset's OWN
          // colorIdentity.gamut (StoredAsset is the sole owner of per-asset color
          // truth) so the upload copy
          // is an identity when the source is already in the working gamut.
          // Falls back to `'srgb'` only if the asset entry can't be resolved
          // (shouldn't happen for a registered asset — defensive only). The frame
          // no longer carries a colour space to fall back to, and sRGB is what an
          // untagged raster means everywhere else (`DEFAULT_COLOR_IDENTITY`,
          // `WebGpuEngine`'s untagged-source default).
          // SYNC ⚠️: this is the TRANSFER-time tag (steers copyExternalImageToTexture
          // into an identity copy). It MUST stay equal to the RENDER-time tag on the
          // scene layer's `source.gamut` below — both read `assets?.get(sourceAssetId)?.gamut`.
          // They are two independent channels (upload identity vs. shader
          // gamut_to_working); diverging them double-converts or fails to align.
          source: { kind: 'bitmap', data: rawImg as ImageBitmap, gamut: resolvedGamut },
        });
      }

      // Resolve optional mask — SPLIT model. A layer can
      // carry BOTH an eraser bitmap mask (bitmapMasks / live override) AND a
      // vector "hole" mask (vectorMasks / implicit non-rect visibleShape). They
      // are NO LONGER combined on the CPU: the bmask uploads its own alpha
      // texture, the vmask becomes a DECLARATIVE descriptor solved on the GPU
      // (analytic per-fragment SDF, or a compute fill-pass for polygons). The
      // layer shader multiplies both: `color.a *= bmask.a * vmask.a`.
      let bmaskDesc: BitmapMaskDesc | undefined;
      let vmaskDesc: VectorMaskDesc | undefined;

      // ── (1) bmask alpha source: live override SUPERSEDES the baked bitmapMask ──
      let bmaskSource: ImageBitmap | OffscreenCanvas | undefined;
      let bmaskId: string | undefined;
      let bmaskInverted = false;
      let bmaskVersion: number | undefined;
      const maskOverride = getBitmapMaskOverride ? getBitmapMaskOverride(layer.id) : undefined;
      if (maskOverride && maskOverride.source) {
        // `maskOverride.source` is EITHER a live-preview `OffscreenCanvas`
        // (an in-progress eraser/restore drag, which never has `.close`) OR
        // an already-baked `ImageBitmap` — both upload directly through the
        // same path, no discriminator needed.
        bmaskSource = maskOverride.source;
        bmaskId = maskOverride.maskId;
        bmaskInverted = false;
        bmaskVersion = maskOverride.version;
      } else if (layer.bitmapMasks && layer.bitmapMasks.length > 0) {
        // Selection standard unified with factory → LAST enabled mask
        // (the newest / active one).
        const enabled = layer.bitmapMasks.filter((m) => m.enabled !== false);
        const activeMask = enabled.length > 0 ? enabled[enabled.length - 1] : undefined;
        if (activeMask) {
          const maskSrc = assets
            ? assets.resolve(activeMask.assetId, activeMask.src)
            : activeMask.src;
          const maskImg = sourceBitmapCache.getOrFetch(maskSrc);
          if (maskImg && typeof (maskImg as ImageBitmap).close === 'function') {
            bmaskSource = maskImg as ImageBitmap;
            bmaskId = activeMask.id;
            bmaskInverted = !!activeMask.inverted;
          }
        }
      }
      if (bmaskSource && bmaskId) {
        // Upload the bmask alpha AS-IS (no CPU combine); the shader applies
        // `inverted` at sample time. Unchanged from the pre-split eraser path.
        uploads.push({
          assetId: bmaskId,
          source: { kind: 'bitmap', data: bmaskSource },
          version: bmaskVersion,
        });
        bmaskDesc = { maskId: bmaskId, inverted: bmaskInverted };
      }

      // ── (2) vmask: vectorMasks + implicit non-rect visibleShape → declarative ──
      // (implicit shape mask preserves the fragment non-rect clip, see
      // translateLocalShapeToOrigin.)
      const explicitMasks = latestLayer.vectorMasks?.filter((m) => m.enabled !== false) ?? [];
      const shape = latestLayer.visibleShape;
      // A non-rect visibleShape is an implicit clip mask; a rect visibleShape that
      // carries a feather (feathered fragment) also needs one so its soft edge
      // renders. A plain rect fragment (featherPx 0/absent) keeps the crop-only path.
      const implicitFeatherPx = (shape as { featherPx?: number } | undefined)?.featherPx ?? 0;
      const hasImplicitShapeMask = shape !== undefined && (shape.type !== 'rect' || implicitFeatherPx > 0);
      let combinedMasks: VectorMask[] = explicitMasks;
      if (hasImplicitShapeMask) {
        const vx = shape!.rect.x;
        const vy = shape!.rect.y;
        const normalizedShape = translateLocalShapeToOrigin(shape!, -vx, -vy);
        const implicitMask: VectorMask = {
          id: `implicit-visible-shape-${layer.id}`,
          shape: normalizedShape,
          inverted: false,
          feather: implicitFeatherPx,
          enabled: true,
        };
        combinedMasks = [implicitMask, ...explicitMasks];
      }
      if (combinedMasks.length > 0 && layerWidth > 0 && layerHeight > 0) {
        // No CPU rasterization, no upload — the GPU resolves it (analytic SDF or
        // compute fill-pass baked in prepareVmaskSources.ts).
        vmaskDesc = buildVectorMaskDesc(combinedMasks, layerWidth, layerHeight);
      }

      // Translate adjustment state once, split the LayerNode
      // fields (adjustments/filters) from the LUT upload plan (`luts`).
      const { luts: lutPlan, ...adjustmentResult } = translateLayerAdjustments(latestLayer);

      sceneLayers.push({
        id: layer.id,
        source: vectorSource ?? {
          kind: 'raster',
          // Must match the resident-texture key used in the upload above:
          // the source content hash, so fragments sharing an origin
          // resolve to the same GPUTexture in RenderGraph.
          assetId: sourceAssetId,
          // The asset's colour DOMAIN, judged per-asset from the decoder's
          // reported interpretation. 8-bit bitmap assets have no high-depth entry, so
          // this stays undefined ⇒ 'srgb-trc' (correct: browser decoders always emit
          // sRGB-encoded pixels). NEVER derived from `frame.trc` — see LayerSource.trc.
          trc: highDepth?.trc ?? 'srgb-trc',
          // Forwarding terminus: the per-asset source gamut the GPU sampling
          // shader converts to the working space (Display-P3). High-depth sources
          // carry their own decoded gamut; 8-bit bitmap sources (no high-depth
          // entry) read the asset's OWN colorIdentity.gamut (StoredAsset is the
          // sole owner of per-asset color truth, not the frame),
          // matching the identity upload tag above, so gamut_id resolves to
          // srgb(1)/p3(0) and the shader aligns srgb→P3 (p3 is a no-op).
          // Falls back to `'srgb'` only if the asset entry can't be resolved — the
          // frame carries no colour space to fall back to, and sRGB is
          // the universal meaning of an untagged raster.
          // SYNC ⚠️ (8-bit): this RENDER-time tag must equal the TRANSFER-time
          // `UploadSource.gamut` set above — keep both sourced from
          // `assets?.get(sourceAssetId)?.gamut`.
          // A solid-colour source carries the ColorValue's OWN `space`
          // (the fill's gamut), which the shader aligns to working.
          // The 1×1 rgba16float texels are already in that space, so gamut_to_working
          // is the sole (lossless) conversion.
          gamut: fillColor ? fillColor.space : highDepth?.gamut ?? assets?.get(sourceAssetId)?.gamut ?? 'srgb',
          // Forwarding terminus: the per-asset out-of-box render
          // intent the GPU sampling shader tone-maps at composite. Only scene-linear
          // sources (camera RAW) carry a high-depth entry tagged 'filmic'; 8-bit
          // bitmaps have no high-depth entry ⇒ undefined ⇒ resolveSourceRenderIntent
          // treats it as 'sdr' passthrough. Carried forward from the ingest decision,
          // NEVER re-sniffed here.
          renderIntent: highDepth?.renderIntent ?? 'sdr',
        },
        transform,
        width: layerWidth,
        height: layerHeight,
        crop,
        dprScale: sourceDprScale,
        opacity: typeof layer.opacity === 'number' ? layer.opacity : 1.0,
        blendMode: layer.blendMode || 'source-over',
        bmask: bmaskDesc,
        vmask: vmaskDesc,
        // Translate the layer's adjustment STATE into declarative
        // AdjustmentDesc[] / FilterDesc[]. Identity state → undefined (no
        // signature contribution). This is the single fill point the composite
        // cache's dirty-detection depends on (stale-frame guard): the
        // signature already serialises `adjustments`/`filters`, so filling them
        // here is what makes a slider drag re-composite while pan/zoom stays clean.
        // `luts` is NOT a LayerNode field — it is the curves/levels LUT UPLOAD
        // plan, collected separately below and flushed via syncAssets.
        ...adjustmentResult,
        clip: !!layer.clip,
      });

      // Collect the LUT upload plan (dedup by lutId across layers happens in the
      // engine's uploadLut; we still avoid queueing duplicates here for cheapness).
      if (lutPlan) {
        for (const lut of lutPlan) {
          if (!lutSeen.has(lut.lutId)) {
            lutSeen.add(lut.lutId);
            lutUploads.push(lut);
          }
        }
      }
    }

    const content: SceneContent = {
      // `frame` is the DOCUMENT (canvas) size — the composite
      // target — NOT the screen. Camera-independent, cacheable.
      frame: {
        width: docW,
        height: docH,
      },
      // Artboard clip bounds in DOCUMENT space. The document IS the canvas here,
      // so the artboard is the full frame (origin 0,0). Off-canvas scratch is not
      // composited (not displayed outside the artboard), so no separate clip rect is needed.
      artboard: {
        x: 0,
        y: 0,
        w: docW,
        h: docH,
      },
      // The WORKING gamut, which is a hard invariant rather than a document
      // property: `GpuDevice.configureSurface` configures the swapchain as
      // display-p3 unconditionally, and `resolveSourceGamutId` treats display-p3
      // as the passthrough id. Per-asset colour truth lives on each layer's
      // `source.gamut` above, so there is nothing document-level left
      // for this field to carry — it must NOT be re-derived from the frame.
      colorSpace: 'display-p3',
      hdr,
      layers: sceneLayers,
    };

    return { content, uploads, lutUploads };
  }

  /**
   * Fold the CAMERA-DEPENDENT view onto a (possibly reused) {@link SceneContent}
   * to produce the final immutable `Scene`. CHEAP and
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
      channelMask = CHANNEL_MASK_RGB,
    } = options;

    const targetW = Math.max(1, Math.floor(viewportDim.w * dpr));
    const targetH = Math.max(1, Math.floor(viewportDim.h * dpr));

    // Pixel-snap canvas boundary to integer physical pixels
    const snap = snapCanvasRect(cam, f.canvas, dpr);

    // M_camera maps canvas-space coordinates (0..canvas.w, 0..canvas.h)
    // to physical screen pixel coordinates. This is now the SOLE
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
      // The SOLE camera source. `M_camera` maps document/canvas
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
   * WITHOUT performing any GPU side-effects. Pure w.r.t. the engine:
   * safe to unit-test with no engine mock. `options.engine` is ignored here;
   * the caller flushes `uploads` via {@link SceneAssembler.syncAssets}.
   *
   * Orchestrator over {@link SceneAssembler.buildContent} (camera-independent) +
   * {@link SceneAssembler.composeView} (camera-dependent). CanvasStage calls the
   * two halves separately so it can memoize `buildContent` across pan/zoom; this
   * combined entry stays for one-shot / test callers.
   *
   * NOTE: a `Scene` only carries `assetId`s, not the decoded bitmaps, so the upload plan
   * must be captured here where the bitmaps are resolved — hence `buildScene`
   * returns `{ scene, uploads }` and `syncAssets` consumes `uploads`.
   */
  static buildScene(options: SceneAssemblerOptions): { scene: Scene; uploads: AssetUpload[]; lutUploads: LutUpload[] } {
    const { content, uploads, lutUploads } = SceneAssembler.buildContent(options);
    const scene = SceneAssembler.composeView(content, options);
    return { scene, uploads, lutUploads };
  }

  /**
   * Flush the upload plan produced by {@link SceneAssembler.buildScene} into the
   * engine. Idempotent w.r.t. residency: the engine
   * dedups unchanged assets + LUTs, so calling this every frame is
   * zero-transfer on pan/zoom.
   */
  static syncAssets(
    uploads: readonly AssetUpload[],
    engine: IEngine,
    lutUploads?: readonly LutUpload[],
  ): void {
    for (const u of uploads) {
      engine.uploadSource(u.assetId, u.source, u.version);
    }
    if (lutUploads) {
      for (const lut of lutUploads) {
        engine.uploadLut(lut);
      }
    }
  }

  /**
   * Assemble an immutable `Scene` and synchronize its assets into the engine in
   * one call. Backward-compatible orchestrator over `buildScene` + `syncAssets`.
   */
  static assemble(options: SceneAssemblerOptions): Scene {
    const { scene, uploads, lutUploads } = SceneAssembler.buildScene(options);
    if (options.engine) {
      SceneAssembler.syncAssets(uploads, options.engine, lutUploads);
    }
    return scene;
  }
}
