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

import { Frame, CameraState, Dimensions, GeometryService, AssetService, Layer, ClipDescriptor } from '@opengpex/editor/core/types';
import type { IRenderer } from '@opengpex/editor/core/engine/renderer';
import type { DisplayTransformConfig } from '@opengpex/editor/core/engine/protocol/DisplayTransform';
import { snapCanvasRect } from '@opengpex/editor/core/geometry/operators/snapping';

/** Converts layer viewport and masks into abstract clipping instructions. */
function getRenderPipeline(layer: Layer): ClipDescriptor[] {
  const pipeline: ClipDescriptor[] = [];
  if (layer.visibleShape) {
    pipeline.push({ shape: layer.visibleShape, inverted: false });
  }
  const activeMasks = layer.vectorMasks?.filter(m => m.enabled);
  if (activeMasks) {
    for (const mask of activeMasks) {
      pipeline.push({ shape: mask.shape, inverted: mask.inverted, feather: mask.feather || 0 });
    }
  }
  return pipeline;
}

interface RenderOptions {
  isInteracting: boolean;
  viewportPadding?: number;
  getAnimatedRotation: (layer: Layer) => number;
  getImageOverride?: (layerId: string) => CanvasImageSource | undefined;
  getBitmapMaskOverride?: (layerId: string) => { maskId: string; source: CanvasImageSource } | undefined;
  theme?: 'light' | 'dark';
  /** Display Transform config (channel view, future ICC/soft-proof). */
  displayConfig?: DisplayTransformConfig;
}

/**
 * StageComposer: Stage composer
 * Responsible for scene tree management, viewport culling, camera transform, and layer orchestration.
 * Acts as "director" of rendering pipeline, coordinating drawing order and positions of layers.
 */
