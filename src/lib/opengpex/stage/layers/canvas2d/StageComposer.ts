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

import { Frame, CameraState, Dimensions, GeometryService, AssetService, Layer } from '@opengpex/editor/core/types';
import { PixelUtils } from '@opengpex/editor/core/engine/PixelUtils';
import { IRenderer } from '@opengpex/editor/core/engine/protocol/IRenderer';

interface RenderOptions {
  isInteracting: boolean;
  viewportPadding?: number;
  getAnimatedRotation: (layer: Layer) => number;
  getImageOverride?: (layerId: string) => CanvasImageSource | undefined;
  getBitmapMaskOverride?: (layerId: string) => { maskId: string; source: CanvasImageSource } | undefined;
  theme?: 'light' | 'dark';
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
    const M_dpr = geometry.Matrix.scale(dpr);

    // 3. Start a new frame, reset and clear canvas
    renderer.beginFrame({ w: f.canvas.w * dpr, h: f.canvas.h * dpr });

    // 4. Push background drawing as a Command (deprecated, handled by CanvasBackdrop instead)

    // 5. Traverse and render scene tree
    for (const layerId of f.layers.order) {
      const layer = f.layers.byId[layerId];
      if (!layer.visible) continue;

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

        // [Phase 3] Calculate final screen matrix: DPR * CameraMatrix * LayerMatrix
        const M_camera = geometry.Matrix.translate(cam.x, cam.y).multiply(geometry.Matrix.scale(cam.k));
        const M_final = M_dpr.multiply(M_camera).multiply(M_layer);

        const clipSequence = PixelUtils.getRenderPipeline(latestLayer);

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
          }
        });
      } catch (err) {
        console.warn(`[StageRenderer] Render failed for layer ${layer.id}`, err);
      }
    }

    // 6. Execute all pending render commands
    renderer.flush(assets);
  }
}

export const stageComposer = new StageComposer();