export class StageComposer {
  render(
    renderer: IRenderer,
    f: Frame,
    cam: CameraState,
    viewportDim: Dimensions,
    geometry: GeometryService,
    assets: AssetService,
    options: RenderOptions
  ) {
    if (!renderer || cam.k <= 0) return;

    const { isInteracting, getAnimatedRotation } = options;

    // 1. Physical dimension check (caller should ensure canvas size is synchronized)
    // 2. Calculate dynamic viewport buffer (preparing for View Frustum Culling)
    const basePadding = isInteracting ? 1000 : 500;

    // Heuristic calculation: determine safe margin based on maximum layer size to prevent edge flickering during rotation
    let imageHeuristicPadding = 0;
    if (f.layers.order.length > 0) {
      const largestLayer = f.layers.order.map(id => f.layers.byId[id]).reduce((a, b) =>
        (a.bounding.w * a.bounding.h > b.bounding.w * b.bounding.h ? a : b)
      );
      const screenRect = geometry.space.localToScreenRect(
        geometry.asLocalRect({ x: 0, y: 0, ...largestLayer.bounding }),
        f,
        cam
      );
      imageHeuristicPadding = Math.max(screenRect.w, screenRect.h) * 0.5;
    }

    const viewportPadding = Math.min(Math.max(basePadding, imageHeuristicPadding), 2000);
    const worldViewport = geometry.camera.getViewportWorldRect(viewportDim, cam, f.canvas, viewportPadding);

    const dpr = window.devicePixelRatio || 1;

    // 3. Start a new frame, reset and clear canvas
    // [Pixel-Snap] Quantize canvas boundary to integer physical pixels.
    // This eliminates anti-aliased clip edges that cause ghost lines during pan
    // and 1px checkerboard bleed during zoom. See:
    // docs/opengpex/plans/20260815_canvas_edge_subpixel_artifact_fix.md
    const snap = snapCanvasRect(cam, f.canvas, dpr);
    const artboardClip = snap.physical;

    renderer.beginFrame({ w: f.canvas.w * dpr, h: f.canvas.h * dpr }, artboardClip, options.displayConfig);

    // 4. Push background drawing as a Command (deprecated, handled by CanvasBackdrop instead)

    // 5. Traverse and render scene tree
    for (const layerId of f.layers.order) {
      const layer = f.layers.byId[layerId];
      if (!layer.visible) continue;

      // Group layers have no pixel data — skip rendering (Phase 1: UI-only grouping)
      if (layer.type === 'group') continue;

      // 4a. Construct logical snapshot containing animation states
      const displayRotation = getAnimatedRotation(layer);
      const latestLayer = {
        ...layer,
        rotation: displayRotation
      };

      // 4b. Viewport culling (World Space)
      const layerBBox = geometry.space.getLayerBoundingBox(latestLayer);
      if (!geometry.space.getRectIntersection(layerBBox, worldViewport)) continue;

      try {
        // 4c. Calculate transform matrix and rendering path
        const M_layer = geometry.transform.getLayerLocalMatrix(latestLayer, f);

        // [Pixel-Snap Phase 3] Final screen matrix using snapped render scale.
        // Instead of DPR * translate(cam.x, cam.y) * scale(cam.k), we use
        // translate(snapX, snapY) * scale(renderScale) which maps canvas-local
        // coordinates directly to integer-aligned physical pixel boundaries.
        const M_camera = geometry.Matrix.translate(snap.physical.x, snap.physical.y)
          .multiply(geometry.Matrix.scale(snap.renderScale.x, snap.renderScale.y));
        const M_final = M_camera.multiply(M_layer);

        const clipSequence = getRenderPipeline(latestLayer);

        // 4d. Calculate pixel-level drawing bounds
        const sourceRect = geometry.space.getLayerLocalAABB(latestLayer, worldViewport);

        // [Bugfix]: Removed legacy `hasInverted ? null : ...` bypass logic.
        // Legacy logic on layers with inverted masks would discard physical coordinates of visibleShape, leading to drawRect incorrectly derived from (0,0).
        // This caused drawImage when drawing fragments inheriting inverted masks to crop from top-left of source image, offsetting image completely and rendering transparent.
        // We must always respect absolute position of fragment in source image (layer.visibleShape.rect) for frustum culling intersection.
        const layerLocalRect = layer.visibleShape?.rect ||
          { x: 0, y: 0, w: layer.bounding.w, h: layer.bounding.h };

        const drawRect = geometry.space.getRectIntersection(sourceRect, layerLocalRect);
        if (!drawRect) continue;

        // [DEBUG] Seam diagnosis: log transform and draw info for layers with visibleShape or inverted masks
        if ((window as unknown as Record<string, unknown>).__SEAM_DEBUG) {
          const hasInvertedMask = clipSequence?.some(c => c.inverted);
          const isFragment = !!(layer.visibleShape && (layer.visibleShape.rect.x > 0 || layer.visibleShape.rect.y > 0));
          if (isFragment || hasInvertedMask) {
            console.log(`[SeamDebug] layer="${layer.name}" id=${layer.id}`, {
              isFragment,
              hasInvertedMask,
              'M_final.tx': M_final.tx,
              'M_final.ty': M_final.ty,
              'M_final.a': M_final.a,
              'M_final.d': M_final.d,
              cx: layer.cx,
              cy: layer.cy,
              bounding: layer.bounding,
              visibleShape: layer.visibleShape?.rect,
              drawRect,
              sourceRect,
              layerLocalRect,
              clipCount: clipSequence?.length || 0,
              clips: clipSequence?.map(c => ({
                inverted: c.inverted,
                shape: c.shape?.rect,
                feather: c.feather
              })),
              cam: { x: cam.x, y: cam.y, k: cam.k },
              dpr,
            });
          }
        }

        // 4e. Build Layer Render Command and push to queue
        renderer.pushCommand({
          type: 'layer',
          layer: latestLayer,
          options: {
            matrix: M_final,
            drawRect,
            imageSmoothingQuality: isInteracting ? 'low' : 'high',
            clipSequence: clipSequence || [],
            imageOverride: options.getImageOverride?.(latestLayer.id),
            bitmapMaskOverride: options.getBitmapMaskOverride?.(latestLayer.id),
            // [Filter Fast-Track §2.1] Pass interaction state to engine for
            // filter dispatch decisions (small images → main-thread LUT,
            // large images → show unfiltered source during drag).
            isInteracting,
          }
        });
      } catch (err) {
        console.warn(`[StageRenderer] Render failed for layer ${layer.id}`, err);
      }
    }

    // 6. Execute all pending render commands
    renderer.flush(assets);

    // 7. [Display Transform] Post-composite pipeline stage.
    // Blits intermediate → screen with channel filter (or no-op for 'rgb').
    renderer.endFrame();
  }
}

export const stageComposer = new StageComposer();
